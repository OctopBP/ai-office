# T-328 · Заменить Figma MCP на figma-context-mcp?

Дата ресёрча: 2026-10-04. Код не менялся — только этот документ.

**Короткий ответ: не менять. figma-context-mcp (Framelink) только ЧИТАЕТ
Figma — он не создаст ни одного фрейма, тем более автолейаут или компонент.
Боль «плоских макетов» он не решает в принципе. Решение — дополнить:
сразу ужесточить бриф и скилы дизайнера (автолейаут наш мост уже умеет), а
для компонентов, вариантов и переменных подключить второй сервер с записью —
официальный Figma MCP (`use_figma`) или, если нет Full-места, плагинный
figma-console-mcp.**

---

## 1. Что у нас сейчас

### Как подключено

| Где | Что |
|---|---|
| `src/server/mcp.ts:84` | `DEFAULT_MCP_SERVERS` → `figma-bridge`: `npx -y @gethopp/figma-mcp-bridge`, stdio, `alwaysLoad: true` |
| `src/server/mcp.ts:75` | Устройство: MCP-сервер держит WebSocket на localhost, плагин «Figma MCP Bridge» в открытом файле отдаёт документ. Без токенов и без лимитов Figma API, но только пока плагин открыт; несколько сессий делят порт через выбор лидера |
| `packages/@office/design/agent.json` | `runtime.mcp: ["figma-bridge"]` + описание сервера в `servers` |
| `packages/@office/frontend/agent.json` | тот же мост фронтенду — на чтение макетов |
| `packages/@office/design/skills/figma-screen/SKILL.md` | порядок работы, **требование автолейаута** (`create_frame` → `set_auto_layout`, `parentId` при создании, `SPACE_BETWEEN`, hug через `AUTO`) |
| `packages/@office/design/skills/figma-tokens/SKILL.md` | брать значения из `get_variable_defs`/`get_styles`; прямо сказано: мост ставит **значения, а не привязки** к переменным |
| `packages/@office/design/brief/ru.md` | бриф: «обычный способ сдать экран — канвас дизайна (скил `design`), связный файл в Figma правится мостом» |
| `src/server/i18n/prompts-ru.ts:666` | `mcp.figma-bridge.brief` — строка в системный промпт: «создавать фреймы, тексты и фигуры, менять свойства и авто-лэйаут» |

### Инструменты моста

Проверено по исходникам пакета `@gethopp/figma-mcp-bridge@0.0.22` (лежит в
кеше npx на машине; `npx -y` без версии может подтянуть свежее), MIT,
`dist/tools.js` и `dist/schema.js`:

- **Чтение:** `list_files`, `get_document`, `get_selection`, `get_node`,
  `get_layout_tree`, `get_metadata`, `get_design_context`, `get_styles`,
  `get_variable_defs`, `get_screenshot`, `save_screenshots`, `get_motion_styles`,
  `get_node_motion`.
- **Создание:** `create_page`, `create_frame`, `create_text`, `create_shape`
  (rect/ellipse/line), `create_image`, `import_html_layers` (DOM-снимок
  html-figma одним вызовом).
- **Правка:** `set_auto_layout`, `set_node_properties`, `set_text_content`,
  `set_text_properties`, `set_solid_fill`, `set_gradient_fill`, `set_effects`,
  `set_stroke_properties`, `set_node_visibility`, `duplicate_nodes`,
  `reparent_nodes`, `group_nodes`, `ungroup_node`, `delete_nodes`,
  `set_selection`, `scroll_and_zoom_into_view`, анимации (Motion API beta).

### Что умеет и чего нет

