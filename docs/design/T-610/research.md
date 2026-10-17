# T-610. Свой агент: что уже есть и что дописать

Исследование, код не менялся. Состояние — `main` на 2026-10-17 (HEAD `244201b`, после T-609).
Номера строк сверены с этим коммитом. Копия в библиотеке офиса — документ D-5.

**Коротко.** Почти всё для «своего агента» уже есть, но разложено по двум несвязанным путям:

- **роль руками** (`createRole`) лежит целиком в `state.json` офиса. Бриф редактируется, а инструменты (`tools`) — нет. Скилы можно взять только из `employees/<id>/` внутри репозитория или приложения. В другой офис такую роль не перенести;
- **роль из пакета** (`hireFromPackage`) — это `agent.json` + `brief/<lang>.md` + `skills/`. Пакет переносится между офисами и публикуется в маркет, но создать его из приложения нельзя. Есть только экспорт уже существующей роли в папку (`exportRole`) и CLI `office-agent init`.

Рекомендация: «свой агент» — **локальный пакет того же формата** в `~/.office/agents/@local/<имя>/`. Его создаёт и правит сервер, нанимает тот же `hireFromPackage`, а роль привязывается ссылкой `RoleLink` с новым признаком `local`. Публикация в маркет тогда идёт существующим путём `office-agent publish`, без нового формата.

---

## 1. Что уже есть

### 1.1. Роль — `src/server/roles.ts`

`interface Role` (стр. 14). Поля, значимые для «своего агента»:

| Поле | Смысл |
|---|---|
| `id`, `title`, `emoji`, `color` | id генерирует сервер (`newRoleId` → `slugifyRoleId`: транслит, ≤24 символа, без пересечения с базовыми `baseRoleIds()`). Название ≤ `ROLE_TITLE_LIMIT` = 60 и уникально в офисе без учёта регистра |
| `provider` + `model` / `tier` | Своя пара или уровень (`top/balanced/fast`). Без них роль работает на модели офиса (`roleRuntime`) |
| `permissionMode` | `null` — режим офиса; иначе `auto / ask-risky / ask-writes / readonly` (`isPermissionMode` в permissions.ts) |
| `isolate` | Своя ветка и worktree на задачу (роль правит код) |
| `docsDir` | Папка-клетка для документной роли (юрист, SMM, дизайнер): сессия пишет только туда |
| `tools?: string[]` | Встроенные инструменты движка; `undefined` — все |
| `mcp?: string[]` | Подписка на серверы из каталога офиса; нет поля или `[]` — ничего |
| `capabilities?` | Словарь `CAPABILITIES` (shared/workflow.ts); пусто — выводится в `capabilitiesOf` (стр. 312) по `isolate/tools/docsDir` |
| `maxTurns`, `spendFuseTokens`, `allowLocalBinding` | Потолок ходов, порог расхода на запуск, локальные порты |
| `sprite` | Внешность из `shared/looks.ts`; пусто — по id роли |
| `subprojects` | Зоны, за которыми закреплена роль (`repoDir` устарел и превращается в зону) |
| `brief` | Системная приписка роли. У роли из пакета вычисляется: бриф пакета + `briefExtra` |
| `package?: RoleLink` | Ссылка на пакет: `name`, `version`, `source?` (repo/path/commit — для пакетов из кеша), `overrides`, `briefExtra`, `copy` |

Ключевые функции:

- `roleFromPackage(pkg, lang, id, link)` (стр. 243) — единственный способ получить роль из пакета. Берутся умолчания манифеста, поверх них — оверрайды по белому списку `OVERRIDABLE_KEYS` (стр. 222), к брифу снизу дописывается приписка. Роль с пакетом **всегда пересчитывается** и не хранится как готовый итог. В белом списке есть `mcp` и `capabilities`, но нет `tools`, `docsDir`, `brief` и `isManager`.
- `packageRuntime`, `pairRuntime`, `roleRuntime` — модель и провайдер.
- `capabilitiesOf` — способности по инструментам.
- `newRoleId`, `newRoleTitle`, `slugifyRoleId` — id и названия.
- `defaultRoles`, `defaultRole`, `blankRole`, `withManagerRole` — базовый набор и менеджер.

### 1.2. Жизненный цикл роли в офисе — `src/server/state.ts`

