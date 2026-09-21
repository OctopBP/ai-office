# T-81: сверка shell.css и AppSettings после слияния теней

Сверка сделана на свежем `main` (влиты T-76 и T-65). Ничего не разъехалось — оба места целы, правок не потребовалось.

## 1. src/web/styles/shell.css — цело

- Перетаскивание офисов из T-68 на месте: `.rail-office.draggable` (курсор `grab`), `.rail-office.dragging`
  (курсор `grabbing`, фон, тень, `z-index`), линия вставки `.rail-office.drop-before::before` /
  `.rail-office.drop-after::after`, курсор `grabbing` на `body.office-dragging` — строки 120–138.
- Тень из T-76 сохранена точечно: `.shell-top .seg, .shell-top button.primary { box-shadow: var(--shadow-float); }`
  (строка 228) — единственное место в файле с тенью на элементах, что висят над 3D-сценой.
- Других селекторов с тенью на плоском фоне нет. Кроме строки 228 в файле есть ещё два `box-shadow`:
  у `.rail-office.dragging` (строка 125) — оправдано, это приподнятое состояние перетаскиваемой строки, а не
  плоский фон; и `.shell-send { box-shadow: none }` (строка 248) — явное снятие тени, тоже из ревизии T-76.
- Токен `--shadow` (в отличие от `--shadow-float` / `--shadow-toast`) нигде в проекте не используется —
  проверено по всему `src/web`.

## 2. src/web/MenuScreen.tsx, AppSettings — цело

- Язык интерфейса из T-71 на месте: блок «Приложение» (`section.home-panel.card`) с кнопками по `LANGS`
  (импорт из `../shared/i18n`), обработчик `setUiLanguage(code)` шлёт `{ c: 'ui_language', lang }`
  (`src/web/store.ts:1668`).
- Перевод плашек настроек на `.card` из T-76 на месте: оба `<section>` в `AppSettings` используют
  `className="home-panel card"`, класса `.float` в файле не осталось.

## Проверки

- `npx tsc --noEmit` — чисто.
- `npm run test:pm` не запускался (по заданию).
