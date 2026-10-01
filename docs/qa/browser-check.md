# Проверка MCP-сервера браузера (`tools/browser/server.mjs`)

Дата: 2026-10-02, задача T-267. Скрипт: `node tools/browser/smoke.mjs` (MCP-клиент по stdio,
кадры во временной папке). Зависимости на месте: `playwright-core` 1.63.0, в
`~/Library/Caches/ms-playwright` — `chromium-1243`, `chromium_headless_shell-1243`.

## Итог: прогон частичный — песочница исполнителя не даёт слушать порт

Локальный HTTP-сервер страницы не поднялся: `listen EPERM: operation not permitted 127.0.0.1`.
Поэтому шаги, которым нужна встроенная страница, не проверены по содержимому. Разрешить можно
настройкой песочницы `sandbox.network.allowLocalBinding: true` или запуском скрипта вне неё.

- **Режим Chromium:** сработал запасной `chrome-headless-shell --single-process`. Обычный headless
  упал с `browserType.launch: Target page, context or browser has been closed`.
- **`routeWebSocket`:** в установленном `playwright-core` 1.63.0 есть (`async routeWebSocket` в
  `lib/coreBundle.js`). Вживую блокировку сокета не проверили: нужна страница.

## Шаги

ОК:
- `set_device`: `phone-portrait`, затем поворот в альбом (844×390);
- `screenshot`: PNG 2532×1170 = 844×390 при DPR 3, белый `about:blank`. Это не пустой файл,
  размер и плотность соответствуют устройству;
- `storyboard`: 3 кадра со свайпом, интервал 200 мс, отметки времени t = 1/200/400 мс;
- `set_offline`: в офлайне `navigator.onLine=false`, затем снова онлайн;
- `open https://example.com/` отклонён: `адрес вне разрешённых: https://example.com — …`;
- на `about:blank` отвечают `get_console`, `get_errors`, `get_failed_requests` (все `[]`),
  `get_state` (env со вьюпортом, DPR, ориентацией), `tap` (`input: touch`) и `swipe` (13 touchMove за 235 мс).

ОШИБКА из-за `listen EPERM` (страницы нет):
- `open` локальной страницы;
- содержимое `get_console`, `get_errors` и `get_failed_requests`: ошибка консоли, исключение, 404;
- блокировка чужого fetch и WebSocket;
- `__QA_STATE__` в `get_state`;
- счётчики touch на canvas после `tap` и `swipe`;
- редирект `/go` → `https://example.com/`.

## Что дальше

Запустить `node tools/browser/smoke.mjs` вне песочницы. Итог должен быть «всё ОК», код выхода 0.
Отдельно стоит выяснить, почему обычный headless закрывается при старте: это может быть та же песочница.