| Метод (строка) | Команда ws (`src/server/index.ts`) | Что делает |
|---|---|---|
| `createRole(draft: RoleDraft)` (4467) | `create_role` | Роль руками: название обязательно, остальное по умолчанию. Проверки — `checkRolePatch`. **Сотрудника не нанимает**, роль появляется вакансией |
| `editRole(roleId, patch)` (4534) → `updateRole` (4802) | `update_role` | Правка по белому списку `ROLE_EDITABLE_KEYS`. У роли из пакета правки ложатся в оверрайды ссылки, бриф — в `briefExtra` |
| `checkRolePatch` (4386) | — | Валидация: название (пусто, длина, занято), провайдер, модель (`MODEL_RE`), ходы, порог расхода, режим, внешность, репозиторий, зоны. **`tools` не проверяет и не принимает** |
| `archiveRole` / `removeRole` (4559 / 4603) | `archive_role` / `remove_role` | Архив роли; удаление — если роли нет в истории |
| `hireFromPackage(pkg, source, extra, opts)` (4662) | `market_hire` (через `market.ts`) | Закрыть вакансию из пакета или завести новую роль из пакета (`copy` — номер копии, свободная внешность), затем `hire(id)` |
| `hireCopy(roleId)` (4720) | — | Нанять ещё одного такого же: роль из пакета — через `hireFromPackage`, роль руками — копией полей |
| `updateRolePackage` (4756) | `market_update` | Перевести роль на новую версию пакета; оверрайды и приписка сохраняются |
| `detachRole` (4783) | `detach_role` | Отвязать роль от пакета (форк): дальше она живёт как заведённая руками |

Типы контракта — `src/shared/types.ts`: `RoleEditable`, `RoleView` (с `mcpRequested`, `package`, `effective*`), `RoleDraft`, `FieldError`, `RoleOp`.

**Дефекты, найденные по пути (подтверждены на шаге verify):**

1. `createRole` собирает `wanted.mcp` и `wanted.capabilities` из черновика (стр. 4478), но **не кладёт их в созданную роль**: объект `role` на стр. 4506–4521 их не содержит. Роль, заведённая руками, остаётся без MCP и способностей, пока их не выставят отдельной правкой.
2. `employeePack(role)` (skills.ts:216, папка — стр. 218) для привязанной роли берёт `packageDir(role.package.name)`, то есть **только `packages/` в корне**. А `resolvePackage` (packages.ts:651) для пакета из кеша читает `cacheDir(...)`. В итоге у роли из кеша маркета (`link.source` есть, пакет в `~/.office/packages/...`) скилы, плагины и просьбы о серверах не находятся. Правильно — `resolvePackage(role.package)?.dir`. Чинить нужно в любом случае: локальный пакет сломается так же.
3. `EMPLOYEES_DIR` = `<ROOT>/employees`, а в собранном приложении ROOT — ресурсы приложения, они только для чтения. Скилы ролям, заведённым руками, в приложении положить некуда.

### 1.3. Пакет агента — `src/server/packages.ts`

Формат описан в `packages/README.md`, разбирает его `parseManifest` (стр. 246):

```
@scope/name/
  .claude-plugin/plugin.json   name, version (semver — единственная версия пакета), description
  agent.json                   манифест офиса (schema: 1)
  brief/<lang>.md              бриф по языкам
  skills/<скил>/SKILL.md       свои навыки (front matter: name, description)
  bench/cases.json, README.md, CHANGELOG.md
```

`AgentManifest` (стр. 125): `name` (`PACKAGE_NAME_RE` — `@scope/name`, область обязательна), `kind: agent|team`, `title/summary` по языкам, `tags`, `color`, `emoji`, `look`, `manager`, `docsDir`, `license`, `capabilities`, `runtime { engine, model, tools|null, permissionMode, isolate, maxTurns, allowLocalBinding?, spendFuseTokens?, mcp[] }`, `skills[]` (отбор), `builtin[]` (встроенные скилы движка), `use[]` (пути к установленным плагинам), `servers[]` (просьбы о MCP), `requires { office, env[], network }`.

Функции:

- `readPackage(dir)` — загрузка и валидатор в одной функции. Ошибка означает, что пакета нет. Предупреждения: нет брифа, нет лицензии, у плагина есть хуки, команды, агенты или `.mcp.json` — они не грузятся (`IGNORED_PLUGIN_PARTS`).
- `validatePackage`, `loadPackage(name, root)`, `listPackages(root)`.
- `resolvePackage(link)` (стр. 651) — встроенный пакет из `packages/` или нужная версия из кеша по `link.source`.
- `listCached`, `cacheDir`, `readLock`, `packageIntegrity`, `packageBrief`, `packageTitle`, `packageModel`.