| Возможность | Мост | Подробность |
|---|---|---|
| Auto Layout на фрейме | **да** | `set_auto_layout`: `layoutMode` H/V/NONE, `itemSpacing`, `counterAxisSpacing`, 4 паддинга, выравнивания, `primary/counterAxisSizingMode` FIXED/AUTO, `layoutWrap` |
| «Fill container» у ребёнка | **нет** | нет `layoutSizingHorizontal/Vertical`, `layoutGrow`, `layoutAlign`, `layoutPositioning` (ABSOLUTE внутри AL), min/max — ни в `set_auto_layout`, ни в `set_node_properties`. Растянуть строку на ширину колонки нельзя, только фиксированной шириной |
| Компоненты (создать) | **нет** | нет `createComponent`, `combineAsVariants` |
| Инстансы | **нет** | создать инстанс нельзя; можно лишь читать детей инстанса по id `I…;…` и `duplicate_nodes` |
| Варианты, свойства компонента | **нет** | |
| Переменные | **только чтение** | `get_variable_defs`; создать переменную или привязать её к свойству нельзя (`figma-tokens` это прямо признаёт) |
| Стили | **только чтение** | `get_styles`; применить стиль по id нельзя |
| Произвольный код Plugin API | **нет** | набор инструментов фиксирован |

### Известные беды (журнал и docs)

- **Мост недоступен в сессии.** `docs/design/T-312/spec.md` §0 и
  `docs/design/T-126/cards.md` §6: `list_files` вернул `[]` — плагин не открыт;
  `docs/design/T-127/report.md`: инструменты не зарегистрированы вовсе (тогда
  ещё не было каталога). Любой плагинный мост этим страдает: работает, только
  пока человек держит Figma Desktop с запущенным плагином.
- **Расход.** Журнал: «мост Figma упирался в предохранитель (~2 млн входных
  токенов за запуск)» (T-312). Предохранитель — `src/server/runguard.ts`.
  Причина — сырой JSON `get_document`/`get_node` (весь узел со всеми полями) и
  base64-скриншоты; каждый ответ потом едет в контексте до конца сессии.
- Мелочи из практики: `get_layout_tree` в старой версии отвечал «Unknown
  request type»; `save_screenshots` пишет только в cwd и падает на
  существующем файле; z-order — только через `reparent_nodes`.

### Откуда «плоские» макеты

Техническая причина наполовину в мосте (нет FILL у детей, нет компонентов), а
наполовину — в том, что правило автолейаута живёт только в скиле
`figma-screen`, который дизайнер может и не загрузить, и нигде не
проверяется. Плюс `import_html_layers` (html-figma) по природе даёт абсолютные
координаты — если дизайнер переносит экран через него, автолейаута не будет
вообще.

---

## 2. figma-context-mcp (Framelink)

Репозиторий `github.com/GLips/Figma-Context-MCP`, пакет `figma-developer-mcp`
0.13.2, последний коммит 2026-06-24, ~15.9k звёзд, MIT (© 2025 Graham Lipsman).

**Проверено по исходникам:** инструментов два —
`get_figma_data` (`src/mcp/tools/get-figma-data-tool.ts:110`) и
`download_figma_images` (`src/mcp/tools/download-figma-images-tool.ts:250`).
Весь доступ к Figma — `src/services/figma.ts`, базовый адрес
`https://api.figma.com/v1`, единственный метод `request()` → `fetchJSON` с
одними заголовками авторизации, то есть только GET. Эндпоинты:
`/files/:key`, `/files/:key/nodes`, `/files/:key/images`, `/images/:key`.
REST API Figma вообще не умеет менять узлы документа — писать на холст можно
только из плагина. **Значит, Framelink не может создать ни фрейм, ни
автолейаут, ни компонент — это чтение макета для генерации кода.**

Прочее:
- Доступ: персональный токен Figma (`FIGMA_API_KEY`) или OAuth-токен; плагин и
  открытая Figma не нужны. Подпадает под лимиты REST API Figma (в коде есть
  отдельное сообщение для 429).
- Расход токенов — его сильная сторона: ответ упрощается (раскладка, стили,
  дедупликация одинаковых стилей в общие ссылки, шаблоны повторяющихся узлов),
  формат YAML или JSON, параметр `depth`. В разы компактнее сырого `get_node`.
