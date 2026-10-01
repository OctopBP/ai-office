# Спека: провайдеры и универсальный движок

Задача T-188. Документ только проектирует, кода в задаче нет.

**Чего хочет владелец.** Офис не должен отдавать предпочтение ни одному
провайдеру. Сейчас Claude Code везде стоит первым: в README, в описании выпуска,
на первом запуске приложения, в отдельном пункте меню «Движок агентов…».
Решения владельца:

- раздел «Движок агентов» убрать, установку и вход перенести на экран
  «Провайдеры», который открывается при первом запуске;
- добавить Gemini и Qwen, а Grok, DeepSeek, OpenRouter и локальные модели
  подключить через **готовый** универсальный движок, свой цикл агента не писать;
- провайдер и модель задаются на офис, роль может их переопределить;
- **запасного провайдера при лимите не делать.**

Даты и версии внешних инструментов указаны на 2026-10-01. Что не проверено
руками и требует прототипа, помечено **[проверить]**.

---

## 1. Как сейчас подключены Claude Code и Codex

### 1.1. Граница провайдеров уже есть, но говорит на языке Claude

Все сессии офиса открываются одной функцией `query()` из
`src/server/providers/index.ts`. Она выбирает адаптер по `options.provider`:

| Файл | Что делает |
|---|---|
| `src/shared/providers.ts` | `PROVIDERS = { 'claude-code', codex }`, у каждого метка и модель по умолчанию. `providerOf(role)`: если поле пустое, это `claude-code`. `sessionForProvider()`: у сессий Codex префикс `codex:`, чужой id при продолжении отбрасывается |
| `src/server/providers/index.ts` | Реэкспортирует из `@anthropic-ai/claude-agent-sdk` типы `SDKMessage`, `Options`, `PermissionResult`, `SDKUserMessage` и функции `tool`, `createSdkMcpServer`, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`. `SessionOptions = Options & { provider }`: **параметры сессии — это тип Claude SDK**. Адаптер `claude-code` — прямой вызов `claudeQuery()` с `engineEnv` и `CLAUDE_ENV_FILE`, путь к бинарю берётся из `OFFICE_CLAUDE_BIN` |
| `src/server/providers/codex.ts` | Адаптер Codex. На каждую сессию поднимает `codex app-server --listen stdio://` (JSON-RPC в `rpc.ts`) и **переводит события Codex в формат `SDKMessage`**: `assistant`, `stream_event`, `result`, `rate_limit_event`, `system/init`, `system/compact_boundary`. Свои настройки движка лежат в `CODEX_HOME` = `<данные>/codex-runtime`, туда же симлинком кладётся `auth.json` владельца. Продолжение — `thread/resume`, сжатие — `thread/compact/start`. Лимиты ходов и бюджета адаптер считает сам |
| `src/server/providers/codex-tools.ts` | **Руки агента принадлежат офису.** Встроенные инструменты Codex выключены (`features.shell_tool: false` и другие, `sandbox: 'read-only'`, `approvalPolicy: 'never'`). Вместо них в `thread/start` уходят `dynamicTools`: свои Read/Write/Edit/Bash/Glob/Grep/TodoWrite/Skill, инструменты офиса из `createSdkMcpServer` (через `localTools` WeakMap) и внешние MCP-серверы роли, к которым офис подключается сам через `@modelcontextprotocol/sdk`. Bash выполняется через `command/exec` движка в песочнице `workspaceWrite` без сети |
| `src/server/providers/pricing.ts` | Codex не сообщает стоимость. Цену за токены можно задать переменной `OFFICE_CODEX_PRICING`, иначе `cost_unavailable` |
| `src/server/providers/diagnostics.ts` | `codexStatus()`: доступен ли app-server, есть ли вход (`account/read`), список моделей (`model/list`). Платный ход модели при этом не запускается. Отдаётся по `GET /api/providers/codex` (`index.ts:247`) и используется в `envcheck.ts` |

Вывод: адаптер у второго провайдера уже есть, но **словарь событий и
параметров — это Claude SDK**, и Codex подделывается под него. Третий и
четвёртый провайдер так же подделываться будут, только уже с потерями. Ниже,
в §5, этот словарь заменяется собственным.

### 1.2. Где выбирается провайдер и модель

- **Роль**: `Role.provider?: ProviderId` и `Role.model` (`src/server/roles.ts:19`,
  `src/shared/types.ts:301, 431`). На уровне офиса провайдера нет. В
  `Settings.engine` (`types.ts:686`) лежит `'local' | 'cloud'`, то есть
  «где работают исполнители», а не «каким движком».
- **Умолчания**: `createRole` ставит `claude-code` и `claude-sonnet-5-5`
  (`state.ts:3674`). Роль из старого сохранения без провайдера читается как
  `claude-code` (`state.ts:470`). При смене провайдера модель сбрасывается на
  `PROVIDERS[p].defaultModel` (`state.ts:3986`).
- **Пакеты**: в `agent.json` есть `runtime.engine`, по умолчанию `claude-code`
  (`packages.ts:312`). Модель по умолчанию `sonnet`, у codex — `default`. Алиасы
  `fable/opus/sonnet/haiku` разрешаются только для claude-code (`packages.ts:539`,
  `src/shared/models.ts`). Все встроенные пакеты `packages/@office/*` объявлены
  с `"engine": "claude-code"`. Экспорт роли в пакет по умолчанию тоже пишет
  `claude-code` (`export.ts:96`).
- **Облако**: `cloud.ts:66` прямо отказывает, если среди ролей есть не-Claude.
  Managed Agents существуют только у Anthropic, это честное ограничение.

### 1.3. Места, жёстко завязанные на `@anthropic-ai/claude-agent-sdk`

**Сессии.** Всего 12 мест с `query({...})`, и у каждого параметры в форме
`Options` SDK:

| Где | Сессия |
|---|---|
| `agents.ts:1698` `startPm` | менеджер, потоковый ввод `MessageQueue`, `includePartialMessages` |
| `agents.ts:2326` `holdMeeting` | участник совещания |
| `agents.ts:2447` `talkTo` | разговор владельца с сотрудником |
| `agents.ts:2560` `consultRole` | ответ на `ask_colleague`, только чтение |
| `agents.ts:2915` `startWorker` → `driveWorker` | исполнитель задачи |
| `agents.ts:3772` `runAgentSession` | исполнитель вне задачи: доработка, узлы процессов |
| `agents.ts:4232` `ritualSession` | ритуалы: консолидация, противоречия, рефлексия |
| `agents.ts:4313, 4425, 4560, 4610` `flowSession` | узлы процессов (`workflows.ts`) |
| `bench.ts:95` | стенд пакета |

Опции Claude, которые офис передаёт и которые у других движков называются
иначе или отсутствуют:

- `systemPrompt: { type: 'preset', preset: 'claude_code', append }`. Офис
  опирается на системный промпт Claude Code и только дописывает к нему своё.
  У других движков свой базовый промпт, а Codex сейчас получает склейку через
  `developerInstructions`.