Где лежат пакеты: `PACKAGES_DIR` = `<ROOT>/packages` (встроенные `@office/*`, область `OFFICIAL_SCOPE` зарезервирована), `PACKAGE_CACHE` = `~/.office/packages/@scope/name/<версия>/` + `.office-lock.json`.

### 1.4. Скилы, плагины, просьбы о серверах — `src/server/skills.ts`

- `employeePack(role)` (стр. 216) → `{ dirs, skills, servers }`: собственный плагин пакета (`pluginAt`), плагины по `use` (с `~` и маской версии) и `builtin`. Скилы адресуются как `<плагин>:<скил>`.
- `employeePlugins(role)` → `SdkPluginConfig[]` с `skipMcpDiscovery: true`: MCP плагина в сессию не попадают.
- `employeeSkills(role)` — поимённый список скилов сессии вместо умолчания «все».
- `employeeServers(role)` — просьбы о серверах для экрана «Инструменты».
- `sessionTools(role)` дописывает `Skill` к урезанному `tools`, если у роли есть скилы.
- Подключение в сессию — `src/server/agents.ts`: `tools: sessionTools(role)` (стр. 3258, для шага процесса — 4308), плагины и скилы рядом.

### 1.5. Экспорт и заготовка — `src/server/export.ts`, `src/cli/office-agent.ts`, `src/server/publish.ts`

- `scaffoldPackage(dir, spec: Scaffold)` собирает папку пакета: `plugin.json`, `agent.json`, `brief/`, копию `skills/`, `bench/`, README, CHANGELOG. Папка должна быть пустой. Возвращает замечания валидатора.
- `scaffoldFromRole(role, name, lang)` превращает роль офиса в `Scaffold`. Бриф берётся вычисленный и целиком, так что экспорт — это форк. Модель записывается алиасом или уровнем, скилы — из пакета или из `employees/<id>`.
- `exportRole(role, name, dir, projectDir, lang)` — ws `export_role`, кнопка «Экспортировать в пакет» на вкладке «Инструкция» страницы агента. По умолчанию пишет в `<проект>/agents/<имя>`.
- CLI `office-agent`: `init` (заготовка с шаблоном брифа), `validate`, `bench` (стенд скилов на живых сессиях), `publish` (запись реестра для текущего коммита; флаги `--tag`, `--write`, `--to` с токеном GitHub), `marketplace`, `registry-check`.
- `publish.ts`: `publishInfo`, `scopeProblem` (область пакета должна совпадать с владельцем репозитория на GitHub), `upsertEntry`, `checkRegistry`, `packageAt`.

### 1.6. Маркет и найм — `src/server/market.ts`

- Реестр: `loadRegistry`, `parseRegistry`, `REGISTRY_SOURCE`.
- Установка в кеш: `installFromGit` (клон без рабочей копии, выбор коммита по тегу, ветке или хешу, `readPackage`, копия в `cacheDir`, lock с отпечатком), `installFromMirror`, `installFromRegistry`, `ensureInstalled`. `parseLink` понимает адреса GitHub, ssh, `file://` и **путь на диске** (`/…`, `~/…`), поэтому «Добавить по ссылке» уже ставит пакет из локального git-репозитория.
- `installedPackage(name)` — встроенный пакет или старшая версия из кеша.
- `handleMarketCommand`: `market_open`, `market_install`, `market_add_link`, `market_hire` → `state.hireFromPackage`, `market_hire_team`, `market_check`, `market_update` → `updateRolePackage`, `market_license`.
- Витрина: `packageCards` собирает карточки из `listPackages()` (origin `builtin`), реестра (`registry`) и `listCached()`.

### 1.7. Внешние MCP — `src/server/mcp.ts` (подробно — D-2)

- `DEFAULT_MCP_SERVERS`: `figma-bridge`, `figma-console`, `penpot`, `figcraft`, `blender`, `unity`, `imagegen`, `browser`.
- `mcpCatalog(settings)` — каталог офиса (`Settings.mcpServers`) плюс недостающие умолчания; `mcpCatalogView` — то же с признаком `missingBinary`.
- `mcpNamesFor(role)` = `role.mcp ?? []`; `serversFor(settings, role)` — подписка роли без выключенных и неизвестных серверов; `externalMcp` переводит её в формат SDK; `mcpBrief` даёт строку в промпт; `checkMcpServers` валидирует определение сервера (env и заголовки — только как `${NAME}`).
- Пакет **просит** серверы (`servers`), но сам их не подключает: владелец добавляет их в каталог («Инструменты» → просьбы).

