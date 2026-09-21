# T-74: разведение конфликтов task/T-57 и task/T-56 с main

## Итог: задача НЕ выполнена — окружение не даёт мне писать в git

Эта сессия работает в read-only песочнице по git: **Bash не может записать ни
байта ни в один `.git`**, включая мой собственный (`task/T-74`). Проверено
напрямую:

```
$ cd .../worktrees/o-2/T-57 && touch probe_plain.txt
(eval):1: operation not permitted: probe_plain.txt

$ git commit --allow-empty -m probe   # в СВОЁМ worktree o-2/T-74
fatal: Unable to create '.../office/.git/worktrees/T-74/index.lock': Operation not permitted
```

Общий `.git` репозитория (`/Users/boris_proshin/Projects/ai/office/.git`) не
входит в список каталогов, куда мне разрешена запись через Bash — а именно
туда пишут `git merge`, `git add`, `git commit`, `git worktree`, и туда же
пишут кеши `node`/`npm` для тестов и `tsc`. Инструмент `dangerouslyDisableSandbox`
отключён политикой безвозвратно. Поэтому ни один из практических шагов задачи
(слить main, закоммитить резолюцию конфликта, прогнать
`node --import tsx/esm scripts/test-offices.ts` / `test-premerge.ts` /
`npm run typecheck` в чужих worktree) я выполнить не могу — они все требуют
записи в `.git` или на диск чужого/своего worktree.

**Побочный эффект моей диагностики**: инструмент Write (в отличие от Bash) не
подчиняется той же песочнице и создал файл-пробник
`.office/worktrees/o-2/T-57/.__probe_t74` (содержимое `probe`). Удалить его
через Bash (`rm`, `git clean -f`) я не смог — та же блокировка записи. Файл
untracked, в коммит не попадёт сам по себе, но **сломает проверку «чистая
рабочая копия» пред-merge гейта** — его нужно вручную удалить тому, у кого
есть запись в этот worktree, прежде чем гнать T-57 через гейт.

Дальше — весь анализ, который я смог сделать в режиме чтения
(`git diff`, `git show`, `git merge-tree` — они ничего не пишут), и точный
план резолюции для того, кто продолжит с правами на запись.

---

## Метод: `git merge-tree <merge-base> main task/T-NN`

Старый (3-аргументный, ничего не пишущий) `git merge-tree` делает ровно
трёхстороннее слияние и печатает результат с маркерами конфликта в stdout, не
трогая индекс/рабочее дерево/объекты. Я использовал его как замену
`git merge`, чтобы получить точную картину конфликтов без записи. В этом
вызове `main` — это `.our`, `task/T-NN` — это `.their` (порядок аргументов).
Для реального `git merge main`, стоя на `task/T-NN`, стороны поменяются
местами (`ours`=ветка, `theirs`=main) — резолюция при этом одна и та же: брать
содержимое main.

## task/T-57 («Пауза офиса переживает перезапуск сервера»)

`git merge-base main task/T-57` = `649645d`.

Конфликтующие файлы (`git merge-tree`): `scripts/test-offices.ts`,
`src/server/offices.ts`, `src/server/state.ts`. `src/server/activity.ts`,
который тоже менялся в T-57, конфликта не даёт — `git diff main task/T-57 --
src/server/activity.ts` пуст: содержимое уже целиком совпадает с main (T-60
перенёс его без изменений).

Во всех трёх конфликтующих файлах картина одна и та же: **`.our` (main)
содержит всё, что было в T-57, плюс более позднюю работу** (архив офиса T-64:
`officeArchived`, `archived` в `onDisk()`/`openOfficeState`, импорты
`languageBrief`/`pmPrompt`/`workerSystemPrompt` из `agents.ts`, перенумерация
тестов 24→25, 25→27 из-за вставленных между ними тестов архива). `.their`
(task/T-57) — старая версия без архивного функционала. Собственного контента,
которого нет в main, у T-57 не осталось нигде.

**Резолюция**: взять `.our` (main) целиком во всех трёх конфликтах, `.their`
выбросить. После такой резолюции содержимое всех трёх файлов в task/T-57
станет побайтово равно main.

**Что покажет `git diff main task/T-57`** после слияния и такой резолюции: **пусто** — в ветке не остаётся ничего, чего нет в main.

## task/T-56 («Почему гейт говорит база main уезжает»)

`git merge-base main task/T-56` = тот же участок истории до T-58/T-61/T-62.

Конфликтующие файлы: `scripts/test-premerge.ts`, `src/server/git.ts`,
`src/server/i18n/en.ts`, `src/server/i18n/ru.ts`, `src/server/premerge.ts`,
`src/server/review.ts`. Картина та же: `.our` (main) — итоговая версия после
T-58 (`IntegrationCopy {path, temporary, error, warnings}`, стадия
`'integration'`, `stopOnBrokenGate`/`retryAfterGate` в формулировке main) и
T-61/T-62 (сверка хвостов, объединённые тесты про занятый/чужой каталог,
доходит до 76 проверок). `.their` (task/T-56) — версия ДО T-58: контракт
`IntegrationCopy {path, error, warnings}` без `temporary`, стадия `'broken'`
вместо `'integration'`, свой (более ранний, дублирующий) набор тестов на
занятый каталог.