- `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (`agents.ts:311`) делит промпт на
  кешируемую часть и журнал. Это граница кеша промпта, у других движков её нет.
- `settingSources: []` и `settings: { disableClaudeAiConnectors, autoCompactWindow }`
  (`agents.ts:225`, `workerSettings` в `agents.ts:3588`) изолируют сессию от
  настроек и коннекторов claude.ai владельца и задают окно автосжатия.
- `sandbox` (`SANDBOX`, `sandboxFor` в `agents.ts:323–360`) — песочница
  Claude Code с исключениями для Blender.
- `permissionMode: 'default'` + `canUseTool` (`permissionHandler`) — шлюз
  подтверждений офиса.
- `plugins: SdkPluginConfig[]` и `skills` (`skills.ts:43, 265`) — скилы роли
  в формате плагина Claude Code (`.claude-plugin/plugin.json`, `skills/*/SKILL.md`).
- `tools` — названия встроенных инструментов Claude Code (Read, Write, Edit,
  Bash, Glob, Grep, WebSearch, WebFetch, TodoWrite, Skill).
- `maxTurns`, `maxBudgetUsd`, `abortController`, `resume`, `cwd`,
  `additionalDirectories`, `model`.

**MCP-инструменты офиса.** Наборы `teamTools` (`agents.ts:844`, менеджер:
`create_task`, `ask_owner`, `say` и десятки других), `workerTools`
(`agents.ts:2618`: `say`, `check_criterion`, `ask_colleague`, `ask_owner`,
`finish_task`), `ritualTools` (`agents.ts:4166`), а также наборы в
`agents.ts:3935, 4037` собираются через `createSdkMcpServer` + `tool()` из SDK.
Это MCP-сервер **в процессе**, который понимает только Claude SDK. Codex их
получает обходным путём через `localTools` → `dynamicTools`.
Внешние MCP роли (`src/server/mcp.ts:25`) описаны типом `McpServerConfig` из SDK.

**Продолжение сессии.** `resume: <id>` в `startPm` (`agents.ts:1693`), у
исполнителя после лимита и на доработке (`agents.ts:2907, 3862`), повтор на
широком окне после зацикленного сжатия (`driveWorker`, `agents.ts:3670–3700`).
Сжатие запрашивается командой `/compact` в потоке ввода, конец сжатия
распознаётся по `system/compact_boundary`. Зацикленное сжатие распознаётся по
тексту SDK `Autocompact is thrashing` (`agents.ts:3598`).

**Лимиты.** `src/server/limits.ts` читает `rate_limit_event.rate_limit_info`
(`status`, `resetsAt`, `utilization`, `rateLimitType`) и ответ
`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` живой сессии
(`pollLimits`, вызывается из `agents.ts:1737, 3621`). Виды окон в
`REPORT_KINDS`: claude `five_hour`, `seven_day*` и codex `codex_primary/secondary`.
Трекер заведён на провайдера (`createLimitTracker`), файл `limits.json` или
`limits-<provider>.json`. Отказ по лимиту и ожидание сброса — `limitBlock(now, provider)`.
Флаг `msg.error === 'rate_limit'` на `assistant` (`agents.ts:497`) — тоже
формат Claude.

**Расходы.** Стоимость берётся из `result.total_cost_usd` (`agents.ts:538`),
токены из `message.usage` в форме Anthropic (`input_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`).
Дальше работают `spend.ts` и `Usage` в `types.ts`. Codex обязан
подделывать эти поля.

**Модели по ролям.** `src/shared/models.ts`: `MODEL_ALIASES` (fable/opus/sonnet/haiku →
claude-*), `MODEL_IDS` (только Claude), `currentModel` в `roles.ts` переводит
устаревшие поколения Claude на текущие. В вебе фиксированный список
`claudeModels` (`AgentPanels.tsx:35`), у Codex свободное поле.

**Установка движка.**

- `desktop/engine.js` ищет `claude` в PATH или скачивает из npm пакет
  `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` ровно той версии, что у
  SDK (~310 МБ), в `engineDir()/<версия>/`. Бинарь проприетарный, в установщик
  его класть нельзя.
- `desktop/main.js`: `ensureEngine()` вызывается **при каждом запуске**
  (`main.js:571`), какие бы провайдеры ни стояли у ролей. На первом запуске
  показывается `boot.html` с выбором «Скачать движок» (`boot:need-engine`).
  В меню «Офис» → «Движок агентов…» (`main.js:313–373`). Путь к бинарю
  передаётся серверу переменной `OFFICE_CLAUDE_BIN`.
- Codex приложение не ставит: `codexBinary()` ищет `OFFICE_CODEX_PATH`, затем
  `/Applications/Codex.app` и `ChatGPT.app`, затем `codex` из PATH. Если ничего
  не нашлось, `envcheck` пишет «поставьте Codex CLI».
- Сборка: `scripts/pack-desktop.mjs:77` и `scripts/build-server.mjs:44` всегда
  везут SDK Claude.

**Проверки окружения** (`src/server/envcheck.ts`). `keyCheck` выполняется
всегда, даже если в офисе нет ни одной роли Claude, и проверяет только
`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`. `engineCheck` (только в
приложении, только при ролях Claude) и `provider:codex` входят в `CRITICAL`.

**Ключи.** В системной связке ключей сейчас не хранится ничего: Anthropic
читается из окружения или из входа Claude Code, OpenAI — из
`~/.codex/auth.json` или `OPENAI_API_KEY`. `childenv.ts` (T-200) не пускает
ключи в окружение команд агента: `engineEnv` и `projectEnv`, `UNSET_PROVIDER_SECRETS`.

---

## 2. Где Claude подан как обязательный

Обозначения: **А** — Claude назван обязательным или единственным, **Б** —
Claude стоит первым или выбран по умолчанию.

### 2.1. Документы

| Место | Текст | |
|---|---|---|
| `README.md:22` | «движок Claude Code приложение ставит себе само при первом запуске» | А |
| `README.md:33–34` | «**Claude Code CLI** (`claude` → `/login` либо `ANTHROPIC_API_KEY`) и/или … **Codex CLI**» | Б |
| `README.md:42` | `npm run smoke # доступ к Claude…` — первая проверка только для Claude | Б |
| `CONTRIBUTING.md:20–21` | для разработки нужен «Claude Code CLI … либо `ANTHROPIC_API_KEY`», Codex не упомянут | А |
| `OFFICE.md:21, 52` | «Движок агентов — `@anthropic-ai/claude-agent-sdk`», «движок Claude Code» | А |
| `docs/guide/desktop.md:14–24, 183` | строка «Движок Claude Code — ставится при первом запуске», ~310 МБ, «подписка Claude … как и везде в офисе», «процессы claude (движок)» | А |
| `docs/guide/status.md:10` | «работают реальными инструментами Claude Code (Read/Write/Edit/Bash/Grep)» | А |
| `docs/guide/running.md:7–12, 22–38` | индикатор 🔑/💳 описан как индикатор Claude, проверки для Claude идут первыми | Б |
| `docs/guide/team.md:8–9` | команда по умолчанию — Opus/Sonnet, «полный набор Claude Code» | Б |
| `packages/README.md:3, 16` | «Пакет — это **плагин Claude Code**» | Б |
| `.env.example:4–9` | раздел «Доступ к Claude» — единственный раздел про доступ к моделям | Б |
| `CONCEPT.md:13, 59, 283, 379` | один движок, типы и цены только для Claude | А (исторический документ — поставить пометку, а не переписывать) |

Нейтральные упоминания («Claude Code или Codex», «облако — только Managed
Agents») в `architecture.md`, `offices.md` и `team.md:151` можно не трогать.

### 2.2. GitHub и выпуски

| Место | Текст | |
|---|---|---|
| `.github/workflows/release.yml:167–170` | тело выпуска: «Движок Claude Code (~310 МБ) в установщик не вшит … Нужен доступ к модели: подписка Claude (`claude` → `/login`) или `ANTHROPIC_API_KEY`» | А |
| `scripts/release-notes.mjs` | упоминаний Claude нет, но абзац про движок из `release.yml` попадает в каждый выпуск — править там | — |
| `.github/ISSUE_TEMPLATE/*`, `PULL_REQUEST_TEMPLATE.md` | чисто | — |
| Описание репозитория и темы на GitHub | не в репозитории; проверить руками при выпуске этапа 5 | ? |

### 2.3. Приложение (desktop)

| Место | Текст или поведение | |
|---|---|---|
| `desktop/boot.html:67, 70, 106` | «нужен движок Claude Code — около 310 МБ», кнопка «Скачать движок», «Движок агентов не найден» | А |
| `desktop/main.js:243–265, 571` | `ensureEngine()` при каждом запуске: «Ищу движок агентов…», «Продолжаю без движка» | А |
| `desktop/main.js:313–331, 373` | меню «Движок агентов…» и его диалоги | А |
| `desktop/engine.js:2, 121–156` | «Движок агентов: нативный Claude Code», тексты ошибок скачивания | А |

Строки в `boot.html` и `main.js` зашиты по-русски мимо `desktop/i18n.js` —
при переделке перенести их в словарь.

### 2.4. Тексты интерфейса и сервера (i18n)

**`src/server/i18n/{ru,en}.ts`:**

| Ключ | Текст | |
|---|---|---|
| `env.engine.title` | «Движок агентов» | А |
| `env.engine.ok` | «Claude Code на месте: {path}» | А |
| `env.engine.none` | «Движок не установлен — без него не выполнится ни одна задача» | А |
| `env.engine.noneFix` | «Меню «Офис» → «Движок агентов…»» | А |
| `env.key.title` | «Ключ модели» (на деле только ключ Anthropic) | А |
| `env.key.subscription` | «работаем на авторизации Claude Code (лимиты подписки)» — показывается и офису, где только Codex | А |
| `env.key.apiKey` | «Задан ANTHROPIC_API_KEY…» | Б |
| `boot.paidApi`, `boot.subscription` | «…подписку Claude Code» в консоли при каждом старте (`index.ts:749`) | Б |

**`src/web/i18n/{ru,en}.ts`:**

| Ключ | Текст | |
|---|---|---|
| `shell.user` | «Claude Code» — подпись блока аккаунта внизу рейла | А |
| `shell.auth.subscription`, `shell.auth.api-key` | «Claude: подписка», «Claude: ключ API» | Б |
| `shell.auth.unknown` | «не авторизован» — у офиса только с Codex выходит «Claude Code · не авторизован» | А |
| `settings.mcp.hint` | «Инструменты, которых нет в самом Claude Code…» | Б |

Тексты «лимит плана подписки» (`sup.limit*`, `board.limited`,
`notify.limitPlan`) нейтральны, но годятся только для подписок. Для провайдеров
по ключу понадобится вариант «упёрлись в лимит запросов» или «кончился баланс».

### 2.5. Экраны и умолчания

- **Рейл** `src/web/shell/Rail.tsx:20–23, 398–404`: блок аккаунта
  показывает только авторизацию Claude Code (`AUTH_PROVIDER`). Вход в Codex там
  не виден. — А
- **Мастер нового офиса** (`src/server/setup.ts`, `src/web/SetupWizard.tsx`):
  провайдера выбрать нельзя. Роли берутся из пакетов, а у всех пакетов
  `claude-code`, поэтому новый офис неявно получается целиком на Claude. — Б
- **Форма роли** `AgentPanels.tsx:251`: `claude-code` первым в списке, потому
  что первый в `PROVIDERS`. Список моделей есть только у Claude. — Б
- **Создание роли и загрузка состояния**: `claude-code` по умолчанию
  (`state.ts:470, 3674`, `providerOf`). — Б
- **Пакеты**: `runtime.engine` по умолчанию `claude-code`, сообщение
  валидатора «an alias (fable, opus, sonnet, haiku)» (`packages.ts:312–315`),
  `.claude-plugin/plugin.json` обязателен для любого пакета (`packages.ts:437`). — Б
- **Шкалы лимитов** `LimitBars.tsx:77`, `limits.ts:347`: окно без
  провайдера считается окном Claude и показывается без подписи. — Б
- Отдельного экрана «Движок» в вебе нет: он существует только в меню
  приложения. «Где работают исполнители» (`SettingsPage.tsx:489`) — это выбор
  между локальным режимом и облаком, не выбор движка.

---

## 3. Универсальный движок: сравнение кандидатов

Нужен готовый агент, который:

1. работает без интерфейса и управляется из Node: поток событий, отмена,
   несколько ходов в одной сессии;
2. принимает инструменты офиса по MCP;
3. позволяет отключить свои руки или пропускает их через шлюз подтверждений;
   хорошо, если есть песочница;
4. продолжает сессию по id после перезапуска;
5. говорит с API в формате OpenAI и с родными API: Grok (xAI), DeepSeek,
   OpenRouter, Ollama и LM Studio, по возможности Gemini и Qwen;
6. отдаёт токены и, по возможности, стоимость;
7. имеет лицензию, которая разрешает возить или скачивать его приложением;
8. ставится на macOS и Windows без компилятора.

### 3.1. Таблица

| | **OpenCode** | **Codex CLI со своим model provider** | **Qwen Code** (как универсальный) | **Goose** | Crush | Aider |
|---|---|---|---|---|---|---|
| Без интерфейса | `opencode serve`: HTTP + SSE `/event`, сессии `POST /session`, `prompt_async`, `abort`; также `run --format json` и `acp` | `codex app-server` (JSON-RPC по stdio) — **уже подключён** | SDK `@qwen-code/sdk`: `query()` повторяет Claude Agent SDK; `--output-format stream-json`, `--acp`, `qwen serve` | `goose run` (рецепты), режим ACP | `crush run`, формат событий [проверить] | `--message`, без потока событий |
| MCP | stdio и http в конфиге; конфиг на сессию — через `OPENCODE_CONFIG_CONTENT`. Серверов в процессе нет → нужен мост офиса (§5.4) | `dynamicTools` (экспериментальный API) или `mcp_servers` в конфиге | `mcpServers`, **есть `createSdkMcpServer`/`tool`** в процессе | да (расширения = MCP) | да | нет |
| Свои руки и подтверждения | права allow/ask/deny по инструментам и шаблонам bash; `ask` приходит событием, ответ — `POST /session/:id/permissions/:id`; инструменты можно выключить на агента | встроенные выключены, руки офиса, `approvalPolicy: never` | `permissionMode` + `canUseTool` как в Claude SDK | режимы approve/smart/auto | ask/yolo | подтверждения в терминале |
| Песочница ОС | **нет** | **да**: `command/exec` с `workspaceWrite` (macOS seatbelt, Linux landlock/bwrap, Windows — экспериментально) | есть флаг `--sandbox` (наследие Gemini CLI: docker или seatbelt) [проверить] | нет | нет | нет |
| Продолжение | сессии хранятся движком, `--session <id>`, `GET /session/:id` | `thread/resume` | `resume` в SDK | `goose session resume` (запрет resume в документации касается Goose как клиента чужих ACP-агентов, не его сервера) | да | история чата |
| Grok, DeepSeek, OpenRouter, Ollama, LM Studio | **все**, 75+ провайдеров через AI SDK и models.dev, любой OpenAI-совместимый `baseURL` | только **Responses API**: `wire_api = "chat"` убирается — первоисточник, issue #7413, содержит предупреждение от 26.01.2026 о жёсткой ошибке с февраля 2026; само удаление подтверждают только вторичные источники [проверить]. xAI, OpenRouter (бета), Ollama, LM Studio — да; DeepSeek — Responses API есть, но в документации назван только `deepseek-flash`, даты запуска нет [проверить] | любой OpenAI-совместимый (Chat Completions), плюс Anthropic и Gemini | 15+ провайдеров | много | много (litellm) |
| Gemini, Qwen напрямую | да: провайдеры Google и Alibaba | **нет**: у Google OpenAI-совместимый только Chat Completions | да | Gemini да | да | да |
| Токены и стоимость | токены и `cost` на сообщение, цены из models.dev (баг: `cache.read` не входит в стоимость, занижение в 2–3 раза, #28494 закрыт автоматически без разбора, исправлен ли — неизвестно, проверить на зафиксированной версии [проверить]; у своих провайдеров цены нет, #17223 закрыт как not planned, поэтому их цены офис считает сам) | только токены; цена — наша таблица `OFFICE_CODEX_PRICING` | токены в `result`, полнота [проверить] | токены | токены и стоимость | стоимость в отчёте |
| Лицензия | **MIT** | Apache-2.0 | Apache-2.0 | Apache-2.0 (Linux Foundation, AAIF) | FSL-1.1 (через 2 года становится MIT) | Apache-2.0 |
| Установка | один нативный бинарь: npm `opencode-ai` (платформенные пакеты), brew, scoop, choco, curl; Windows нативно | npm `@openai/codex` (нативный бинарь), brew; Windows — да | npm, **нужен Node 22+**; brew; скрипт PowerShell | бинарь, Windows — да | бинарь | Python |

### 3.2. Почему не Goose, Crush и Aider

- **Aider** без MCP и без потока событий — не подходит.
- **Crush**: FSL — лицензия с исходниками, но не открытая. Для продукта,
  который хочет быть нейтральным и открытым, лучше без неё. Программный
  интерфейс беднее, чем у OpenCode.
- **Goose** — достойная запасная альтернатива: Apache-2.0, ACP, много
  провайдеров. Отказ основан не на продолжении сессии: документированный
  запрет `goose session resume` относится к режиму, когда Goose сам
  *клиент* чужих ACP-агентов (Claude, Codex), а не к его собственному
  серверу, поэтому основанием отказа он не служит. Основание другое: у
  Goose нет подтверждённого потока событий с подтверждениями и учётом
  стоимости, сопоставимого с сервером OpenCode, а проверять его ради
  запасного плана нет смысла, пока прототип OpenCode не провалился
  [проверить].

### 3.3. Почему не Codex в роли универсального движка

Это самый дешёвый путь: адаптер уже написан, руки и песочница офиса уже на
месте. Его стоит держать запасным планом (§3.5), но основным не выбирать:

1. **Только Responses API.** OpenAI уже объявил отказ от Chat Completions
   в Codex (предупреждение в issue #7413 от 26.01.2026 о жёсткой ошибке с
   февраля; удаление подтверждают только вторичные источники [проверить]),
   и всё, что говорит только на нём, отваливается.
   Gemini и многие локальные серверы на нём не работают. Офис, который
   обещает нейтральность, не должен держать охват чужих провайдеров на
   решениях OpenAI.
2. **Нет цен.** Таблицу цен для каждой модели каждого провайдера пришлось
   бы вести самим.
3. **`model/list` знает только модели OpenAI.** Для чужих провайдеров
   список моделей пришлось бы собирать в обход движка.
4. `dynamicTools` и `experimentalApi` помечены экспериментальными.

### 3.4. Почему не Qwen Code в роли универсального движка

Интерфейс SDK почти совпадает с Claude Agent SDK (`query`,
`createSdkMcpServer`, `canUseTool`, `resume`). Переносить на него было бы
легче всего. Против:

- требует Node 22+ рядом с бинарём. Приложение вынуждено было бы везти
  свой Node или зависеть от системного;
- SDK объявлен «minimum experimental»;
- учёт стоимости не описан;
- проект ориентирован на модели Qwen: бесплатный вход Qwen OAuth закрыт
  15.04.2026, развитие идёт вокруг Alibaba Coding Plan.

Как второй адаптер для Qwen он полезен (§4.2), как общий движок — нет.

### 3.5. Рекомендация: OpenCode

**Универсальным движком берём OpenCode.** Codex со своим model provider —
запасной план: если прототип OpenCode (этап 2) не пройдёт, офис получит
Grok, DeepSeek, OpenRouter и Ollama через уже готовый адаптер, без нового
движка.

Обоснование:

1. **Охват.** Все целевые провайдеры (xAI, DeepSeek, OpenRouter, Ollama,
   LM Studio, Google, Alibaba) и любой OpenAI-совместимый адрес. Работает и
   через Chat Completions, и через родные API. Ни на чьё решение об API не
   завязан.
2. **Деньги.** Токены и стоимость на каждом сообщении, цены из models.dev.
   Баг с `cache.read` (#28494, закрыт автоматически, исправлен ли —
   неизвестно [проверить]) обходим: стоимость пересчитываем сами по токенам
   и цене из того же models.dev (`GET /config/providers` [проверить]). Цены
   своих провайдеров OpenCode не знает (#17223 — not planned), их офис
   считает сам.
3. **Управление.** Сервер с сессиями, SSE, отменой и API подтверждений —
   ближе всего к тому, как офис уже работает с Codex.
4. **MIT и один бинарь** для macOS и Windows. Его можно скачивать из npm
   тем же механизмом, что и Claude (`desktop/engine.js`), а по лицензии можно
   даже класть в установщик.
5. **Нейтральность.** Движок не принадлежит ни одному поставщику моделей.

Чем платим и как закрываем:

- **Песочницы ОС нет.** Решение — та же схема, что у Codex: встроенные руки
  OpenCode выключаем (`tools: { bash: false, edit: false, write: false, … }`
  в агенте), руки дают инструменты офиса через мост MCP (§5.4). Bash офиса
  на macOS и Linux запускается в `@anthropic-ai/sandbox-runtime`
  (Apache-2.0; seatbelt и bubblewrap, нативного модуля нет; на Linux нужны
  `bubblewrap`, `socat` и `ripgrep`, на macOS — `ripgrep`) [проверить]. На
  **Windows** sandbox-runtime есть только в статусе alpha, полагаться на
  него не будем: матрица отдаёт `sandbox: false`, и режим подтверждений
  роли автоматически ужесточается (Bash всегда с подтверждением, кроме
  режима `auto`, о чём форма роли предупреждает).
- **MCP только из конфига.** Нужен мост офиса: локальный Streamable HTTP
  MCP с токеном на сессию (§5.4). Документация OpenCode описывает
  `type: "remote"` с `url`, `headers` и `timeout`, но Streamable HTTP или
  SSE прямо не называет [проверить]. Запасной вариант — поднять мост с
  SSE-транспортом или подключить его как `type: "local"` через локальный
  процесс-прокладку, который ходит на мост. Тот же мост потом можно отдать Codex,
  Qwen Code и Antigravity, и `localTools`/`dynamicTools` станут не нужны.
- **API быстро меняется.** Фиксируем версию движка так же, как фиксируем
  версию Claude: офис скачивает ровно ту, под которую проверен адаптер, и
  отключает самообновление (`autoupdate: false`, `share: "disabled"`).
- **Подписку Claude Pro/Max через OpenCode использовать нельзя:** Anthropic
  это запрещает, с версии 1.3.0 плагины убраны (номер версии [проверить]). Claude остаётся своим
  адаптером `claude-code`, OpenCode к Anthropic не подключаем.

---

## 4. Gemini CLI и Qwen Code

### 4.1. Gemini

**Ситуация изменилась по сравнению с планом владельца.** Google объявил в
мае 2026 (блог Google Developers): с 18.06.2026 Gemini CLI не обслуживает
Google AI Pro/Ultra и бесплатный личный уровень; платные ключи API и
корпоративные лицензии работают. Замена — **Antigravity CLI**
(`agy`): закрытый, на Go, заново написанный. Организации с лицензией Gemini
Code Assist пока могут пользоваться старым CLI.

| | Gemini CLI (старый) | Antigravity CLI |
|---|---|---|
| Без интерфейса | `-p`, `--output-format json/stream-json` (`init`, `message`, `tool_use`, `tool_result`, `result` со `stats`), `--acp` (JSON-RPC: `initialize`, `authenticate`, `newSession`, `loadSession`, `prompt`, `cancel`) | только `-p/--print` одним блоком, без потока и без продолжения. ACP запрошен (issue #31), но ответа нет |
| MCP | да, MCP-серверы передаются в ACP на `initialize`, а не на `newSession` [проверить] | [проверить] |
| Песочница | `--sandbox` (docker или seatbelt) | [проверить] |
| Продолжение | `-r/--resume`, `loadSession` (в ACP на Windows есть баги, #29288) | нет |
| Вход | вход Google — **закрыт для частных лиц**; `GEMINI_API_KEY`, Vertex — по объявлению работают и после 18.06 | аккаунт Google, `AV_API_KEY` |
| Лицензия | Apache-2.0 | проприетарная |
| Установка | npm (Node 20+) | `curl … \| bash`, Windows [проверить] |

**Вывод.** Строить адаптер на Gemini CLI сейчас — значит строить на
выводимом из оборота инструменте. Antigravity CLI пока нельзя управлять
программно. Поэтому:

- **Gemini по API-ключу подключаем через OpenCode** (провайдер Google). Это
  работает уже на этапе 3, без отдельного движка.
- **Отдельный адаптер `antigravity`** — поздний необязательный этап (этап 6),
  как только у `agy` появится ACP или поток JSON с продолжением. Он нужен
  ради входа по подписке Google AI Pro/Ultra, которой по ключу нет.

Вопрос владельцу задан (Q-46). Спека пока исходит из этого допущения.

### 4.2. Qwen Code

| | Qwen Code |
|---|---|
| Без интерфейса | TS SDK `@qwen-code/sdk` (`query`, `canUseTool`, `resume`, `abortController`, `mcpServers`, `createSdkMcpServer`), `stream-json`, `--acp`, `qwen serve` (HTTP + SSE) |
| MCP | stdio и http, а также серверы в процессе через SDK |
| Подтверждения | `permissionMode`: default, plan, auto-edit, auto, yolo; `canUseTool` с тайм-аутом 60 с |
| Продолжение | `resume` по id |
| Вход | **Qwen OAuth закрыт 15.04.2026.** Остались Alibaba Cloud Coding Plan (подписка через отдельный адрес), Token Plan (по факту) и любой ключ (OpenAI, Anthropic, Gemini, свой адрес). Ключи читаются из окружения, `.qwen/.env` и `~/.qwen/settings.json` |
| Токены и стоимость | [проверить] |
| Лицензия | Apache-2.0 |
| Установка | npm (**Node 22+**), brew, скрипт PowerShell для Windows |

**Вывод.** Модели Qwen по ключу DashScope и Coding Plan — это
OpenAI-совместимые адреса, и OpenCode их обслуживает (провайдер Alibaba или
свой `baseURL`); принимает ли адрес Coding Plan сторонний клиент —
[проверить].
Поэтому **Qwen на этапе 3 подключаем через OpenCode**. Адаптер `qwen-code`
поверх его SDK — этап 6 и только если окажется, что Coding Plan пускает
лишь свой клиент. SDK так похож на Claude Agent SDK, что адаптер выйдет
тонким. Минус — Node 22+ рядом.

---

## 5. Проект интерфейса EngineAdapter

### 5.1. Понятия

- **Движок** (`EngineId`) — программа, которая ведёт цикл агента:
  `claude-code`, `codex`, `opencode`, позже `qwen-code`, `antigravity`.
  Ставится, обновляется, проверяется.
- **Провайдер** (`ProviderId`) — у кого модель и чей счёт: `anthropic`,
  `openai`, `xai`, `deepseek`, `openrouter`, `google`, `alibaba`, `ollama`,
  `lmstudio`, `custom` (любой OpenAI-совместимый адрес). Провайдер
  обслуживается одним движком. Пользователь видит **провайдеров**, движок —
  деталь реализации экрана «Провайдеры».

В сохранениях `provider: 'claude-code' | 'codex'` остаются как есть и при
загрузке читаются как `anthropic` и `openai` (миграция в `state.ts`, по
образцу `LEGACY_ROLE_COLORS` в `roles.ts`).

### 5.2. Типы

```ts
// src/shared/providers.ts — общий контракт с вебом

export type EngineId = 'claude-code' | 'codex' | 'opencode' | 'qwen-code' | 'antigravity';

export type ProviderId =
  | 'anthropic' | 'openai'                    // свои движки
  | 'xai' | 'deepseek' | 'openrouter'         // через OpenCode
  | 'google' | 'alibaba'
  | 'ollama' | 'lmstudio' | 'custom';

/** Как провайдер пускает: подписка (вход в браузере), ключ API или без входа (локальные модели). */
export type AuthKind = 'subscription' | 'api-key' | 'none';

