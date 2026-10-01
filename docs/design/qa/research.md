# T-241. QA: Chromium в песочнице исполнителя и выбор MCP-сервера браузера

Исследование перед ролью «Тестировщик (QA)» (`packages/@office/qa`). Код роли
здесь не пишется. Всё, что ниже помечено «проверено», запускалось 2026-10-01 в
сессии исполнителя офиса, то есть в той самой песочнице (macOS Seatbelt,
`SANDBOX` из `src/server/agents.ts`), на arm64, Node 22.23.1. Playwright 1.63.0
ставился во временную папку `$TMPDIR/pw`, `@playwright/mcp` — версии 0.0.83.
`package.json` репозитория не менялся.

## 1. Итог по песочнице

**Коротко: в Bash-песочнице исполнителя Chromium запускается, но только как
`chrome-headless-shell` с флагом `--single-process` и с одним контекстом
браузера на процесс. localhost из песочницы недоступен вовсе. Для роли это
почти не важно: MCP-сервер браузера работает не в Bash-песочнице (см. §1.4), там
этих ограничений нет.**

### 1.1. Что пробовали и чем закончилось (проверено)

| Вариант запуска | Результат | Точная ошибка |
|---|---|---|
| headless shell (по умолчанию в Playwright 1.63) | падает | `FATAL:base/apple/mach_port_rendezvous_mac.cc:159] Check failed: kr == KERN_SUCCESS. bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.<pid>: Permission denied (1100)` |
| то же + `--no-sandbox --disable-gpu --disable-dev-shm-usage` | падает | та же: флаги на регистрацию mach-сервиса не влияют |
| **headless shell + `--single-process`** | **работает**, ~0,2 с на старт | в stderr шум без последствий: `Failed to read DnsConfig`, `CVDisplayLinkCreateWithCGDisplay failed`, `SCDynamicStoreCreate failed with Error: 1100` (повторяется раз в секунду) |
| новый headless (`channel: 'chromium'`, полный Chrome for Testing) | падает | `chrome_crashpad_handler: --database is required`, `ERROR:chrome/browser/process_singleton_posix.cc:1043] Failed to create socket directory.`, `Failed to create a ProcessSingleton for your profile directory` |
| то же + `TMPDIR`/`HOME` в `$TMPDIR`, `--disable-crash-reporter`, `--single-process` | падает | то же: каталог сокета берётся не из `TMPDIR` |
| headed (окно), с флагами и без | падает | то же, что новый headless: это тот же бинарник Chrome for Testing |

Причина в Seatbelt: родительский процесс Chromium регистрирует mach-сервис
(`bootstrap_check_in`), через который находят друг друга процессы рендера и GPU,
а профиль песочницы регистрацию запрещает. `--single-process` держит всё в одном
процессе, и регистрация не нужна. Полному Chrome вдобавок не дают создать сокет
ProcessSingleton. Headed-режима в Bash-песочнице нет: окна (Launch Services)
она не даёт открыть в принципе.

Настройкой песочницы это не лечится. В SDK есть `sandbox.network.allowMachLookup`
(в его справке Playwright назван прямо), но по тексту профиля Seatbelt в
бинарнике Claude Code (SDK 0.3.280) этот список превращается только в
`(allow mach-lookup (global-name …))`. Chromium же падает на
`bootstrap_check_in`, то есть на **регистрации** сервиса (`mach-register`), а
такого разрешения профиль не выдаёт ни при какой настройке. Поэтому для Bash
единственный путь — `--single-process`.

### 1.2. Что работает в `--single-process` (проверено одним прогоном)

- Эмуляция iPhone 13: `devicePixelRatio=3`, `390×664`, `maxTouchPoints=1`,
  `(pointer:coarse)`. Десктоп `1440×900` при DPR 2 — тоже (в отдельном браузере).
- Тап `page.tap()` → `pointerdown:touch, touchstart, pointerup:touch, touchend, click:touch`.
- Свайп через CDP `Input.dispatchTouchEvent` (10 точек по 16 мс, 336 мс) → цепочка
  `touchmove`. Долгое нажатие (800 мс) → `touchstart…touchend`.
  `Input.synthesizeScrollGesture` со скоростью 800 px/с → `scrollY=301`.