### 1.8. Разрешения — `src/server/permissions.ts`

Это не список разрешённых роли инструментов, а **классификатор риска** вызова: `classify` даёт уровень риска, `decide(mode, risk)` — `allow/ask/deny`. Группы: `SAFE_TOOLS` (Read, Glob, Grep, NotebookRead, TodoWrite, WebSearch, WebFetch, AskUserQuestion, Task) и `WRITE_TOOLS` (Write, Edit, NotebookEdit, MultiEdit). `Bash` разбирается отдельно, MCP — по глаголам (`get_/list_/read_…` — чтение, `delete_/remove_…` — опасно), для `browser`, `figma-console`, `unity` и `figcraft` есть свои правила. Какие инструменты роль **вообще видит**, решает `Role.tools` → `options.tools` сессии. Что из видимого спрашивать у владельца, решают `permissionMode` роли или офиса и этот классификатор.

### 1.9. Веб

- `src/web/TeamWindow.tsx` — окно «Команда»: вкладки `staff` («В офисе») и `market` («Маркет»), поиск, «Добавить по ссылке» (`market_add_link`).
- `src/web/PackageCard.tsx` — карточка пакета: «Установить», «Нанять» (`marketHire`), «Нанять команду», лицензия, обновление.
- `src/web/AgentSettings.tsx` — страница агента с вкладками `profile` (имя, название, внешность), `model` (провайдер, модель, ходы, порог расхода, репозиторий, изоляция, локальные порты), `access` (режим доступа роли и личный, MCP, способности), `brief` (бриф или пакет + приписка) и `results`.
- `src/web/AgentPanels.tsx` — сами панели. `AccessPanel`: галочки MCP из `settings.mcpServers` и галочки `CAPABILITIES`. `BriefPanel`: бриф пакета только для чтения, `briefExtra`, экспорт в пакет, отвязка.
- `src/web/McpCatalog.tsx` — каталог серверов в настройках офиса и просьбы пакетов.
- `src/web/store.ts`: `createRole` (стр. 2044) **есть, но в интерфейсе её никто не вызывает** — кнопки «Создать роль» нет. Встроенных инструментов (`tools`) и скилов на странице агента тоже нет.

---

## 2. Модель данных «своего агента»

### 2.1. Решение: локальный пакет того же формата

«Свой агент» = `agent.json` + `.claude-plugin/plugin.json` + `brief/<lang>.md` + `skills/`, ровно как в `packages/@office/*`. Почему не роль руками:

- пакет переносится между офисами, а роль руками живёт в `state.json` одного офиса;
- он публикуется в маркет существующим `office-agent publish`, без конвертации;
- `roleFromPackage` уже разделяет «умолчания агента» и «правки офиса» (оверрайды, `briefExtra`), пересчитывает нанятых и ведёт номер копии;
- валидатор один (`readPackage`), так что созданное в приложении гарантированно загрузится.

### 2.2. Где хранить

> Допущение до ответа владельца (вопрос **Q-203**): хранить на компьютере, общим для всех офисов.

`LOCAL_AGENTS_DIR` = `~/.office/agents/` — рядом с кешем `~/.office/packages`; для тестов путь переопределяет `OFFICE_AGENTS_DIR`. Внутри — `@local/<имя>/` без папки версии: это рабочая копия автора, а не замороженная установка.

- Уровень машины, а не офиса: одного агента нанимают в несколько офисов, а папка офиса и репозиторий проекта не засоряются.
- Область `@local` зарезервирована, как `@office`: реестр и `scopeProblem` её не принимают. Перед публикацией агента экспортируют (`scaffoldPackage`) под область владельца `@<github-login>/<имя>`. Это форк — так уже работает экспорт роли.
- Версия живёт в `plugin.json`. Сервер поднимает patch при каждой сохранённой правке: это нужно для `RoleLink.version` и признака «обновлено».

Если владелец выберет папку офиса, меняется только корень (`<офис>/.office/agents`), остальное остаётся как есть. Найм в другой офис тогда копирует пакет в его папку.

### 2.3. Ссылка роли

`RoleLink` получает признак `local?: true`, взаимоисключающий с `source`. `resolvePackage(link)` для `link.local` вызывает `loadPackage(link.name, LOCAL_AGENTS_DIR)`. Всё остальное работает без изменений: `roleFromPackage`, восстановление из сохранения, `hireCopy`, экспорт. Если пакет пропал с диска, роль, как и сейчас, поднимается из сохранённых полей и ждёт.