export interface ProviderInfo {
  id: ProviderId;
  label: string;                 // «Anthropic (Claude)», «xAI (Grok)», …
  engine: EngineId;
  auth: AuthKind[];              // что из этого принимает провайдер
  /** OpenAI-совместимый адрес по умолчанию; у custom его задаёт пользователь. */
  baseUrl?: string;
  cloud: boolean;                // есть облачный режим (сейчас только anthropic)
}

/** Состояние провайдера на экране «Провайдеры» и в проверках окружения. */
export type ProviderStatus =
  | { state: 'not-installed'; engine: EngineId; sizeMb?: number }
  | { state: 'installing'; engine: EngineId; share: number }
  | { state: 'needs-login'; auth: AuthKind[]; detail?: string }
  | { state: 'unreachable'; detail: string }  // Ollama не запущен, адрес не отвечает
  | { state: 'ready'; account?: string; auth: AuthKind; plan?: string }
  | { state: 'limited'; resetsAt?: number; kind: 'plan' | 'rate' | 'balance'; detail?: string }
  | { state: 'error'; detail: string };

/** Провайдер и модель: на офисе — обязательно, на роли — переопределение. */
export interface ModelChoice {
  provider: ProviderId;
  /** Полный id модели провайдера или алиас уровня (см. ModelTier). */
  model: string;
}

