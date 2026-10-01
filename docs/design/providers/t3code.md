# Разбор: провайдеры и движки в t3code

Задача T-202. Документ только изучает чужой проект и предлагает правки к
[`spec.md`](spec.md). Ни код офиса, ни `spec.md` в задаче не менялись.

Изучался репозиторий [pingdotgg/t3code](https://github.com/pingdotgg/t3code),
коммит `148e6de` от 2026-10-01. Все ссылки ниже указывают на этот коммит и
поэтому не протухнут. Корень ссылок:
`https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/`.
Что прочитано по коду, но не запускалось, помечено **[проверить]**.

[t3]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1

---

## 1. Что такое t3code

t3code — «пульт управления агентами»: веб, Electron и мобильное приложение
поверх локального сервера на Node. Сам агентов он не пишет, а водит чужие:
Claude Code, Codex, Cursor, Grok Build, OpenCode и Google Antigravity
([README][t3-readme]). Пользователь работает в **нитях** (thread): одна нить —
один разговор с одним агентом в рабочей папке проекта.

Весь сервер написан на **Effect v4** (`Effect.gen`, `Layer`, `Schema`, `Stream`).
Это важно для раздела про лицензию (§8): копировать код к нам как есть не
получится, его пришлось бы переписывать.

[t3-readme]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/README.md

## 2. Абстракция провайдеров

### 2.1. Три понятия: драйвер, экземпляр, адаптер

Код: `apps/server/src/provider/`, контракты — `packages/contracts/src/`.

| Понятие | Где | Что это |
|---|---|---|
| **Драйвер** `ProviderDriverKind` | [`providerInstance.ts`][pi] | Реализация протокола: `codex`, `claudeAgent`, `cursor`, `grok`, `opencode`, `antigravity`. Это **открытая строка-слаг**, а не закрытый union: настройки с драйвером, которого нет в сборке, читаются без ошибки, а экземпляр показывается как `availability: "unavailable"` |
| **Экземпляр** `ProviderInstanceId` | [`providerInstance.ts`][pi], [`ProviderDriver.ts`][pd] | Настроенный пользователем экземпляр драйвера со своим id, именем, цветом, переменными окружения и конфигом. **Именно он — ключ маршрутизации**: нити, сессии и события ссылаются на экземпляр, а не на драйвер. Так можно держать `codex_personal` и `codex_work` или `claude_openrouter` — драйвер Claude с другим `ANTHROPIC_BASE_URL` ([`modelSelection.ts`][web-ms]) |
| **Адаптер** `ProviderAdapterShape` | [`Services/ProviderAdapter.ts`][pa] | Сессии конкретного драйвера: `startSession`, `sendTurn`, `interruptTurn`, `respondToRequest` (подтверждение), `respondToUserInput` (вопрос агента), `stopSession`, `readThread`, `rollbackThread`, `compaction` (`native` или `slash-command`), `streamEvents` |

Драйвер — это **обычное значение**, а не сервис ([`ProviderDriver.ts`][pd]):

```ts
interface ProviderDriver<Config, R> {
  driverKind; metadata: { displayName; supportsMultipleInstances? };
  configSchema;            // схема конфига экземпляра — её же читает форма настроек
  defaultConfig(): Config;
  create(input): Effect<ProviderInstance>;  // сбой → «недоступный» снимок, не исключение
}
interface ProviderInstance {
  instanceId; driverKind; continuationIdentity; enabled;
  snapshot: ServerProviderShape;   // состояние для UI: getSnapshot, refresh, streamChanges, applyUsageLimits
  adapter: ProviderAdapterShape;   // сессии
  textGeneration;                  // разовые генерации (заголовок нити, текст коммита)
  auth?: ProviderAuthController;   // вход/выход
  consumeResetCredit?; refreshModels?; invalidateCaches?;
}
```

Список встроенных драйверов — [`builtInDrivers.ts`][bid]. Возможности адаптера
описаны скупо ([`ProviderAdapter.ts`][pa]): `sessionModelSwitch:
'in-session' | 'unsupported'`, `promptlessTurnContinuation`,
`supportsConversationRollback`. Часть возможностей отдаётся в UI прямо в
снимке: `reportsContextWindow`, `requiresNewThreadForModelChange`,
`showInteractionModeToggle`, `setup: { canAuthenticate, canInstall }`.

**Продолжение сессии привязано к экземпляру.** `continuationIdentity` =
`<driver>:instance:<id>` ([`ProviderDriver.ts`][pd]). Нить, начатая на одном
экземпляре, другим не продолжается.

### 2.2. Снимок провайдера `ServerProvider` — единственное, что видит UI

[`server.ts`][srv] стр. 207–265. Главные поля:

```ts
{
  instanceId, driver, displayName?, accentColor?, badgeLabel?,
  enabled, installed, version,
  status: 'ready' | 'warning' | 'error' | 'disabled',
  auth: { status: 'authenticated' | 'unauthenticated' | 'unknown', type?, label?, email? },
  message?,                         // готовый текст «что не так и что сделать»
  availability?: 'available' | 'unavailable', unavailableReason?,
  models: ServerProviderModel[],    // slug, name, isDefault, isLegacy, isCustom, capabilities
  slashCommands, skills,
  usageLimits?,                     // окна подписки (§6.3)
  versionAdvisory?, compatibilityAdvisory?, updateState?,  // версия движка (§4.4)
  setup?: { canAuthenticate, canInstall },
  checkedAt,
}
```

Массив снимков объявлен как `ForwardCompatibleArray`: старый клиент
отбрасывает провайдера с незнакомым статусом, а не ломает весь ответ.

[pi]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/packages/contracts/src/providerInstance.ts
[pd]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/ProviderDriver.ts
[pa]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/Services/ProviderAdapter.ts
[bid]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/builtInDrivers.ts
[srv]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/packages/contracts/src/server.ts
[web-ms]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/web/src/modelSelection.ts

## 3. Запуск агента и поток событий

### 3.1. Как запускается каждый движок

| Драйвер | Как запускается | Файлы |
|---|---|---|
| Claude | `@anthropic-ai/claude-agent-sdk` `query()` с **бинарём `claude` пользователя** (`binaryPath`, `CLAUDE_CONFIG_DIR`), `permissionMode` + `canUseTool` | [`Layers/ClaudeAdapter.ts`][ca] (5,7 тыс. строк), [`Drivers/ClaudeDriver.ts`][cd] |
| Codex | `codex app-server` по JSON-RPC через свою библиотеку `effect-codex-app-server`. Клиент **сгенерирован из схемы протокола** | [`Layers/CodexSessionRuntime.ts`][csr], [`Layers/CodexAdapter.ts`][cxa], [`packages/effect-codex-app-server`][ecas] |
| OpenCode | `opencode serve`, клиент `@opencode-ai/sdk/v2`. **Один сервер на экземпляр, общий для всех нитей**: поднимается лениво и гасится через 30 с простоя. Можно указать внешний `serverUrl` и пароль (`OPENCODE_SERVER_PASSWORD`). Адрес сервер сообщает строкой `server listening on http://…` в stdout | [`opencodeRuntime.ts`][ocr], [`OpenCodeServerOwner.ts`][ocso], [`Layers/OpenCodeAdapter.ts`][oca] |
| Cursor, Grok, Antigravity | **ACP** (Agent Client Protocol, JSON-RPC по stdio) через свою библиотеку `effect-acp`. Общий рантайм плюс расширения под каждого агента | [`acp/AcpSessionRuntime.ts`][acp], [`packages/effect-acp`][eacp], [`acp/XAiAcpExtension.ts`][xai] |

Пример для OpenCode: минимальная версия зашита константой
`MINIMUM_OPENCODE_VERSION = "1.14.19"`. При подключении сервер проверяет
версию через health-ответ и при старой версии отказывает с текстом «Upgrade
to v1.14.19 or newer» ([`opencodeRuntime.ts`][ocr], стр. 42, 140–175).

### 3.2. Поток событий

Каждый адаптер переводит родные события в **один словарь**
`ProviderRuntimeEvent` (V2, около 50 видов; [`providerRuntime.ts`][prt],
стр. 152–200): `session.*`, `thread.*`, `turn.started/completed/aborted`,
`turn.plan.updated`, `turn.diff.updated`, `item.started/updated/completed`,
`content.delta`, `request.opened/resolved` (подтверждения),
`user-input.requested/resolved` (вопросы агента), `thread.token-usage.updated`,
`account.rate-limits.updated`, `mcp.status.updated`, `model.rerouted`,
`config.warning`, `deprecation.notice`, `tool.denied`,
`runtime.warning/error`.

К нормализованному событию прикладывается **сырое событие с меткой
источника** (`raw.source`: `claude.sdk.message`, `codex.app-server.notification`,
`opencode.sdk.event`, `acp.jsonrpc` и т. д., стр. 24–31). Все родные события
пишутся NDJSON-логом ([`Layers/EventNdjsonLogger.ts`][ndjson]). Это нужно для
разбора, когда адаптер что-то понял неправильно.

События OpenCode, которые разбирает адаптер ([`OpenCodeAdapter.ts`][oca]):
`message.part.updated` (текст и шаги, в `step-finish` лежат токены),
`permission.asked` / `permission.replied`, `question.asked` /
`question.replied` / `question.rejected`, `session.error`. После
переподключения адаптер **заново подбирает висящие запросы подтверждения**
(стр. 2060–2170, `permission.list` и `question.list`): иначе агент навсегда повис бы на `ask`, о котором UI не
узнал.

[ca]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/Layers/ClaudeAdapter.ts
[cd]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/Drivers/ClaudeDriver.ts
[csr]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/Layers/CodexSessionRuntime.ts
[cxa]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/Layers/CodexAdapter.ts
[ecas]: https://github.com/pingdotgg/t3code/tree/148e6deea046658639aae9fef5b349781cec39d1/packages/effect-codex-app-server
[ocr]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/opencodeRuntime.ts
[ocso]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/OpenCodeServerOwner.ts
[oca]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/Layers/OpenCodeAdapter.ts
[acp]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/acp/AcpSessionRuntime.ts
[eacp]: https://github.com/pingdotgg/t3code/tree/148e6deea046658639aae9fef5b349781cec39d1/packages/effect-acp
[xai]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/acp/XAiAcpExtension.ts
[prt]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/packages/contracts/src/providerRuntime.ts
[ndjson]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/Layers/EventNdjsonLogger.ts

### 3.3. Свои инструменты агенту: MCP-мост

У t3code есть свои инструменты: превью в браузере, устройства, пулл-реквесты.
Отдаются они **одним HTTP MCP-сервером на сервере t3code**
([`mcp/McpHttpServer.ts`][mcph]): путь `/mcp`, протокол MCP `2025-06-18`
(Streamable HTTP), авторизация `Authorization: Bearer <токен сессии>`. Токены
выдаёт [`McpSessionRegistry.ts`][mcpr]. Хранится только хеш токена, а живёт
токен, пока сессия активна. Каждый движок подключается к мосту своим способом:

| Движок | Как подключён мост |
|---|---|
| Claude | `mcpServers: { "t3-code": { type: "http", url, headers: { Authorization } } }` ([`ClaudeAdapter.ts`][ca], стр. 5025–5040) |
| Codex | аргументы `-c mcp_servers.t3-code.url=…` и `mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"`. Токен передаётся в окружении процесса, в конфиг не попадает ([`CodexAdapter.ts`][cxa], стр. 2305–2340) |
| OpenCode | **во время работы**: `client.mcp.add({ name: "t3-code", config: { type: "remote", url, headers: { Authorization }, oauth: false } })` после подключения к серверу ([`OpenCodeAdapter.ts`][oca], стр. 2870–2884) |
| ACP (Grok и др.) | `mcpServers` в `session/new` ([`GrokAdapter.ts`][grok], стр. 1013–1020; [`AcpSessionRuntime.ts`][acp], стр. 772) |

Это ровно наш мост из §5.4 `spec.md`. Кроме того, это ответ на один из наших
вопросов [проверить]: `type: "remote"` у OpenCode в t3code работает со
Streamable HTTP. Отличие от нашей схемы — токен идёт в заголовке, а не в пути.

[mcph]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/mcp/McpHttpServer.ts
[mcpr]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/mcp/McpSessionRegistry.ts
[grok]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/Layers/GrokAdapter.ts

## 4. Вход, ключи, установка движка

### 4.1. Проверка «установлен ли и вошли ли»

Каждый драйвер собирает снимок (§2.2) **без платного хода модели**:

- **Claude** ([`Layers/ClaudeProvider.ts`][cp]): ищет бинарь, запускает
  `claude auth status`. Если там нет типа подписки, поднимает сессию SDK с
  промптом, который **никогда ничего не отдаёт**, и читает из
  `initializationResult()` поля `account.email`, `subscriptionType`,
  `tokenSource`, а также `usage_EXPERIMENTAL…()` — после этого прерывает
  сессию (стр. 320–400). Метка входа: «Claude Max», «API key» и т. п.
  Сообщения на отказ: «Claude Agent CLI (`claude`) was not found on PATH.»,
  «…installed but failed to run».
- **OpenCode** ([`Layers/OpenCodeProvider.ts`][ocp]): «OpenCode CLI
  (`opencode`) is not installed or not on PATH.», «server rejected
  authentication», «too old. Upgrade to v1.14.19». Модели и подключённые
  провайдеры берутся из `opencode models` или из API сервера.
- Модели и их актуальность приходят из **манифеста моделей** (§4.4).

### 4.2. Установка

У t3code три подхода, и это не единая система:

1. **Ставит сам, с фиксированной версией и sha256.** Codex в режиме
   `managed`: таблица с адресами релизов GitHub `rust-v0.156.1` и sha256 на
   каждую платформу ([`CodexInstallation.ts`][ci], стр. 55–100). Antigravity:
   скачивает `agy-acp-server 1.1.1` с `dl.google.com` по адресам из ACP
   registry ([`antigravityRelease.ts`][agr]) и требует Node
   ([`AntigravityInstallation.ts`][agi], стр. 529). Прогресс установки описан
   контрактом `ProviderInstallState`: `downloading → extracting → verifying →
   succeeded`, байты, версия, `source: managed | local`, `canRemove`
   ([`providerSetup.ts`][ps], стр. 160–181).
2. **Даёт команду официального установщика** и запускает её во встроенном
   терминале онбординга: `curl -fsSL https://claude.ai/install.sh | bash`,
   `irm https://chatgpt.com/codex/install.ps1 | iex` и т. п.
   ([`onboarding/providerReadiness.logic.ts`][opr], стр. 80–105).
3. **Ничего не ставит** — OpenCode, Cursor, Grok: «установите CLI и выполните
   `… login`» ([README][t3-readme]).

Обновление движков: определяется, как он был поставлен (npm, brew, родной
установщик), и предлагается обновление в один клик
([`providerMaintenance.ts`][pm]).

### 4.3. Вход и секреты

- **Вход — это сценарий с «взаимодействиями»** ([`providerSetup.ts`][ps],
  стр. 35–160; [`ProviderAuthFlow.ts`][paf]): сервер ведёт `flowId` с фазами
  `idle → starting → waiting → verifying → succeeded | failed | cancelled`, а
  клиенту отдаёт одно из взаимодействий: `browser` (адрес), `deviceCode`
  (адрес и код), `terminal` (вывод CLI, клиент шлёт ввод), `credentials`
  (поля формы, у каждого признак `secret`). У провайдера может быть несколько
  методов входа `ProviderAuthMethod { type: agent | terminal | credentials }`.
  Поле `credentialOwner: 'provider' | 't3'` показывает, где хранится вход: у
  самого движка или у t3code.
- **Свой OAuth там, где можно.** Codex: вход ChatGPT через PKCE с локальным
  callback ([`CodexChatGptAuth.ts`][cga]). Токен хранит t3code, Codex
  получает его в `ACCESS_TOKEN` и управляемом `CODEX_HOME`, а
  `OPENAI_API_KEY` и `OPENAI_BASE_URL` из окружения вычищаются
  ([`CodexManagedRuntime.ts`][cmr], стр. 90–100). Antigravity: «Sign in with
  Google» — браузерный вход ACP-сервера, адрес перехватывается из его stdout
  ([`antigravityAuthSupport.ts`][aas]).
- **Claude и OpenCode** — только собственный вход движка (`claude auth login`,
  `opencode auth login`) во встроенном терминале. Ключ API для Claude
  задаётся переменной окружения экземпляра.
- **Секреты лежат не в системной связке ключей**, а в
  `ServerSecretStore`: файлы с правами `0600` в каталоге `secrets/` с правами
  `0700` ([`auth/ServerSecretStore.ts`][sss], стр. 160–240). У переменных
  окружения экземпляра есть флаг `sensitive`: такое значение уезжает в
  хранилище секретов, а клиент получает только `valueRedacted: true`
  ([`serverSettings.ts`][ss], стр. 160–185, 865–880). `@napi-rs/keyring`
  используется только для **чтения** токена Cursor из Keychain macOS, с
  тайм-аутом на системный диалог ([`cursorCredentialStore.ts`][ccs]). В
  Electron есть `safeStorage` ([`ElectronSafeStorage.ts`][ess]), но он
  обслуживает настройки окружений приложения, а не ключи провайдеров
  [проверить].

### 4.4. Совместимость версий — удалённый манифест

[`model-manifest.json`][mm] + [`ModelManifest.ts`][mmts]: файл лежит в
репозитории, **вшит в сборку** и раз в час подтягивается с `main` через
raw.githubusercontent. Порядок предпочтения: удалённый, затем последний
удачный с диска, затем вшитый. Сбой загрузки проверку провайдера не роняет.
Внутри:

- `compatibility[]` — для каждого драйвера и диапазона версий t3code
  указываются диапазоны версий движка со статусом `supported | graceful |
  unsupported | broken` и рекомендуемая версия. Например, OpenCode `>=2.0.0` —
  `broken`, `>=1.14.19 <2.0.0` — `supported`. В снимке это
  `compatibilityAdvisory` и `versionAdvisory` (`behind_latest`, команда
  обновления);
- `currentModels` и `providers.<driver>.models` — текущие и устаревшие модели,
  модель по умолчанию, профили возможностей.

Так можно пометить версию движка как сломанную **без выпуска приложения**.

### 4.5. Что видит пользователь, если движка нет

- Карточка в «Настройки → Провайдеры»: цветная точка (`ready` зелёная,
  `warning` жёлтая, `error` красная, `disabled` серая) и заголовок из
  [`providerStatus.ts`][pst]: «Not found — CLI not detected on PATH», «Not
  authenticated», «Needs attention», «Unavailable», «Authenticated · Claude
  Max». Текст под заголовком — `provider.message` с сервера.
- Онбординг ([`providerReadiness.logic.ts`][opr]) сводит снимок к шагу:
  `checking → disabled | install | signIn | attention | ready`. Из нескольких
  экземпляров одного драйвера показывается самый готовый. На шаге `install`
  есть кнопка установки или терминал с командой, на шаге `signIn` — терминал с
  `… auth login` или браузерный вход.

[cp]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/Layers/ClaudeProvider.ts
[ocp]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/Layers/OpenCodeProvider.ts
[ci]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/CodexInstallation.ts
[agr]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/antigravityRelease.ts
[agi]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/AntigravityInstallation.ts
[ps]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/packages/contracts/src/providerSetup.ts
[opr]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/web/src/onboarding/providerReadiness.logic.ts
[pm]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/providerMaintenance.ts
[paf]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/ProviderAuthFlow.ts
[cga]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/CodexChatGptAuth.ts
[cmr]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/CodexManagedRuntime.ts
[aas]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/antigravityAuthSupport.ts
[sss]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/auth/ServerSecretStore.ts
[ss]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/serverSettings.ts
[ccs]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/cursorCredentialStore.ts
[ess]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/desktop/src/electron/ElectronSafeStorage.ts
[mm]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/model-manifest.json
[mmts]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/ModelManifest.ts
[pst]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/web/src/components/settings/providerStatus.ts

## 5. Выбор модели и провайдера в интерфейсе

- **Выбор — пара «экземпляр + модель»**: `ModelSelection { instanceId, model,
  options? }` ([`orchestration.ts`][orc], стр. 61–126). В `options` лежат
  параметры модели: усилие рассуждения, быстрый режим. Старое сохранение
  `{ provider, model }` переводится в новое **схемой при чтении**, отдельного
  кода миграции нет.
- **Цепочка умолчаний**: `settings.defaultModelSelection` → у проекта
  `defaultModelSelection` → у нити `modelSelection`. Кроме того, модель можно
  сменить **на один ход** — `modelSelection` есть в `ProviderSendTurnInput`
  ([`provider.ts`][prov], стр. 69–85). Для служебных генераций отдельные
  настройки: `textGenerationModelSelection` (заголовки) и
  `sourceControlWriterModelSelection` (коммиты, PR)
  ([`settings.ts`][set], стр. 1051–1061).
- **Пикер модели в композере** ([`ProviderModelPicker.tsx`][pmp]): модели
  сгруппированы по экземплярам, со своими (`customModels`) и пометками
  `new`/устаревшая. Когда нить уже начата, провайдер **заблокирован**
  (`deriveLockedProvider`, [`ChatView.logic.ts`][cvl], стр. 1014–1040): сменить
  можно только модель того же драйвера. Если драйвер не умеет менять модель
  на ходу (`requiresNewThreadForModelChange`), UI пишет «Start a new chat to
  change models» (стр. 1042–1075).
- **Состояние подключения**: точка и заголовок на карточке экземпляра
  (§4.5), шкалы лимитов подписки, плашка «доступно обновление движка» в
  сайдбаре ([`SidebarProviderUpdatePill.tsx`][spu]).
- **Форма настроек экземпляра строится из схемы**: у полей конфига есть
  аннотации `providerSettingsForm: { placeholder, control: 'password', hidden,
  clearWhenEmpty }` ([`settings.ts`][set], стр. 577–870;
  [`ProviderSettingsForm.tsx`][psf]). Новый драйвер получает форму без
  вёрстки.

[orc]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/packages/contracts/src/orchestration.ts
[prov]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/packages/contracts/src/provider.ts
[set]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/packages/contracts/src/settings.ts
[pmp]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/web/src/components/chat/ProviderModelPicker.tsx
[cvl]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/web/src/components/ChatView.logic.ts
[spu]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/web/src/components/sidebar/SidebarProviderUpdatePill.tsx
[psf]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/web/src/components/settings/ProviderSettingsForm.tsx

## 6. Подтверждения, токены, стоимость, лимиты

### 6.1. Подтверждения инструментов

- **Режим на нить** `RuntimeMode`: `approval-required | auto-accept-edits |
  auto | full-access`. **По умолчанию `full-access`**
  ([`orchestration.ts`][orc], стр. 128–136). Отдельно есть режим
  взаимодействия `default | plan`.
- **Решение пользователя**: `accept | acceptForSession | acceptAlways |
  decline | cancel`. Вид запроса: `command | file-read | file-change |
  mcp-elicitation | permission`. Варианты с предупреждением провайдера —
  например, о prompt injection (стр. 137–160).
- **Перевод на движки.** Claude: `approval-required → default`,
  `auto-accept-edits → acceptEdits`, `full-access → bypassPermissions`, плюс
  `canUseTool` ([`ClaudeAdapter.ts`][ca], стр. 4736–4960). OpenCode: режим
  разворачивается в набор правил на сессию
  ([`opencodeRuntime.ts`][ocr], `buildOpenCodePermissionRules`,
  стр. 505–545):

  ```
  * → ask; read → allow, но *.env и *.env.* → ask (*.env.example → allow);
  glob, grep, lsp, skill, todowrite, question → allow;
  bash, webfetch, websearch, codesearch, external_directory, doom_loop → ask;
  edit → allow только в auto-accept-edits, иначе ask
  ```

  Решения отправляются как `once` / `always` / `reject`
  (`toOpenCodePermissionReply`). Режим `auto` для OpenCode равен
  `approval-required`, потому что у OpenCode нет ИИ-ревьюера.

### 6.2. Токены и стоимость

- **Токены хода в одной форме** `TurnTokenUsage` ([`providerRuntime.ts`][prt],
  стр. 318–346): `inputTokens` (уже **включает** чтение и запись кеша),
  `cachedInputTokens`, `cacheCreationTokens`, `outputTokens` (включает
  рассуждения), `reasoningTokens`, `hasSubagents` и, главное,
  **`usageStatus: 'complete' | 'partial' | 'unavailable'`** — честный признак,
  что движок отдал не всё. `turn.completed` несёт `totalCostUsd`, если движок
  его сообщил.
- **Стоимость считается отдельно** ([`usage/UsageService.ts`][us],
  [`usagePricing.ts`][up]): сервис читает транскрипты движков на диске (JSONL,
  SQLite), в том числе работу, сделанную мимо t3code, и считает цену по
  **таблице LiteLLM** `model_prices_and_context_window.json`. Таблица
  подтягивается раз в сутки и лежит копией на диске. Свои цены пользователь
  задаёт в `usagePriceOverrides`. Цена берётся по базовому тарифу: какой тариф
  сработал на самом деле, в транскрипте не записано.

### 6.3. Лимиты подписки

[`providerUsageLimits.ts`][pul]: окна `{ id, kind: session | weekly | monthly
| other, label, usedPercent, resetsAt }` лежат в снимке провайдера. Во время
хода приходят частичные обновления, и окна сливаются по `id`
(`applyUsageLimits`). `unavailable.reason: 'unsupported' | 'probeFailed'`
различает «у входа по ключу окон не бывает» и «сейчас не смогли прочитать».
Для Codex учитываются кредиты сброса лимита. Свои читатели лимитов есть у
Claude, Codex, Cursor, Grok и OpenCode Go ([`Layers/*UsageLimits.ts`][pl]).
Запасного провайдера при лимите нет.

[us]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/usage/UsageService.ts
[up]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/usage/usagePricing.ts
[pul]: https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/packages/contracts/src/providerUsageLimits.ts
[pl]: https://github.com/pingdotgg/t3code/tree/148e6deea046658639aae9fef5b349781cec39d1/apps/server/src/provider/Layers

## 7. Сравнение: у них / у нас / брать или нет

| Тема | У них (t3code) | У нас (`spec.md`) | Брать? |
|---|---|---|---|
| Движок и провайдер | Драйвер плюс **экземпляр** — ключ маршрутизации. Провайдеров моделей как понятия нет: что умеет OpenCode, решает сам OpenCode | `EngineId` + `ProviderId`, провайдер обслуживается одним движком (§5.1) | **Нет.** Наша модель «пользователь видит провайдера» проще для офиса. Экземпляры (два аккаунта Codex) владельцу не нужны. Вернуться к этому, если попросят «рабочий и личный аккаунт» |
| Открытый id драйвера | Слаг, а не union. Неизвестный драйвер → `unavailable`, данные не теряются | `EngineId`/`ProviderId` — закрытые union (§5.2) | **Да, частично.** При загрузке `state.json` незнакомый провайдер роли не должен ронять загрузку или молча становиться Claude. Показывать «провайдер недоступен в этой версии» |
| Интерфейс адаптера | `ProviderAdapterShape`: сессии, ходы, подтверждения, вопросы, откат, компакция, поток событий | `EngineAdapter` + `EngineSession` (§5.2) | **Свой оставить.** Добавить только `compaction: native \| slash-command` — у нас это уже `compaction` в матрице |
| Словарь событий | ~50 видов, сырое событие прикладывается с меткой источника, NDJSON-лог | `EngineEvent` — 11 видов (§5.2) | **Да:** поле `raw?: { source, event }` в `EngineEvent` и лог сырых событий на сессию — дешёвая страховка для отладки адаптеров |
| Claude | Agent SDK + бинарь пользователя | Agent SDK + скачанный бинарь | Совпадает |
| Codex | app-server, клиент **сгенерирован из схемы** | app-server, рукописный `rpc.ts` | **Идея — да:** генерировать типы из `codex app-server generate-json-schema` [проверить наличие команды] вместо ручного описания |
| OpenCode | `opencode serve` **на экземпляр**, общий, гаснет через 30 с простоя; SDK `@opencode-ai/sdk/v2`; пароль сервера | `opencode serve --port 0` **на сессию** (этап 2) | **Да:** один сервер на офис (или на набор XDG-каталогов), сессии внутри него. Брать официальный SDK, а не писать HTTP руками. Задавать `OPENCODE_SERVER_PASSWORD` |
| Мин. версия OpenCode | `1.14.19`, `>=2.0.0` — `broken` | «фиксируем версию» без числа (§3.5) | **Да:** закрепить ту же нижнюю границу как отправную точку прототипа [проверить на нашей задаче] |
| ACP | Cursor, Grok и Antigravity — через общий ACP-рантайм | ACP только упомянут (Gemini CLI, Goose) | **Да, на этап 6:** общий ACP-адаптер вместо отдельных `antigravity.ts`/`qwen.ts` |
| Antigravity | `agy-acp-server 1.1.1` с `dl.google.com` (из ACP registry), вход Google, нужен Node | «ACP у `agy` нет, issue #31 открыт» (§4.1) | **Пересмотреть §4.1:** ACP-сервер Antigravity существует [проверить условия использования] |
| MCP-мост | Один `/mcp` (Streamable HTTP, 2025-06-18), токен в `Authorization`, в хранилище — хеш; Codex — `bearer_token_env_var`; OpenCode — `client.mcp.add({type:'remote'})` | `/mcp/<токен>`, `OPENCODE_CONFIG_CONTENT.mcp.office` (§5.4) | **Да:** токен в заголовке вместо пути (не попадёт в логи доступа), хранить хеш, для Codex — `bearer_token_env_var`. Снимает [проверить] про транспорт `remote` |
| Проверка входа | Снимок `installed/auth/status/message`; Claude — `claude auth status` + init SDK без промпта | `ProviderStatus` union (§5.2–5.3) | **Наш union оставить.** Взять приём проверки Claude без платного хода и поле `message` с готовым текстом «что сделать» в каждом состоянии |
| Совместимость версий | Удалённый `model-manifest.json`: диапазоны `supported/graceful/unsupported/broken`, текущие и устаревшие модели; вшитая копия на случай без сети | Версия зашита, модели — `models()` у движка | **Да, упрощённо:** вшитый манифест «движок → проверенный диапазон версий + модели по уровням `top/balanced/fast`». Удалённое обновление — позже, нашим реестром (`src/registry`), а не raw GitHub |
| Установка | Codex/Antigravity — сами, фиксированная версия + **sha256 на платформу**; прочие — команда официального установщика в терминале | Ставим из npm в `engineDir()/<движок>/<версия>/` (этап 4) | **Да:** проверять sha256 скачанного (таблица в коде). Запасной путь для движков, которые мы не ставим, — показать официальную команду |
| Контракт прогресса | `ProviderInstallState`: фазы, байты, `source: managed \| local`, `canRemove` | `installing { share }` (§5.2) | **Да:** фазы и `source` — чтобы UI отличал «наш» движок от найденного в PATH и не предлагал удалить чужой |
| Вход | Сценарий с взаимодействиями `browser / deviceCode / terminal / credentials`, несколько методов | `LoginStart = done \| authUrl` (§5.2) | **Да:** заменить на взаимодействия. `deviceCode` и `credentials` покрывают Codex, ключи OpenRouter и т. п., `terminal` — запасной вход `claude auth login` |
| Хранение ключей | Файлы `0600` в `secrets/`; флаг `sensitive`, клиенту — только `valueRedacted`; keyring только на чтение Cursor | Системная связка: `safeStorage` / `@napi-rs/keyring` (§5.7) | **Наше оставить** (решение владельца). Взять правило «клиент видит только `redacted`» и вычищение `OPENAI_API_KEY`/`OPENAI_BASE_URL` из окружения управляемого движка |
| Модель на офис, роль, ход | Глобально → проект → нить → **ход**; служебные генерации отдельно | Офис → роль (§5.6) | **Частично:** отдельная модель для служебных генераций (ритуалы, заголовки, тексты коммитов) — да. На ход — нет, у нас нет ручного выбора на ход |
| Смена провайдера у начатой сессии | Блок: провайдер не меняется, модель — только если драйвер умеет | `sessionForProvider` отбрасывает чужой id (§5.6) | Совпадает. **Добавить** возможность `sessionModelSwitch`: при смене модели роли на ходу не рвать сессию, если движок умеет |
| Форма из схемы | Поля конфига с аннотациями → форма настроек | Экран «Провайдеры» верстается руками (этап 4) | **Нет пока:** у нас 3 движка, а генератор форм — лишняя механика. Вернуться, если движков станет больше пяти |
| Подтверждения | 4 режима на нить, решения `once/session/always`, `full-access` по умолчанию | Шлюз офиса `PermissionGate`, режимы роли | **Правила OpenCode — да** (§6.1, в том числе `*.env → ask`) как основа его набора на сессию. Решение `acceptForSession` — да. `full-access` по умолчанию — **нет** |
| Висящие запросы | Перечитывать `permission.asked` после переподключения | Не описано | **Да** |
| Токены | `TurnTokenUsage` с `usageStatus` и вложенным кешем | `TokenUsage` без признака полноты (§5.2) | **Да:** добавить `status: complete \| partial \| unavailable` |
| Стоимость | Сканер транскриптов + таблица LiteLLM + переопределения пользователя | Цена от движка или models.dev, своя таблица для Codex | **Да, как запасной источник:** таблица LiteLLM (MIT) для моделей, у которых нет цены в models.dev, плюс цены владельца в настройках. Сканер транскриптов не берём: офис считает только свои сессии |
| Лимиты | Окна в снимке, слияние по `id`, `unavailable: unsupported \| probeFailed` | `limited` + `LimitReport` (§5.3) | **Да:** различать «не бывает» и «не смогли прочитать», чтобы шкала не пропадала при сбое опроса |
| Запасной провайдер | Нет | Нет (решение владельца) | Совпадает |

## 8. Лицензия

t3code распространяется по лицензии **MIT**, © 2026 T3 Tools Inc.
([LICENSE](https://github.com/pingdotgg/t3code/blob/148e6deea046658639aae9fef5b349781cec39d1/LICENSE)).
Наш проект — Apache-2.0.

Что из этого следует:

- **Копировать код можно**, в том числе в проект под Apache-2.0. Условие одно:
  сохранить уведомление об авторских правах и текст MIT рядом со
  скопированным кодом. Например, шапкой в файле и записью в новом
  `THIRD_PARTY_NOTICES.md` — сейчас такого файла у нас нет.
- **На практике берём идеи, а не код.** Сервер t3code написан на Effect v4,
  каждая функция — `Effect.gen` с сервисами из контекста. Перенос в наш стек
  без Effect — это переписывание, после которого от оригинала остаётся
  только замысел, а замысел лицензией не охраняется.
- **Без переписывания можно взять** небольшие чистые куски, если захотим
  дословно: набор правил OpenCode (`buildOpenCodePermissionRules`), перевод
  решений в `once/always/reject`, разбор `server listening on …`, данные
  `compatibility` из `model-manifest.json`. Каждый такой кусок — с пометкой
  MIT и записью в notices.
- **Чего брать нельзя или не стоит:** зависеть во время работы от их
  `raw.githubusercontent.com/pingdotgg/t3code/main/…` — это чужая
  инфраструктура без обещаний. Имена и логотипы t3code лицензия не передаёт.
- Таблица цен LiteLLM, которую использует t3code, — отдельный проект BerriAI
  под MIT [проверить лицензию файла цен].

## 9. Предложения правок к `spec.md`

Только предложения: `spec.md` в этой задаче не менялся.

1. **§4.1 (Antigravity).** Вывод «Antigravity CLI пока нельзя управлять
   программно» устарел. Google выкладывает `agy-acp-server` (1.1.1, macOS,
   Linux, Windows) на `dl.google.com`, он есть в ACP registry, t3code
   подключает его по ACP со входом Google. Предлагается переписать вывод так:
   ACP есть, нужен Node, вход по подписке Google работает через браузер. Этап
   6 остаётся необязательным, но перестаёт быть «когда появится ACP».
   [проверить: условия использования Google для сторонних клиентов и
   совпадение с нашим запретом «подписка через чужой клиент»].
2. **§3.5 и §5.4 (мост MCP).** Снять [проверить] про транспорт
   `type: "remote"`: t3code подключает к OpenCode Streamable HTTP MCP
   (протокол 2025-06-18) с заголовком `Authorization`. Изменить схему моста:
   один путь `/mcp`, токен сессии в `Authorization: Bearer`, в памяти хранить
   хеш токена. Подключать мост к OpenCode через `client.mcp.add()` после
   старта сервера, а не только через `OPENCODE_CONFIG_CONTENT`. Для Codex —
   `mcp_servers.office.url` + `bearer_token_env_var`: так мостом можно
   заменить `dynamicTools`, если они останутся экспериментальными.
3. **§6, этап 2 (OpenCode).** Заменить «процесс `opencode serve --port 0` на
   сессию» на «один сервер на офис, сессии OpenCode внутри него, сервер
   гаснет после простоя». Взять официальный клиент `@opencode-ai/sdk/v2`.
   Задавать `OPENCODE_SERVER_PASSWORD`, потому что порт локальный, но
   открытый всем процессам машины. Закрепить нижнюю границу версии `1.14.19`
   и считать `>=2.0.0` несовместимой до проверки.
4. **§3.5 и §5.5 (подтверждения OpenCode).** Снять [проверить] про форму
   `ask`: события называются `permission.asked` / `permission.replied`,
   ответ — `once | always | reject`, у вопросов агента отдельные события
   `question.asked` / `question.replied` / `question.rejected`. Добавить
   требование: после переподключения к серверу перечитать висящие запросы.
   Набор правил по умолчанию для режимов ниже `auto` взять из t3code
   (`*.env → ask`, `doom_loop → ask`, `external_directory → ask`).
5. **§5.2 (`EngineEvent`).** Добавить к каждому событию необязательное
   `raw?: { source: string; event: unknown }` и писать сырые события сессии в
   NDJSON-файл рядом с логом задачи. Добавить вид `ask-user` (вопрос агента
   с вариантами) — он нужен OpenCode и ACP; у нас его сейчас решает только
   инструмент `ask_owner`.
6. **§5.2 (`TokenUsage`).** Добавить `status: 'complete' | 'partial' |
   'unavailable'` и договориться, что `input` включает кеш (или явно, что не
   включает). Сейчас это не сказано, а Claude и OpenCode считают по-разному.
7. **§5.2 (`ProviderStatus`).** К каждому состоянию добавить `message?:
   string` — готовый текст «что сделать» с сервера, как `provider.message` у
   t3code. Для `limited` различать `unsupported` и `probeFailed`, чтобы
   шкала лимита не пропадала при сбое опроса.
8. **§5.2 (`LoginRequest` / `LoginStart`).** Заменить `authUrl` на
   взаимодействия: `browser { url }`, `deviceCode { url, userCode }`,
   `credentials { fields[] }`, `terminal { output }`, с фазами `starting →
   waiting → verifying → succeeded | failed | cancelled` и `flowId`.
   `terminal` нужен как запасной вход в Claude Code (`claude auth login`) без
   выхода из приложения.
9. **§5.2 и этап 4 (установка).** `installing` расширить до фаз
   `downloading | extracting | verifying` с байтами и полем `source:
   'managed' | 'local'`, где `local` — найден в PATH и удалять его нельзя. В
   `desktop/engines.js` проверять sha256 скачанного архива по таблице в коде,
   как `CodexInstallation.ts`.
10. **§5 (новый подраздел «Манифест движков»).** Вшитый в сборку файл: для
    каждого движка проверенный диапазон версий со статусами `supported |
    graceful | broken` и модели по уровням `top/balanced/fast` с пометкой
    устаревших. Позже обновлять его через наш сервис индекса
    (`src/registry`) без выпуска приложения. Это заменяет `MODEL_IDS` в
    `src/shared/models.ts` и даёт `ModelInfo.tier` (§5.2) источник данных.
11. **§5.2 (`ProviderId`).** При загрузке незнакомый провайдер роли (сохранение
    из более новой версии или ветки) не сбрасывать на умолчание, а сохранять
    как есть и показывать «провайдер недоступен в этой версии».
12. **§5.5 (матрица).** Добавить строку `sessionModelSwitch`: можно ли сменить
    модель в начатой сессии. Если нельзя, смена модели роли действует со
    следующей сессии — как и смена провайдера сейчас.
13. **§5.6.** Добавить необязательную модель офиса для служебных генераций
    (`Settings.utilityModel?: ModelChoice`): ритуалы, тексты коммитов и
    выпусков, заголовки. Пусто — как у офиса.
14. **§5.7.** Дописать: управляемому движку убирать из окружения
    `OPENAI_API_KEY` и `OPENAI_BASE_URL` (и аналоги других провайдеров),
    чтобы переменная из окружения владельца не перенаправила движок на другой
    счёт. Веб получает только признак «ключ задан», значение — никогда
    (у нас это уже `KeyStore.list()`, пункт для явности).
15. **§3.5, деньги.** Запасной источник цен: таблица LiteLLM
    (`model_prices_and_context_window.json`), копия на диске, обновление раз
    в сутки, плюс цены владельца в настройках. Закрывает «цены своих
    провайдеров OpenCode не знает» (#17223).
16. **Новый пункт в «Чего здесь сознательно нет» (§7).** Экземпляры
    провайдеров (два аккаунта одного движка) и выбор модели на отдельный ход.
    В t3code это есть, офису пока не нужно.

## Проверка

- Репозиторий склонирован (`git clone --depth 1`, коммит `148e6de` от
  2026-10-01), всё выше прочитано по коду этого коммита. Номера строк в
  ссылках — оттуда.
- Ничего не запускалось: ни t3code, ни движки. Поведение «по коду» помечено
  там, где это существенно.

**Не проверено [проверить]:**

- условия Google на использование `agy-acp-server` сторонним приложением;
- есть ли у Codex команда генерации JSON-схемы app-server в нашей версии;
- что `ElectronSafeStorage` в t3code не трогает ключи провайдеров;
- подходит ли `1.14.19` как нижняя граница OpenCode под наши запросы;
- лицензия именно файла цен LiteLLM.

## Итог: что внесено в `spec.md` (T-209)

Владелец согласовал разбор. Предложения §9 внесены в [`spec.md`](spec.md) в
задаче T-209, кроме отклонённых.

| № | Предложение | Итог | Куда в `spec.md` |
|---|---|---|---|
| 1 | Antigravity по ACP | **Отклонено** — решение владельца Q-53: условия Google (раздел 6) запрещают доступ через стороннее ПО, разбор [`docs/legal/T-210/antigravity.md`](../../legal/T-210/antigravity.md). В §4.1 записан отказ, этапа под Antigravity нет, движок убран из `EngineId` и матрицы | §4.1, §6 этап 6, §7 |
| 2 | Мост MCP: `/mcp`, Bearer, хеш, `client.mcp.add`, Codex `bearer_token_env_var` | Внесено, [проверить] про транспорт снят | §3.5, §5.4, этап 2 |
| 3 | Один сервер OpenCode на офис, `@opencode-ai/sdk/v2`, пароль, версия `1.14.19` / `>=2.0.0` | Внесено | §3.5, этап 2, §5.8 |
| 4 | Подтверждения OpenCode `permission.asked` → `once/always/reject`, вопросы, висящие запросы, правила по умолчанию | Внесено, [проверить] про форму `ask` снят; `full-access` по умолчанию не взят | §3.5, §5.5, этап 2 |
| 5 | `EngineEvent.raw`, NDJSON-лог, событие `ask-user` | Внесено | §5.2, этап 1 |
| 6 | `TokenUsage.status`, договорённость про кеш во `input` | Внесено: `input` без кеша | §5.2 |
| 7 | `ProviderStatus.message`, `unsupported` / `probeFailed` у лимитов | Внесено | §5.2, §5.3 |
| 8 | Вход взаимодействиями `browser/deviceCode/credentials/terminal`, `flowId`, фазы | Внесено | §5.2, этап 4 |
| 9 | Фазы установки, байты, `source`, sha256 | Внесено | §5.2, этап 4 |
| 10 | Манифест движков | Внесено | §5.8, этап 3 |
| 11 | Незнакомый провайдер не сбрасывать | Внесено | §5.1, §5.2, §5.3, этап 3 |
| 12 | `sessionModelSwitch` в матрице | Внесено | §5.2, §5.5 |
| 13 | `Settings.utilityModel` | Внесено | §5.6, этап 3 |
| 14 | Вычищение `OPENAI_API_KEY`/`OPENAI_BASE_URL`, веб видит только «ключ задан» | Внесено | §5.7 |
| 15 | Запасные цены LiteLLM | Внесено | §3.5 |
| 16 | Экземпляры провайдеров и модель на ход — в «Чего здесь сознательно нет» | Внесено (как отказ: сами экземпляры и модель на ход не берём) | §7 |

Из таблицы §7 вне списка §9 внесены ещё: генерация типов Codex из схемы
(этап 1, [проверить]), проверка Claude без платного хода (§5.3), решение «на
сессию» в шлюзе (`PermissionGate.scope`, §5.2), общий ACP-адаптер вместо
отдельных файлов (этап 6). Форма настроек из схемы не взята, как и решено в
разборе.