### 2.4. Что пишется в манифест из формы

| Поле формы | Куда в пакете |
|---|---|
| Название, описание | `title.<lang>`, `summary.<lang>` (язык офиса) |
| Эмодзи, цвет, внешность | `emoji`, `color` (из `--accent-1..8`), `look` |
| Инструкции | `brief/<lang>.md` |
| Модель | `runtime.engine` + `runtime.model` (по умолчанию алиас уровня `opus/sonnet/haiku` — так переносимо) |
| Работает с кодом / с документами | `runtime.isolate: true` или `docsDir: docs/<id>` + `isolate: false` |
| Режим доступа | `runtime.permissionMode` (обычно `null`) |
| Встроенные инструменты | `runtime.tools` (`null` — все) |
| MCP-серверы | `runtime.mcp` (id из каталога) + `servers` (определение, если сервера нет в стандартном каталоге, — для переносимости) |
| Скилы | `skills/<имя>/SKILL.md` + `builtin` |
| Способности | `capabilities` |
| Лицензия | `license` (пусто — валидатор предупреждает, на найм это не влияет) |

Пример для «геймдизайнера настольных игр»:

```json
{
  "schema": 1,
  "name": "@local/boardgame-designer",
  "kind": "agent",
  "title": { "ru": "Геймдизайнер настольных игр" },
  "summary": { "ru": "Механики, баланс, правила и прототипы карт" },
  "emoji": "🎲", "color": "#…", "look": "",
  "docsDir": "docs/boardgame",
  "capabilities": ["docs.write", "research.web"],
  "runtime": {
    "engine": "claude-code", "model": "opus",
    "tools": ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"],
    "permissionMode": null, "isolate": false, "maxTurns": null, "mcp": ["imagegen"]
  },
  "builtin": ["dataviz"],
  "license": ""
}
```

---

## 3. Какие инструменты можно дать роли

### 3.1. Встроенные инструменты движка

Задаются полем `Role.tools` / `runtime.tools` и уходят в `options.tools` сессии (`sessionTools`). `undefined`/`null` означает все инструменты движка. Пакеты офиса реально используют `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebSearch`, `WebFetch`, `TodoWrite`; у дизайнера есть ещё `Artifact`. `Skill` дописывается сам, если у роли есть скилы.

**Матрица по движкам** (сверена по коду адаптеров на шаге rework; живые сессии Codex и OpenCode не запускались, см. §5):

| Инструмент | Claude Code | Codex | OpenCode | Где это видно |
|---|:-:|:-:|:-:|---|
| Read, Write, Edit, Glob, Grep, Bash, TodoWrite | ✓ свои | ✓ руки офиса | ✓ руки офиса через мост | `officeCatalog` в `providers/codex-tools.ts:73–118`, каждый под `enabled(name)`; OpenCode зовёт тот же каталог (`providers/opencode.ts:590`) |
| WebSearch | ✓ | ✓ свой `web_search` движка | ✗ | Codex: `web_search: … 'disabled' : 'live'` (`providers/codex.ts:234`); OpenCode: `webSearch: false` в `engines/opencode.ts`, его `websearch` запрещён (`opencode.ts:216`) |
| WebFetch | ✓ | ✗ | ✗ | Ни в `officeCatalog`, ни у Codex такого инструмента нет; у OpenCode свой `webfetch` выключен (`NATIVE_TOOLS`, `opencode.ts:198`) |
| NotebookEdit, Artifact, Task и прочие инструменты Claude Code | ✓ | ✗ | ✗ | `nativeHands: false` у Codex и OpenCode: свои руки этих движков выключены, а руки офиса умеют только 7 инструментов из первой строки |
| Skill | ✓ через плагин | ✓ инструментом | ✓ инструментом | `capabilities().skills`: `'plugin'` / `'tool'` / `'tool'` |

Вывод для формы и валидатора:

- общий для всех движков набор — `Read, Write, Edit, Glob, Grep, Bash, TodoWrite`; `WebSearch` есть у Claude Code и Codex; `WebFetch` и остальное — только у Claude Code;
- в `EngineCapabilities` (`shared/providers.ts`) уже есть флаги `nativeHands` и `webSearch`. Отдельного списка инструментов движка нет, его нужно добавить: `builtinTools: readonly string[]` в адаптер (`engines/*.ts`) — по нему форма показывает галочки, а валидатор предупреждает;
- имя, которого движок не знает, сейчас **молча отбрасывается** (проверено): `enabled = (name) => !Array.isArray(options.tools) || options.tools.includes(name)` (`providers/codex-tools.ts:83`) — это фильтр по 7 известным именам, а не проверка списка, поэтому лишние имена просто не находят пары. Нигде на пути (`parseManifest` packages.ts:328–331 проверяет только, что это список строк; `checkRolePatch` поле `tools` не принимает; `perm.reason.unknownTool` — это причина отказа в разрешении на вызов, а не проверка конфигурации) предупреждения нет. Роль с `WebFetch` на Codex останется без веба и даже не узнает об этом. Для Codex `WebSearch` — отдельный путь: в `options.tools` без `WebSearch` движок получает `web_search: 'disabled'` (`providers/codex.ts:234`).

Другие особенности:

- без `Bash` и `Edit` `capabilitiesOf` не выдаст `code.write`, без `WebSearch` — `research.web`;
- урезанный список отключает `ToolSearch`, поэтому MCP таким ролям нужен с `alwaysLoad` (D-2 §3.6);
- что из разрешённого спрашивать у владельца, решает `permissionMode` (+ классификатор `permissions.ts`), отдельно от списка;
- `parseManifest` принимает в `runtime.tools` любые строки, проверки имён нет.

Вместо голого списка форма предлагает пресеты: «Код» (все, `isolate: true`), «Документы» (без Bash, `docsDir`), «Исследование» (чтение + веб), «Свой набор» (галочки по `builtinTools` движка роли).

### 3.2. MCP-серверы из каталога

Подписка — `Role.mcp` / `runtime.mcp`, id из `mcpCatalog(settings)` офиса. На странице агента галочки уже есть (`AccessPanel`). Новый сервер владелец добавляет в настройках («Инструменты», `McpCatalog.tsx`); секреты — только `${NAME}` из окружения (ограничения в D-2: у MCP нет секретов офиса и нет OAuth). Пакет может объявить нужный сервер в `servers`: офис покажет просьбу, но сам его не подключит. Для своего агента: подписка на id из каталога, а при сохранении определение сервера копируется в `servers`, если его нет в `DEFAULT_MCP_SERVERS`, — чтобы агент в другом офисе мог его попросить. MCP работает на всех трёх движках (Claude Code — в процессе, Codex — dynamic-tools, OpenCode — мост `mcp-bridge.ts`).

### 3.3. Скилы

- Свои: `skills/<имя>/SKILL.md` (front matter `name`, `description`) внутри пакета. Подключаются плагином пакета, адресуются как `<plugin>:<skill>`.
- Встроенные скилы движка: `builtin` (например `design`, `artifact-capabilities`, `dataviz`) — по имени, без проверки на диске. Есть только у Claude Code.
- Чужие плагины: `use` — путь к установленному плагину (`~/.claude/plugins/...`, маска версии) + отбор `skills`.
- Хуки, команды, сабагенты и `.mcp.json` плагина офис намеренно не грузит (`IGNORED_PLUGIN_PARTS`).

Бриф описывает обязанности и границы и попадает в каждый промпт; скил — подробная инструкция к одному делу, грузится по требованию. Форме стоит это подсказывать: длинный бриф — повод вынести часть в скил.

---

## 4. Пробелы и список изменений

### 4.1. Сервер

1. **Починить `employeePack`** (skills.ts:218): брать папку пакета через `resolvePackage(role.package)?.dir`, а не `packageDir(name)`. Без этого не работают скилы пакетов из кеша маркета и не будут работать у локальных. Тест: роль из кеша получает свои скилы.
2. **Починить `createRole`** (state.ts:4506–4521): класть в роль `mcp` и `capabilities` из черновика.
3. **Хранилище локальных агентов** — новый модуль `src/server/myagents.ts`:
   - `LOCAL_AGENTS_DIR` (`~/.office/agents`, env `OFFICE_AGENTS_DIR`), `LOCAL_SCOPE = '@local'`;
   - `listLocalAgents()`, `loadLocalAgent(name)` поверх `listPackages/loadPackage(…, LOCAL_AGENTS_DIR)`;
   - `createLocalAgent(draft, lang)` — имя из названия (`slugifyRoleId`, уникальность в папке), сборка через `scaffoldPackage`, ошибки валидатора → `FieldError[]`;
   - `updateLocalAgent(name, patch, lang)` — переписать `agent.json`, бриф и скилы, поднять patch-версию в `plugin.json`, перевалидировать. Писать во временную папку и делать `rename`, чтобы на диске не остался битый пакет;
   - `deleteLocalAgent(name)` — только если ни один офис не держит на него ссылку (или переводить такие роли в `detachRole`);
   - `addLocalSkill / removeLocalSkill(name, skill, text)` — SKILL.md с front matter.