/**
 * Нейтральные алиасы вместо fable/opus/sonnet/haiku: пакет называет уровень,
 * офис разрешает его в модель выбранного провайдера. Старые алиасы Claude
 * остаются синонимами: opus → top, sonnet → balanced, haiku → fast.
 */
export type ModelTier = 'top' | 'balanced' | 'fast';

export interface ModelInfo {
  id: string;
  label: string;
  tier?: ModelTier;
  contextWindow?: number;
  /** USD за миллион токенов; нет — стоимость не считается (cost_unavailable). */
  price?: { input: number; cachedInput?: number; cacheWrite?: number; output: number };
}
```

```ts
// src/server/engines/types.ts — серверная граница, вебу не видна

import type { EngineId, ProviderId, ProviderStatus, AuthKind, ModelInfo } from '../../shared/providers';

/** Что движок умеет. По матрице офис решает, что показать и что разрешить. */
export interface EngineCapabilities {
  subscriptionLogin: boolean;     // вход по подписке в браузере
  apiKeyLogin: boolean;
  resume: boolean;                // продолжение сессии по id после перезапуска
  streamingInput: boolean;        // несколько ходов в одной сессии (менеджер)
  partialText: boolean;           // текст по кусочкам (пузыри, чат)
  officeTools: 'in-process' | 'mcp-bridge' | 'dynamic-tools';
  nativeHands: boolean;           // свои Read/Edit/Bash, пропущенные через шлюз подтверждений
  sandbox: boolean;               // песочница ОС для команд (на этой платформе)
  compaction: 'auto-window' | 'auto' | 'manual' | 'none';
  costUsd: 'reported' | 'computed' | 'none';
  planLimits: boolean;            // окна подписки с процентами и сбросом
  balance: boolean;               // остаток денег у провайдера (OpenRouter, DeepSeek)
  skills: 'plugin' | 'tool' | 'none'; // скилы роли: плагином движка или инструментом Skill офиса
  webSearch: boolean;
  cloud: boolean;
}