- Поворот без перезагрузки: `setViewportSize` + CDP
  `Emulation.setDeviceMetricsOverride({screenOrientation:{type:'landscapePrimary',angle:90}})` →
  та же загрузка страницы (`loadedAt` не изменился), событие `resize`,
  `screen.orientation.type = landscape-primary`, `844×390`.
- Офлайн после загрузки: `context.setOffline(true)` → событие `offline`,
  `navigator.onLine=false`, `fetch` падает.
- Консоль, исключения, упавшие запросы: события `console`, `pageerror`,
  `requestfailed`, `response` со статусом ≥ 400 ловятся.
- Скриншоты: вся страница (`fullPage`), элемент, прямоугольник `clip`.
  Кириллица отрисовывается.
- Раскадровка: 5 кадров с шагом 100 мс заняли 791 мс (сам снимок ≈ 60 мс).
  CDP `Page.startScreencast` дал 32 кадра за 0,7 с.
- Автоплей: `new AudioContext().state === 'suspended'` без жеста пользователя.
  Политика по умолчанию соблюдается, а Playwright сам добавляет `--mute-audio`.
- `file://` открывается.

Ограничения `--single-process`:

- **Второй `browser.newContext()` роняет браузер** (`Target page, context or
  browser has been closed`), даже если первый контекст закрыт. Две вкладки в
  одном контексте и `launchPersistentContext` с несколькими страницами
  работают. Отсюда правило: один браузер — один контекст. Смена устройства
  означает перезапуск браузера (0,2 с) или CDP-override в том же контексте.
- Playwright не может убить процесс браузера (`kill EPERM`): `kill` запрещён
  и песочницей, и классификатором. Браузер нужно закрывать штатно, через `browser.close()`.

### 1.3. Сеть из песочницы (проверено)

- **localhost и 127.0.0.1 закрыты.** `listen` на 127.0.0.1 даёт `EPERM`.
  Подключение к работающему серверу офиса `127.0.0.1:50954`: curl отвечает
  `exit 7`, браузер — `net::ERR_ACCESS_DENIED`. Unix-сокет в `$TMPDIR` тоже не
  открыть: `listen EPERM`.
- Внешние адреса браузер напрямую не видит (`net::ERR_NAME_NOT_RESOLVED`). Через
  прокси песочницы видит: `chromium.launch({ proxy: { server, username, password } })`
  с данными из `HTTPS_PROXY`, `https://example.com` → 200. Список разрешённых
  хостов при этом остаётся за песочницей.

### 1.4. Где на самом деле будет жить браузер QA

Песочница ОС в офисе — это опция `sandbox` у сессии SDK (`SANDBOX` в
`src/server/agents.ts:325`). Она оборачивает **команды Bash** (и всех их детей).
stdio-серверы MCP из каталога (`src/server/mcp.ts` → `externalMcp`, передаются в
`mcpServers` сессии, `agents.ts:3938`) запускает сам процесс Claude Code, а не
Bash, поэтому Seatbelt на них не распространяется.

**Подтверждено по коду движка** (доработка после ревью). В бинарнике Claude Code
из `@anthropic-ai/claude-agent-sdk-darwin-arm64` (SDK 0.3.280) обёртка
`wrapWithSandbox`/`wrapWithSandboxArgv` вызывается ровно в трёх местах:

1. инструмент Bash (рядом строки `Sandboxed bash on Windows requires Git Bash`,
   `claude_code.bash.subprocess`);
2. хуки проекта (`a project hook could not be wrapped for the sandbox`);
3. служебный вызов git с `env -u GIT_CONFIG_COUNT`.

Запуска stdio-транспорта MCP среди них нет. Справка SDK к сетевым настройкам
говорит то же самое: «Enforced for sandboxed commands only — in-process tools
such as WebFetch are not gated». Найдено поиском `grep -a -b -F wrapWithSandbox`
по бинарнику и чтением окрестностей каждого вхождения.

Косвенные признаки из проекта с этим сходятся:

- `figma-bridge` держит WebSocket на localhost, а из Bash-песочницы `listen`
  даёт EPERM (проверено выше);
- он же поднимается через `npx -y`, хотя npm в песочнице не может писать в
  `~/.npm/_cacache` (проверено: `EPERM ... /Users/.../.npm/_cacache/tmp/...`);