4. **Ссылка `local`**: `RoleLink.local?: true`; `resolvePackage` ищет такие пакеты в `LOCAL_AGENTS_DIR`; `hireFromPackage` принимает источник `local`. Допущение до ответа на **Q-204** — правка доезжает до всех сразу: после `updateLocalAgent` вызывается `updateRolePackage` для всех ролей с этой ссылкой во всех открытых офисах (`offices.ts`), а закрытые офисы подхватят правку при загрузке, потому что роль пересчитывается из пакета. Если владелец выберет «по кнопке», `updateRolePackage` не вызывается, и на карточке роли загорается «Обновить», как у пакетов маркета (`market_check`).
5. **Найм**: команда `my_agent_hire { name }` → `state.hireFromPackage(pkg, null, {}, …)` с `local`. Проверки уже существуют (`noDeskProblem`, `MAX_HIRE_COUNT`). Менеджера нанять нельзя: `manager` у своего агента не выставляется вообще.
6. **Валидация**:
   - список встроенных инструментов в адаптере движка (`EngineAdapter.builtinTools`, см. §3.1) и предупреждение `runtime.tools: unknown tool "X" for engine Y` в `parseManifest` и при найме;
   - `runtime.mcp` сверяется с каталогом офиса — предупреждение при найме, а не ошибка: каталоги у офисов разные;
   - лимиты: название ≤ 60, у брифа мягкий потолок с предупреждением о токенах;
   - `@local` и `@office` зарезервированы для публикации (`scopeProblem`).
7. **Правка `tools` у роли**: добавить `tools` в `RoleEditable`, `ROLE_EDITABLE_KEYS`, `OVERRIDABLE_KEYS` и `checkRolePatch` с проверкой по тому же списку. Это нужно и ролям руками, и для оверрайда поверх пакета.
8. **Протокол** (`src/shared/types.ts`, `src/server/index.ts`): команды `my_agents_list`, `my_agent_create { draft }`, `my_agent_update { name, patch }`, `my_agent_delete { name }`, `my_agent_skill { name, skill, text | null }`, `my_agent_hire { name }`, `my_agent_publish_prep { name, scope, dir }` (экспорт под своей областью = `scaffoldPackage` + подсказка `office-agent publish`). События: `my_agents { list }`, `my_agent.saved`, `my_agent.error { errors: FieldError[] }`. Черновик — `MyAgentDraft` с полями из таблицы §2.4.
9. **Витрина**: в `packageCards` появляется origin `local` — свои агенты видны в маркете рядом с остальными и нанимаются той же кнопкой.
10. **Скилы ролям руками в приложении**: `EMPLOYEES_DIR` в собранном приложении только для чтения. Варианты — перенести его в `~/.office/employees` или (лучше) направлять владельца в «своего агента»; `detach` не трогать.
11. **Менеджер** (по желанию, вторая очередь): инструмент PM «предложить своего агента» с черновиком; применяет его владелец кнопкой, как `propose_release_target`.
12. **Тесты**: `npm run test:myagents` — создание, валидатор, правка с поднятием версии, найм, пересчёт роли после правки, скилы из локального пакета в сессии (`employeeSkills`), предупреждение о неизвестном инструменте движка, экспорт под область.

### 4.2. Веб

1. **Окно «Команда»**: вкладка или раздел «Мои агенты» (либо фильтр в «Маркете» по origin `local`) и кнопка «Создать агента».
2. **Форма создания и правки своего агента** (`MyAgentForm.tsx`), шагами или вкладками, как страница агента:
   - «Кто»: название, описание, эмодзи, цвет из палитры, внешность;
   - «Инструкции»: бриф (большой текст, счётчик символов и ≈токенов, подсказка «бриф — границы, скил — инструкция к делу»);
   - «Модель»: уровень (по умолчанию) или конкретная модель;
   - «Как работает»: «с кодом в своей ветке» / «с документами в папке» → `isolate`/`docsDir`;
   - «Инструменты»: пресет + галочки встроенных по `builtinTools` выбранного движка (недоступные для движка — серые с пояснением), галочки MCP из каталога офиса (как в `AccessPanel`), список скилов с редактором SKILL.md, встроенные скилы;
   - «Способности» — галочки `CAPABILITIES`, свёрнуты, по умолчанию выводятся сами.
   Ошибки — `FieldError` под полями, тем же подходом, что `role.error`.