export interface InstallProgress { share: number; bytes?: number; note?: string }

export interface LoginRequest {
  provider: ProviderId;
  kind: AuthKind;
  /** Для api-key: ключ сразу уходит в связку ключей, в состояние офиса не пишется. */
  apiKey?: string;
  /** Для custom, ollama и lmstudio: адрес. */
  baseUrl?: string;
}
export type LoginStart =
  | { done: true; status: ProviderStatus }
  | { done: false; authUrl: string; loginId: string };   // открыть в браузере и ждать onLoginCompleted

/** Всё, что нужно сессии, без типов какого-либо SDK. */
export interface SessionSpec {
  kind: 'manager' | 'worker' | 'consult' | 'meeting' | 'talk' | 'ritual' | 'flow' | 'bench';
  provider: ProviderId;
  model: string;                  // уже разрешённый полный id
  cwd: string;
  readableDirs?: string[];        // additionalDirectories
  /** Промпт офиса: постоянная часть кешируется, журнал идёт после границы. */
  system: { stable: string; dynamic?: string };
  /** Ввод: одна строка (исполнитель) или очередь сообщений (менеджер). */
  input: string | AsyncIterable<string>;
  resume?: string;                // id сессии этого же движка; чужой адаптер отбрасывает
  hands: HandName[] | null;       // null — полный набор
  officeTools: OfficeToolset[];   // наборы офиса (teamTools, workerTools, …)
  externalMcp: Record<string, ExternalMcp>; // из server/mcp.ts, уже в нейтральной форме
  skills?: SkillRef[];
  permission: PermissionGate;     // шлюз офиса (permissions.ts)
  limits: { maxTurns?: number; maxBudgetUsd?: number; contextWindow?: number };
  sandbox?: { extraUnsandboxed?: string[] };  // исключения вроде Blender
  signal: AbortSignal;
}

export type HandName = 'Read' | 'Write' | 'Edit' | 'Bash' | 'Glob' | 'Grep' | 'WebSearch' | 'WebFetch' | 'TodoWrite' | 'Skill';

/** Инструмент офиса без привязки к SDK: zod-схема и обработчик. */
export interface OfficeTool<I = any> {
  name: string;
  description: string;
  input: import('zod').ZodRawShape;
  run(input: I): Promise<ToolOutput>;
}
export interface OfficeToolset { server: string; tools: OfficeTool[] }
export type ToolOutput = { content: Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }>; isError?: boolean };

export type ExternalMcp =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

export interface SkillRef { id: string; dir: string; file: string }

