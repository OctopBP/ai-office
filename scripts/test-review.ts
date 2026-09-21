/**
 * Конвейер ревью на настоящем репозитории и без единого токена: сдачу задачи,
 * подтягивание основной ветки, конфликты, упавшие проверки, вердикт ревьюера
 * и слияние гоняем на временном репозитории, подставив вместо живых агентов
 * заглушки (PipelineAgents). Проверяется именно ПОРЯДОК шагов и то, что после
 * него остаётся в git.
 *
 * Запуск: npm run test:review
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice, worktreesRoot, type OfficeState, type Task } from '../src/server/state';
import { mergeableTasks } from '../src/server/merge';
import {
  runPipeline, setPipelineAgents, whenPipelinesIdle,
  type ReviewOutcome, type ReworkOutcome, type StepOutcome, type StepRequest,
} from '../src/server/review';
import { answerQuestion } from '../src/server/questions';
import { resetProjectWorkflow, saveProjectWorkflow, workflowCatalog } from '../src/server/workflows';
import type { TaskType } from '../src/shared/workflow';
import { superviseOffice } from '../src/server/supervisor';
import { MessageQueue } from '../src/server/queue';

// Проверки сверяют тексты офиса дословно и написаны по-русски — значит,
// и офисы здесь должны быть русскими. Язык нового офиса берётся из
// окружения, и задать его надо до того, как офис откроется.
process.env.OFFICE_LANG = 'ru';

/**
 * Офис проверки берём по id: состояния живут в реестре по офисам, общего
 * «текущего на процесс» нет — конвейер и надзор получают офис аргументом.
 */
const office = getOffice('o-1');

const results: string[] = [];
const check = (what: string, ok: boolean) => {
  const line = `  ${ok ? '✅' : '❌'} ${what}: ${ok}`;
  results.push(line);
  console.log(line);
};

/** Репозиторий с main и одним коммитом; проверка падает, если есть файл boom. */
function fixture(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'office-review-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (name: string, body: string) => writeFileSync(resolve(dir, name), body);

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'office@local');
  git('config', 'user.name', 'AI Office');
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { typecheck: 'node check.js' } }));
  write('check.js', "const fs=require('fs');if(fs.existsSync('boom')){console.error('сломано: boom');process.exit(1);}");
  write('.gitignore', '.office/\n');
  write('shared.txt', 'общая строка\n');
  git('add', '-A');
  git('commit', '-qm', 'Начало');
  return dir;
}

/** git для проверок: отказ — это тоже результат, ронять прогон он не должен. */
const git = (dir: string, ...args: string[]): string => {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
};

