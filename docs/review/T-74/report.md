# T-74: разведение конфликтов task/T-57 и task/T-56 с main

## Итог: сделано, проверено на актуальном main

**Правка после ревью**: ниже в отчёте изначально стоял вывод «задача
невыполнима — Bash не пишет в `.git`». Это было неверно (или верно только для
`.git` ЧУЖИХ worktree — писать в СВОЙ собственный `.git` инструментом Bash
внутри этой же песочницы, как показал ревьюер, можно). Но к моменту, когда я
вернулся к задаче, реальную git-работу уже сделал другой воркер — задача T-79
(«отчёт о сведении веток T-56 и T-57 к состоянию main», коммит `046b8c6`) —
и она попала в main через штатный гейт коммитами `ffd0857`/`940ccc4` (T-57) и
`e2ae9aa`/`984aa02` (T-56). Резолюция там ровно та, что я предсказал в анализе
ниже: «все конфликты в пользу main» — это буквальный текст коммитов слияния.
Ветки `task/T-57` и `task/T-56` в репозитории больше не существуют (гейт
удаляет ветку и worktree после успешного слияния) — вместе с ними исчез и мой
случайный артефакт `.__probe_t74`, отдельно убирать нечего.

Я не стал повторно проделывать `git merge` (веток для этого уже нет — они
слиты и удалены), а **проверил результат реальными командами на текущем тике
main**, а не по историческим снимкам:

```
$ git checkout --detach main   # в своём worktree T-74, дерево было чистым
HEAD is now at 037cdee Merge branch 'task/T-80' into HEAD

$ node --import tsx/esm scripts/test-offices.ts   | tail -1
Все проверки прошли: 183

$ node --import tsx/esm scripts/test-premerge.ts  | tail -1
Все проверки прошли: 76

$ npm run typecheck
> tsc --noEmit                                     # пусто — чисто

$ git checkout task/T-74                            # вернулся на свою ветку
```

Дополнительно двухточечным `git diff` сверил, что финальные состояния
`task/T-57` и `task/T-56` перед их слиянием в main (коммиты `ffd0857` и
`e2ae9aa`) по всем конфликтовавшим файлам совпадают с main **байт в байт**:

```
$ git diff main ffd0857 -- scripts/test-offices.ts src/server/offices.ts src/server/state.ts | wc -l
0
$ git diff main e2ae9aa -- scripts/test-premerge.ts src/server/git.ts src/server/i18n/en.ts \
    src/server/i18n/ru.ts src/server/premerge.ts src/server/review.ts src/server/merge.ts \
    src/server/i18n/prompts-en.ts src/server/i18n/prompts-ru.ts | wc -l
0
```

Остальная разница между `main` и этими снимками — только более поздние,
никак не связанные с T-56/T-57 коммиты main (`docs/review/T-80/report.md`,
`Agents3D.tsx`, `kit.css`, `scene.css`), это ожидаемо и не в счёт.

Отдельно проверил тот риск, о котором предупреждал ниже (тихое дублирование
блока предупреждений в `src/server/merge.ts` при автослиянии без маркеров
конфликта): в актуальном main блок ровно один, дублирования нет.

Дальше в отчёте оставлен весь read-only анализ конфликтов, как он был сделан
до этой правки, — он совпал с тем, что реально произошло, и полезен как
объяснение, почему резолюция именно такая.

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

## Проверки — реально прогнаны на актуальном main

`scripts/test-offices.ts` — **183/183**, `scripts/test-premerge.ts` —
**76/76**, `npm run typecheck` — чисто. Числа совпали с ожиданием, посчитанным
заранее через `grep -c '^  check(' <(git show main:<file>)`. Полный вывод
команд — в блоке «Итог» выше.

## Как разведены конфликты (уже сделано, для истории)

Обе ветки слиты и удалены штатным гейтом офиса. Резолюция конфликтов, которую
предсказывал анализ ниже и которая подтвердилась в реальных коммитах слияния
(`ffd0857`, `940ccc4`, `e2ae9aa`, `984aa02`):

1. `task/T-57`: конфликт в `scripts/test-offices.ts`, `src/server/offices.ts`,
   `src/server/state.ts` — резолюция «взять main» везде.
2. `task/T-56`: конфликт в `scripts/test-premerge.ts`, `src/server/git.ts`,
   `src/server/i18n/en.ts`, `src/server/i18n/ru.ts`, `src/server/premerge.ts`,
   `src/server/review.ts` — резолюция «взять main» везде. Дополнительно
   проверены вручную (без маркеров конфликта, но с риском тихого дубля)
   `src/server/merge.ts`, `src/server/i18n/prompts-en.ts`,
   `src/server/i18n/prompts-ru.ts` — в итоговом main дубля нет, версия main.

Случайный побочный артефакт `.__probe_t74` из первого прохода исчез вместе с
удалённым после слияния worktree `T-57` — отдельно убирать не пришлось.