export interface PermissionGate {
  (tool: string, input: Record<string, unknown>, ctx: { signal: AbortSignal; callId: string }):
    Promise<{ behavior: 'allow'; input?: Record<string, unknown> } | { behavior: 'deny'; message: string }>;
}

/** Словарь событий офиса. agents.ts читает только его. */
export type EngineEvent =
  | { t: 'init'; sessionId: string; model: string; auth: AuthKind }
  | { t: 'text-delta'; text: string }
  | { t: 'text'; text: string }
  | { t: 'thinking'; text: string }
  | { t: 'tool-call'; callId: string; name: string; input: Record<string, unknown> }
  | { t: 'tool-result'; callId: string; isError: boolean; text?: string }
  | { t: 'usage'; usage: TokenUsage; costUsd?: number }     // нарастающий итог хода
  | { t: 'compacted'; preTokens?: number; postTokens?: number }
  | { t: 'compact-failed'; reason: 'thrash' | 'error'; detail?: string }
  | { t: 'limit'; status: 'allowed' | 'warning' | 'rejected'; kind: 'plan' | 'rate' | 'balance';
      window?: string; utilization?: number; resetsAt?: number }
  | { t: 'turn-end'; ok: boolean; text: string; reason?: 'max-turns' | 'budget' | 'limit' | 'error' | 'aborted';
      error?: string; usage: TokenUsage; costUsd: number | null; turns: number };

export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number }

export interface EngineSession extends AsyncIterable<EngineEvent> {
  readonly provider: ProviderId;
  /** Принудительное сжатие контекста (если compaction !== 'none'). */
  compact?(): Promise<void>;
  /** Полная картина лимитов и баланса без платного хода. */
  limits?(): Promise<LimitReport>;
  mcpStatus(): Promise<Array<{ name: string; status: 'connected' | 'failed'; error?: string }>>;
  stop(): void;
}

export interface LimitReport {
  plan?: string;
  windows: Array<{ id: string; utilization: number; resetsAt?: number }>;
  balance?: { remainingUsd: number | null; limitUsd?: number | null };
}

export interface EngineAdapter {
  readonly id: EngineId;
  readonly providers: ProviderId[];
  capabilities(platform: NodeJS.Platform): EngineCapabilities;

  /** Установка: где лежит бинарь, какая версия нужна, скачать её. */
  locate(): Promise<{ path: string; version: string } | null>;
  requiredVersion(): string;
  install(onProgress: (p: InstallProgress) => void, signal: AbortSignal): Promise<{ path: string }>;

  /** Состояние провайдера. Только метаданные: платный ход модели не запускается никогда. */
  status(provider: ProviderId, opts?: { force?: boolean }): Promise<ProviderStatus>;

  /** Вход. Подписка — через браузер (authUrl), ключ — в связку ключей. */
  login(req: LoginRequest): Promise<LoginStart>;
  onLoginCompleted?(loginId: string): Promise<ProviderStatus>;
  logout(provider: ProviderId): Promise<void>;

  /** Модели провайдера, с ценами, если движок их знает. */
  models(provider: ProviderId): Promise<ModelInfo[]>;

  /** Сессия исполнителя или менеджера. Вид сессии — в spec.kind. */
  start(spec: SessionSpec): EngineSession;
}
```

```ts
// src/server/engines/keys.ts — ключи только в системной связке ключей

export interface KeyStore {
  get(provider: ProviderId): Promise<string | null>;
  set(provider: ProviderId, secret: string): Promise<void>;
  delete(provider: ProviderId): Promise<void>;
  /** Какие ключи есть — без самих значений, для экрана «Провайдеры». */
  list(): Promise<ProviderId[]>;
}
```

### 5.3. Состояния статуса

```
not-installed ──install──▶ installing ──▶ needs-login ──login──▶ ready ⇄ limited
      ▲                                        │                   │
      └───────── бинарь исчез ─────────────────┴──── ключ отозван ──┘