- исключение `excludedCommands` для Blender понадобилось ровно потому, что
  Blender запускается через Bash (`tools/blender/run.sh`), а мост `blender`
  через MCP исключения не требовал.

Значит, MCP-сервер браузера получит обычный многопроцессный Chromium (headless
shell или headed), доступ к localhost, сеть без прокси и любой контекст.
Ограничения из §1.1–1.3 касаются только ситуации, когда агент сам запускает
Playwright из Bash (скриптом, `npx playwright test`). Так QA работать не должен:
его инструмент — MCP.

> Уровень уверенности: код движка, а не замер живого процесса. Из сессии
> исполнителя дерево процессов не посмотреть (`ps` и `pgrep` в песочнице дают
> `operation not permitted` / `Cannot get process list`), а сессию роли с
> MCP-браузером отсюда не поднять. Поведение может поменяться с версией SDK.
> Поэтому до написания роли — отдельная микрозадача (§6, п. 1): стенд-сервер
> MCP из 30 строк в каталоге, живая сессия, `navigate` на `http://127.0.0.1:<порт>`
> и снимок. Если она провалится, работает запасной рецепт из §1.5 (Bash-вариант):
> `--single-process`, один контекст, прокси из окружения и `allowLocalBinding`
> только у роли QA.

### 1.5. Рабочий рецепт

**Для MCP-сервера (основной путь):**

```js
chromium.launch({
  headless: true,                 // headless shell; headed только по запросу человека
  executablePath: undefined,      // браузер из PLAYWRIGHT_BROWSERS_PATH
  args: [],                       // по умолчанию флаги не нужны
})
```

**Если Playwright всё же запускается из Bash исполнителя:**

```js
chromium.launch({
  headless: true,                          // только headless shell
  args: ['--single-process'],              // без него mach_port_rendezvous FATAL
  proxy: fromEnv(process.env.HTTPS_PROXY), // иначе внешние адреса не резолвятся
})
// один контекст на браузер; закрывать через browser.close()
```

`--no-sandbox` Playwright ставит сам. `--disable-gpu` и `--disable-dev-shm-usage`
на результат не влияют.

## 2. Где лежит браузер и как скачать его один раз

- Путь по умолчанию на macOS — `~/Library/Caches/ms-playwright`. Из песочницы
  туда не записать (`EPERM: operation not permitted, mkdir '/Users/…/Library/Caches/ms-playwright'`).
  На этой машине папки нет: браузер никто не скачивал.
- Путь задаётся переменной `PLAYWRIGHT_BROWSERS_PATH`. Скачанное: `chromium-1243`
  (Chrome for Testing 153, 359 МБ), `chromium_headless_shell-1243` (195 МБ),
  `ffmpeg-1011` (2,5 МБ, для видео). Для QA хватит одного
  `npx playwright install chromium-headless-shell` (около 200 МБ). Полный Chrome
  нужен, только если владелец захочет смотреть в окно.
- Загрузка: основной адрес `storage.googleapis.com/chrome-for-testing-public`
  упал по таймауту через прокси, Playwright сам перешёл на зеркало
  `cdn.playwright.dev` и скачал. В список разрешённых хостов установки нужны
  оба, плюс `registry.npmjs.org`.
- npm в песочнице тоже требует обхода: `npm_config_cache=$TMPDIR/npm-cache`.

- Windows: по документации Playwright кеш по умолчанию —
  `%LOCALAPPDATA%\ms-playwright`, а `PLAYWRIGHT_BROWSERS_PATH` работает так же.
  На Windows ничего не запускалось: машины нет. Если браузер ставит процесс
  офиса в свой каталог и передаёт путь переменной (ниже), путь по умолчанию на
  Windows не используется вовсе, и разница платформ сводится к имени каталога
  данных приложения.

**Предложение (не решение, нужно согласие владельца — §7): ставить браузер один
раз, процессом офиса, а не агентом.**

1. Офис держит общий каталог браузеров — `~/.office/browsers` (рядом с кешем
   пакетов маркета `~/.office/packages`). В приложении для macOS и Windows — в
   его данных, как движок Claude Code, который ставится при первом запуске
   (`docs/design/desktop-app/spec.md`).
2. Устанавливает его серверный процесс офиса (вне песочницы) при найме роли с
   сервером `browser`, либо кнопкой «Установить» у сервера в каталоге MCP.
   Сама установка — `PLAYWRIGHT_BROWSERS_PATH=~/.office/browsers npx playwright install chromium-headless-shell`
   или тот же вызов `registry.install()` из `playwright-core`.