**Резолюция**: взять `.our` (main) целиком во всех шести конфликтах.

Три файла (`src/server/merge.ts`, `src/server/i18n/prompts-en.ts`,
`src/server/i18n/prompts-ru.ts`) `git merge-tree` пометил «changed in both»,
но **без маркеров конфликта** — git считает их автосливаемыми. Здесь нужна
отдельная осторожность: наивный `git merge` тут МОЛЧА совместит обе версии
построчно, и в `merge.ts` это даст дублирование функциональности, а не чистое
объединение:

```
main (уже полная версия, ~204-215):
  state.addLog(null, outcome.ok ? 'system' : 'error', `merge ${branch}: ${outcome.kind}, copy ${outcome.worktree ?? integrationDir(state)}`);
  for (const warning of outcome.warnings) {
    state.addLog(null, 'system', warning);
    state.addChat(OFFICE_SENDER, `⚠️ ${warning}`);
  }
  if (outcome.checkout.state === 'lagging') { ... }

task/T-56 (старая, более простая версия, ~204-212):
  state.addLog(null, outcome.ok ? 'system' : 'error', `merge ${branch}: ${outcome.kind}`);
  if (outcome.checkout.state === 'lagging') { ... }
  for (const warning of outcome.warnings) state.addChat(OFFICE_SENDER, warning);
```

Изменения затрагивают одни и те же строки (порядок `checkout.state`/`warnings`
разный), но `git merge-tree` не поставил маркеры — вероятно, из-за того, как
лёг трёхсторонний diff. **Кто будет реально делать `git merge`, обязан
проверить эти три файла руками после слияния** — merge может либо дать
конфликт (и тогда резолюция та же — брать main), либо тихо принять обе версии
и продублировать блок предупреждений. Правильный результат — версия main,
версия T-56 отбрасывается целиком.

`src/server/i18n/prompts-en.ts` и `prompts-ru.ts`: T-56 убирает ключи
`bubble.listRules`/`addRule`/`editRule`/`dropRule` и текст про правила офиса —
это чужая, более ранняя точка истории без функциональности правил (T-65+),
которая уже есть в main. Взять main целиком.

**Что покажет `git diff main task/T-56`** после слияния и резолюции по main
во всех шести конфликтах плюс ручной проверки трёх «тихих» файлов: **пусто** —
как и в T-57, у ветки не остаётся собственного контента, которого нет в main.

## Проверки (не выполнены мной — see блокер выше)

Ожидаемое число проверок после резолюции (т.к. итоговое содержимое равно
main): `scripts/test-offices.ts` — 183 `check(...)` (столько же, сколько в
main сейчас), `scripts/test-premerge.ts` — 76 `check(...)`. Оба числа получены
`grep -c '^  check(' <(git show main:<file>)` — то есть посчитаны у main, а не
прогнаны. Реальный прогон
(`node --import tsx/esm scripts/test-offices.ts`,
`node --import tsx/esm scripts/test-premerge.ts`, `npm run typecheck`) должен
сделать тот, кто будет физически проводить слияние — у меня для этого нет
исполняемого доступа.

## Что нужно исполнителю с правами записи

1. В `task/T-57`: `git merge main`, конфликт в `scripts/test-offices.ts`,
   `src/server/offices.ts`, `src/server/state.ts` — резолюция «взять main»
   везде. Готово — тождественно main.
2. Убрать `.office/worktrees/o-2/T-57/.__probe_t74` (мой случайный артефакт,
   untracked, `rm` не даёт песочница).
3. В `task/T-56`: `git merge main`, конфликт в `scripts/test-premerge.ts`,
   `src/server/git.ts`, `src/server/i18n/en.ts`, `src/server/i18n/ru.ts`,
   `src/server/premerge.ts`, `src/server/review.ts` — резолюция «взять main»
   везде. Дополнительно вручную сверить `src/server/merge.ts`,
   `src/server/i18n/prompts-en.ts`, `src/server/i18n/prompts-ru.ts` — там
   возможен тихий дубль вместо конфликта (см. пример выше), нужная версия —
   main.
4. Прогнать `node --import tsx/esm scripts/test-offices.ts`,
   `node --import tsx/esm scripts/test-premerge.ts`, `npm run typecheck` —
   ожидаются зелёными, 183 и 76 проверок соответственно (как в main).
5. Сверить `git diff main task/T-57` и `git diff main task/T-56`
   (двухточечный) — по анализу должны быть пустыми.
