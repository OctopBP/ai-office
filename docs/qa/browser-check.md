# Проверка MCP-сервера браузера (`tools/browser/server.mjs`)

Дата: 2026-10-02, задача T-268. Скрипт: `node tools/browser/smoke.mjs`, MCP-клиент по stdio.
Страница пишется во временную папку и отдаётся через `serve`. Итог: **все 20 шагов ОК** в песочнице
исполнителя, код выхода 0 (с правкой ниже прошло со второго запуска).

## Раздача без порта: `serve(dir)`

- Папка рабочей копии (проверка `insideWorkdir`) отдаётся на `http://127.0.0.1:<47100+n>/`
  через тот же `context.route`, что и фильтр адресов. Порт никто не слушает. Каталог отдаёт
  свой `index.html`, MIME выбирается по расширению, на отсутствующий файл — честный 404.
- **Офлайн:** Playwright 1.63 сам перехваченные запросы не роняет. При `setOffline(true)`
  `route.fulfill` отвечал 200 и на fetch, и на goto (проверено отдельным опытом). Поэтому в
  офлайне обработчик делает `route.abort('internetdisconnected')`: `open` падает с
  `net::ERR_INTERNET_DISCONNECTED`, а после `set_offline(false)` раздача снова отвечает 200.

## Шаги smoke.mjs (все ОК)

`serve` → `open` (200, «QA smoke»), css применился (проверка MIME), `set_device` портрет → альбом
844×390, `get_console` (намеренная ошибка), `get_errors` (исключение), 404 на `missing.json`,
чужой fetch и `wss://` заблокированы (`routeWebSocket` есть), `__QA_STATE__`. `tap` и `swipe`
по canvas: start/end 1, move 13. Затем `screenshot` (прочитан: canvas с квадратом на синем фоне),
`storyboard` (3 кадра, t = 0/200/400 мс), offline роняет раздачу, внешний `open` отклонён,
`serve ../` отклонён, клиентский редирект на example.com уведён на `about:blank`.
Статика не умеет 302, поэтому редирект теперь сделан клиентским.

## Найдено и исправлено

`applyDevice` слал `Emulation.setTouchEmulationEnabled` с `maxTouchPoints: 0` для десктопа.
Chrome отвечает «Touch points must be between 1 and 16», поэтому первый `open` в десктопном режиме
падал. Теперь при выключенном touch поле не передаётся.

## Мишень

`node tools/browser/smoke.mjs --dir tools/browser/fixtures/target/fixed --shot docs/qa/T-268/target-fixed.png`:
200 «Каталог уровней». Ошибок консоли, исключений и сбойных запросов нет. Снимок не пустой:
карточка уровня, подсказки, «Старт» и баннер cookie.

Режим Chromium: обычный headless в песочнице падает при старте, работает запасной
`chrome-headless-shell --single-process`.