- Телеметрия PostHog включена по умолчанию; выключается
  `FRAMELINK_TELEMETRY=off` или `DO_NOT_TRACK=1`.

Кому он полезен у нас: **фронтенду** — читать макет без открытой Figma и
дешевле, чем сырой `get_node`. Дизайнеру — нет.

---

## 3. Альтернативы, которые пишут

- **Официальный Figma MCP** (`https://mcp.figma.com/mcp`, удалённый; есть и
  десктопный сервер в приложении Figma). Инструмент `use_figma` исполняет код
  Plugin API на холсте: фреймы, автолейаут, компоненты, варианты, переменные,
  «с учётом вашей дизайн-системы». Рядом — чтение (`get_design_context`,
  `get_metadata` разреженным XML, `get_variable_defs`, `search_design_system`,
  `get_screenshot`) и `generate_figma_design`. Ограничения: ответ `use_figma`
  ≤ 20 КБ, нет картинок (заглушки), шрифты — только загруженные в аккаунт.
  Запись — **только с Full-местом**; Dev-место — только чтение. Запись
  бесплатна на время беты, потом станет платной по использованию. Лимиты на
  чтение: Professional — 200 вызовов в день / 10 в минуту, Organization —
  200/15, Enterprise — 600/20, Starter — 20 в месяц; записывающие инструменты
  от лимитов освобождены. Вход — OAuth, клиенты из каталога Figma (Claude Code
  в списке). Официальный набор скилов — `github.com/figma/mcp-server-guide`
  (`skills/figma-use`).
- **figma-console-mcp** (`github.com/southleft/figma-console-mcp`, MIT,
  ~2.4k звёзд, v1.40.x). Плагин Desktop Bridge + локальный сервер через npx,
  121 инструмент: `figma_execute` (произвольный Plugin API — значит, и
  автолейаут с FILL), `figma_create_component_set` (варианты из матрицы осей),
  `figma_instantiate_component`, `figma_add_component_property`,
  `figma_create_variable_collection`/`figma_create_variable`/
  `figma_batch_create_variables`, `figma_setup_design_tokens`. Для части
  функций — персональный токен Figma. Удалённый режим SSE — только чтение.
- **cursor-talk-to-figma-mcp** (`github.com/grab/cursor-talk-to-figma-mcp`, MIT,
  ~7k звёзд). Плагин + WebSocket, как наш мост. Есть `set_layout_mode`,
  `set_padding`, `set_axis_align`, `set_item_spacing`, **`set_layout_sizing`**
  (FILL/HUG у детей), `get_local_components`, **`create_component_instance`**,
  `set_instance_overrides`. Создать компонент, варианты или переменную нельзя.

### Таблица сравнения

| | Наш мост (`figma-bridge`) | figma-context-mcp | Официальный Figma MCP | figma-console-mcp | cursor-talk-to-figma |
|---|---|---|---|---|---|
| Чтение | да | да (компактно) | да | да | да |
| Запись на холст | да | **нет** | да (`use_figma`) | да | да |
| Auto Layout | на фрейме — да; FILL у детей — нет | нет | да, полностью | да (`figma_execute`) | да, с FILL/HUG |
| Создать компонент | нет | нет | да | да | нет |
| Инстансы | нет | нет (читает) | да | да | да |
| Варианты | нет | нет (читает свойства) | да | да (`create_component_set`) | нет |
| Переменные | чтение | чтение (через стили) | создание и привязка | создание и привязка | нет |
| Доступ | плагин в открытой Figma Desktop | токен Figma API | OAuth; запись — Full-место | плагин + токен Figma | плагин в открытой Figma |
| Лимиты | нет | REST API Figma | чтение 200/день (Pro), запись без лимита | нет на плагинном пути | нет |
| Лицензия | MIT | MIT | проприетарный сервис | MIT | MIT |
| Стоимость | бесплатно | бесплатно | Full-место; запись станет платной | бесплатно | бесплатно |
| Токены на ответ | высокие (сырой JSON, base64) | низкие (упрощённый YAML) | средние (XML-обзор, ответ записи ≤ 20 КБ) | средние–высокие | высокие (сырой JSON) |