3. Каталог передаётся серверу через `env` в `DEFAULT_MCP_SERVERS`:
   `PLAYWRIGHT_BROWSERS_PATH`. Это не секрет, ссылка `${…}` не нужна, но нужен
   абсолютный путь. Поэтому, как `OFFICE_WORKDIR`, его стоит подставлять в
   `toSdkConfig`, а не записывать в каталог настроек.
4. Версия браузера привязана к версии `playwright-core`. При обновлении
   зависимости установка повторяется: Playwright докачает только недостающую
   ревизию, старую можно удалить.

**Что поменять в песочнице офиса:** для основного пути (браузер в MCP-сервере)
ничего. Если всё же нужен Playwright из Bash, понадобятся `network.allowLocalBinding: true`
(чтобы видеть dev-сервер проекта) и запуск с `--single-process`. Расширять
песочницу всем ролям ради QA не стоит. Исключение уровня `excludedCommands`,
как у Blender, тоже не нужно: браузер не ходит через Bash.

Хватит ли `allowLocalBinding`, проверено по тексту профиля Seatbelt в бинарнике
движка (не замером: настройки песочницы этой сессии задаёт офис, а в `SANDBOX`
этого флага нет). С флагом профиль добавляет `(allow network-bind (local ip "*:*"))`,
`(allow network-inbound (local ip "*:*"))` и
`(allow network-outbound (remote ip "localhost:*"))`. То есть открывается и
`listen`, и подключение к любому порту localhost — dev-сервер проекта из Bash
станет виден. Добавлять его стоит через `sandboxFor(role)` только роли QA, так
же как сейчас `excludedCommands` у Blender, а не в общий `SANDBOX`.

## 3. Сравнение: `@playwright/mcp` и свой `tools/browser`

### 3.1. Реальный состав `@playwright/mcp` 0.0.83

Снято вызовом `tools/list` по stdio. «RO» означает `annotations.readOnlyHint = true`.

**Ядро (25, без `--caps`):**
`browser_navigate`, `browser_navigate_back`, `browser_tabs`, `browser_close`,
`browser_resize`, `browser_click`, `browser_hover`, `browser_drag`, `browser_type`,
`browser_press_key`, `browser_fill_form`, `browser_select_option`,
`browser_file_upload`, `browser_drop`, `browser_handle_dialog`,
`browser_emulate_media`, `browser_evaluate`, `browser_run_code_unsafe` — все rw;
`browser_snapshot`, `browser_take_screenshot`, `browser_console_messages`,
`browser_network_requests`, `browser_network_request`, `browser_find`,
`browser_wait_for` — RO.

**Через `--caps` (в справке названы только `vision, pdf, devtools`, в коде
есть ещё `storage, testing, network, config`):**
- `vision`: `browser_mouse_move_xy`, `browser_mouse_click_xy`,
  `browser_mouse_drag_xy`, `browser_mouse_down`, `browser_mouse_up`,
  `browser_mouse_wheel` — rw. Только мышь.
- `network`: `browser_network_state_set {state: online|offline}`,
  `browser_route`, `browser_unroute` — rw; `browser_route_list` — RO.
- `devtools`: `browser_start_video`, `browser_stop_video`, `browser_video_chapter`,
  `browser_video_show_actions`, `browser_video_hide_actions`,
  `browser_start_tracing`, `browser_stop_tracing`, `browser_highlight`,
  `browser_hide_highlight`, `browser_annotate`, `browser_start_recording`,
  `browser_stop_recording`, `browser_generate_locator` — RO; `browser_resume` — rw.
- `testing`: `browser_verify_element_visible`, `browser_verify_text_visible`,
  `browser_verify_list_visible`, `browser_verify_value` — RO.
- `storage`: `browser_cookie_*`, `browser_localstorage_*`,
  `browser_sessionstorage_*`, `browser_storage_state` (RO),
  `browser_set_storage_state` (rw).
- `pdf`: `browser_pdf_save` (RO). `config`: `browser_get_config` (RO).

