# AI Office

Офис с видом сверху, где команда AI-агентов выполняет ваши задачи. Вы ставите
задачу менеджеру, он режет её на задачи и раздаёт исполнителям, а человечки в
комнате показывают, кто чем занят прямо сейчас. Исполнители работают
настоящими инструментами Claude Code или Codex, каждый в своей ветке вашего
репозитория; сданную работу смотрит ревьюер, и конвейер вливает её сам.

*AI Office is a top-down office where a team of AI agents works on your
project: you brief the manager, agents pick up tasks in isolated git
worktrees, and the room shows who is doing what. The office speaks English
or Russian; the docs are in Russian for now.*

Концепт и план развития — [CONCEPT.md](CONCEPT.md).

## Быстрый старт

Офис ставится приложением — `.dmg` для macOS и `.exe` для Windows — со
страницы [релизов](https://github.com/OctopBP/ai-office/releases). Клон
репозитория и Node для этого не нужны: движок Claude Code приложение ставит
себе само при первом запуске, а состояние держит в папке данных пользователя.
Подробности — [docs/guide/desktop.md](docs/guide/desktop.md).

## Запуск из исходников

Так офис запускают те, кто правит его сам. Понадобится:

- **Node 22** (версия в `.nvmrc`);
- **Git и Git LFS** — 3D-модели и текстуры лежат в LFS, без него сцена не
  соберётся;
- **Claude Code CLI** (`claude` → `/login` либо `ANTHROPIC_API_KEY`) и/или
  актуальный **Codex CLI** (`codex login`). Провайдер выбирается для каждой роли;
- Blender и python3 — только если правите 3D-сцену.

```bash
git lfs install
git clone git@github.com:OctopBP/ai-office.git
cd ai-office
npm ci
npm run smoke      # доступ к Claude: должно напечатать RESULT: success
npm run test:providers # адаптер Codex без расхода токенов
npm run office     # сборка и сервер, откройте http://localhost:3001
```

Поставьте задачу менеджеру, например: «Сделай CRUD для заметок: JSON API на
бэке и страницу на фронте». По умолчанию команда работает в отдельной папке
`workspace/`, чтобы не править исходники самого офиса; свой проект укажите
через `OFFICE_PROJECT_DIR`. Остальные переменные — в [.env.example](.env.example).

Для разработки самого офиса, с пересборкой на лету:

```bash
npm run dev        # http://localhost:5173
```

Разница не только в удобстве: `npm run dev` перезапускает сервер на каждую
правку и обрывает живые сессии агентов, а `npm run office` держит офис
работающим, пока вы правите код. Подробнее —
[docs/guide/running.md](docs/guide/running.md).

## Что внутри

- **Команда из десяти ролей** — менеджер, backend, frontend, дизайнер, SMM,
  ревьюер, художник, 3D-художник, иллюстратор и юрист — с разными моделями,
  инструментами и изоляцией. Новых сотрудников можно нанять из маркета
  пакетов или описать свою роль.
- **Изоляция не на доверии.** Каждая задача идёт в своём git worktree,
  каждый вызов инструмента проходит классификатор рисков, а под ним —
  песочница ОС.
- **Конвейер ревью.** Сданную ветку смотрит ревьюер, автор правит, офис
  вливает; при конфликте работа не теряется.
- **Совещания, план, процессы.** Круговое обсуждение с итогом у менеджера,
  план фич с порядком и зависимостями, свои процессы с проверками.
- **Расходы на виду.** Стоимость каждой задачи и агента, лимит плана и
  бюджеты офиса.

Клавиши: `ENTER` чат с менеджером, `B` доска, `E` расходы, `L` лог,
`M` совещание, `P` процессы, `SPACE` пауза, `1`–`9` карточка агента.

## Документация

| Файл | О чём |
|---|---|
| [docs/guide/running.md](docs/guide/running.md) | Запуск, подписка или API, переменные окружения, бриф `OFFICE.md`, все команды |
| [docs/guide/desktop.md](docs/guide/desktop.md) | Приложение для macOS и Windows: установка, движок, папка данных, сборка установщика |
| [docs/guide/office.md](docs/guide/office.md) | Интерфейс, язык, совещания, карточка агента, критерии готовности, пауза |
| [docs/guide/team.md](docs/guide/team.md) | Роли и модели, найм, бюджеты, маркет пакетов |
| [docs/guide/architecture.md](docs/guide/architecture.md) | Как устроено, разрешения, песочница, изоляция задач |
| [docs/guide/pipeline.md](docs/guide/pipeline.md) | План фич и конвейер ревью от «сдал» до «влито» |
| [docs/guide/offices.md](docs/guide/offices.md) | Несколько офисов и репозиториев, облачный режим, персистентность |
| [docs/guide/costs.md](docs/guide/costs.md) | Расходы, лимит плана, расходы по офисам |
| [docs/guide/testing.md](docs/guide/testing.md) | Регрессионные тесты менеджера |
| [docs/guide/graphics.md](docs/guide/graphics.md) | Спрайты, сетка и темы |
| [docs/guide/status.md](docs/guide/status.md) | Что есть и чего пока нет |
| [OFFICE.md](OFFICE.md) | Бриф, который офис даёт своим агентам: принцип и карта файлов |
| [docs/design/](docs/design/) | Спеки крупных частей: маркет, процессы, живой офис, 3D-сцена |
| [packages/README.md](packages/README.md) | Формат пакета роли и авторский путь в маркет |

## Проверки

```bash
npm run typecheck
npm run build
npm run test:state     # и другие test:* — без сети и токенов
npm run test:pm        # поведение менеджера, стоит токенов
```

Полный список наборов с описанием — в
[docs/guide/running.md](docs/guide/running.md#полезные-команды).

## Участие

Как поднять окружение, что гонять перед PR и какие правила проект держит
сознательно — в [CONTRIBUTING.md](CONTRIBUTING.md). Об уязвимостях — в
[SECURITY.md](SECURITY.md), не через issue.

Лицензия — [Apache-2.0](LICENSE).