---

## 4. Можно ли полечить брифом, не меняя MCP

Частично — да, и это надо сделать первым, потому что бесплатно.

Мост умеет автолейаут на фреймах, значит «плоские фреймы с абсолютным
позиционированием» — в большой степени вопрос дисциплины. Что поправить:

1. Поднять правило из скила в бриф (`packages/@office/design/brief/ru.md` и
   `en.md`) и в строку `mcp.figma-bridge.brief` (`src/server/i18n/prompts-ru.ts`,
   `prompts-en.ts`), чтобы оно было в промпте всегда, а не только при
   загрузке скила: «каждый фрейм с больше чем одним ребёнком — с
   автолейаутом; `x`/`y` только у корневого фрейма на странице и оверлеев».
2. Самопроверка перед сдачей в `figma-screen`: обойти дерево корня
   (`get_design_context` или `get_node` с ограниченной глубиной) и убедиться,
   что у всех контейнеров `layoutMode ≠ NONE`; в отчёт — число фреймов без
   автолейаута с обоснованием.
3. Запретить `import_html_layers` для итоговых экранов (он даёт абсолютные
   координаты) — только как черновик-референс.
4. Повторяющиеся элементы: собрать один эталон, размножить `duplicate_nodes`,
   назвать слои по схеме `Компонент / Вариант` — чтобы человек одной командой
   «Create multiple components» превратил их в компоненты. В отчёте — список
   таких эталонов.
5. Против расхода токенов: не звать `get_document` целиком; читать
   `get_design_context`/`get_metadata`, а `get_node` — только по конкретному id;
   скриншоты сохранять `save_screenshots` в файл, а не base64 в ответ.
6. Добавить в `packages/@office/design/bench/cases.json` случай «собрать
   карточку» с проверкой, что в результате нет контейнеров без автолейаута.

Чего брифом не добиться: FILL у детей, компоненты, инстансы, варианты,
привязка переменных — инструментов для этого в мосте нет.

---

## 5. Рекомендация: дополнять

**figma-context-mcp вместо моста — нет:** он только читает, и дизайнер
потеряет запись вообще.

1. **Сейчас (без смены MCP):** пункты §4 — бриф, скил, строка в промпт,
   стенд. Закроет основную массу «плоских» макетов.
2. **Следом:** второй сервер с записью для дизайнера, мост оставить как
   резерв. Выбор зависит от тарифа владельца:
   - есть Full-место Figma → **официальный Figma MCP** (`use_figma`):
     полноценные компоненты, варианты, переменные; минус — OAuth, будущая плата
     за запись, нет картинок в записи;
   - нет Full-места или нужна работа без облака → **figma-console-mcp**:
     то же через плагин, MIT, бесплатно; минус — `figma_execute` исполняет
     произвольный код в файле, его надо гонять через вопрос владельцу, и снова
     нужна открытая Figma Desktop с плагином.
3. **По желанию фронтенду:** Framelink как дешёвое чтение без открытой Figma
   (нужен `FIGMA_API_KEY`). Не обязательно — у официального MCP чтение тоже
   компактное.

### План внедрения (на отдельную задачу)

**Шаг 1 — бриф и скилы** (пакет дизайнера, i18n): пункты 1–6 из §4.

**Шаг 2 — сервер с записью в `src/server/mcp.ts`:**

- Официальный, десктопный путь (без OAuth, работает при открытой Figma Desktop
  с включённым MCP-сервером в настройках) — запись в каталог:
  ```ts
  server({
    id: 'figma',
    title: 'Figma (официальный)',
    transport: 'http',
    url: 'http://127.0.0.1:3845/mcp',
    alwaysLoad: true,
  }),
  ```
  Перед этим проверить вживую, что десктопный сервер отдаёт `use_figma`
  (документация называет основным удалённый сервер).