Объём описаний: ядро — 25 инструментов и около 5,8 тыс. токенов,
`vision,network,devtools` — 48 и около 9,7 тыс., все `caps` — 72 и около 13 тыс.
При `alwaysLoad: true`, как у остальных серверов каталога, это постоянная
добавка к префиксу каждой сессии QA.

**Флаги, важные для QA:** `--device "iPhone 15"`, `--mobile`, `--viewport-size`,
`--headless` (по умолчанию headed!), `--isolated` (профиль в памяти), `--browser`
(`chrome|firefox|webkit|msedge`; по умолчанию системный Chrome — для своего
headless shell нужен `--executable-path` или `--config` с `browserName: chromium`),
`--caps`, `--config` (только через него передаются `launchOptions.args` и
`contextOptions` вроде `deviceScaleFactor`, `hasTouch`), `--console-level`,
`--allowed-origins` и `--blocked-origins` (в справке прямо сказано: «*does not*
serve as a security boundary»), `--allow-unrestricted-file-access` (без него
`file://` запрещён), `--output-dir`, `--image-responses`, `--proxy-server`,
`--init-script`, `--grant-permissions`, `--timeout-action`, `--timeout-navigation`,
`--idle-timeout`, `--no-sandbox`.

Отдельно: при первом вызове инструмента 0.0.83 поднимает браузерный сервер на
unix-сокете `$TMPDIR/pw-<hash>/browser/browser-*.sock`. В Bash-песочнице это
`listen EPERM`, и все 9 вызовов в проверке упали именно так. В MCP-контексте
(§1.4) это не мешает, но показывает, что архитектура пакета меняется от версии к
версии (0.0.x).

### 3.2. Таблица по возможностям QA

| # | Возможность | `@playwright/mcp` 0.0.83 | Свой `tools/browser` (проверено на Playwright 1.63) |
|---|---|---|---|
| 1 | Открыть localhost / статику / опубликованную страницу | `browser_navigate`. `file://` — только с `--allow-unrestricted-file-access` (или внутри корней workspace). Ограничение адресов (`--allowed-origins`) по словам самих авторов не граница безопасности и не действует на редиректы | `navigate {url}` с политикой адресов внутри сервера: localhost/127.0.0.1/`file://` внутри `OFFICE_WORKDIR`; внешние — только из списка проекта. Проверка и в `page.route`, то есть на редиректах и подзапросах |
| 2 | Телефон портрет/альбом, планшет, десктоп DPR 2–3 | Одно устройство на процесс: `--device`, `--mobile` или `contextOptions` в `--config`. Сменить устройство в ходе нельзя, только через `browser_run_code_unsafe` | `set_device {preset \| width,height,dpr,mobile,touch}`: новый контекст (или перезапуск браузера в `--single-process`) по таблице `devices` Playwright. Проверено: iPhone 13 DPR 3, десктоп DPR 2 |
| 3 | Поворот / смена размера без перезагрузки | `browser_resize {width,height}` меняет только вьюпорт: `screen.orientation`, `deviceScaleFactor` и `isMobile` не трогает | `rotate {orientation}` и `resize {w,h}` через `setViewportSize` + CDP `Emulation.setDeviceMetricsOverride` со `screenOrientation`. Проверено: та же загрузка, `resize`, `landscape-primary` |
| 4 | Отключить сеть после загрузки | **Есть**: `browser_network_state_set {offline\|online}` (`--caps network`) | `set_offline {offline}` через `context.setOffline`. Проверено: событие `offline`, `onLine=false`, `fetch` падает |
| 5 | Touch: тап, свайп по траектории со скоростью, drag, долгое нажатие | **Нет.** Только мышь: `browser_click` даже на эмуляции телефона даёт `pointerType: mouse` (проверено на Pixel 7), `browser_mouse_*_xy` и `browser_drag` — тоже мышь. Touch только через `browser_run_code_unsafe` (`page.touchscreen.tap` и CDP вручную) | `tap {x,y \| selector}`, `swipe {points[], durationMs}` (интерполяция траектории и шаг по времени через CDP `Input.dispatchTouchEvent`), `long_press {x,y,ms}`, `touch_drag`, при желании `pinch` (несколько `touchPoints`), `scroll_gesture {speed}` (`Input.synthesizeScrollGesture`). Проверено: тап, свайп 10 точек за 336 мс, долгое нажатие 800 мс, жест прокрутки |
| 6 | Ошибки консоли, упавшие запросы, исключения | **Есть**: `browser_console_messages {level}`, `browser_network_requests {filter}`, `browser_network_request {index}` (RO) | `get_console {level, since}`, `get_network_errors` (`requestfailed` и ответы ≥ 400), `get_exceptions` (`pageerror`), с буфером с момента загрузки. Проверено |
| 7 | Скриншот страницы и области | `browser_take_screenshot {fullPage, element/target, scale}` (RO). Произвольного прямоугольника нет | `get_screenshot {fullPage \| selector \| clip{x,y,w,h}}`, файл в рабочую копию. Проверено все три вида |
| 8 | Раскадровка с интервалом | **Нет.** Есть видео (`browser_start_video {fps}`), но модель видео не смотрит, а кадры придётся резать ffmpeg. Серия снимков — только `browser_run_code_unsafe` | `get_frames {count, intervalMs, clip?}`: серия PNG и, по желанию, склейка в одну сетку-контактный лист (одна картинка вместо N). Проверено: 5 кадров по 100 мс за 791 мс, screencast ≈ 45 кадров/с |
| 9 | JS на странице для чтения состояния | `browser_evaluate` (rw, destructive по аннотации) | `evaluate {expression}`: произвольный код, честно пишущий (§4). Дополнительно `get_state {path}` — чтение готовых значений (`window.__state`, `localStorage`, размер, ориентация, `AudioContext.state`) без произвольного кода |
| — | Политика автоплея звука | Только флагом запуска через `--config` (`launchOptions.args: ['--autoplay-policy=…']`), на весь процесс | Политика по умолчанию (как у живого браузера) и параметр `autoplay` при `set_device`/запуске. `get_state` отдаёт `AudioContext.state`. Проверено: без жеста `suspended` |

