# T-83: Сверка kit.css после слияний теней (T-76) и бейджа (T-75)

## Вывод

Гейт предупредил зря либо разъезд случился в промежуточном состоянии — в
текущем `main` (после `4cebccf`, где T-75 слито поверх T-76) обе правки целы
и не пересекаются. Восстанавливать нечего.

## Проверка 1 — тени (T-76)

`src/web/styles/kit.css`:
- `.float` — фон `--surface`, рамка `--hairline`, `box-shadow: var(--shadow-float)`. ✓
- `.card` — тот же язык поверхности, тени нет. ✓
- `.seg` — рамка `--hairline`, тени нет; `button.primary` / `button.on` — заливка акцентом без тени. ✓
- Тень для верхнего ряда над сценой (`.shell-top .seg`, `.shell-top button.primary`)
  задаётся отдельно в `shell.css:228`, как и описано в комментарии kit.css — это
  ожидаемое поведение, не дубль.

## Проверка 2 — бейдж агента (T-75)

`src/web/styles/kit.css` — общая подложка бейджа: `.agent-badge`,
`.agent-badge-role`, `.agent-badge-dot` (+ `.live`/`.warn`/`.danger`). ✓

`src/web/styles/scene.css` — раскладка бейджа в сцене под `.tag3d`:
`.tag3d .agent-badge`, `.agent-badge-head`, `.agent-badge-task`,
`.agent-badge-note`. ✓ Плюс отдельный `.tag3d-plate` (голый код задачи на
столе, не часть бейджа) — на месте.

Старые классы `.tag3d-bubble` и `.tag3d-task` — `grep -rn` по всему `src/`
ничего не нашёл, в разметке (`Agents3D.tsx`, `KitBench.tsx`) используются
только актуальные классы.

## Проверка 3 — дубли и токен `--shadow`

- `grep` по `.card`, `.float`, `.seg` (топ-уровня), `button.primary`,
  `.agent-badge` — каждый селектор объявлен ровно один раз в своём файле.
- Ссылок на удалённый токен `--shadow` нигде нет — только `--shadow-float`
  и `--shadow-toast` (оба определены в `tokens.css` для обеих тем).
- `.card` в `drawer.css` — как и должно быть после T-82, переименован в
  `.drawer-card`/`.drawer-card-head`; коллизии с `.card` из kit.css нет.
  Результат T-82 не трогал.

## Проверки

- `npx tsc --noEmit` — чисто.
- `npm run test:pm` не запускал (по инструкции задачи).

## Изменения в коде

Нет — по итогам сверки код не менялся, только прочитан и проверен grep'ом.
