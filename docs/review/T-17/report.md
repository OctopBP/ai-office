# T-17: Сверка рейла после слияния T-13

Проверил src/web/shell/Rail.tsx, src/web/store.ts, src/web/styles/shell.css,
src/web/officeColor.ts, src/shared/types.ts, src/web/OfficesModal.tsx на
task/T-17 (== main на момент проверки, ветка чистая, новых коммитов не
потребовалось).

## Результат по каждому пункту

1. **Иконка (T-13).** `OfficeAvatarIcon` (Rail.tsx:28-35) рендерит эмодзи,
   `<img>` через `/api/office-icon?office=...` или, если иконки нет, инициал —
   всё внутри `.rail-office-avatar`, у которого фон задаётся инлайн-стилем
   `officeAvatarColor(o.id)` (Rail.tsx:137). Цветная подложка и инициалы не
   затёрты: `.rail-office-avatar` в shell.css (строки 67-71) не задаёт
   `background` и не имеет `color: var(--office-color-ink)`-конфликта — это
   цвет текста для контраста с любой цветной подложкой, а не сам фон.
2. **Бейдж (T-4) и компактные размеры.** `lifeBadge` считается из
   `openQuestions` (Rail.tsx:89-90), рендерится только для вкладки `life`,
   при 0 — `null` (бейдж не рисуется), при >9 — «9+». `.rail-win-badge`
   определён в shell.css:108-112. Размеры компактные: `.rail-office` — высота
   40px (shell.css:61), `.rail-office-avatar` — 24×24 (shell.css:68),
   `.rail-office-list` — `min-height: 84px` (shell.css:54).
3. **Сортировка (T-11).** `sortedOffices` в store.ts:1130-1131 —
   `[...offices].sort((a, b) => a.name.localeCompare(b.name, locale()))`,
   без `lastOpenedAt` и без вынесения текущего офиса первым.
4. **Цвет (T-12).** `officeAvatarColor(officeId)` в officeColor.ts — хеш id
   офиса по модулю 8, возвращает `var(--office-color-N)`. Палитра
   `--office-color-1..8` и `--office-color-ink` есть в tokens.css:72-80.
   У `.rail-office.current` нет акцентного оверрайда для `.rail-office-avatar`
   (только для фона всей кнопки и цвета статуса).

Все четыре результата T-11/T-12/T-4/T-13 сосуществуют без конфликтов —
дубль правки, о котором предупредил гейт, разошёлся мирно.

## Проверки

`npm run typecheck` — прошёл чисто (exit 0, вывод без ошибок).

`npm run test:pm` не запускал (EPERM в песочнице на IPC-сокете tsx — известное
ограничение, проверку оставляю конвейеру офиса).

## Расхождений с main не найдено — файлы не менял.