Чего у своего сервера не будет без дополнительной работы: снимка доступности,
как `browser_snapshot`. Он закрывается одним инструментом
`get_snapshot` поверх `locator.ariaSnapshot()` из Playwright. Заполнение форм и
выбор опций — через `tap`/`type` или `evaluate`. Видео, трассы и куки для QA из
задачи не нужны.

### 3.3. Вариант «готовый + свои недостающие инструменты»

Недостающие у готового сервера — touch (5), раскадровка (8), поворот с
ориентацией и смена устройства (2, 3). Закрыть их можно двумя путями, и оба плохие:

- **Через `browser_run_code_unsafe` в брифе роли.** Это произвольный код в
  процессе сервера (авторы так его и назвали). Классификатор офиса не отличит
  «свайп» от «прочитать файл с диска», а ключ «разрешать всегда» будет один на
  всё. Главная возможность QA, жесты, окажется самой непрозрачной.
- **Второй, свой сервер с жестами рядом с `@playwright/mcp`.** Два процесса — два
  браузера. Чтобы жест попал в ту же страницу, свой сервер должен цепляться к
  браузеру готового через CDP (порт отладки открывается только аргументом
  `--remote-debugging-port` в `launchOptions.args` через `--config`, то есть
  ещё одним слушающим портом), или наоборот готовый к нашему через `--cdp-endpoint`.
  Тогда мы всё равно запускаем и держим браузер сами, а от готового берём только
  обёртку над `navigate`/`screenshot`/консолью, то есть самую простую часть.
  Плюс около 6–10 тыс. токенов описаний и два набора имён в брифе.

Комбинация не окупается.

## 4. Рекомендация

**Свой тонкий сервер `tools/browser/server.mjs` поверх `playwright-core`**, по
образцу `tools/imagegen`: обычный node без сборки,
`@modelcontextprotocol/sdk` уже в зависимостях, рабочая копия приходит через
`OFFICE_WORKDIR`, браузер — через `PLAYWRIGHT_BROWSERS_PATH`.

Почему:

1. **Три из девяти возможностей у готового нет совсем** — touch, раскадровка,
   поворот и смена устройства в ходе работы. Для QA мобильного веба это главное.
   Заполнять дыру через `run_code_unsafe` значит отдать агенту произвольный код в
   процессе сервера и потерять разбор рисков.
2. **Разбор рисков ложится естественно.** Читающие инструменты называем `get_*`,
   и `permissions.ts` пропускает их без вопросов, ничего не меняя (§5).
   У готового все инструменты называются `browser_*` и все становятся `write`,
   включая скриншот и чтение консоли (§5).
