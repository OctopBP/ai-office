# Проверка MCP-сервера браузера (`tools/browser/server.mjs`)

Дата: 2026-10-01, задача T-264. Итог: **живой прогон не состоялся** — остановлено на шаге 0.

## Чего не хватает

1. **`playwright-core` не установлен.** В `package.json` он объявлен (`"playwright-core": "^1.63.0"`),
   но в `node_modules` его нет: `node -e "require.resolve('playwright-core')"` падает с
   `Error: Cannot find module 'playwright-core'`. `server.mjs` импортирует его в строке 18,
   так что сервер сейчас не стартует вовсе. `@modelcontextprotocol/sdk` на месте.
2. **Нет браузеров Playwright.** Папки `~/Library/Caches/ms-playwright` нет — ни Chromium,
   ни `chrome-headless-shell`. Системный Google Chrome в `/Applications` есть; его можно
   отдать серверу через `OFFICE_BROWSER_PATH`, но без `playwright-core` это ничего не даёт.

## Как поставить

```
npm install                                         # подтянет playwright-core из package.json
npx playwright-core install chromium                # Chromium и chrome-headless-shell
# или без скачивания браузера — системный Chrome:
# OFFICE_BROWSER_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Ставить надо в основной копии (`node_modules` в рабочих копиях — симлинк на неё).
Из песочницы исполнителя установку не делали: по задаче ставить через сеть и обходить нельзя.

## Что дальше

После установки повторить задачу: `tools/browser/smoke.mjs` (MCP-клиент по stdio, все
инструменты на локальной странице, проверки фильтра адресов), один запуск — один отчёт здесь.
Режим Chromium, наличие `routeWebSocket` и итог по шагам пока неизвестны.