/** Ветка задачи с готовой работой — то, что оставляет после себя исполнитель. */
function taskBranch(
  dir: string, id: string, files: Record<string, string>,
  opts: { roleId?: string; type?: TaskType; assigneeId?: string } = {},
): Task {
  git(dir, 'checkout', '-q', '-b', `task/${id}`, 'main');
  for (const [name, body] of Object.entries(files)) writeFileSync(resolve(dir, name), body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', `${id}: работа`);
  git(dir, 'checkout', '-q', 'main');

  const task = office.createTask({
    title: `Задача ${id}`, description: 'тестовая', criteria: ['готово'],
    roleId: opts.roleId ?? 'backend', ...(opts.type ? { type: opts.type } : {}),
  });
  // Ветку заводим под тем же именем, что и id задачи в офисе.
  git(dir, 'branch', '-m', `task/${id}`, `task/${task.id}`);
  office.updateTask(task.id, {
    status: 'review', branch: `task/${task.id}`, baseBranch: 'main',
    repoDir: dir, worktreePath: null, result: 'сделано',
    assigneeId: opts.assigneeId ?? null,
    handoff: { did: 'сделано', assumed: 'взял синий', left: 'ничего' },
  });
  return office.tasks.get(task.id) as Task;
}

/**
 * Второй репозиторий офиса — вложенный, как у ролей с разными проектами.
 * Имя основной ветки у него то же самое: именно на этом совпадении и держалась
 * ошибка, пока копия офиса для слияний была одна на офис.
 */
function nestedRepo(parent: string, name: string): string {
  const dir = resolve(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'office@local');
  git(dir, 'config', 'user.name', 'AI Office');
  writeFileSync(resolve(dir, 'readme.txt'), `${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'Начало');
  appendFileSync(resolve(parent, '.gitignore'), `${name}/\n`);
  git(parent, 'add', '-A');
  git(parent, 'commit', '-qm', `игнорируем ${name}`);
  return dir;
}

/** Готовая работа в заданном репозитории — как `taskBranch`, но не в родительском. */
function repoTask(repo: string, id: string, files: Record<string, string>): Task {
  git(repo, 'checkout', '-q', '-b', `task/${id}`, 'main');
  for (const [name, body] of Object.entries(files)) writeFileSync(resolve(repo, name), body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', `${id}: работа`);
  git(repo, 'checkout', '-q', 'main');

  const task = office.createTask({
    title: `Задача ${id}`, description: 'тестовая', criteria: ['готово'], roleId: 'backend',
  });
  git(repo, 'branch', '-m', `task/${id}`, `task/${task.id}`);
  office.updateTask(task.id, {
    status: 'review', branch: `task/${task.id}`, baseBranch: 'main',
    repoDir: repo, worktreePath: null, result: 'сделано',
    handoff: { did: 'сделано', assumed: 'ничего', left: 'ничего' },
  });
  return office.tasks.get(task.id) as Task;
}

/** Правка прямо в main — так база уезжает, пока задача была в работе. */
function moveBase(dir: string, file: string, body: string): void {
  writeFileSync(resolve(dir, file), body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', `main: ${file}`);
}

const say = (text: string) => { results.push(text); console.log(text); };

interface Stub {
  reviews: ReviewOutcome[];
  /** Что делает «автор», когда его зовут: правит файлы в своей рабочей копии. */
  rework: (state: OfficeState, task: Task, instruction: string) => ReworkOutcome;
  /** Шаг процесса: кто-то с нужными умениями делает узел. */
  step: (state: OfficeState, task: Task, req: StepRequest) => StepOutcome;
  calls: { reviews: number; reworks: number; instructions: string[]; steps: StepRequest[] };
  pm: string[];
}

function stub(input: Partial<Stub> = {}): Stub {
  const s: Stub = {
    reviews: input.reviews ?? [],
    rework: input.rework ?? (() => ({ ok: true, message: 'ничего не потребовалось' })),
    step: input.step ?? (() => ({ ok: true, outcome: 'ok', summary: 'шаг сделан', actor: 'someone#1' })),
    calls: { reviews: 0, reworks: 0, instructions: [], steps: [] },
    pm: [],
  };
  setPipelineAgents({
    async step(state, task, req) {
      s.calls.steps.push(req);
      return s.step(state, task, req);
    },
    async review() {
      s.calls.reviews += 1;
      return s.reviews.shift()
        ?? { verdict: 'approve', text: 'Замечаний нет.', reviewerId: 'reviewer#1' };
    },
    async rework(state, task, instruction) {
      s.calls.reworks += 1;
      s.calls.instructions.push(instruction);
      return s.rework(state, task, instruction);
    },
    notifyPm(_state, text) { s.pm.push(text); },
  });
  return s;
}

async function main(): Promise<void> {
  office.setStateFile(resolve(tmpdir(), `office-review-state-${process.pid}.json`));
  const dir = fixture();
  // Рабочие копии задач конвейер кладёт рядом с рабочей директорией процесса —
  // уводим её во временный репозиторий, чтобы прогон не сорил в настоящем.
  process.chdir(dir);
  office.seed();
  office.projectDir = dir;
  office.settings.autoPipeline = true;

  // 1. Чистая ветка + одобрение ревьюера: влито и убрано за собой.
  {
    const task = taskBranch(dir, 'A', { 'a.txt': 'A\n' });
    const s = stub();
    await runPipeline(office, task.id);

    const fresh = office.tasks.get(task.id) as Task;
    const pr = office.prOf(task.id);
    say('▶ Одобренная работа доезжает до main сама');
    check('стадия — влито', pr?.stage === 'merged');
    check('задача отмечена слитой', fresh.merged && fresh.status === 'done');
    check('файл появился в main', existsSync(resolve(dir, 'a.txt')));
    check('слияние merge-коммитом', git(dir, 'log', '-1', '--pretty=%P').split(' ').length === 2);
    check('ветка задачи удалена', !git(dir, 'branch', '--list', `task/${task.id}`));
    check('рабочая копия убрана', !existsSync(resolve(worktreesRoot(office), task.id)));
    check('ревьюера спросили один раз', s.calls.reviews === 1);
    check('автора не дёргали', s.calls.reworks === 0);
    check('менеджеру сообщили о слиянии', s.pm.some((m) => m.includes('влита')));
  }

  // 2. База уехала: конфликт разбирает автор в своей копии, main не трогаем.
  {
    const task = taskBranch(dir, 'B', { 'shared.txt': 'строка от задачи\n' });
    moveBase(dir, 'shared.txt', 'строка от main\n');
    const headBefore = git(dir, 'rev-parse', 'main');

    const s = stub({
      rework: (_state, t) => {
        // Автор разрешает конфликт: оставляет обе строки.
        const wt = office.tasks.get(t.id)?.worktreePath as string;
        writeFileSync(resolve(wt, 'shared.txt'), 'строка от main\nстрока от задачи\n');
        return { ok: true, message: 'разрешил' };
      },
    });
    await runPipeline(office, task.id);

    const pr = office.prOf(task.id);
    say('▶ Конфликт с main разбирает автор, а не человек');
    check('автора позвали ровно один раз', s.calls.reworks === 1);
    check('звали именно на конфликт', s.calls.instructions[0].includes('конфликт'));
    check('стадия — влито', pr?.stage === 'merged');
    check('main сдвинулся только слиянием', git(dir, 'rev-parse', `${headBefore}..main`).length > 0);
    check('в main обе строки',
      git(dir, 'show', 'main:shared.txt').includes('от main')
      && git(dir, 'show', 'main:shared.txt').includes('от задачи'));
  }

  // 2б. Дубль правки: одну и ту же функцию правят обе стороны, но в разных
  //     строках. Git сливает молча — офис обязан сказать вслух (урок T-138).
  {
    const preset = `export function entryOf(place) {
  const cell = place.cell;
  const dx = cell.x;
  const dy = cell.y;
  return { dx, dy };
}
`;
    moveBase(dir, 'preset.ts', preset);
    const task = taskBranch(dir, 'DUP', {
      'preset.ts': preset.replace('  return { dx, dy };', '  return { dx, dy, id: place.id };'),
    });
    moveBase(dir, 'preset.ts', preset.replace('  const dx = cell.x;', '  const dx = cell.x ?? 0;'));

    const s = stub();
    await runPipeline(office, task.id);

    const fresh = office.tasks.get(task.id) as Task;
    const report = fresh.result ?? '';
    say('▶ Правку одного места с двух сторон офис называет вслух');
    check('предупреждение слияние не остановило',
      office.prOf(task.id)?.stage === 'merged' && fresh.merged === true);
    check('в отчёте задачи назван файл',
      report.includes('дубль правки') && report.includes('preset.ts'));
    check('и функция, которую правили обе стороны', report.includes('entryOf'));
    check('отчёт исполнителя при этом цел', report.includes('сделано'));
    check('менеджеру предупреждение ушло', s.pm.some((m) => m.includes('дубль правки')));
    check('в логе офиса предупреждение есть',
      office.log.some((e) => e.text.includes('дубль правки')));
  }

  // 3. Конфликт, который автор не разрулил: конвейер встаёт, main цел.
  {
    const task = taskBranch(dir, 'C', { 'shared.txt': 'ещё одна версия\n' });
    moveBase(dir, 'shared.txt', 'main снова поменялся\n');
    const headBefore = git(dir, 'rev-parse', 'main');

    const s = stub({ rework: () => ({ ok: false, message: 'не смог' }) });
    await runPipeline(office, task.id);

    const pr = office.prOf(task.id);
    say('▶ Неразрешённый конфликт останавливает конвейер, а не портит main');
    check('стадия — встало', pr?.stage === 'stuck');
    check('задача не отмечена слитой', !office.tasks.get(task.id)?.merged);
    check('main не сдвинулся', git(dir, 'rev-parse', 'main') === headBefore);
    // Менеджера на первой же заминке не дёргаем: офис сначала пробует сам.
    check('менеджера пока не дёргали', s.pm.length === 0);
    check('остановка помечена как «попробуем ещё»',
      office.prOf(task.id)?.needsDecision === false);
    check('ревьюера не звали', s.calls.reviews === 0);
    check('вставшая задача видна в ручной очереди',
      mergeableTasks(office).some((t) => t.id === task.id));
  }

  // 4. Проверки проекта падают в ветке — автор чинит, и только потом ревью.
  {
    const task = taskBranch(dir, 'D', { boom: 'ломаем сборку\n', 'd.txt': 'D\n' });
    const s = stub({
      rework: (_state, t) => {
        const wt = office.tasks.get(t.id)?.worktreePath as string;
        rmSync(resolve(wt, 'boom'), { force: true });
        return { ok: true, message: 'починил' };
      },
    });
    await runPipeline(office, task.id);

    const pr = office.prOf(task.id);
    say('▶ Сломанная сборка чинится до ревью, а не после слияния');
    check('автора позвали на проверки', s.calls.instructions.some((i) => i.includes('Проверки проекта')));
    check('ревью было после починки', s.calls.reviews === 1);
    check('стадия — влито', pr?.stage === 'merged');
    check('сломанный файл в main не попал', !existsSync(resolve(dir, 'boom')));
  }

  // 5. Ревьюер возвращает работу: два круга доработки, на третий отказ — к менеджеру.
  {
    const task = taskBranch(dir, 'E', { 'e.txt': 'E\n' });
    const s = stub({
      reviews: [
        { verdict: 'changes', text: 'первый отказ', reviewerId: 'reviewer#1' },
        { verdict: 'changes', text: 'второй отказ', reviewerId: 'reviewer#1' },
        { verdict: 'changes', text: 'третий отказ', reviewerId: 'reviewer#1' },
      ],
    });
    await runPipeline(office, task.id);

    const pr = office.prOf(task.id);
    say('▶ Бесконечных кругов доработки не бывает');
    check('ревью было три раза', s.calls.reviews === 3);
    check('доработок было две', s.calls.reworks === 2);
    check('стадия — встало', pr?.stage === 'stuck');
    check('в отзывах сохранены все три', pr?.reviews.length === 3);
    check('менеджер узнал про последний отзыв', s.pm.some((m) => m.includes('третий отказ')));
    check('задача не влита', !office.tasks.get(task.id)?.merged);
  }

  // 6. Ревьюер сначала вернул, потом одобрил — обычный рабочий круг.
  {
    const task = taskBranch(dir, 'F', { 'f.txt': 'F\n' });
    const s = stub({
      reviews: [
        { verdict: 'changes', text: 'добавь проверку на пустой список', reviewerId: 'reviewer#1' },
        { verdict: 'approve', text: 'теперь хорошо', reviewerId: 'reviewer#1' },
      ],
      rework: (_state, t) => {
        const wt = office.tasks.get(t.id)?.worktreePath as string;
        writeFileSync(resolve(wt, 'f.txt'), 'F с проверкой\n');
        return { ok: true, message: 'поправил' };
      },
    });
    await runPipeline(office, task.id);

    const pr = office.prOf(task.id);
    say('▶ Доработка по отзыву доезжает до main');
    check('автору передали текст отзыва',
      s.calls.instructions.some((i) => i.includes('добавь проверку на пустой список')));
    check('стадия — влито', pr?.stage === 'merged');
    check('круг доработки посчитан', pr?.rounds === 1);
    check('в main лежит доработанная версия', git(dir, 'show', 'main:f.txt').includes('с проверкой'));
  }

  // 7. Задача, которую ведёт конвейер, из ручной очереди не видна.
  {
    const task = taskBranch(dir, 'G', { 'g.txt': 'G\n' });
    let seenDuringReview: string[] = [];
    stub({
      reviews: [],
    });
    setPipelineAgents({
      async review() {
        // Момент, когда пулл-реквест в работе: человек не должен видеть его
        // в списке «слить вручную», иначе сольёт ветку из-под ревьюера.
        seenDuringReview = mergeableTasks(office).map((t) => t.id);
        return { verdict: 'approve', text: 'ок', reviewerId: 'reviewer#1' };
      },
      async rework() { return { ok: true, message: '' }; },
      notifyPm() { /* не нужно */ },
    });
    await runPipeline(office, task.id);

    say('▶ Ручная очередь не перехватывает работу у конвейера');
    check('во время ревью задачи в ручной очереди нет', !seenDuringReview.includes(task.id));
    check('после слияния её там тоже нет', !mergeableTasks(office).some((t) => t.id === task.id));
  }

  // 8. Незакоммиченные правки человека В ДРУГИХ файлах слиянию не мешают.
  {
    const task = taskBranch(dir, 'I', { 'i.txt': 'I\n' });
    // Человек прямо сейчас правит свой файл и не коммитит его.
    writeFileSync(resolve(dir, 'shared.txt'), 'человек правит прямо сейчас\n');
    const s = stub();
    await runPipeline(office, task.id);

    say('▶ Правки человека в рабочей копии не останавливают слияние');
    check('стадия — влито', office.prOf(task.id)?.stage === 'merged');
    check('правка человека цела',
      readFileSync(resolve(dir, 'shared.txt'), 'utf8').includes('человек правит'));
    check('копия подтянулась до слитого', existsSync(resolve(dir, 'i.txt')));
    check('копия осталась на main', git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main');
    check('человека ни о чём не спрашивали', s.pm.every((m) => !m.includes('встал')));
    git(dir, 'checkout', '--', 'shared.txt');
  }

  // 9. Правки человека В ТЕХ ЖЕ файлах: слияние всё равно проходит, а копию
  //    офис отцепляет, чтобы влитое не смешалось с несохранённой работой.
  {
    const task = taskBranch(dir, 'J', { 'shared.txt': 'версия задачи J\n' });
    writeFileSync(resolve(dir, 'shared.txt'), 'а тут человек пишет своё\n');
    const headBefore = git(dir, 'rev-parse', 'main');
    const s = stub();
    await runPipeline(office, task.id);

    say('▶ Пересечение с правками человека тоже не повод останавливаться');
    check('стадия — влито', office.prOf(task.id)?.stage === 'merged');
    check('main сдвинулся', git(dir, 'rev-parse', 'main') !== headBefore);
    check('в main версия задачи', git(dir, 'show', 'main:shared.txt').includes('версия задачи J'));
    check('правка человека на диске цела',
      readFileSync(resolve(dir, 'shared.txt'), 'utf8').includes('человек пишет своё'));
    check('копия отцеплена, а не сломана', git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') === 'HEAD');
    check('офис объяснил, что произошло',
      office.chat.some((c) => c.text.includes('отцеплена') && c.text.includes(task.id)));
    check('конвейер не встал', office.prOf(task.id)?.stage !== 'stuck');

    // Человек прибрался — и снова может вернуться на ветку.
    git(dir, 'checkout', '--', 'shared.txt');
    git(dir, 'checkout', 'main');
    check('после уборки копия возвращается на main',
      git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main');
  }

  // 10. Надзор: сданную задачу, которую никто не ведёт, офис заводит сам.
  {
    const task = taskBranch(dir, 'K', { 'k.txt': 'K\n' });
    office.updateTask(task.id, { status: 'done', finishedAt: Date.now() });
    const s = stub();

    say('▶ Офис сам подбирает ветки, которые никто не ведёт');
    check('до прохода надзора конвейера нет', office.prOf(task.id) === null);
    await superviseOffice(office);
    await whenPipelinesIdle(office);
    check('надзор завёл задачу в конвейер', office.prOf(task.id) !== null);
    check('и она доехала до main', office.tasks.get(task.id)?.merged === true);
    check('человека для этого не потребовалось', s.pm.every((m) => !m.includes('встал')));
  }

  // 11. Надзор перезапускает вставший конвейер сам — и с паузой, а не подряд.
  {
    const task = taskBranch(dir, 'L', { 'shared.txt': 'версия L\n' });
    moveBase(dir, 'shared.txt', 'main поменялся до L\n');
    let canFix = false;
    const s = stub({
      rework: (_state, t) => {
        if (!canFix) return { ok: false, message: 'исполнитель был занят' };
        const wt = office.tasks.get(t.id)?.worktreePath as string;
        writeFileSync(resolve(wt, 'shared.txt'), 'main поменялся до L\nверсия L\n');
        return { ok: true, message: 'разрешил' };
      },
    });
    await runPipeline(office, task.id);

    say('▶ Вставший конвейер офис перезапускает сам');
    check('после первой беды он стоит', office.prOf(task.id)?.stage === 'stuck');
    check('и помечен как «попробуем ещё»', office.prOf(task.id)?.needsDecision === false);

    canFix = true;
    await superviseOffice(office);
    await whenPipelinesIdle(office);
    check('надзор перезапустил и задача доехала', office.tasks.get(task.id)?.merged === true);
    check('попытка посчитана', (office.prOf(task.id)?.retries ?? 0) >= 1);
    check('менеджера так и не дёрнули', s.pm.every((m) => !m.includes('не доехала')));
  }

  // 12. Попытки кончились — офис зовёт менеджера, а не пользователя, и один раз.
  {
    const task = taskBranch(dir, 'M', { 'shared.txt': 'версия M\n' });
    moveBase(dir, 'shared.txt', 'main поменялся до M\n');
    const s = stub({ rework: () => ({ ok: false, message: 'не смог' }) });
    await runPipeline(office, task.id);
    // Три прохода надзора с уже наступившим сроком — это и есть три попытки.
    for (let i = 0; i < 4; i += 1) {
      office.patchPr(task.id, { nextTryAt: null });
      await superviseOffice(office);
      await whenPipelinesIdle(office);
    }

    const pr = office.prOf(task.id);
    say('▶ Когда сам не справился — зовём менеджера, а не пользователя');
    check('попыток было ровно три', pr?.retries === 3);
    check('дальше пробовать не будет', pr?.needsDecision === true && pr?.nextTryAt === null);
    check('менеджеру объяснили, что от него нужно',
      s.pm.some((m) => m.includes('не доехала') && m.includes('решай ты')));
    check('менеджера позвали один раз',
      s.pm.filter((m) => m.includes('не доехала')).length === 1);
    check('задача не влита', !office.tasks.get(task.id)?.merged);

    // Следующий проход уже ничего не трогает: решение за менеджером.
    const before = s.calls.reworks;
    await superviseOffice(office);
    await whenPipelinesIdle(office);
    check('ждущий решения PR надзор больше не дёргает', s.calls.reworks === before);
  }

  // 12½. Офис отступился — но обстановка изменилась, и он вернулся сам.
  //      Раньше задача стояла до чьего-нибудь клика, даже когда причина
  //      давным-давно ушла (например, починку уже влили в main).
  {
    const task = taskBranch(dir, 'M2', { 'shared.txt': 'версия M2\n' });
    moveBase(dir, 'shared.txt', 'main поменялся до M2\n');
    let canFix = false;
    const s = stub({
      rework: (_state, t) => {
        if (!canFix) return { ok: false, message: 'исполнитель был занят' };
        const wt = office.tasks.get(t.id)?.worktreePath as string;
        writeFileSync(resolve(wt, 'shared.txt'), 'main поменялся до M2\nверсия M2\n');
        return { ok: true, message: 'разрешил' };
      },
    });
    await runPipeline(office, task.id);
    for (let i = 0; i < 4; i += 1) {
      office.patchPr(task.id, { nextTryAt: null });
      await superviseOffice(office);
      await whenPipelinesIdle(office);
    }

    say('▶ Обстановка изменилась — офис возвращается к задаче сам');
    check('офис отступился', office.prOf(task.id)?.needsDecision === true);
    check('и запомнил обстановку', Boolean(office.prOf(task.id)?.situation));

    // Пока вокруг всё то же самое, повторять нечего: ни попыток, ни денег.
    const before = s.calls.reworks;
    await superviseOffice(office);
    await whenPipelinesIdle(office);
    check('без перемен офис не дёргается',
      s.calls.reworks === before && office.prOf(task.id)?.needsDecision === true);

    // Причина ушла (а заодно сдвинулась и база) — офис пробует снова сам.
    canFix = true;
    moveBase(dir, 'поехали.txt', 'main поехал дальше\n');
    await superviseOffice(office);
    await whenPipelinesIdle(office);
    check('офис вернулся к задаче без кнопки', office.tasks.get(task.id)?.merged === true);
    check('и сказал в ленту, что изменилось',
      office.log.some((l) => l.text.includes(task.id) && l.text.includes('обстановка изменилась')));
    check('менеджера второй раз не дёргали',
      s.pm.filter((m) => m.includes('не доехала')).length === 1);
    check('отпечаток обстановки снят', !office.prOf(task.id)?.situation);
  }

  // 12¾. Сохранение старше отпечатка: офис отступился ещё прежним кодом, и
  //      обстановки того момента не знает никто. Один заход всё равно дешевле,
  //      чем задача, стоящая до конца времён.
  {
    const task = taskBranch(dir, 'M3', { 'shared.txt': 'версия M3\n' });
    moveBase(dir, 'shared.txt', 'main поменялся до M3\n');
    let canFix = false;
    const s = stub({
      rework: (_state, t) => {
        if (!canFix) return { ok: false, message: 'исполнитель был занят' };
        const wt = office.tasks.get(t.id)?.worktreePath as string;
        writeFileSync(resolve(wt, 'shared.txt'), 'main поменялся до M3\nверсия M3\n');
        return { ok: true, message: 'разрешил' };
      },
    });
    await runPipeline(office, task.id);
    for (let i = 0; i < 4; i += 1) {
      office.patchPr(task.id, { nextTryAt: null });
      await superviseOffice(office);
      await whenPipelinesIdle(office);
    }
    // Ровно то, что лежит в старых сохранениях: решения ждёт, отпечатка нет.
    office.patchPr(task.id, { situation: null });

    say('▶ Задача из старого сохранения тоже не ждёт кнопки');
    canFix = true;
    await superviseOffice(office);
    await whenPipelinesIdle(office);
    check('офис попробовал и довёл её до main', office.tasks.get(task.id)?.merged === true);
    check('в ленте сказано, что обстановку не помним',
      office.log.some((l) => l.text.includes(task.id) && l.text.includes('не запомнили')));
  }

  // 13. Ревьюер трижды завернул — это сразу к менеджеру, без повторов.
  {
    const task = taskBranch(dir, 'N', { 'n.txt': 'N\n' });
    const s = stub({
      reviews: [
        { verdict: 'changes', text: 'раз', reviewerId: 'reviewer#1' },
        { verdict: 'changes', text: 'два', reviewerId: 'reviewer#1' },
        { verdict: 'changes', text: 'три', reviewerId: 'reviewer#1' },
      ],
    });
    await runPipeline(office, task.id);
    const before = s.calls.reviews;
    await superviseOffice(office);
    await whenPipelinesIdle(office);

    say('▶ Спор с ревьюером повторами не лечится');
    check('помечено как «нужно решение»', office.prOf(task.id)?.needsDecision === true);
    check('менеджера позвали сразу', s.pm.some((m) => m.includes('сам он дальше не поедет')));
    check('надзор повторов не устраивал', s.calls.reviews === before);
  }

  /** Дождаться вопроса-согласования по задаче и ответить на него. */
  const decide = async (taskId: string, answer: string): Promise<string> => {
    for (let i = 0; i < 200; i += 1) {
      const q = [...office.questions.values()].find(
        (x) => x.kind === 'gate' && x.taskId === taskId && !x.answeredAt && !x.dismissedAt);
      if (q) {
        answerQuestion(office, q.id, answer);
        return q.id;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`согласование по ${taskId} так и не спросили`);
  };

  // 16. Контент: юрист смотрит, владелец согласует, офис вливает.
  {
    const task = taskBranch(dir, 'P', { 'p.md': 'Пост\n' },
      { roleId: 'smm', type: 'content', assigneeId: 'smm#1' });
    const s = stub();
    const done = runPipeline(office, task.id);
    const qid = await decide(task.id, 'да');
    await done;

    say('▶ Контент идёт к юристу и на согласование, а не к ревьюеру кода');
    const legal = s.calls.steps[0];
    check('первым шагом позвали юриста', legal?.node === 'legal' && legal.needs.includes('docs.legal'));
    check('не автора', legal?.exclude.includes('smm#1'));
    check('юристу передали отчёт с запиской', legal?.prompt.includes('взял синий'));
    check('ревьюера кода не звали', s.calls.reviews === 0);
    check('владельца спросили согласованием', office.questions.get(qid)?.kind === 'gate');
    check('после «да» — влито', office.prOf(task.id)?.stage === 'merged');
    check('прогон закончен', office.runOf(task.id)?.status === 'done');
    check('шагов было ровно один', s.calls.steps.length === 1);
  }

  // 17. Владелец сказал «нет»: доработка тем же автором, потом снова юрист и согласование.
  {
    const task = taskBranch(dir, 'R', { 'r.md': 'Пост\n' },
      { roleId: 'smm', type: 'content', assigneeId: 'smm#1' });
    const s = stub({
      step: (_state, _task, req) => ({
        ok: true, outcome: req.node === 'legal' ? 'ok' : 'done', summary: `сделал ${req.node}`, actor: req.prefer ?? 'legal#1',
      }),
    });
    const done = runPipeline(office, task.id);
    await decide(task.id, 'нет, короче и без цен');
    await decide(task.id, 'да');
    await done;

    say('▶ «Нет» владельца — доработка автором и второй круг');
    check('порядок шагов: юрист, доработка, юрист',
      s.calls.steps.map((r) => r.node).join(',') === 'legal,rework,legal');
    check('доработку отдали автору', s.calls.steps[1]?.prefer === 'smm#1');
    check('автору передали ответ владельца', s.calls.steps[1]?.prompt.includes('без цен'));
    check('в итоге влито', office.prOf(task.id)?.stage === 'merged');
  }

  // 18. Исследование: проверяющий нашёл пробелы — автор закрывает, потом владелец.
  {
    const task = taskBranch(dir, 'S', { 's.md': 'Выводы\n' },
      { roleId: 'legal', type: 'research', assigneeId: 'legal#1' });
    let verifies = 0;
    const s = stub({
      step: (_state, _task, req) => {
        if (req.node === 'verify') {
          verifies += 1;
          return { ok: true, outcome: verifies === 1 ? 'gaps' : 'ok', summary: 'нет источника на цифру', actor: 'legal#1' };
        }
        return { ok: true, outcome: 'done', summary: 'добавил источник', actor: req.prefer ?? '' };
      },
    });
    const done = runPipeline(office, task.id);
    await decide(task.id, 'ok');
    await done;

    say('▶ Исследование проверяют, пробелы закрывает автор');
    check('проверка, доработка, проверка', s.calls.steps.map((r) => r.node).join(',') === 'verify,rework,verify');
    check('доработке передали отзыв проверяющего', s.calls.steps[1]?.prompt.includes('нет источника'));
    check('влито', office.prOf(task.id)?.stage === 'merged');
  }

  // 19. Макет: сразу к владельцу; три «нет» подряд — к менеджеру.
  {
    const task = taskBranch(dir, 'U', { 'u.md': 'Макет\n' },
      { roleId: 'design', assigneeId: 'design#1' });
    const s = stub({ step: (_s, _t, req) => ({ ok: true, outcome: 'done', summary: 'поправил', actor: req.prefer ?? '' }) });
    const done = runPipeline(office, task.id);
    await decide(task.id, 'нет');
    await decide(task.id, 'нет, всё ещё не то');
    await decide(task.id, 'нет');
    await done;

    say('▶ Согласование не бесконечно');
    check('тип выведен из роли', office.tasks.get(task.id)?.type === 'design');
    check('до слияния не дошло', office.prOf(task.id)?.stage === 'stuck');
    check('нужно решение менеджера', office.prOf(task.id)?.needsDecision === true);
    check('менеджеру объяснили', s.pm.some((m) => m.includes('вернул работу')));
    check('доработок было две', s.calls.steps.length === 2);
    check('прогон стоит на согласовании', office.runOf(task.id)?.nodeId === 'approve');
  }

  // 20. Своя проверка проекта: узел project:lint в файле процесса самого репозитория.
  {
    const catalog = workflowCatalog(office).find((e) => e.id === 'feature')!;
    const own = JSON.parse(catalog.text) as { version: number; nodes: Array<Record<string, unknown> & { id: string; next: Record<string, unknown> }> };
    own.version = 2;
    const checks = own.nodes.find((n) => n.id === 'checks')!;
    checks.next = { ...checks.next, pass: 'lint' };
    const at = own.nodes.indexOf(checks) + 1;
    own.nodes.splice(at, 0, { id: 'lint', kind: 'check', run: 'project:lint', stage: 'checks', next: { pass: 'open-pr', fail: 'stuck' } });
    check('свой процесс сохранён в workflows/ проекта', saveProjectWorkflow(office, 'feature', JSON.stringify(own, null, 2)) === null);
    office.settings.checks = { lint: 'test ! -e lintboom' };
    // Файл процесса — часть проекта: коммитим в main, иначе ветка задачи
    // унесёт его с собой при первом же checkout.
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'процесс проекта');

    const task = taskBranch(dir, 'W', { 'w.txt': 'W\n' });
    const s = stub();
    await runPipeline(office, task.id);
    say('▶ Своя проверка проекта идёт узлом процесса');
    check('задача влита', office.prOf(task.id)?.stage === 'merged');
    check('прогон шёл по своей версии', office.runOf(task.id)?.version === 2);
    check('узел lint пройден', office.runOf(task.id)?.steps.some((st) => st.node === 'lint' && st.outcome === 'pass') === true);
    check('у шагов есть длительность и цена', office.runOf(task.id)?.steps.every((st) => st.ms >= 0 && st.costUsd >= 0) === true);
    check('ревьюера спросили один раз', s.calls.reviews === 1);

    const bad = taskBranch(dir, 'X', { lintboom: 'ломаем линтер\n', 'x.txt': 'X\n' });
    const s2 = stub({ rework: () => ({ ok: true, message: 'ничего не менял' }) });
    await runPipeline(office, bad.id);
    say('▶ Проваленная своя проверка останавливает конвейер');
    check('конвейер встал', office.prOf(bad.id)?.stage === 'stuck');
    check('причина — проверка lint', (office.prOf(bad.id)?.note ?? '').includes('lint'));
    check('до ревью не дошло', s2.calls.reviews === 0);

    office.settings.checks = {};
    check('свой процесс убран', resetProjectWorkflow(office, 'feature') === null);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'процесс проекта убран');
  }
  // 21. Второй репозиторий офиса: задача вложенного репозитория доезжает до
  //     его main. Пока копия офиса для слияний была одна на офис, сюда
  //     приезжала копия РОДИТЕЛЬСКОГО репозитория, и конвейер гонял задачу по
  //     кругу «база уехала», пока не кончались попытки.
  {
    const back = nestedRepo(dir, 'back');
    const task = repoTask(back, 'Y', { 'y.txt': 'Y\n' });
    const s = stub();
    await runPipeline(office, task.id);

    say('▶ Задача второго репозитория офиса вливается в его же main');
    check('стадия — влито', office.prOf(task.id)?.stage === 'merged');
    check('файл появился в main вложенного репозитория',
      git(back, 'show', 'main:y.txt').includes('Y'));
    check('родительский репозиторий не тронут', !existsSync(resolve(dir, 'y.txt')));
    check('автора чинить конфликты не звали', s.calls.reworks === 0);
    check('ревьюера спросили один раз', s.calls.reviews === 1);
  }

  // 22. Ветки задачи нет в её репозитории (а в родительском — есть): это
  //     поломка настройки. Конвейер обязан встать сразу, а не выдавать её за
  //     уехавшую базу и заходить на второй круг. Сообщение с именем
  //     репозитория проверяется на очереди слияния (test:merge).
  {
    const back = nestedRepo(dir, 'other');
    const task = repoTask(back, 'Z', { 'z.txt': 'Z\n' });
    // Ветка есть в родительском репозитории, но не в том, где ведётся задача.
    git(dir, 'branch', `task/${task.id}`, 'main');
    git(back, 'branch', '-D', `task/${task.id}`);
    const headBefore = git(back, 'rev-parse', 'main');

    const s = stub();
    await runPipeline(office, task.id);

    const pr = office.prOf(task.id);
    say('▶ Ветка не в том репозитории — стоп на первой же попытке');
    check('конвейер встал', pr?.stage === 'stuck');
    check('в причине названа ветка', (pr?.note ?? '').includes(`task/${task.id}`));
    check('ревьюера не звали', s.calls.reviews === 0);
    check('про «база уехала» не сказано ни слова',
      !office.chat.some((m) => m.text.includes('уехала') && m.text.includes(task.id)));
    check('main вложенного репозитория цел', git(back, 'rev-parse', 'main') === headBefore);
    check('автора не дёргали', s.calls.reworks === 0);
  }

  // 23. Исследование в офисе, где проверить его некому: шаг пропускается, и
  //     работа доезжает до владельца. Раньше она застревала навсегда — нанять
  //     роль может только человек, а сказать ему об этом было некому.
  {
    // Архивная роль не может держать сотрудников: сначала распускаем их.
    const hidden = office.capableRoles(['research.web']).map((r) => r.id);
    for (const id of hidden) for (const inst of office.staffOf(id)) office.fire(inst.id);
    const archiveErrors = hidden.flatMap((id) => office.archiveRole(id, true));
    const task = taskBranch(dir, 'V', { 'v.md': 'Выводы\n' },
      { roleId: 'backend', type: 'research', assigneeId: 'backend#1' });
    const s = stub();
    const nobodyLeft = hidden.length > 0 && archiveErrors.length === 0
      && office.capableRoles(['research.web']).length === 0;
    const done = runPipeline(office, task.id);
    await decide(task.id, 'да');
    await done;
    for (const id of hidden) office.archiveRole(id, false);

    say('▶ Некому проверить — работа едет к владельцу, а не встаёт навсегда');
    check('в офисе правда некому проверять', nobodyLeft);
    check('проверяющего не звали', s.calls.steps.length === 0);
    check('шаг проверки пройден пропуском',
      office.runOf(task.id)?.steps.some((st) => st.node === 'verify' && st.outcome === 'ok') === true);
    check('офис сказал об этом вслух',
      office.chat.some((m) => m.text.includes(task.id) && m.text.includes('research.web')));
    check('владельца всё равно спросили', office.runOf(task.id)?.steps.some((st) => st.node === 'accept') === true);
    check('после «да» — влито', office.prOf(task.id)?.stage === 'merged');
  }

  // 14. Выключенный конвейер: задача просто остаётся сделанной, как раньше.
  {
    office.settings.autoPipeline = false;
    const task = taskBranch(dir, 'H', { 'h.txt': 'H\n' });
    const s = stub();
    await runPipeline(office, task.id);
    office.settings.autoPipeline = true;

    say('▶ Выключенный конвейер ничего не делает молча');
    check('пулл-реквеста нет', office.prOf(task.id) === null);
    check('ни ревью, ни доработок', s.calls.reviews === 0 && s.calls.reworks === 0);
    check('ветка задачи цела', git(dir, 'branch', '--list', `task/${task.id}`).length > 0);
  }

  // 15. Доска не должна стоять: очередь, прерванные перезапуском и провалы.
  //     Исполнителей тут поднимаем заглушкой (dryRun) — проверяется поведение
  //     офиса, а не работа агентов.
  {
    // Хвосты прошлых сценариев конвейеру больше не интересны: этот блок про доску.
    for (const t of office.tasks.values()) {
      if (t.status === 'done' && !t.merged) office.updateTask(t.id, { merged: true });
    }
    office.dryRun = true;
    process.env.OFFICE_DRY_RUN_DELAY = '30';
    // Настоящую сессию менеджера не поднимаем: подсовываем готовую очередь.
    office.pmQueue = new MessageQueue();
    office.pmLoop = Promise.resolve();
    const s = stub();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const said = (part: string) => s.pm.filter((m) => m.includes(part)).length;

    // Задача, которую завели и не раздали.
    const queued = office.createTask({
      title: 'Стоит в очереди', description: '', criteria: ['есть'], roleId: 'frontend',
    });
    office.updateTask(queued.id, { createdAt: Date.now() - 6 * 60_000 });
    await superviseOffice(office);

    say('▶ Задача, которую завели и не раздали, не стоит вечно');
    check('менеджеру сказали про стоящую задачу',
      s.pm.some((m) => m.includes(queued.id) && m.includes('никто не выполняет')));
    check('сама пока не роздана — первое слово за менеджером',
      office.tasks.get(queued.id)?.status === 'backlog');
    check('офис запомнил, что показал её', office.tasks.get(queued.id)?.attention !== null);

    // Менеджер промолчал — офис раздаёт сам.
    office.updateTask(queued.id, { attention: Date.now() - 11 * 60_000 });
    await superviseOffice(office);
    await sleep(120);
    check('офис раздал её сам', office.tasks.get(queued.id)?.status !== 'backlog');
    check('исполнитель назначен', Boolean(office.tasks.get(queued.id)?.assigneeId));
    check('менеджеру сказали, что раздали за него', said('офис отдал её') === 1);

    // Работу оборвал перезапуск сервера.
    const killed = office.createTask({
      title: 'Прибита перезапуском', description: '', criteria: ['есть'], roleId: 'frontend',
    });
    office.updateTask(killed.id, {
      status: 'blocked', interrupted: true, assigneeId: 'frontend#1',
      result: '⚠️ Работа прервана перезапуском сервера.',
    });
    await superviseOffice(office);
    await sleep(120);

    say('▶ Работу, прибитую перезапуском, офис возобновляет сам');
    check('задача больше не заблокирована', office.tasks.get(killed.id)?.status !== 'blocked');
    check('пометка снята', office.tasks.get(killed.id)?.interrupted === false);
    check('офис сказал об этом вслух',
      office.chat.some((c) => c.text.includes(killed.id) && c.text.includes('возобновляю')));

    // Провалившаяся задача, о которой все забыли.
    const broke = office.createTask({
      title: 'Упала по лимиту ходов', description: '', criteria: ['есть'], roleId: 'backend',
    });
    office.updateTask(broke.id, {
      status: 'failed', result: 'Ошибка: Reached maximum number of turns (60)',
    });
    await superviseOffice(office);
    const toldAboutFailures = said('провалившиеся задачи');
    await superviseOffice(office);

    say('▶ Про забытые провалы офис напоминает менеджеру — один раз');
    check('менеджеру показали провал',
      s.pm.some((m) => m.includes('провалившиеся задачи') && m.includes(broke.id)));
    check('и объяснили, что делать с лимитом ходов',
      s.pm.some((m) => m.includes('меньшими кусками')));
    check('на втором проходе про то же не повторяются',
      said('провалившиеся задачи') === toldAboutFailures);
    check('пользователя не звали ни разу',
      s.pm.every((m) => !m.includes('спроси пользователя')));

    office.dryRun = false;
  }

  const failed = results.filter((r) => r.includes('❌'));
  rmSync(dir, { recursive: true, force: true });
  office.wipe();
  if (failed.length) {
    console.error(`\nПровалено проверок: ${failed.length}`);
    process.exit(1);
  }
  console.log(`\nВсе проверки прошли: ${results.filter((r) => r.includes('✅')).length}`);
}

void main();