3. **Граница адресов у нас, а не в справке чужого пакета.** У готового
   `--allowed-origins` по словам авторов не граница безопасности и не работает на
   редиректах. Свою проверку делаем в `page.route` по каждому запросу и в
   классификаторе по аргументу `url`.
4. **Префикс дешевле.** Набор около 15 инструментов — порядка 2–3 тыс. токенов
   против 6–13 тыс. у готового.
5. **Стабильность.** `@playwright/mcp` — 0.0.x, и даже архитектура запуска
   (сокет-сервер браузера) меняется между версиями. `playwright-core` — стабильный
   API, на котором проверено всё из таблицы.

Цена: новая зависимость `playwright-core` (без браузеров, около 8 МБ) и
порядка 500–700 строк сервера. Обе оценки — объём кода и токены префикса —
прикидка по проверочным скриптам и по числу инструментов, а не замер готового
сервера. На выбор они не влияют: решают пункты 1–3. Установку браузера (§2) делаем в любом случае.

Набросок набора (имена уже под классификатор):

| Инструмент | Риск по `permissions.ts` |
|---|---|
| `get_screenshot`, `get_frames`, `get_console`, `get_network_errors`, `get_exceptions`, `get_state`, `get_snapshot`, `get_device` | `safe` (префикс `get_`) |
| `navigate`, `set_device`, `rotate`, `resize`, `set_offline`, `tap`, `swipe`, `long_press`, `touch_drag`, `type`, `evaluate`, `close` | `write` |

Файлы скриншотов и кадров `get_*` пишут в рабочую копию (`OFFICE_WORKDIR`,
подпапка вроде `qa/shots/`). Формально это запись, но по сути результат чтения,
и он остаётся в ветке задачи, как у `imagegen`. Внутри сервера нужен периметр
записи, как в `tools/imagegen/save.mjs`.

## 5. permissions.ts: как будут классифицироваться инструменты

Как сейчас (`classify`, `src/server/permissions.ts:112`):

- имя `mcp__<сервер>__<инструмент>`; серверы `office` и `team` — `safe`;
- инструмент чужого сервера, подходящий под `^(get|list|read|search|find|fetch|describe|inspect)_`, — `safe`;
- подходящий под `^(delete|remove|clear|drop|purge|reset|ungroup|detach|revert)_` — `danger`;
- всё остальное — `write`, ключ «разрешать всегда» равен полному имени инструмента;
- аннотации MCP (`readOnlyHint`) классификатор не видит: в `canUseTool` приходит
  только имя и аргументы.

**Готовый `@playwright/mcp`:** у всех инструментов префикс `browser_`, поэтому
ни один не попадает под `READ_MCP_TOOL`. Все 72 станут `write`, включая
`browser_take_screenshot`, `browser_console_messages` и `browser_snapshot`. В
режиме «спрашивать про запись» каждый взгляд на страницу уйдёт владельцу. Хуже
того, `browser_cookie_delete`, `browser_localstorage_clear` и
`browser_run_code_unsafe` тоже окажутся `write`, а не `danger`, потому что
`DESTRUCTIVE_MCP_TOOL` смотрит на начало имени. Использовать готовый сервер без
правки классификатора нельзя: понадобился бы список по серверу (`browser_` +
известные RO-имена) — то самое знание о чужом пакете, которое ломается с его
версией.

**Свой `tools/browser`:** `get_*` проходят как `safe` без единой правки
`permissions.ts`. Остальное — `write`, и в режиме `ask-risky` проходит без
вопросов.

**Политика адресов для `navigate`** — то, что потребует правки классификатора
при реализации роли:

1. В `classify` для сервера браузера смотреть `input.url`:
   - `http(s)://localhost`, `127.0.0.1`, `[::1]` на любом порту, `file://`
     внутри `projectDir` (через существующий `insideProject`) — `write` (в
     `ask-risky` и `auto` без вопроса). Можно и `safe`, если владелец согласен,
     что открыть локальную страницу — это чтение;
   - адрес из списка «опубликованная страница проекта» — `write`;
   - любой другой внешний адрес, `file://` вне проекта, `chrome://`,
     `javascript:` — `danger`, с ключом «разрешать всегда» вида
     `mcp__browser__navigate:external`, по аналогии с `Write:outside`.
