# Antigravity (agy-acp-server) в стороннем приложении: условия Google

**Решение владельца (Q-53): Antigravity не подключаем, Gemini — только через OpenCode по API-ключу.** Документ остаётся обоснованием этого решения (на него ссылается `docs/design/providers/spec.md`) и черновиком для живого юриста.

> **Черновик для проверки живым юристом. Это не юридическая консультация и не заключение о соответствии условиям.**
> Источники читались через веб-выдержки на 2026-10-01; шаг verify повторно открыл условия (раздел 6, цитата верна, даты редакции на странице нет, есть оговорка об исключении для пользователей Gemini Enterprise) и все четыре форумных ответа (цитаты, даты и роли сверены). Страницу условий я видел в пересказе, без даты редакции. Прежде чем строить на ней текст на экране, надо открыть её и прочитать целиком.
> Шаг rework (2026-10-01) дополнительно прочитал: страницу тарифов Antigravity, объявление о переходе Gemini CLI → Antigravity CLI и страницу Anthropic «Legal and compliance» (первоисточник для сравнения). WebFetch отдаёт пересказ модели, а не сырой текст: все цитаты ещё раз сверяет юрист по оригиналу. Места, где источник неоднозначен или не проверен, помечены **[проверить]**.

## 1. Вывод

**Можно с оговорками.** По документам картина двоякая:

- Письменные условия запрещают доступ к сервису через «стороннее ПО» и называют это нарушением. Они не определяют границу между «сторонним ПО» и официальным клиентом, запущенным из чужой программы.
- Сотрудники Google на форуме отвечают по этому вопросу **противоположно**. Эти ответы не являются условиями и ничем нас не связывают.
- Сам Google выпускает ACP-сервер (`agy_acp_server.par`), и он есть в ACP Registry. Это сильный довод в пользу того, что запуск официального бинарника по ACP — задуманный путь.

Рабочая гипотеза: **безопасно только то, что офис запускает неизменённый официальный бинарник на машине пользователя, вход делает сам пользователь через agy, и офис не касается токенов.** Всё сверх этого (прокси, общий аккаунт, чтение токенов, облачный запуск вместо локального) — вне допустимого. Остаётся реальный риск: Google может трактовать запуск несколькими автономными агентами как «сторонний агент на квоте подписки» и приостановить аккаунт. Этот риск должен знать пользователь **[проверить]** (вопрос к Google/юристу, раздел 6).

**Главная оговорка — форум, 30.09.2026.** Даже самый разрешающий ответ сотрудника Google допускает запуск `agy` только лично пользователем и прямо исключает автономную работу без человека: «not exposed as a shared server, multi-user relay, or **unattended high-frequency polling loop**». Это бьёт по самому сценарию офиса: агенты берут задачи и работают без присмотра владельца, часто и параллельно. Значит, даже при благоприятном прочтении условий офис в своём обычном режиме выходит за рамки, которые Google называет допустимыми. Итог: **можно с оговорками, риск высокий**; владелец решил не подключать (Q-53).

## 2. Первоисточники и цитаты

### 2.1. Условия: сторонние программы запрещены

