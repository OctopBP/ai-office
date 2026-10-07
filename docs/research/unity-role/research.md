# Исследование: Unity CLI, batchmode, тесты, мерж

Задача T-412. Основа для пакета роли «Unity-разработчик» в маркете агентов
(`packages/@office/unity/` по образцу `packages/@office/qa/`: `agent.json`,
`brief/ru.md`, `brief/en.md`, `skills/`).

Дата сбора: 2026-10-07. Unity CLI помечен у Unity как **экспериментальный** —
команды и флаги могут поменяться; авторитетный список на конкретной машине
даёт `unity --help` и `unity commands --format json`.

Обозначения уверенности:
- **[док]** — прямо из официальной документации, ссылка рядом;
- **[практика]** — общепринятое в сообществе (GameCI, разборы CI), в официальной доке
  не закреплено или закреплено косвенно — перед использованием в гейте проверить вживую.

---

## 1. Unity CLI (`unity`)

Источники: [Введение](https://docs.unity.com/en-us/unity-cli/unity-cli),
[Использование](https://docs.unity.com/en-us/unity-cli/use-unity-cli),
[Справочник команд](https://docs.unity.com/en-us/unity-cli/unity-cli-reference),
[Пакет Unity Pipeline](https://docs.unity.com/en-us/unity-cli/unity-pipeline/unity-pipeline-package),
[Замена MCP-сервера на Unity CLI](https://docs.unity.com/en-us/unity-cli/replace-mcp-server-unity-cli).

### 1.1 Что это

Отдельный бинарник `unity` для установки и управления редакторами, модулями,
проектами, сборкой и тестами из терминала **[док]**. Распространяется вместе с
Unity Hub (Hub ставит его автоматически), но ставится и обновляется независимо;
**Hub для работы не нужен** — это прямо сказано в таблице миграции со старого
Hub CLI (`"Unity Hub.exe" -- --headless <команда>` → `unity <команда>`,
«standalone binary; no Hub installation required») **[док]**.

Заявленные сценарии: CI/CD и билд-агенты без полного Hub, скрипты с
машиночитаемым выводом и предсказуемыми кодами выхода, работа из терминала **[док]**.
Бесплатен, подписка Unity AI не нужна **[док]**.

### 1.2 Установка

Требования: macOS 14+, Windows 10 21H1+, Linux с glibc 2.34+ (RHEL 9, Ubuntu 22.04+) **[док]**.

```bash
# macOS / Linux — скрипт; ставит в ~/.local/bin/unity
curl -fsSL https://unity.com/install.sh | bash
UNITY_CLI_HOME=/custom/path bash install.sh   # свой каталог → <UNITY_CLI_HOME>/bin

brew install --cask unity-cli          # macOS/Linux
winget install Unity.CLI               # Windows
sudo apt install unity-cli             # после подключения репозитория hub.unity3d.com/linux/repos/deb
sudo dnf install unity-cli             # после подключения rpm-репозитория

unity --version
unity self-update                      # обновить сам CLI (алиас: unity upgrade)
unity doctor                           # диагностический снимок окружения
```

### 1.3 Команды (по группам)

**Редакторы и модули [док]:**

| Команда | Что делает |
|---|---|
| `unity install [версия] [-m модули…] [-c changeset] [--cm] [-a arm64\|x86_64]` | Ставит редактор. Алиасы версии: `latest`, `lts`, `default`, `6`, `6.5`, `2022` |
| `unity install-modules -e <версия> -m android ios` (`-l` — список, `--all`) | Добавляет модули к установленному редактору |
| `unity uninstall <версия>` | Удаляет редактор |
| `unity editors -i` / `-r` / `add <путь…>` / `default [версия]` | Установленные/доступные редакторы, регистрация уже установленного, редактор по умолчанию |
| `unity modules list <версия>`, `unity releases`, `unity install-path` | Справочные |
| `unity hub install` | Поставить сам Hub (если всё же нужен) |

**Проекты, сборка, тесты [док]:**

| Команда | Что делает |
|---|---|
| `unity open <путь>` (или `unity ./MyProject`), `--wait` | Открыть проект в подходящей версии редактора (GUI). С `--wait` на macOS/Linux ждёт выхода: 0 — чисто, 6 — сбой |
| `unity close` | Закрыть редактор с проектом (ничего не сохраняет) |
| `unity projects create <имя> [--no-cloud]` | Создать проект; по умолчанию — ещё и облачный проект Unity Cloud |
| `unity projects …` | list/clone/open/link/pin/размер на диске |
| `unity templates …`, `unity assets inspect\|export\|import` | Шаблоны, `.unitypackage` |
| `unity build [--list-targets] [--list-profiles] [--create-profile <target>] [--timeout <сек>]`, `unity build run` | **Сборка в batch mode** с CI-флагами (включая подпись Android) |
| `unity run [--command <cmd>] [--log-file <путь>]` | Запуск проекта в batch mode или зарегистрированной команды редактора headless |
| `unity test` | **EditMode и PlayMode тесты** через Test Runner, отчёт в NUnit XML |
| `unity watch test` | Перезапуск `unity test --affected` при изменении файлов |
| `unity recompile [--strict]` | Перекомпиляция скриптов **в уже запущенном** редакторе с отчётом об ошибках компиляции |

Подробные флаги `test`/`build`/`run` (фильтры, путь к отчёту, целевая
платформа) в справочнике не расписаны — справочник сам отсылает к
`unity <команда> --help`. Пакет роли должен опираться на `--help` на машине,
а не на зашитые флаги.

**Аккаунт и лицензии [док]:**

| Команда | Что делает |
|---|---|
| `unity auth login` / `status` / `logout` | Вход через браузер, проверка, выход |
| `unity license` | Список, активация и возврат лицензий на этой машине |
| `UNITY_SERVICE_ACCOUNT_ID` + `UNITY_SERVICE_ACCOUNT_SECRET` | Вход сервисным аккаунтом для безлюдных сценариев (CI). Проекты в организации сервисный аккаунт создавать не может |

**Контроль версий — `unity vcs` [док].** Для нас самая ценная группа:

| Команда | Что делает |
|---|---|
| `vcs setup` | Довести проект от «без VCS» до первого коммита на удалённом |
| `vcs status` | Изменения, сгруппированные по смыслу для Unity, **включая проблемы парности `.meta`** |
| `vcs doctor [--fix]` | Проверка настроек репозитория, ignore-правил и LFS, которые нужны Unity-проекту |
| `vcs merge-setup` | Настроить UnityYAMLMerge для сцен и префабов |
| `vcs conflicts` / `explain` / `resolve` | Список конфликтов с признаком «сольётся ли само», объяснение сторон, разрешение мерж-инструментом редактора |
| `vcs diff` / `blame` | Diff и blame сцены/префаба по именам GameObject и компонентов, а не по `fileID` |
| `vcs affected` | Какие ассеты, сборки и **тесты** затронуты изменением |
| `vcs summarize` | Сводка изменений ветки для описания PR |
| `vcs hooks` | Git-хуки с проверками целостности Unity на коммит |
| `vcs sync` / `switch` | Безопасный pull/смена ветки (отказ, пока редактор держит проект; подтягивает LFS) |
| `vcs git migrate-lfs` | Перевод ассетов в LFS |

**Связь с запущенным редактором и агенты [док]:** `unity command`/`cmd`,
`unity list`, `unity status`, `unity pipeline install`, `unity mcp`,
`unity mcp configure claude`, `unity skill install <агент>`, `unity job`.
Всё это работает через пакет `com.unity.pipeline` (Unity 6.0+), который
поднимает в **запущенном** редакторе локальный HTTP API (порт 7800, только
localhost). Unity объявила устаревшим MCP-сервер в `com.unity.ai.assistant`;
замена — `unity mcp` на базе Pipeline.

**Прочее:** `unity commands --format json` — манифест всех команд (удобно
агенту), `unity shell` — тёплый интерактивный процесс, `unity cache key` —
детерминированный ключ кеша для `Library/`, `unity logs`, `unity env`,
`unity context`, `unity config`.

### 1.4 Вывод и коды выхода [док]

Формат: `--format human|tsv|json|ndjson|github` (или `UNITY_FORMAT`). В пайп
по умолчанию идёт TSV. В `json` — конверт `{success, command, data, errors,
warnings}`; ветвиться надо по `errors[0].code`, а не по stderr.
`--format github` печатает аннотации `::error::`. Для безлюдного запуска:
`UNITY_NON_INTERACTIVE=1`, `UNITY_NO_PAGER=1`, `UNITY_NO_UPDATE_CHECK=1`,
`UNITY_NO_CONSENT_PROMPT=1`.

| Код | Смысл |
|---|---|
| 0 | Успех |
| 1 | Общая ошибка |
| 2 | Ошибка использования (флаги) |
| 3 | Аутентификация/авторизация |
| 4 | Не задана нужная настройка/контекст |
| 6 | Основная операция не удалась; для `unity test` — прогон **не завершился** (ошибка компиляции, **нет лицензии**, падение редактора, таймаут). Можно повторить |
| 7 | Сервис Unity недоступен / `recompile` не достучался до редактора. Можно повторить |
| 8 | Только `unity test`: тесты прошли до конца, есть упавшие. Повтор бессмыслен |
| 130 / 143 | SIGINT / SIGTERM |

### 1.5 Без GUI, без Hub, лицензия

- **Без Hub** — да, CLI самостоятельный **[док]**.
- **Без GUI** — `build`, `run`, `test` заявлены как batch mode / headless
  **[док]**. Вход `unity auth login` открывает браузер, поэтому на безлюдной
  машине — сервисный аккаунт через переменные окружения **[док]**. Когда Hub
  не запущен, CLI сам поднимает фоновый identity-server, отвечающий редактору
  на запросы входа (`UNITY_NO_EDITOR_IDENTITY_SERVER` его отключает) **[док]** —
  то есть активная сессия Hub не требуется.
- **Лицензия** — CLI лишь запускает **редактор**, а редактору в batchmode
  по-прежнему нужна активированная лицензия; её отсутствие `unity test`
  сообщает кодом 6 **[док]**. Активировать/вернуть — `unity license` **[док]**
  или классические флаги редактора (раздел 2.4).
- **Что работает вообще без редактора и лицензии:** установка CLI, `editors`,
  `releases`, `install` (скачать редактор), большая часть `vcs …` (status,
  doctor, merge-setup, diff, conflicts, affected — это работа с git и YAML)
  **[практика: следует из описания команд; `vcs resolve` прямо использует мерж-инструмент
  редактора, значит редактор должен быть установлен]**.
- **Что требует запущенного редактора:** `command`, `list`, `status`,
  `recompile`, `mcp`, всё через `com.unity.pipeline` **[док]**.

### 1.6 Чем отличается от `Unity -batchmode -quit -projectPath`

| | Классический запуск | Unity CLI |
|---|---|---|
| Где взять редактор | Путь к бинарнику ищется руками (`/Applications/Unity/Hub/Editor/<ver>/Unity.app/Contents/MacOS/Unity`, `C:\Program Files\Unity\Hub\Editor\<ver>\Editor\Unity.exe`) | Подбирает редактор под `ProjectSettings/ProjectVersion.txt`, сам может его поставить |
| Сборка | Свой C#-метод в `Editor/` + `-executeMethod` | `unity build` с профилями Unity 6 и флагами CI |
| Тесты | `-runTests -testPlatform … -testResults …` | `unity test`, различимые коды 6/8, `--affected` |
| Вывод | Лог редактора (`-logFile`) | Структурированный JSON/NDJSON + лог редактора |
| Git | Ничего | `unity vcs …` |
| Зрелость | Стабильно годами, это и использует GameCI | Экспериментальный |

Под капотом CLI всё равно запускает тот же редактор в batch mode — это обёртка,
а не замена движка. Поэтому для гейта разумно поддерживать оба пути: CLI, если
есть, иначе прямой вызов редактора.

---

## 2. Классический headless-путь

Источники: [Command line arguments](https://docs.unity3d.com/Manual/EditorCommandLineArguments.html),
[Test Framework: command line](https://docs.unity3d.com/Packages/com.unity.test-framework@1.4/manual/reference-command-line.html),
[GameCI: активация](https://game.ci/docs/github/activation/).

### 2.1 Ключевые аргументы [док]

| Аргумент | Смысл |
|---|---|
| `-batchmode` | Выполнить аргументы без участия человека, без окон |
| `-nographics` | В batchmode не инициализировать графическое устройство — для машин без GPU. Нельзя для того, что рендерит (запекание света, часть PlayMode-тестов со снимками) |
| `-quit` | Выйти после выполнения остального. Может скрыть часть ошибок — они остаются в логе |
| `-projectPath <путь>` | Какой проект открыть |
| `-executeMethod Класс.Метод` | Вызвать статический метод после открытия проекта (метод в папке `Editor/`) |
| `-logFile <путь>` | Куда писать лог; `-logFile -` — в stdout |
| `-buildTarget <android\|ios\|webgl\|win64\|osxuniversal\|linux64…>` | Активная платформа при старте (иначе — долгий реимпорт при переключении) |
| `-accept-apiupdate` | Запустить API Updater в batchmode |
| `-upmLogFile <путь>` | Отдельный лог Package Manager |

Типовой вызов сборки:

```bash
"$UNITY" -batchmode -nographics -quit \
  -projectPath "$PWD" -buildTarget webgl \
  -executeMethod Ci.Build.WebGL \
  -logFile build.log
```

### 2.2 Коды выхода редактора

- Метод из `-executeMethod`, чтобы сообщить о провале, должен **бросить
  исключение (код 1)** или вызвать `EditorApplication.Exit(<не ноль>)` **[док]**.
- Ошибка компиляции скриптов в batchmode → редактор завершается с ненулевым
  кодом, в логе `Scripts have compiler errors.` **[практика]**.
- Отсутствие лицензии → ненулевой код и сообщение о лицензии в логе
  **[практика]**. Поэтому одного кода мало: гейт должен ещё грепать лог.

### 2.3 Тесты Unity Test Framework [док]

```bash
"$UNITY" -batchmode -projectPath "$PWD" \
  -runTests -testPlatform EditMode \
  -testResults "$PWD/artifacts/editmode.xml" \
  -logFile artifacts/editmode.log
# PlayMode — то же с -testPlatform PlayMode (без -nographics, если тесты рендерят)
```

| Аргумент | Смысл |
|---|---|
| `-runTests` | Запустить тесты |
| `-testPlatform` | `EditMode` (по умолчанию), `PlayMode` или имя BuildTarget (тесты в собранном плеере) |
| `-testResults <путь>` | Куда писать XML |
| `-testFilter` | Имена через `;` или regex |
| `-testCategory` | Категории через `;`/regex, отрицание через `!` |
| `-assemblyNames` | Тестовые сборки через `;` |
| `-testSettingsFile` | `TestSettings.json` |
| `-runSynchronously` | Всё в одном кадре, только EditMode (быстро, но без `UnityTest`-корутин) |
| `-retry N`, `-repeat N`, `-playerHeartbeatTimeout` | Повторы, таймаут плеера |

Важно:
- **Не ставить `-quit` вместе с `-runTests`**: раннер сам закрывает редактор
  по окончании, а `-quit` может закрыть его до старта тестов **[практика]**.
- Официальная дока прямо говорит, что единого определения кодов выхода нет
  **[док]**. На практике: `0` — всё прошло, `2` — есть упавшие тесты, `3` —
  прогон не состоялся (ошибка компиляции, лицензия и т.п.) **[практика]**.
  Поэтому надёжный признак — **XML**, а не код.
- EditMode — тесты в сборке, у которой в `.asmdef` указана только платформа
  `Editor`; PlayMode — сборки со ссылками на `UnityEngine.TestRunner` и
  `nunit.framework.dll` под всеми платформами. Без `.asmdef` с этими ссылками
  тесты не найдутся **[док, Test Framework manual]**.

### 2.4 Как прочитать результат

Формат — NUnit 3 XML **[док]**. Корень:

```xml
<test-run id="2" testcasecount="42" result="Failed(Child)" total="42"
          passed="40" failed="2" inconclusive="0" skipped="0" duration="12.3">
  …
  <test-case name="Jump_IncreasesY" fullname="Player.Tests.Jump_IncreasesY"
             result="Failed">
    <failure><message>Expected 1 but was 0</message><stack-trace>…</stack-trace></failure>
  </test-case>
```

Алгоритм для гейта:
1. Файла нет → прогон не состоялся: искать в логе `error CS`, `compiler errors`,
   `No valid Unity Editor license`/`License`.
2. Файл есть → `failed` и `total` у `<test-run>`; `total == 0` считать
   провалом (тесты не нашлись — частая тихая ошибка).
3. Для отчёта агенту — `name`, `message` и первые строки `stack-trace` у
   `test-case[@result="Failed"]`.

### 2.5 Лицензии в batchmode

- Pro/Plus (серийник): `-batchmode -quit -serial <ключ> -username <почта> -password <пароль>`,
  возврат — `-returnlicense` **[док]**.
- Ручная активация: `-createManualActivationFile` → `.alf` → `.ulf` →
  `-manualLicenseFile <файл.ulf>` **[док]**. Для Personal Unity этот путь
  больше не поддерживает; GameCI советует получить `.ulf` через Hub на своей
  машине и передать его содержимое секретом `UNITY_LICENSE` (+ почта и пароль)
  **[практика, GameCI]**.
- Floating-лицензии — через Unity Licensing Server **[док/GameCI]**.
- Новый путь — `unity license activate/return` и сервисный аккаунт **[док]**.

Для офиса: на машине владельца с Hub и вошедшим аккаунтом лицензия уже
активна, редактор в batchmode её подхватит. Отдельная активация нужна только
на чистом CI.

---

## 3. Git для Unity

Источники: [Smart Merge](https://docs.unity3d.com/Manual/SmartMerge.html),
[Version control integrations / Editor settings](https://docs.unity3d.com/Manual/Versioncontrolintegration.html),
[Asset metadata (.meta)](https://docs.unity3d.com/Manual/AssetMetadata.html),
[github/gitignore: Unity.gitignore](https://github.com/github/gitignore/blob/main/Unity.gitignore),
[Git LFS](https://git-lfs.com/), справочник `unity vcs` (раздел 1.3).

### 3.1 Что в репозиторий, что нет

Коммитить: `Assets/`, `Packages/` (`manifest.json`, `packages-lock.json`),
`ProjectSettings/`. Остальное генерируется.

`.gitignore` (сокращённо по github/gitignore):

```gitignore
/[Ll]ibrary/
/[Tt]emp/
/[Oo]bj/
/[Bb]uild/
/[Bb]uilds/
/[Ll]ogs/
/[Uu]ser[Ss]ettings/
/[Mm]emoryCaptures/
/[Rr]ecordings/
# IDE и сгенерированные решения
.vs/
.idea/
*.csproj
*.sln
*.unityproj
*.pidb
*.booproj
*.userprefs
*.suo
*.user
# Крэш-репорты и сборки
crashlytics-build.properties
sysinfo.txt
*.apk
*.aab
*.unitypackage
# Автогенерируемые .meta от игнорируемых папок
/[Aa]ssets/[Ss]treamingAssets/aa.meta
```

`Library/` — кеш импорта, восстанавливается сам (долго: минуты–часы).
`UserSettings/` — личные настройки редактора. Слешы в начале важны: папку
`Assets/Foo/Library/` игнорировать нельзя.

### 3.2 `.meta`-файлы — их нельзя терять

У каждого файла и папки в `Assets/` есть `.meta` с **GUID** и настройками
импорта **[док, AssetMetadata]**. Сцены, префабы и материалы ссылаются на
ассеты **по GUID**, а не по пути. Последствия:

- Потерян `.meta` → Unity создаст новый с новым GUID → все ссылки на ассет
  молча станут `Missing`. Сборка при этом пройдёт.
- Файл переименован/перемещён без `.meta` → то же самое.
- Два разных `.meta` с одним GUID (копия папки вне редактора) → конфликт GUID.
- `.meta` без файла («сирота») → предупреждение и мусор.

Правила для агента:
- Добавил/переместил/удалил файл в `Assets/` — **то же сделать с `.meta`**
  (`git mv Foo.cs Bar.cs && git mv Foo.cs.meta Bar.cs.meta`).
- Новый файл без редактора — `.meta` надо создать самому (GUID — 32 hex-символа,
  уникальный; для `.cs` достаточно минимального `MonoImporter`). Иначе его
  создаст первый же запуск редактора, и у двух разработчиков GUID разойдутся.
- В Project Settings → Editor: **Version Control Mode = Visible Meta Files**
  (в современных версиях по умолчанию).

Проверка парности без редактора — простой скрипт по `git ls-files` или
`unity vcs status` / `unity vcs hooks` **[док]**.

### 3.3 Force Text

Project Settings → Editor → **Asset Serialization Mode = Force Text** — сцены,
префабы, ассеты сохраняются как YAML, а не бинарно **[док]**. Без этого нет ни
диффа, ни Smart Merge. Проверка без редактора:
`ProjectSettings/EditorSettings.asset` содержит `m_SerializationMode: 2`
(2 = Force Text) **[практика]**. Файлы начинаются с `%YAML 1.1` и
`%TAG !u! tag:unity3d.com,2011:`.

### 3.4 `.gitattributes` и Git LFS

Текстовые YAML-ассеты — в обычный git с мерж-драйвером, бинарные — в LFS:

```gitattributes
# Unity YAML — текст, мерж семантический
*.unity        merge=unityyamlmerge eol=lf
*.prefab       merge=unityyamlmerge eol=lf
*.asset        merge=unityyamlmerge eol=lf
*.mat          merge=unityyamlmerge eol=lf
*.anim         merge=unityyamlmerge eol=lf
*.controller   merge=unityyamlmerge eol=lf
*.meta         merge=unityyamlmerge eol=lf
*.physicMaterial merge=unityyamlmerge eol=lf
*.cs           text diff=csharp

# Бинарное — в LFS
*.png  filter=lfs diff=lfs merge=lfs -text
*.jpg  filter=lfs diff=lfs merge=lfs -text
*.psd  filter=lfs diff=lfs merge=lfs -text
*.tga  filter=lfs diff=lfs merge=lfs -text
*.exr  filter=lfs diff=lfs merge=lfs -text
*.fbx  filter=lfs diff=lfs merge=lfs -text
*.blend filter=lfs diff=lfs merge=lfs -text
*.wav  filter=lfs diff=lfs merge=lfs -text
*.mp3  filter=lfs diff=lfs merge=lfs -text
*.ogg  filter=lfs diff=lfs merge=lfs -text
*.mp4  filter=lfs diff=lfs merge=lfs -text
*.ttf  filter=lfs diff=lfs merge=lfs -text
*.otf  filter=lfs diff=lfs merge=lfs -text
*.dll  filter=lfs diff=lfs merge=lfs -text
*.so   filter=lfs diff=lfs merge=lfs -text
*.a    filter=lfs diff=lfs merge=lfs -text
*.unitypackage filter=lfs diff=lfs merge=lfs -text
*.cubemap filter=lfs diff=lfs merge=lfs -text
LightingData.asset filter=lfs diff=lfs merge=lfs -text  # бинарный, несмотря на .asset
```

Тонкости:
- Если `.asset` в проекте бывает бинарным (LightingData, Terrain data), ему
  нужно отдельное правило LFS по имени/папке, иначе бинарь попадёт в YAML-драйвер.
- `merge=unityyamlmerge` в `.gitattributes` ничего не делает, пока драйвер не
  описан в git-конфиге (это локальная настройка, в репозиторий не едет).
- LFS-объекты в изолированной копии исполнителя: без `git lfs install` и
  `git lfs pull` в рабочей копии будут указатели вместо картинок. Для кода это
  неважно, для импорта в редакторе — критично.
- Проверка/починка: `unity vcs doctor --fix`, перевод уже закоммиченного —
  `unity vcs git migrate-lfs` **[док]** (или `git lfs migrate import`).

### 3.5 UnityYAMLMerge (Smart Merge) [док]

Инструмент из поставки редактора, семантически сливающий сцены и префабы
(понимает объекты и компоненты, а не строки).

- Windows: `C:\Program Files\Unity\Editor\Data\Tools\UnityYAMLMerge.exe`
  (у установок через Hub — `…\Hub\Editor\<ver>\Editor\Data\Tools\`).
- macOS: `/Applications/Unity/Unity.app/Contents/Helpers/UnityYAMLMerge`
  (через Hub — `/Applications/Unity/Hub/Editor/<ver>/Unity.app/Contents/Tools/UnityYAMLMerge`
  **[практика: путь зависит от версии, искать find'ом]**).
- Рядом `mergespecfile.txt` — что делать с неразрешёнными конфликтами и
  неизвестными файлами (запасной текстовый мерж-инструмент).

Как mergetool (из доки):

```ini
[merge]
    tool = unityyamlmerge
[mergetool "unityyamlmerge"]
    trustExitCode = false
    cmd = '<путь к UnityYAMLMerge>' merge -p "$BASE" "$REMOTE" "$LOCAL" "$MERGED"
```

Как мерж-драйвер, чтобы работало прямо при `git merge` без ручного
`git mergetool` **[практика]**:

```ini
[merge "unityyamlmerge"]
    name = Unity SmartMerge
    driver = '<путь к UnityYAMLMerge>' merge -h -p --force %O %B %A %A
    recursive = binary
```

Или одной командой: `unity vcs merge-setup` **[док]**.

Для офиса это важно: гейт `premerge.ts` делает пробное слияние обычным git.
Без драйвера две задачи, тронувшие одну сцену, почти всегда дадут текстовый
конфликт в YAML, даже если правили разные объекты. С драйвером — часто
сольются сами. Драйвер требует установленного редактора (бинарник из его
поставки).

---

## 4. MCP-мосты к редактору Unity

Все они работают одинаково по сути: пакет внутри **открытого редактора**
поднимает локальный сокет/HTTP, а отдельный MCP-сервер переводит вызовы
агента в команды редактору.

| Мост | Лицензия | Зрелость | Устройство | Что умеет | Редактор |
|---|---|---|---|---|---|
| [CoplayDev/unity-mcp](https://github.com/CoplayDev/unity-mcp) (бывший justinpbarnett/unity-mcp, «MCP for Unity») | MIT | ~14.7k звёзд, v10.0.0 (2026-06-30), активно, спонсор Aura | Unity-пакет + Python-сервер через `uv`, HTTP/stdio; Unity 2021.3 LTS – 6.x | ~48 инструментов: сцены и GameObject, правка C#-скриптов, ассеты, запуск тестов, профайлинг, сборка, консоль | Должен быть открыт |
| [IvanMurzak/Unity-MCP](https://github.com/IvanMurzak/Unity-MCP) («AI Game Developer») | Apache-2.0 | ~4.4k звёзд, >3k коммитов, CI, Docker-образ | C#-плагин + сервер (stdio / streamableHttp), npm-CLI `unity-mcp-cli` | 70+ инструментов (ассеты, иерархия, скрипты, профайлинг); любой C#-метод становится инструментом атрибутом; есть режим **в собранной игре** (runtime) | Для инструментов редактора нужен работающий Unity; README говорит, что CLI ставит плагин без открытого редактора. Путь проекта без пробелов |
| [CoderGamester/mcp-unity](https://github.com/CoderGamester/mcp-unity) | MIT | ~1.9k звёзд, v1.5 (ломает совместимость с 1.4) | Unity-пакет + Node-сервер, WebSocket :8090 с токеном на проект; Unity 6+, Node 18+ | 30+ инструментов: GameObject, компоненты, материалы, сцены, префабы, `run_tests`, Play Mode | Должен быть открыт |
| Официальный: `unity mcp` из Unity CLI + `com.unity.pipeline` ([док](https://docs.unity.com/en-us/unity-cli/replace-mcp-server-unity-cli)) | Проприетарный, бесплатный | Экспериментальный; заменяет устаревший MCP в `com.unity.ai.assistant` | Pipeline в редакторе, HTTP :7800 только localhost; `unity mcp configure claude`, `unity skill install` | `eval`, `eval_file` и зарегистрированные команды редактора; без MCP — `unity command` (дешевле по токенам) | Должен быть запущен, Unity 6.0+ |

Наблюдения:
- **Ни один мост не работает без запущенного редактора** (для операций
  редактора). В песочнице исполнителя офиса GUI-редактора нет, значит мост —
  только для роли, которая работает на машине владельца с открытым Unity.
- Это та же ситуация, что с Blender в `src/server/mcp.ts`: мост живёт в GUI, а
  результат роли — файлы в репозитории. Правки сцены через мост редактор
  сохраняет на диск, но они не воспроизводимы и не видны в ветке, пока не
  сохранены и не закоммичены. Мост годится для разведки и проверки глазами,
  итог — код/YAML в git.
- Мосты исполняют произвольный C# в редакторе (`eval`, правка скриптов,
  выполнение методов) — для `permissions.ts` это «рискованный» класс по
  умолчанию, в отличие от нашего `browser`.
- Официальный путь (`unity command` без MCP) Unity сама называет более
  быстрым и дешёвым по токенам; для агента с Bash это предпочтительнее MCP.

---

## 5. Выводы и рекомендации

### 5.1 Что агент может сам — в песочнице, без редактора

- Писать и править C# (геймплей, Editor-скрипты, тесты NUnit/UTF), `.asmdef`,
  `Packages/manifest.json`, `ProjectSettings/*.asset` (YAML).
- Читать и аккуратно править YAML сцен/префабов (поменять поле, ссылку,
  значение) — с пониманием `fileID`/`guid`. Крупные правки сцен — нет.
- Создавать `.meta` для новых файлов и следить за парностью при `git mv`/`rm`.
- Вести `.gitignore`, `.gitattributes`, LFS-правила.
- Статически проверять: парность `.meta`, уникальность GUID, отсутствие
  `Library/` и т.п. в индексе, Force Text в `EditorSettings.asset`, валидность
  YAML-заголовков, что бинарники идут через LFS.
- Синтаксическая проверка C# без Unity ограничена: можно собрать
  `dotnet build` только если сгенерированы `.csproj` (их делает редактор) —
  в общем случае **нельзя**. Компиляцию честно проверяет только редактор.

### 5.2 Что через Unity CLI

- Без редактора и лицензии: `unity vcs status/doctor/affected/diff/summarize/conflicts`,
  `unity editors -i`, `unity commands --format json`, `unity doctor`.
- С установленным редактором и лицензией: `unity test` (коды 6/8 удобнее
  классических), `unity build`, `unity run`.
- С запущенным редактором (машина владельца): `unity recompile --strict`
  (быстрая проверка компиляции без полного запуска), `unity command`, `unity mcp`.

### 5.3 Что требует установленного Unity и лицензии

- Компиляция скриптов (единственный честный способ — открыть проект в редакторе).
- EditMode/PlayMode тесты.
- Сборка плеера под любую платформу (+ нужный модуль: Android/iOS/WebGL).
- Импорт ассетов (первый запуск на чистой копии — построение `Library/`,
  долго; кешировать `Library/` по `unity cache key`).
- UnityYAMLMerge (бинарник из поставки редактора).
- Всё через MCP-мосты и `com.unity.pipeline` — ещё и **запущенный** редактор.

### 5.4 Гейт слияния для Unity-репозитория

Рекомендуемый набор `mergeChecks` по уровням (дешёвые — всегда, дорогие —
если на машине офиса найден редактор нужной версии):

**Уровень 0 — без Unity (быстро, всегда):**
1. Нет игнорируемых путей в дереве: `git ls-files | grep -E '^(Library|Temp|Obj|Logs|UserSettings)/'` — пусто.
2. Парность `.meta`: у каждого файла/папки под `Assets/` есть `.meta` и
   наоборот (`unity vcs status`, либо свой скрипт ~30 строк).
3. Уникальность GUID по всем `.meta`.
4. Force Text: `m_SerializationMode: 2` в `ProjectSettings/EditorSettings.asset`.
5. Бинарные ассеты — LFS-указатели, а не бинарь (`git lfs ls-files` против
   расширений из `.gitattributes`); при наличии CLI — `unity vcs doctor`.
6. Версия редактора в `ProjectSettings/ProjectVersion.txt` не поменялась
   «случайно» (менять только отдельной задачей).

**Уровень 1 — с редактором и лицензией (минуты):**
7. Компиляция: batchmode-запуск с `-quit` и проверкой лога на `error CS` /
   `compiler errors`, либо `unity run`.
8. EditMode-тесты: `unity test` (EditMode) или `-runTests -testPlatform EditMode`;
   провал — нет XML, `failed > 0` или `total == 0`.

**Уровень 2 — по настройке (дольше):**
9. PlayMode-тесты (без `-nographics`, если рендерят).
10. Пробная сборка под целевую платформу (`unity build` / `-executeMethod`).

Также для гейта:
- Пробное слияние в `premerge.ts` должно идти с подключённым драйвером
  UnityYAMLMerge, если редактор найден, иначе — предупреждение «сцены
  сливаются построчно».
- `overlap.ts` для Unity полезно расширить: пересечение по `.unity`/`.prefab`
  важнее, чем по C#-символам — две задачи в одной сцене почти наверняка
  конфликт. (Отдельная задача.)
- Таймауты: первый импорт проекта без кеша `Library/` может идти десятки
  минут; кеш `Library/` на ключ `unity cache key` в копии офиса.
- Различать «прогон не состоялся» (лицензия, компиляция; CLI-код 6) и
  «тесты упали» (код 8 / `failed>0`) — в отчёте ревьюеру это разные вещи.

### 5.5 Что положить в пакет роли

`agent.json` (по образцу `@office/qa`):
- `runtime.tools`: Read, Write, Edit, Glob, Grep, Bash, TodoWrite;
  `isolate: true` (работа в своей копии).
- `servers`: **без MCP-моста по умолчанию**. Опционально (подписка
  владельцем) — `unity` → `command: "unity", args: ["mcp"]` (официальный,
  требует открытого Unity 6+ и `com.unity.pipeline`) или CoplayDev/unity-mcp.
  Не `alwaysLoad`: без открытого редактора инструменты бесполезны.
- `env`-ссылки (как у `imagegen`): `UNITY_PATH` (явный путь к редактору),
  `UNITY_SERVICE_ACCOUNT_ID`/`UNITY_SERVICE_ACCOUNT_SECRET` (для CI),
  `UNITY_NON_INTERACTIVE=1`.
- Скилл `unity-check` (как `qa-report`): скрипт статических проверок
  уровня 0 + разбор NUnit XML в короткий отчёт.

Пункты брифа `brief/ru.md`:
1. **Источник правды — файлы в git.** Всё, что сделано в редакторе руками или
   через мост, считается сделанным, только когда сохранено и закоммичено.
2. **`.meta` — часть файла.** Создаёшь/переносишь/удаляешь ассет — делай то же
   с `.meta`. Никогда не удаляй `.meta`, чтобы «починить» конфликт. Новый GUID
   генерируй уникальным.
3. **Не коммить** `Library/`, `Temp/`, `Obj/`, `Logs/`, `UserSettings/`,
   `*.csproj`, `*.sln`, сборки.
4. **Сцены и префабы — YAML.** Точечные правки полей — можно; массовые
   перестройки сцен — через Editor-скрипт (`-executeMethod`/`unity run`),
   который лежит в репозитории и воспроизводим. Не переписывай `fileID`.
5. **Бинарные ассеты — через LFS** по `.gitattributes`; новое расширение —
   сначала правило, потом файл.
6. **Не меняй версию Unity** (`ProjectVersion.txt`) и пакетов без явной задачи.
7. **Тесты:** логику — в EditMode-тесты (быстро, без сцены), поведение в
   кадре — PlayMode. Тестовые сборки — с `.asmdef`. Каждая фича — с тестом.
8. **Как проверить себя:** сначала статические проверки (скилл); если на
   машине есть Unity — `unity test` / batchmode с `-logFile`; читай XML, а не
   код выхода; `total == 0` — это провал.
9. **Не путай** «прогон не состоялся» (лицензия/компиляция) с «тесты упали» —
   пиши в отчёте, что именно случилось, с выдержкой из лога.
10. **Нет Unity в песочнице — это норма**, а не повод останавливаться: сделай
    код и тесты, пройди статические проверки и честно напиши в отчёте, что
    компиляцию и тесты проверит гейт.
11. Логику — в обычные C#-классы, MonoBehaviour — тонкий слой: так больше
    кода покрывается EditMode-тестами и меньше правок сцен.
12. Мост к редактору (если подключён) — для разведки и проверки глазами;
    произвольный `eval` — только с согласия владельца.

### 5.6 Открытые вопросы

- Флаги `unity test`/`unity build` (фильтр, путь отчёта, платформа) в
  справочнике не расписаны — снять с `unity test --help` на реальной машине
  перед реализацией гейта.
- Работает ли batchmode-редактор из песочницы исполнителя (Seatbelt: доступ к
  `~/Library/Unity/`, лицензии, сокету identity-server) — проверить вживую.
  Скорее всего, Unity-шаги надо выполнять процессом офиса (гейт), а не агентом.
- Пробное слияние с драйвером UnityYAMLMerge в `premerge.ts` — отдельная
  задача по коду.