2. Источник «опубликованной страницы» в настройках сейчас отсутствует. Есть
   только `url` в результате выпуска (`OFFICE_RESULT`, `src/shared/release.ts`),
   и он разовый. Понадобится поле настроек, например
   `Settings.publishedUrls: string[]` (или поле у цели выпуска), — это правка
   контракта `src/shared/types.ts`, отдельной задачей и только после решения
   владельца (§7). Пока поля нет, безопасное умолчание — внешние адреса
   всегда `danger`, то есть каждый раз вопрос владельцу.
3. Тот же список нужно передать серверу (`env` в `toSdkConfig`,
   например `BROWSER_ALLOWED_ORIGINS`), чтобы он резал запросы в `page.route`.
   Классификатор видит только адрес первой навигации, а не редиректы, ссылки и
   `location.href = …` из `evaluate`. Настоящая граница — в сервере, классификатор
   лишь показывает владельцу намерение.

   Порядок важен: сначала граница в сервере (`page.route` по каждому запросу,
   включая редиректы, подзапросы, `fetch` из страницы и переходы по ссылкам;
   чужой адрес — `route.abort('blockedbyclient')` и запись в `get_network_errors`),
   и только потом ветка по `input.url` в `classify`. Наоборот нельзя: правка
   одного классификатора создаёт видимость защиты, которой нет. Ветка в
   `classify` привязывается к имени сервера (`mcp__browser__navigate`), а не к
   префиксу инструмента: чужой сервер с инструментом `navigate` не должен
   получать ту же льготу на localhost.
4. `evaluate` оставить `write`: произвольный JS может и читать, и менять
   страницу (а через `fetch` — ходить в сеть, что ловит пункт 3). Называть его
   `get_*` нельзя: это обманет классификатор. Для частых чтений и нужен отдельный
   `get_state` с фиксированным набором значений.

## 6. Что проверить первым делом при реализации

1. **Отдельной микрозадачей до роли** — живой замер §1.4. Минимальный
   stdio-сервер с двумя инструментами (`navigate`, `get_screenshot`) на
   `playwright-core` во временной папке, подключённый к одной сессии через
   каталог MCP. Критерии: многопроцессный headless shell без `--single-process`
   стартует; `http://127.0.0.1:<порт офиса>/` открывается; два контекста подряд
   не роняют браузер. Если что-то из этого не так — роль строится на рецепте для
   Bash из §1.5, и §4 надо пересмотреть только в части запуска, не в выборе
   сервера.
2. Установка браузера процессом офиса в выбранный каталог (§7) и запуск сервера
   с `PLAYWRIGHT_BROWSERS_PATH`. Из сессии исполнителя это не проверить:
   `~/.office` вне разрешённых для записи путей, а ставит браузер серверный
   процесс офиса. Проверить на Windows (если путь не передан —
   `%LOCALAPPDATA%\ms-playwright`).
3. Если когда-нибудь понадобится Playwright из Bash (`npx playwright test` в
   проекте пользователя): `--single-process`, прокси из окружения, один контекст
   и `allowLocalBinding` у роли QA (§2). По профилю Seatbelt этого достаточно;
   живым замером подтвердить в той же микрозадаче.

## 7. Что решает владелец

Это предложения исследования, а не принятые решения. Без ответа на них
реализацию роли не начинать (журнал офиса: задачи QA на реализацию — только
после «поехали»).

| Вопрос | Предложение | Если не решено |
|---|---|---|
| Где хранить браузер | `~/.office/browsers`, в приложении — каталог данных приложения; ставит процесс офиса при найме роли с сервером `browser` | агент качает браузер сам в каждой сессии — около 200 МБ и разрешённые хосты загрузки в песочнице |
| Откуда брать «опубликованную страницу проекта» | поле настроек `Settings.publishedUrls: string[]` (правка `src/shared/types.ts`) или поле у цели выпуска | любой внешний адрес — `danger`, вопрос владельцу на каждую навигацию |
| Новая зависимость `playwright-core` | да, около 8 МБ без браузеров | свой сервер не написать; остаётся `@playwright/mcp` через `npx` с правкой классификатора по списку его имён |
| Открывать localhost как `safe` или `write` | `write` (без вопроса в `ask-risky` и `auto`) | — |