[Google Antigravity Additional Terms of Service, раздел 6](https://antigravity.google/terms/):

> «Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts.»

Что из этого следует:
- Приостановка касается аккаунта **пользователя**, а не только нашего приложения.
- Пример в скобках (чужой инструмент, который берёт OAuth Antigravity) описывает подмену клиента. Наш сценарий в нём не назван ни разрешённым, ни запрещённым. **[проверить]**: считается ли запуск официального `agy`/ACP-сервера подпроцессом «сторонним ПО, обращающимся к сервису».
- Версия и дата условий в выдержке не указаны **[проверить]**.

### 2.2. Google сам поставляет ACP-сервер

- [Zed: Google Antigravity — ACP Agent](https://zed.dev/acp/agent/antigravity-acp) указывает Google как издателя («Google's AI coding agent»). Установка идёт из ACP Registry, запуск — `./agy_acp_server.par`.
- Официальное ядро проприетарное и ставится отдельно. Оно само отвечает за «OAuth | models | tools | MCP | inference» ([DEV Community, Paseo adapter, август 2026](https://dev.to/tiezbro/building-a-paseo-product-adapter-for-googles-official-antigravity-acp-kernel-2lcn), пересказ третьего лица **[проверить]**).
- Прямой страницы документации Google про `agy-acp-server` я не нашёл. Условия лицензии на бинарник и лимиты неизвестны **[проверить]**.
- Оговорка: в [обсуждении Zed #57221](https://github.com/zed-industries/zed/discussions/57221) (на момент его создания) и в [issue #604 fidget](https://github.com/omesser/fidget/issues/604) утверждается, что у Google нет нативного ACP. [Запрос #31 в antigravity-cli](https://github.com/google-antigravity/antigravity-cli/issues/31) о нём открыт. Эти источники, судя по датам, старше появления официального сервера в реестре. Спутать официальный сервер с **сообщественными обёртками** (`antigravity-acp`, `agy-acp` и др.) нельзя: обёртки сами предупреждают, что аккаунт могут заблокировать.

### 2.3. Форум Google AI Developers: ответы сотрудников противоречат друг другу

Форум не является условиями использования. Но это единственные официальные пояснения, и они расходятся:

| Дата | Ответ | Смысл для нас |
|---|---|---|
| 21.07.2026 (отвечает «DrQwertySilence» — **участник сообщества, не сотрудник Google**; проверено 2026-10-01, вес как у мнения, не как у разъяснения) | [«That's fine. The issue Google has with third-party tools is when they use the models at your disposal for your account in other harnesses»](https://discuss.ai.google.dev/t/is-invoking-the-official-antigravity-cli-agy-print-from-a-third-party-developer-tool-an-acceptable-use/175462) | Вызов официального `agy --print` допустим. Не допускается использовать модели в чужой «упряжи». |
| 16.09.2026 (Rebbanpalli_Naveen, сотрудник команды Antigravity; роль проверена 2026-10-01) | [«Да, описанный вами способ (обёртка agy через IPC/PTY для ACP-редакторов) соответствует требованиям. Ограничения ToS направлены на предотвращение краж учётных данных и мульти-пользовательского прокси»](https://discuss.ai.google.dev/t/clarification-request-is-local-ipc-pty-wrapping-of-agy-cli-for-open-standard-editor-bridges-e-g-acp-tos-compliant/175905) (английский оригинал проверен 2026-10-01: «Yes, your described pattern is compliant. The ToS restriction on third-party access tools is aimed at credential harvesting, unofficial API reverse-engineering, and multi-tenant proxying»; условие — токены не извлекаются, не хранятся и не пересылаются, процесс одиночный и локальный) | Самый близкий к нашему случаю. Говорит «можно». |
| 25.09.2026 (Ambati_Rajendra — по выдержке — сотрудник команды Antigravity **[проверить]**; цитаты сверены дословно) | [«Wrapping `agy -p` in a local MCP server to use with third-party agents … is **not permitted**»; «Your Google AI Pro subscription quota is strictly for direct use within official Antigravity tools … and cannot be used to power third-party agents»](https://discuss.ai.google.dev/t/is-using-the-official-agy-cli-through-a-local-mcp-server-with-third-party-ai-agents-permitted/184829) | Прямо против: квота Pro «для официальных инструментов». Речь о MCP-мосте для сторонних агентов. Офис с ACP — очень похожий случай **[проверить]**. |
| 30.09.2026 (chunduriv, «Google team member»; проверено 2026-10-01) | [Локальный AI-помощник (Claude Code) может запускать `agy.exe` как дочерний процесс: «Yes». Условия: «You do not extract, read, or forward Antigravity's cached OAuth tokens to external tools»; «The setup is used strictly by you as an individual user on your local machine (not exposed as a shared server, multi-user relay, or unattended high-frequency polling loop)» — **оговорка про «unattended high-frequency polling loop» бьёт по автономным агентам офиса без человека; в первой версии документа она была пропущена**. Headless-запуски расходуют ту же квоту, что и интерактивные](https://discuss.ai.google.dev/t/is-invoking-the-official-agy-cli-from-a-local-ai-coding-assistant-allowed-on-an-individual-google-ai-account/185992) | Самый свежий и самый близкий к «приложение запускает agy». Условия: лично пользователем, локально, без токенов, не «неприсмотренный высокочастотный опрос». |

Самое свежее (30.09) разрешает локальный дочерний процесс на личном аккаунте. Раньше (25.09) тот же форум запрещал мост для сторонних агентов. Единой позиции нет. Ссылаться на любой из ответов как на разрешение нельзя.

## 3. Ответы на вопросы задачи

### 3.1. Подписка пользователя: Pro / Ultra, бесплатный, корпоративный

| Тип входа | Что сказано | Оценка |
|---|---|---|
| **Google AI Pro / Ultra** (личный аккаунт) | 30.09: допустимо локально и лично. 25.09: квота Pro «только для официальных инструментов и не для сторонних агентов». Условия, раздел 6: запрет стороннего ПО | **С оговорками, высокий риск** **[проверить]**. Отдельные тарифные условия Pro/Ultra в выдержках не нашёл |
| **Бесплатный уровень** | [Страница тарифов](https://antigravity.google/docs/plans/): «all product features, such as scheduled tasks and the CLI» доступны на всех планах; базовый план — «A meaningful quota, refreshed weekly». Для индивидуальных аккаунтов — «terms derived from Google's Terms of Service». Gemini CLI с 18.06.2026 перестал обслуживать free, Pro и Ultra ([объявление, 19.05.2026](https://github.com/google-gemini/gemini-cli/discussions/27274)): эти уровни теперь только через Antigravity CLI | Отдельных правил для сторонних приложений на free нет; различий в условиях не видно. Тарифная страница про сторонние инструменты молчит. **[проверить]**: «terms derived from Google's Terms of Service» — какой именно документ |
| **Корпоративные** (Gemini Enterprise Standard/Plus, Workspace). Условия Antigravity: при доступе через Gemini Enterprise (Google Cloud) «the terms below do not apply to you» (пересказ, **[проверить]** точную формулировку) | [Документация Enterprise](https://antigravity.google/docs/enterprise/): доступ «under your existing Google Cloud Terms of Service», поддержаны Antigravity 2.0, CLI и расширения IDE (VS Code, JetBrains, Zed, Xcode). Условия самих Additional Terms для таких пользователей не действуют: они подчиняются отдельным корпоративным условиям | **[проверить]**: что корпоративные условия говорят о запуске CLI из стороннего приложения. Администратор организации может ограничить использование. Пользователь не вправе решать это сам |
| **API-ключ** (AI Studio / Vertex AI) | Google прямо советует его для сторонних сценариев. Это отдельная оплата по API, без подписки | Самый безопасный путь. Для офиса его даёт путь через OpenCode (решение T-46 в spec.md) |

### 3.2. Автоматизация, параллельные сессии, работа без человека

- Прямого запрета автоматизации в условиях нет: в выдержке раздела про автоматизацию и лимиты не нашёл **[проверить]**.
- Форум: «headless-запуски расходуют ту же квоту, что интерактивные» (30.09). «Обычные пользовательские запросы не вызовут флаги злоупотребления» (16.09). Слово «обычные» не определено.
- Локальный скрипт для собственной автоматизации — «стандартное использование CLI» (25.09, тот же ответ, что запрещает мост для сторонних агентов).
- Параллельные сессии: ограничений в источниках не нашёл. Но «мульти-пользовательский прокси» запрещён; параллель одного человека — не прокси, а несколько автономных агентов без человека может выглядеть как злоупотребление квотой **[проверить]**.
- Условие «каждый запрос — реальное действие пользователя» из пересказа ответа 21.07 — вывод пересказчика, не цитата Google.

### 3.3. Отличие от Anthropic

Anthropic проверен по первоисточнику: [Claude Code — Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) (в пересказе, без даты редакции **[проверить]**). Ключевое из него:

> «Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.»
>
> «Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code…»
>
> «The Claude Code binary must not be modified» · «Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK.»

**Заметка.** Та же страница Anthropic ([code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)) велит разработчикам на Agent SDK входить по API-ключу, а не по подписке. Это согласуется с решением владельца в `docs/design/providers/spec.md` (Q-47): основной вход в Claude — по API-ключу, подписка — дополнительный способ с пометкой «вход в ваш собственный Claude Code».

То есть у Anthropic граница написана в самих условиях и совпадает с нашей схемой: неизменённый бинарник, вход самого пользователя в Anthropic-поток, никаких токенов у приложения. У Google то же допущение держится только на форумных ответах.

| | Anthropic | Google (Antigravity) |
|---|---|---|
| Что разрешено | В условиях: пользователь входит своей подпиской в **неизменённый** Claude Code, в том числе когда его запускает чужая платформа; приложение не принимает, не хранит и не пересылает токены | Условия запрещают «стороннее ПО для доступа к сервису». Формальной оговорки «вход в официальный клиент разрешён» в условиях нет |
| Кто разъясняет | Правило сформулировано явно, в документации | Разъяснения только на форуме, сотрудники противоречат друг другу |
| Лимиты и автоматизация | «Ordinary, individual usage» — тоже не определено | Форум 30.09: не «unattended high-frequency polling loop» |
| Официальный путь для сторонних | Claude Code как подпроцесс, вход самого пользователя (решение T-204 в spec.md) | Официальный ACP-сервер Google в ACP Registry **и** рекомендация использовать API-ключ |
| Риск | Известная граница | Граница неясна, возможна приостановка аккаунта и Antigravity, и Gemini CLI |

Уточнение к формулировке задачи: у Anthropic не «только в его Claude Code» вообще, а «неизменённый Claude Code + вход самого пользователя; приложение не оказывается посредником». Общее у обоих: офис — оболочка над официальным бинарником, токенов не касается, вход делает человек.

## 4. Что офис обязан показать и сделать

Пометки и ссылки (рекомендация, не требование закона):

1. До первого входа на экране «Провайдеры» показать предупреждение (текст ниже).
2. Ссылка на [Antigravity Additional Terms](https://antigravity.google/terms/), раздел 6, и на условия аккаунта пользователя.
3. Явная метка у входа «подписка Google»: «Использование на ваш риск и по условиям Google». Рядом метка у API-ключа: «рекомендуется Google для сторонних приложений».
4. Подтверждение галочкой («Я прочитал условия Google и принимаю риск для моего аккаунта») до включения движка. Включать движок без подтверждения нельзя.
5. Для организации: «Если вы входите рабочим аккаунтом, уточните у администратора, разрешено ли это».

Технические условия, из которых исходит допущение «можно»:
- Офис запускает только неизменённый официальный `agy_acp_server.par`, поставленный Google. Бинарник офис с собой не распространяет **[проверить]**: лицензия на распространение неизвестна, надо ставить из реестра/у пользователя.
- Офис не читает, не копирует и не передаёт токены и не лезёт в хранилище ключей agy.
- Запуск только локально, на машине пользователя. Облачный режим (`cloud.ts`) и серверный запуск для чужих аккаунтов для этого движка не включать.
- Один человек — один аккаунт. Не делать общих аккаунтов и прокси.
- Не позиционировать офис как способ «получить Gemini по подписке» для чужих агентов.

## 5. Рекомендуемый текст на экране «Провайдеры» (черновик)

**Antigravity (Google) — вход подпиской**

> Офис запускает официальный Antigravity CLI на вашем компьютере и общается с ним через ACP. Вы входите в свой аккаунт Google сами; офис не видит и не сохраняет ваши ключи и токены.
>
> Условия Google запрещают доступ к Antigravity через стороннее ПО и допускают приостановку аккаунта ([условия, раздел 6](https://antigravity.google/terms/)). Мы запускаем официальную программу Google, но Google может считать, что подписка Pro/Ultra предназначена только для её собственных инструментов. Всю работу офиса (несколько агентов, без вашего участия) спишут с вашей квоты. Риск приостановки аккаунта — ваш.
>
> Google допускает такой запуск только лично вами, на вашем компьютере, без общего доступа к серверу и без «неприсмотренного» высокочастотного опроса. Автономная работа агентов без вас может выйти за эти рамки.
>
> Рабочий аккаунт организации: уточните у администратора, разрешено ли это.
>
> Безопаснее: ключ API Google AI Studio или Vertex AI (оплата по использованию). [Подключить по ключу]
>
> ☐ Я прочитал условия Google и принимаю риск для своего аккаунта. [Войти через Google]

Тексты нужны на русском и английском (словари `src/web/i18n`). Английский перевод юридически значимой формулировки должен проверить юрист.

## 6. Не закрыто

Эти вопросы без Google или живого юриста не закрыть. Решение владельца (Q-53) от них не зависит; они нужны, только если к Antigravity когда-нибудь вернутся.

1. **[проверить]** Полный текст и дата Antigravity Additional Terms, а также условия Google AI Pro/Ultra и бесплатного уровня. В выдержках их не было; на тарифной странице — только «terms derived from Google's Terms of Service».
2. **[проверить]** Прямой письменный ответ Google (или запрос в поддержку): допустим ли запуск `agy_acp_server.par` из стороннего настольного приложения на личной подписке, с несколькими параллельными сессиями. Форум этого не заменяет.
3. **[проверить]** Роль автора ответа от 25.09 (Ambati_Rajendra): по выдержке — сотрудник команды Antigravity; подтвердить на самой странице. Ответ запрещающий, и при подтверждённой роли вес у него как у ответов 16.09 и 30.09.
4. **[проверить]** Страница документации `agy-acp-server` и лицензия на бинарник `agy_acp_server.par`, включая право распространения. Своей страницы документации Google я не нашёл.
5. **[проверить]** Корпоративные условия (Gemini Enterprise, Workspace) для сценария «сторонний клиент», включая точную формулировку исключения «the terms below do not apply to you».
6. **[проверить]** Применимость к пользователям в ЕС и других юрисдикциях, обработка персональных данных при передаче промптов Google (для нашей политики конфиденциальности).
7. **[проверить]** Условия Anthropic (Consumer/Commercial Terms): читалась только страница документации Claude Code, цитаты сверены; юристу сверить с самими Terms, в том числе указание входить по API-ключу при разработке на Agent SDK (см. заметку в 3.3).
8. **[проверить]** Автономная работа без человека (оговорка 30.09, «unattended high-frequency polling loop»): где граница «неприсмотренной» работы и подпадает ли под неё обычный режим офиса.

Закрыто в шаге rework: тарифная страница и объявление о переходе прочитаны (молчат про сторонние приложения); позиция Anthropic проверена по первоисточнику.

## 7. Источники

- [Google Antigravity Additional Terms](https://antigravity.google/terms/)
- [Antigravity Enterprise docs](https://antigravity.google/docs/enterprise/)
- [Antigravity Plans](https://antigravity.google/docs/plans/)
- [Gemini CLI → Antigravity CLI, объявление](https://github.com/google-gemini/gemini-cli/discussions/27274)
- [Anthropic: Claude Code — Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Zed ACP Registry: Google Antigravity](https://zed.dev/acp/agent/antigravity-acp)
- Форум Google AI Developers: [175462](https://discuss.ai.google.dev/t/is-invoking-the-official-antigravity-cli-agy-print-from-a-third-party-developer-tool-an-acceptable-use/175462), [175905](https://discuss.ai.google.dev/t/clarification-request-is-local-ipc-pty-wrapping-of-agy-cli-for-open-standard-editor-bridges-e-g-acp-tos-compliant/175905), [184829](https://discuss.ai.google.dev/t/is-using-the-official-agy-cli-through-a-local-mcp-server-with-third-party-ai-agents-permitted/184829), [185992](https://discuss.ai.google.dev/t/is-invoking-the-official-agy-cli-from-a-local-ai-coding-assistant-allowed-on-an-individual-google-ai-account/185992)
- [antigravity-cli, issue #31 (ACP)](https://github.com/google-antigravity/antigravity-cli/issues/31)
- [Zed discussion #57221](https://github.com/zed-industries/zed/discussions/57221), [fidget issue #604](https://github.com/omesser/fidget/issues/604), [DEV: Paseo adapter](https://dev.to/tiezbro/building-a-paseo-product-adapter-for-googles-official-antigravity-acp-kernel-2lcn) — вторичные источники
