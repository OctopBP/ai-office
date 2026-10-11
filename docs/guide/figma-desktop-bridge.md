# Figma Desktop Bridge: где manifest.json и как запустить плагин

Короткая памятка на случай «в Plugins → Development плагина нет, а
`manifest.json` найти не могу». Подробности про сервер, токен и обновления —
в [figma-console.md](figma-console.md).

## Откуда берётся плагин

`figma_execute` дизайнеру даёт сервер `figma-console` из каталога офиса
(`src/server/mcp.ts`): npm-пакет **`figma-console-mcp`**, версия зафиксирована
— **1.40.9**. Локально он не установлен: офис поднимает его на каждую сессию
агента командой `npx -y figma-console-mcp@1.40.9`.

Плагин Desktop Bridge едет в том же пакете. При каждом запуске сервер
выкладывает его файлы в постоянную папку в домашнем каталоге:

```
~/.figma-console-mcp/plugin/manifest.json
```

На машине владельца (macOS, пользователь `boris_proshin`) это

```
/Users/boris_proshin/.figma-console-mcp/plugin/manifest.json
```

Файл там уже есть, версия плагина 1.40.9 — ставить и качать ничего не надо.
Найти его мешает одно: папка начинается с точки, и Finder её прячет.

Если папки нет (другая машина, чистый профиль) — сервер ещё ни разу не
поднимался. Запустите его руками и остановите через несколько секунд
(`Ctrl C`), папка появится:

```
npx -y figma-console-mcp@1.40.9
ls ~/.figma-console-mcp/plugin/manifest.json
```

Запасной путь — тот же плагин внутри кеша npx. Он рабочий, но имя папки с
хешем меняется при очистке кеша, поэтому импортировать лучше из
`~/.figma-console-mcp`:

```
ls ~/.npm/_npx/*/node_modules/figma-console-mcp/figma-desktop-bridge/manifest.json
```

## Импорт в Figma Desktop (один раз)

1. Откройте **Figma Desktop** (в браузере плагины разработки не импортируются)
   и в ней любой файл.
2. Меню **Plugins → Development → Import plugin from manifest…**
3. В окне выбора файла нажмите **`⌘ Shift G`**, вставьте путь
   `/Users/boris_proshin/.figma-console-mcp/plugin/manifest.json` и нажмите
   Enter. Либо **`⌘ Shift .`** — Finder покажет скрытые папки, и до файла можно
   дойти руками.
4. Нажмите «Открыть». В **Plugins → Development** появится пункт
   **Figma Desktop Bridge**.

## Запуск в файле

1. Откройте облачный файл **«Office»** — ключ `AfSCsJLqUWxKUh4MrWlJFS`, адрес
   `https://www.figma.com/design/AfSCsJLqUWxKUh4MrWlJFS`. Именно его, а не
   несохранённую копию и не черновик без имени: агент обращается к файлу по
   ключу, а у несохранённой копии ключ другой или его нет вовсе — плагин
   подключится, но дизайнер будет работать не в том файле.
2. В этом файле: **Plugins → Development → Figma Desktop Bridge**.
3. Окно плагина не закрывайте, пока агент работает: закрыли — файл для агента
   пропал. Свернуть можно.

Порядок запуска не важен: плагин сам ищет серверы на портах 9223–9232 и
подключается, когда сервер появится.

## Как понять, что подключился

- **В окне плагина** статус сменился с «connecting…» на подключённый. Пока ни
  одна сессия дизайнера не запущена, сервера нет и плагин честно ждёт — это
  не ошибка.
- **У агента.** Поставьте дизайнеру задачу «вызови `figma_get_status` и напиши,
  какой файл активен». В ответе должны быть подключение по WebSocket и файл
  «Office» с ключом `AfSCsJLqUWxKUh4MrWlJFS`.
- **`figma_execute`** перестал отвечать «Cannot connect to Figma Desktop».

Если агент по-прежнему не видит Figma: плагин запущен не в том файле, окно
плагина закрыто или плагин стартовал давно и уснул — запустите его заново
или попросите агента вызвать `figma_reconnect`.

## Не путать со вторым плагином

В офисе два сервера Figma, и у каждого свой плагин. Они не заменяют друг
друга и могут быть открыты в одном файле одновременно.

| | Figma Desktop Bridge | Figma MCP Bridge |
|---|---|---|
| Сервер в каталоге | `figma-console` | `figma-bridge` |
| Пакет | `figma-console-mcp@1.40.9` | `@gethopp/figma-mcp-bridge` |
| Что умеет | компоненты, варианты, инстансы, переменные, `figma_execute` — произвольный код Plugin API | читает документ, рисует фреймы, тексты и фигуры; код не исполняет |
| Откуда плагин | `~/.figma-console-mcp/plugin/manifest.json`, кладёт сам сервер | архив со страницы выпусков `github.com/gethopp/figma-mcp-bridge/releases`, папка `plugin/` |
| Имя в Plugins → Development | Figma Desktop Bridge | Figma MCP Bridge |

Работающий Figma MCP Bridge не означает, что работает `figma_execute`: для
него нужен именно Desktop Bridge.
