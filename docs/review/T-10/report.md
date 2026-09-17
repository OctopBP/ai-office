# T-10: проверка дубля правки state.ts и types.ts после T-3 и T-5

## Что проверено

Взял содержимое `main` (`git show main:<файл>`, ветка `task/T-10` в этих двух
файлах совпадает с `main` побайтово — проверено `git diff main -- src/server/state.ts
src/shared/types.ts`, пусто).

### Правка T-3 (openQuestions / isOpenQuestion) — на месте целиком

- `src/shared/types.ts:1439` — поле `openQuestions: number` в `{ t: 'snapshot' }`.
- `src/shared/types.ts:1456` — поле `openQuestions: number` в дельте `{ t: 'question' }`.
- `src/server/state.ts:1043` — `OfficeState.openQuestionCount()`.
- `src/server/state.ts:3451` — общий признак `isOpenQuestion(q) = !q.answeredAt && !q.dismissedAt`.
- `src/server/state.ts:3438` — снапшот отдаёт `openQuestions: this.openQuestionCount()`.
- `src/server/state.ts:1067,1076` — события `question` несут `openQuestions: this.openQuestionCount()`.
- `src/server/questions.ts:15,28` — `openQuestions()` фильтрует тем же `isOpenQuestion`, импортированным из `state.ts` (счётчик в снапшоте и отбор для планёрки не расходятся, как и задумано).

### Правка T-5 (icon / set_office_icon) — на месте целиком

- `src/shared/types.ts:735-737` — тип `OfficeIcon`.
- `src/shared/types.ts:745` — поле `icon?` на `OfficeView`.
- `src/shared/types.ts:722` — `'icon'` в `OfficeOp`.
- `src/shared/types.ts:1631` — команда `{ c: 'set_office_icon' }`.
- `src/shared/types.ts:1474` — событие `{ t: 'office.error'; op: OfficeOp; ... }` (использует тот же `OfficeOp`, `'icon'` в нём есть).
- `src/server/offices.ts:14,23` — поле `icon?` на `OfficeEntry`.
- `src/server/offices.ts:332-399` — `setOfficeIcon()` целиком (валидация emoji/пути, проверка, что путь не выходит за корень офиса).
- `src/server/office-api.ts:424-438` — разбор команды `set_office_icon`: вызывает `setOfficeIcon`, при ошибке шлёт `office.error` с `op: 'icon'`, при успехе — `broadcastOffices()` и (если офис открыт) `broadcastSnapshot()`.
- `src/server/state.ts:3472-3481` — `officeViews()` переносит `o.icon` в `OfficeView.icon` (поле опускается, если иконки нет — не путает «нет иконки» с «пустая»).

## Снапшот и события

- `state.ts:3406-3443` (`OfficeState.snapshot()`) содержит и `offices: officeViews()` (со списком офисов, где у каждого есть `icon`, если задана), и `openQuestions: this.openQuestionCount()` — оба поля присутствуют в одном и том же объекте, друг другу не мешают.
- Событие `{ t: 'offices' }` (`office-api.ts:167,213,376`) шлёт `officeViews()` — с иконкой.
- Событие `{ t: 'office.error', op: 'icon' }` собирается в `refuse()` (`office-api.ts:255-256`), вызывается из ветки `set_office_icon`.
- Событие `{ t: 'question' }` собирается в `state.ts:1067,1076` вместе со свежим `openQuestions`.

**Расхождений не нашлось.** Обе правки слились в main независимо друг от друга без потерь — ни одна не затёрла и не откатила код другой. Файлы не трогал.

## Проверки

- `npm run typecheck` — **прошёл чисто** (`tsc --noEmit`, без ошибок).
- `npm run test:pm` — **не удалось прогнать в песочнице**: скрипт падает на старте с `EPERM: operation not permitted /tmp/.../tsx-501/NNNN.pipe` (tsx пытается открыть unix-сокет для IPC, песочница это запрещает). Это известное ограничение среды (см. память `ai-office-tests-in-sandbox`), не связано с содержимым проверяемых файлов. Прямой запуск `scripts/test-pm.ts` в обход раннера не делал: он цепляется к серверу на 3002 и хард-ресетит его текущий офис (память `pm-tests-only-via-runner`) — рискованно в общем репозитории. Тест должен прогнать конвейер офиса после сдачи задачи.

## Вывод

Обе правки (T-3 и T-5) присутствуют в `main` целиком и согласованно, снапшот несёт оба поля, typecheck чистый. `test:pm` не прогнан из-за ограничения песочницы (EPERM на unix-сокет tsx) — доверяю прогону конвейера офиса. Расхождений между ветками не нашлось, изменений в код не вносил.