- Официальный, удалённый путь (`https://mcp.figma.com/mcp`) — нужен OAuth.
  Сейчас каталог умеет только заголовки со ссылкой `${NAME}`
  (`resolveEnv`, `toSdkConfig`), а сессии идут с `settingSources: []`, так что
  токены OAuth из настроек Claude Code пользователя туда не попадут. Значит,
  либо поддержка OAuth для MCP в офисе (отдельная задача, по образцу ключей в
  `src/server/engines/keys.ts`), либо десктопный путь.
- figma-console-mcp:
  ```ts
  server({
    id: 'figma-console',
    title: 'Figma Console',
    command: 'npx',
    args: ['-y', 'figma-console-mcp@<зафиксированная версия>'],
    env: { FIGMA_ACCESS_TOKEN: '${FIGMA_ACCESS_TOKEN}' },
    alwaysLoad: true,
  }),
  ```
  Версию фиксировать: 121 инструмент с `alwaysLoad` — заметный префикс
  промпта; стоит проверить, не лучше ли `alwaysLoad: false` с поиском
  инструментов (у дизайнера его сейчас нет — см. комментарий у `figma-bridge`).
- `src/server/permissions.ts`: `use_figma` и `figma_execute` — пишущие,
  с произвольным кодом → «рискованные» (вопрос владельцу в режиме
  `ask-risky`), читающие — без вопроса.
- `src/server/i18n/prompts-ru.ts` / `prompts-en.ts`: ключи
  `mcp.<id>.brief` (дизайнеру — «компоненты и автолейаут делай через …») и
  `mcp.<id>.brief.frontend` (только чтение).

**Шаг 3 — пакет дизайнера:**

- `packages/@office/design/agent.json`: `runtime.mcp: ["figma-bridge", "<id>"]`
  и запись сервера в `servers`; поднять `version` в
  `.claude-plugin/plugin.json`.
- Новый скил `skills/figma-components/SKILL.md`: найти компонент в файле или
  библиотеке → поставить инстанс → новый компонент только если нет
  подходящего → варианты через `combineAsVariants` → привязка цветов и
  отступов к переменным. Для официального сервера — взять за основу
  `skills/figma-use` из `figma/mcp-server-guide` (проверить его лицензию
  перед копированием).
- `figma-tokens`: снять оговорку «привязать нельзя» для нового сервера.
- `bench/cases.json`: случай «карточка из компонента с вариантом» с проверкой
  `type: INSTANCE` и привязанных переменных.

**Шаг 4 — уже нанятые офисы:** `mcpCatalog` сам дольёт новый сервер в
каталог по id, но подписка роли (`role.mcp`) у уже нанятого дизайнера
старая — нужна миграция по образцу T-284/T-285 или обновление пакета через
маркет.

---

## Источники

- Наш мост: `@gethopp/figma-mcp-bridge@0.0.22`, `dist/tools.js`, `dist/schema.js`;
  `github.com/gethopp/figma-mcp-bridge`.
- Framelink: `github.com/GLips/Figma-Context-MCP` (клон 2026-10-04, коммит от
  2026-06-24), `src/services/figma.ts`, `src/mcp/tools/*`.
- Официальный Figma MCP: developers.figma.com/docs/figma-mcp-server/ —
  write-to-canvas, tools-and-prompts, remote-server-installation,
  rate-limits-access; help.figma.com «Figma MCP server FAQs».
- figma-console-mcp: `github.com/southleft/figma-console-mcp` (README).
- cursor-talk-to-figma: `github.com/grab/cursor-talk-to-figma-mcp` (README).

Сведения о сторонних сервисах (лимиты, тарифы, число звёзд) сняты 2026-10-04
со страниц проектов и документации; исходники проверены только у нашего моста
и у Framelink.