unreachable — только у локальных (ollama, lmstudio, custom): адрес не отвечает
error — всё прочее с текстом «что сделать»
```

- `not-installed` — у `ollama`, `lmstudio` и `custom` не бывает: движок для
  них — OpenCode, и его отсутствие показывается как `not-installed` у
  OpenCode, общее для всех его провайдеров. Сам Ollama офис не ставит, только
  проверяет `GET <адрес>/api/tags` → `unreachable`.
- `needs-login` у Claude — нет ни входа Claude Code, ни ключа. У Codex —
  `account/read` пуст. У провайдеров OpenCode — в связке ключей нет ключа.
- `limited` строится из того же трекера `limits.ts`, что и сейчас (окна
  подписки), плюс два новых вида: `rate` (ответ 429 с `retry-after` у
  провайдера по ключу) и `balance` (OpenRouter `GET /api/v1/key` →
  `limit_remaining`, DeepSeek `GET /user/balance`). **Запасного провайдера
  нет**: при `limited` задачи роли ждут сброса через `limitBlock` ровно как
  сейчас, при `balance` ждут пополнения, а владелец получает вопрос.
- `envcheck.ts`: проверки `key`, `engine` и `provider:codex` сводятся в одну
  проверку `provider:<id>` для каждого провайдера, на котором есть хотя бы
  одна активная роль. `ready` и `limited` — ок. `limited` при этом не
  критичен: офис ждёт. Остальное критично.

### 5.4. Инструменты офиса: мост MCP

Сегодня инструменты офиса живут в процессе (`createSdkMcpServer`), и это
понимает только Claude SDK. Новая форма — `OfficeToolset` (§5.2), из
которой каждый адаптер делает своё:

- `claude-code` → `createSdkMcpServer` + `tool()` прямо в адаптере;
- `codex` → `dynamicTools` (как сейчас в `codex-tools.ts`);
- `opencode`, `qwen-code`, `antigravity` → **мост**. Сервер офиса поднимает
  на `127.0.0.1` Streamable HTTP MCP (`@modelcontextprotocol/sdk/server`, пакет
  уже в зависимостях) с адресом `/mcp/<одноразовый токен сессии>`. Адрес
  уходит в конфиг сессии (`OPENCODE_CONFIG_CONTENT.mcp.office = { type: 'remote', url }`).
  Какой транспорт OpenCode ждёт от `type: "remote"`, Streamable HTTP или SSE,
  документация не говорит [проверить]; запасной вариант — SSE или
  локальный процесс-прокладка (§3.5).
  Токен живёт, пока жива сессия. Каждый вызов проходит через `PermissionGate`
  до обработчика.

Тем же мостом отдаются **руки офиса** (Read/Write/Edit/Bash/Glob/Grep —
вынести из `codex-tools.ts` в `engines/hands.ts`) для движков, у которых свои
руки выключены. Внешние MCP роли офис подключает сам, как уже делает для
Codex, и отдаёт тем же мостом: так роль получает только каталог офиса, а
разбор рисков и подтверждения остаются на месте.

### 5.5. Матрица возможностей

| | claude-code | codex | opencode | qwen-code (этап 6) | antigravity (этап 6) |
|---|---|---|---|---|---|
| Провайдеры | anthropic | openai | xai, deepseek, openrouter, google, alibaba, ollama, lmstudio, custom | alibaba | google |
| Вход по подписке | да (`claude` → `/login`, `setup-token` [проверить]) | да (ChatGPT, `account/login/start` [проверить]) | нет | Coding Plan — ключом | да |
| Вход по ключу | да | да | да | да | да |
| Продолжение | да | да | да | да | нет (пока) |
| Потоковый ввод (менеджер) | да | да (ходы в треде) | да (сообщения в сессию) | да | нет |
| Текст по кусочкам | да | да | да (SSE `message.part.updated`) | да | нет |
| Инструменты офиса | в процессе | dynamic-tools | мост | в процессе (SDK) | мост |
| Свои руки через шлюз | да | нет (руки офиса) | нет (руки офиса) | да | [проверить] |
| Песочница ОС | macOS, Linux | macOS, Linux; Windows — эксп. | руки офиса + sandbox-runtime: macOS, Linux; **Windows — нет** (у sandbox-runtime только alpha) | [проверить] | [проверить] |
| Сжатие | окно `autoCompactWindow` | ручное | авто + `summarize` | авто | ? |
| Стоимость | reported | computed (таблица) | computed (models.dev) | [проверить] | none |
| Окна подписки | да | да | нет | нет | ? |
| Баланс | нет | нет | openrouter, deepseek | нет | нет |
| Скилы роли | plugin | tool (Skill офиса) | tool | tool | tool |
| Веб-поиск | да | да | webfetch; поиск — у провайдера [проверить] | да | да |
| Облако | да | нет | нет | нет | нет |

Как офис пользуется матрицей:

- форма роли не предлагает то, чего движок не умеет (облако, окно сжатия);
- при `sandbox: false` и режиме ниже `auto` Bash всегда спрашивает;
- при `costUsd: 'none'` бюджет задачи в долларах не принимается: так уже
  сделано для Codex без цен;
- при `resume: false` продолжение после лимита и на доработке идёт заново
  с пересказом (`resumedPrompt` → новый промпт);
- при `streamingInput: false` такой провайдер нельзя назначить менеджеру.

### 5.6. Провайдер на офисе и на роли

- `Settings.model: ModelChoice` — провайдер и модель офиса. При первом
  запуске выбирается на экране «Провайдеры» из готовых (`ready`). Пока не
  выбран, офис не раздаёт задачи и показывает экран.
- `Role.provider?` и `Role.model?`: **пусто — значит как у офиса**.
  Сохранённые сейчас значения остаются переопределениями. Миграция: у роли,
  чей провайдер совпадает с выбором офиса, поле очищается, только если
  совпадает и модель.
- Пакет называет уровень (`top/balanced/fast`) или полный id. Уровень
  разрешается в модель провайдера роли (`ModelInfo.tier`). Полный id другого
  провайдера в роль не попадает: берётся уровень по умолчанию, и об этом
  пишется предупреждение в журнал найма.
- Смена провайдера офиса не трогает роли с переопределением, а роли без
  него переходят на нового провайдера со следующей сессии. Начатые сессии
  не продолжаются чужим движком: это уже обеспечивает `sessionForProvider`.

### 5.7. Хранение ключей

- **Приложение.** Главный процесс Electron шифрует ключи через
  `safeStorage` (на macOS это Keychain, на Windows DPAPI) и хранит
  зашифрованный файл в папке данных. Серверу ключи отдаются по IPC-каналу
  при старте и при изменении — не переменной окружения процесса сервера,
  чтобы их не наследовали дочерние процессы.
- **Из исходников.** `@napi-rs/keyring` как необязательная зависимость
  (готовые бинари, без компиляции — риск сборки, которого OFFICE.md
  избегает, не возникает). Если её нет, ключ берётся из переменной
  окружения, как сейчас.
- **Движку** ключ отдаётся только в окружение его процесса (`engineEnv`). В
  конфиг OpenCode попадает подстановка `{env:OFFICE_KEY_XAI}`, а не значение.
  Команды агента ключей не видят (`childenv.ts`, проверка `test:secrets` —
  дополнить переменными новых провайдеров).
- В `state.json`, журнал, логи и сообщения веба ключи не попадают никогда.
  Веб получает только `KeyStore.list()`.

---

## 6. Этапы переделки

Каждый этап сливается отдельно, офис работает между этапами.

### Этап 1. Свой словарь сессии вместо Claude SDK (без новых провайдеров)

Цель: `agents.ts` не импортирует ничего из SDK, Claude и Codex — два
равноправных адаптера.

- новый `src/server/engines/types.ts` (§5.2), `engines/index.ts` (реестр
  адаптеров вместо `providers/index.ts`);
- `src/server/engines/claude.ts`: из `providers/index.ts`, перевод `SDKMessage → EngineEvent`,
  `SessionSpec → Options` (preset `claude_code`, граница кеша,
  `settingSources`, `sandbox`, `autoCompactWindow`, плагины);
- `src/server/engines/codex.ts`, `codex-rpc.ts`, `hands.ts` (руки из
  `codex-tools.ts`), `pricing.ts`, `diagnostics.ts` → `status()`/`models()`;
- `src/server/agents.ts`: 12 мест `query()` → `engine.start(spec)`. Разбор
  событий (`consume` в `agents.ts:463`, разбор менеджера ~`1750–1860`, `driveWorker`)
  переходит на `EngineEvent`. `THRASH_MARK` уходит в адаптер Claude
  (`compact-failed: thrash`). Инструменты (`teamTools`, `workerTools`,
  `ritualTools`, наборы `3935` и `4037`) переходят на `OfficeToolset`;
- `src/server/bench.ts`, `src/server/queue.ts` (`SDKUserMessage` → строки),
  `src/server/mcp.ts` (`McpServerConfig` → `ExternalMcp`), `src/server/skills.ts`
  (`SdkPluginConfig` → `SkillRef`);
- `src/server/limits.ts`: `LimitSource` → `EngineSession.limits()`, события
  `limit`;
- проверки: `scripts/test-providers.ts`, `test-mcp.ts`, `test-skills.ts`,
  `smoke.ts`, `npm run test:pm` через конвейер.

### Этап 2. Прототип OpenCode и мост MCP

- `src/server/engines/mcp-bridge.ts`: Streamable HTTP MCP на маршруте
  сервера, токен на сессию;
- `src/server/engines/opencode.ts`: процесс `opencode serve --port 0` на
  сессию, `XDG_DATA_HOME`/`XDG_CONFIG_HOME` → `<данные>/opencode-runtime`
  (продолжение переживает перезапуск, личные настройки владельца не
  подмешиваются), `OPENCODE_CONFIG_CONTENT` (агент без своих рук, мост,
  провайдер, `autoupdate: false`, `share: disabled`), SSE → `EngineEvent`,
  подтверждения → `PermissionGate`, стоимость по models.dev;
- `src/server/engines/sandbox.ts`: Bash рук офиса через
  `@anthropic-ai/sandbox-runtime` на macOS и Linux (зависимости:
  `bubblewrap`, `socat`, `ripgrep` на Linux, `ripgrep` на macOS);
- `scripts/test-opencode.ts`: заглушка сервера OpenCode (по образцу мока
  app-server в `test-providers.ts`) и живой прогон на Ollama.
- **Критерий прохода прототипа:** исполнитель на Ollama и на OpenRouter
  выполняет задачу в worktree, продолжает её после перезапуска сервера,
  расходы видны на доске. Не прошло — запасной план: провайдеры
  `xai/deepseek/openrouter/ollama` подключаются к адаптеру `codex` через
  `model_providers` в `config` треда (Responses API), Gemini откладывается.

### Этап 3. Провайдеры и выбор на офисе (меняет контракт `src/shared/types.ts`)

- `src/shared/providers.ts`: `EngineId`, `ProviderId`, `PROVIDERS`
  (§5.2), миграция `claude-code → anthropic`, `codex → openai`;
- `src/shared/types.ts`: `Settings.model: ModelChoice`, `Role.provider/model`
  становятся необязательными, `ProviderStatusView`, сообщения ws
  `providers`/`provider-login`/`provider-install`;
- `src/shared/models.ts`: `ModelTier`, алиасы-синонимы, `MODEL_IDS` → модели
  провайдера из `models()`;
- `src/server/state.ts` (умолчания `470`, `3674`, `3986`, `providerOf`
  → «как у офиса»), `src/server/roles.ts` (`currentModel` только для
  anthropic), `src/server/packages.ts` (`runtime.engine` → `runtime.provider`,
  без умолчания `claude-code`, уровни моделей, текст валидатора,
  `.claude-plugin` не обязателен для пакета без скилов), `src/server/export.ts`;
- `src/server/engines/keys.ts` (§5.7);
- `src/server/envcheck.ts`: проверки `provider:<id>` вместо `key`, `engine`,
  `provider:codex`; `src/server/cloud.ts`: отказ по матрице (`cloud`);
- `src/server/index.ts`: `/api/providers` (статусы, модели, вход, установка)
  вместо `/api/providers/codex`; `boot.*` — нейтральные тексты;
- `src/server/limits.ts`: виды `rate` и `balance`;
- `src/server/i18n/{ru,en}.ts`: `env.provider.*` вместо `env.engine.*`/`env.key.*`,
  тексты «лимит запросов» и «кончился баланс».

### Этап 4. Экран «Провайдеры» и первый запуск

- веб: новый `src/web/ProvidersPage.tsx` (список провайдеров со статусом,
  «Установить», «Войти», «Ключ API», «Адрес», выбор модели офиса),
  открывается при первом запуске и из настроек;
- `src/web/shell/Rail.tsx`: блок аккаунта показывает провайдера офиса и его
  статус, а не зашитый Claude Code;
- `src/web/AgentPanels.tsx`, `AgentSettings.tsx`, `AgentDrawer.tsx`: «как у
  офиса» первым пунктом, модели из `models()`, ни один провайдер не стоит
  первым по умолчанию; `LimitBars.tsx`: подпись провайдера всегда;
- `src/web/SetupWizard.tsx` + `src/server/setup.ts`: шаг «Провайдер» (или
  переход на экран, если провайдер ещё не выбран);
- `src/web/i18n/{ru,en}.ts`: `shell.user`, `shell.auth.*`, `settings.mcp.hint`,
  новые `providers.*`;
- desktop: `desktop/engine.js` → `desktop/engines.js` (ставит любой движок
  по запросу сервера: claude — npm-пакет платформы, opencode — `opencode-ai`
  платформы, codex — `@openai/codex` платформы, в
  `engineDir()/<движок>/<версия>/`); `desktop/main.js`: убрать
  `ensureEngine()` с запуска и пункт меню «Движок агентов…», установку
  вызывает экран «Провайдеры» через сервер (`OFFICE_ENGINE_DIR` вместо
  `OFFICE_CLAUDE_BIN`); `desktop/boot.html`: без шага движка;
  `desktop/i18n.js` — оставшиеся строки; ключи — `safeStorage` (§5.7);
- `scripts/pack-desktop.mjs`, `scripts/build-server.mjs`: SDK Claude
  остаётся (адаптер), бинари движков в установщик не кладутся.

### Этап 5. Тексты и витрина

- `README.md`, `CONTRIBUTING.md`, `OFFICE.md` (стек и карта файлов:
  `src/server/engines/*`), `.env.example` (раздел «Доступ к моделям» по
  провайдерам), `docs/guide/{desktop,status,running,team}.md`,
  `packages/README.md`, пометка в `CONCEPT.md`;
- `.github/workflows/release.yml:167–170`: абзац «Движки ставятся с экрана
  «Провайдеры» при первом запуске», без Claude;
- встроенные пакеты `packages/@office/*/agent.json`: `runtime.model` →
  уровень, `runtime.engine` убрать (провайдер офиса);
- описание и темы репозитория на GitHub — руками при выпуске.

### Этап 6 (необязательный). Родные адаптеры Qwen Code и Antigravity

- `src/server/engines/qwen.ts` поверх `@qwen-code/sdk` — если Coding Plan
  не пускает сторонний клиент;
- `src/server/engines/antigravity.ts` — когда у `agy` появится ACP или поток
  JSON с продолжением; вход по подписке Google.

---

## 7. Чего здесь сознательно нет

- **Запасного провайдера при лимите** — решение владельца. Упёрлись —
  ждём сброса или пополнения, как сейчас.
- **Своего цикла агента** — только готовые движки.
- **OpenCode для Claude.** Подписку Pro/Max через сторонние клиенты
  Anthropic запрещает, у Claude свой адаптер.
- **Облака для не-Claude.** Managed Agents есть только у Anthropic.

## 8. Риски

- **Подписка Claude в продуктах на Agent SDK.** Правила Anthropic разрешают
  только собственный вход пользователя в его Claude Code; раздавать доступ
  по подписке Claude через свой продукт нельзя. Как офис вписывается в эти
  правила, решает владелец: вопрос Q-47 открыт [проверить].
- **Зрелость OpenCode.** Около 4,7 тыс. открытых issue, API быстро
  меняется, часть багов закрывается автоматически без разбора (#28494).
  Закрываем фиксацией версии движка, своим пересчётом стоимости и запасным
  планом на Codex (§3.5, этап 2).
- **Песочница на Windows.** sandbox-runtime там только alpha, руки офиса на
  Windows работают без песочницы ОС (§3.5).
- **Отказ от Chat Completions в Codex.** Запасной план держится на Responses
  API у чужих провайдеров; кто из них его поддерживает, меняется [проверить].

## Проверка спеки

Ссылки на код (12 вызовов `query()`, строки в `agents.ts`, `state.ts`,
`packages.ts`, `desktop/*`, `envcheck.ts`, `limits.ts`, i18n, README,
`release.yml`) сверены с рабочей копией. `Settings.engine` —
`src/shared/types.ts:686`, сверено с текущим main.

**Проверено:**

- уход Gemini CLI: объявлен в мае 2026 (блог Google Developers), с
  18.06.2026 не обслуживает Google AI Pro/Ultra и бесплатный личный уровень;
  платные ключи API и корпоративные лицензии работают;
- Antigravity CLI без ACP (issue #31, открыт);
- закрытие Qwen OAuth 15.04.2026 и адреса Coding Plan; SDK Qwen
  «minimum experimental», Node 22+, `createSdkMcpServer`, `canUseTool` 60 с,
  `resume`;
- OpenCode: MIT, `POST /session/:id/prompt_async`, `abort`, ответ на
  подтверждение, SSE `/event`, `OPENCODE_CONFIG_CONTENT`, `autoupdate`,
  `share`, выключение инструментов; #28494 закрыт автоматически без разбора,
  #17223 закрыт как not planned;
- Codex: предупреждение об отказе от `wire_api = "chat"` (issue #7413,
  26.01.2026);
- запрет Anthropic на подписку через сторонние клиенты;
- лицензии: Crush — FSL-1.1-MIT, Goose — Apache-2.0,
  `@anthropic-ai/sandbox-runtime` — Apache-2.0;
- sandbox-runtime: macOS и Linux, Windows — alpha; зависимости `bubblewrap`,
  `socat`, `ripgrep` на Linux и `ripgrep` на macOS;
- запрет `goose session resume` относится к Goose как клиенту чужих
  ACP-агентов.

**Не проверено (нужен прототип этапа 2), в тексте помечено [проверить]:**

- форма события `ask` в SSE OpenCode и ответ на него;
- транспорт моста MCP у OpenCode (`type: "remote"`: Streamable HTTP или SSE);
- точность `cache.read` в стоимости OpenCode на зафиксированной версии;
- sandbox-runtime как обёртка Bash офиса;
- пускает ли Qwen Coding Plan сторонний клиент;
- токены в `result` у Qwen Code;
- вход Claude и Codex из интерфейса;
- версия OpenCode 1.3.0, с которой убраны плагины для подписки Claude;
- передача MCP-серверов в ACP Gemini CLI на `initialize`;
- само удаление `wire_api = "chat"` в Codex (только вторичные источники);
- Responses API у DeepSeek: модели и дата запуска.

## Источники

- OpenCode: [server](https://opencode.ai/docs/server/), [providers](https://opencode.ai/docs/providers/), [cli](https://opencode.ai/docs/cli/), [mcp](https://opencode.ai/docs/mcp-servers/), [permissions](https://opencode.ai/docs/permissions/), [config](https://opencode.ai/docs/config/), [репозиторий](https://github.com/anomalyco/opencode), [баг cache.read](https://github.com/anomalyco/opencode/issues/28494), [цены своих провайдеров](https://github.com/anomalyco/opencode/issues/17223)
- Codex: [свои провайдеры](https://learn.chatgpt.com/docs/config-file/config-advanced), [удаление wire_api chat](https://github.com/janhq/jan/issues/7413), [DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api/), [DeepSeek + Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)
- Gemini: [headless](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md), [ACP](https://geminicli.com/docs/cli/acp-mode/), [уход Gemini CLI](https://inventivehq.com/blog/gemini-cli-deprecated-antigravity-cli-migration), [Antigravity CLI](https://byteiota.com/antigravity-cli-gemini-successor/), [ACP в agy — запрос](https://github.com/google-antigravity/antigravity-cli/issues/31), [баг loadSession](https://github.com/google-gemini/gemini-cli/issues/29288)
- Qwen Code: [репозиторий](https://github.com/qwenLM/qwen-code), [TS SDK](https://qwenlm.github.io/qwen-code-docs/en/developers/sdk-typescript/), [вход](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/), [headless](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/)
- Goose: [репозиторий](https://github.com/aaif-goose/goose), [ACP](https://goose-docs.ai/docs/guides/acp-providers/)