3. **Карточка своего агента** (`PackageCard` с origin `local`): «Нанять», «Править», «Удалить», «Подготовить к публикации».
4. **Страница нанятого агента**: на вкладке «Инструкция» у роли со ссылкой `local` вместо «только для чтения» — ссылка «Править агента» (правка меняет агента во всех офисах); `briefExtra` остаётся правкой офиса.
5. **Вкладка «Доступ»**: секция «Встроенные инструменты» (пресет + галочки) — после пункта 7 сервера.
6. **store**: `myAgentsList/Create/Update/Delete/Skill/Hire/PublishPrep`, срез `myAgents`.
7. Тексты `ru`/`en` в `src/web/i18n` для всех новых полей и ошибок.

### 4.3. Порядок задач

```
S1 (backend)  фиксы employeePack + createRole                   — независимо, сразу
S2 (backend)  myagents.ts + RoleLink.local + протокол            — после S1
S3 (backend)  tools в RoleEditable + builtinTools движков + валидатор
D1 (design)   форма «Свой агент» и место в окне «Команда»
W1 (frontend) список и форма своих агентов, найм                 — после S2, D1
W2 (frontend) «Встроенные инструменты» на вкладке «Доступ»        — после S3
```

### 4.4. Решения владельца (вопросы заданы, работа идёт по допущениям)

| Вопрос | Допущение | Если ответ другой |
|---|---|---|
| **Q-203** Где хранить своих агентов | На компьютере: `~/.office/agents/@local/<имя>` | Корень `<офис>/.office/agents`, при найме в другой офис пакет копируется; меняется только `LOCAL_AGENTS_DIR` и найм (S2) |
| **Q-204** Как правка доезжает до нанятых | Сразу у всех копий во всех офисах, со следующей задачи | Не вызывать `updateRolePackage` после правки и показывать «Обновить» через `market_check` (S2) |

Ни одно из решений не блокирует S1 и S3, а S2 различается в одной точке. Начинать задачи можно, не дожидаясь ответов.

---

## 5. Проверка утверждений (шаги verify и rework)

| Утверждение | Статус | Чем подтверждено |
|---|---|---|
| `employeePack` берёт папку пакета из `PACKAGES_DIR`, а не из кеша | подтверждено (verify) | skills.ts:216–218 против `resolvePackage` packages.ts:651, `PACKAGE_CACHE` packages.ts:65 |
| `createRole` теряет `mcp` и `capabilities` черновика | подтверждено (verify) | state.ts:4478 собирает `wanted`, объект роли 4506–4521 их не содержит |
| Номера строк `createRole`/`editRole`/`checkRolePatch`/`hireFromPackage`/`updateRolePackage`/`detachRole`/`parseManifest`/`resolvePackage` | подтверждено (verify) | state.ts — искать `grep -a` (файл бинарный для grep) |
| Неизвестное имя инструмента молча отбрасывается | подтверждено (rework) | `enabled()` codex-tools.ts:83 — фильтр; проверки имён нет ни в `parseManifest` (packages.ts:328–331), ни в `checkRolePatch` |
| Codex и OpenCode дают роли только 7 инструментов рук офиса | подтверждено по коду (rework) | `officeCatalog` codex-tools.ts:88–116 (Read, Write, Edit, Bash, Glob, Grep, TodoWrite); OpenCode зовёт тот же каталог через мост (providers/opencode.ts:590), свои инструменты движка запрещены в `buildConfig` (opencode.ts:215–216); `nativeHands: false` в engines/codex.ts:29 и engines/opencode.ts:72 |
| WebSearch: Claude Code ✓, Codex ✓ (свой), OpenCode ✗ | подтверждено по коду (rework) | `webSearch: true/true/false` в engines/claude-code.ts:202, engines/codex.ts:38, engines/opencode.ts:81; codex.ts:234 |
| Матрица на живых сессиях Codex/OpenCode | не проверялось | Нужны установленные движки и ключи; на рекомендации не влияет — в S3 список `builtinTools` берётся из того же кода адаптеров |
| Q-203, Q-204 | допущения | Вопросы владельцу заданы; влияют только на корень хранения и вызов `updateRolePackage` в S2 (§4.4) |

Код на шагах verify и rework не менялся; меняется только этот документ.
