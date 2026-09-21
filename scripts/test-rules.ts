/**
 * Проверки правил офиса (docs/design/rules/spec.md) без единого токена:
 * разбор и запись `RULES.md`, круги, правка, и главное — что именно из правил
 * доезжает до промпта исполнителя и до промпта менеджера.
 *
 * Последнее и есть смысл всей затеи: правило, не доехавшее до агента, —
 * просто текст в репозитории.
 *
 * Запуск: npm run test:rules
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice, unloadOfficeState } from '../src/server/state';
import {
  addRule, dropRule, editRule, parseRules, readRulesFile, ruleScopes, rulesBrief, rulesText,
  serializeRules,
} from '../src/server/rules';

// Тексты офиса сверяем по-русски — значит, и офис должен быть русским.
process.env.OFFICE_LANG = 'ru';

const results: string[] = [];
const check = (what: string, ok: boolean) => {
  results.push(`  ${ok ? '✅' : '❌'} ${what}: ${ok}`);
};

const dirs: string[] = [];

const git = (at: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: at, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * Репозиторий с одним коммитом: роль без него не заводится — офис проверяет,
 * что рабочая директория роли годна для веток.
 */
function repo(at: string): string {
  git(at, 'init', '-q', '-b', 'main');
  git(at, 'config', 'user.email', 'office@local');
  git(at, 'config', 'user.name', 'AI Office');
  writeFileSync(resolve(at, 'README.md'), '# repo\n');
  git(at, 'add', '-A');
  git(at, 'commit', '-qm', 'Начало');
  return at;
}

function dir(name: string): string {
  const made = mkdtempSync(resolve(tmpdir(), `office-rules-${name}-`));
  dirs.push(made);
  return made;
}

async function main(): Promise<void> {
  // ------------------------------------------------------------ разбор файла
  const sample = [
    '# Правила',
    '',
    '<!-- служебный комментарий -->',
    '',
    '- Первое правило',
    '- Второе правило,',
    '  продолженное со сдвигом',
    '',
    '## Не правила',
    '',
    'Абзац, который офис не трогает.',
  ].join('\n');
  const doc = parseRules(sample);
  check('правил разобрано два', doc.rules.length === 2);
  check('продолжение пункта приклеилось', doc.rules[1] === 'Второе правило, продолженное со сдвигом');
  check('шапка сохранилась', doc.head.includes('служебный комментарий'));
  check('хвост сохранился', doc.tail.includes('Абзац, который офис не трогает.'));

  const again = parseRules(serializeRules(doc));
  check('запись и разбор не теряют правила', again.rules.join('|') === doc.rules.join('|'));
  check('запись и разбор не теряют хвост', again.tail === doc.tail);

  const plain = parseRules('Просто текст без списка\n');
  check('файл без списка — файл без правил', plain.rules.length === 0 && plain.head.startsWith('Просто'));

  // -------------------------------------------------------------- круги
  const projectDir = repo(dir('office'));
  const webDir = repo(dir('web'));
  const office = getOffice('o-rules');
  office.projectDir = projectDir;
  office.dryRun = true;

  // Два фронтендера в одном репозитории — ровно тот случай, ради которого
  // правило и уезжает из брифа роли в файл.
  const make = async (title: string, patch: Record<string, unknown> = {}): Promise<string> => {
    const made = await office.createRole({ title, brief: `Роль ${title}.`, ...patch });
    if ('errors' in made) throw new Error(`${title}: ${made.errors.map((e) => e.message).join('; ')}`);
    return made.role.id;
  };
  const fe = await make('Фронтендер', { repoDir: webDir });
  const fe2 = await make('Фронтендер 2', { repoDir: webDir });
  const be = await make('Бэкендер');

  const scopes = ruleScopes(office);
  const officeScope = scopes.find((s) => s.id === 'office');
  const webScope = scopes.find((s) => s.kind === 'repo');
  check('круг офиса есть всегда', Boolean(officeScope));
  check('репозиторий роли стал кругом', Boolean(webScope) && webScope!.path === webDir);
  check('круг накрывает обе копии фронтендера',
    (webScope?.roles.map((r) => r.id).join(',') ?? '') === `${fe},${fe2}`);
  check('бэкендер сидит в круге офиса',
    (officeScope?.roles.map((r) => r.id) ?? []).includes(be));

  // -------------------------------------------------------------- правка
  const added = addRule(office, webScope!.id, '  Каждый  элемент интерфейса анимируем  ');
  check('правило завелось', added.ok);
  check('пробелы схлопнулись', added.ok && added.rule.text === 'Каждый элемент интерфейса анимируем');
  check('файл появился в репозитории направления',
    readRulesFile(webDir).rules[0] === 'Каждый элемент интерфейса анимируем');
  check('у нового файла есть шапка для человека',
    readFileSync(resolve(webDir, 'RULES.md'), 'utf8').startsWith('# Правила'));
  check('правка ушла в ленту офиса',
    office.log.some((l) => l.text.includes('Каждый элемент интерфейса анимируем')));

  check('второе такое же правило не заводится', !addRule(office, webScope!.id, 'Каждый элемент интерфейса анимируем').ok);
  check('пустое правило не заводится', !addRule(office, webScope!.id, '   ').ok);
  check('слишком длинное правило не заводится', !addRule(office, webScope!.id, 'а'.repeat(501)).ok);
  check('круга с выдуманным id нет', !addRule(office, 'repo:нет-такого', 'текст').ok);

  addRule(office, 'office', 'Комментарии по-русски');
  const edited = editRule(office, `${webScope!.id}#1`, 'Анимируем появление и смену состояний элементов');
  check('правило переписалось', edited.ok && readRulesFile(webDir).rules[0].startsWith('Анимируем появление'));
  check('чужой id правку не принимает', !editRule(office, 'repo:нет#1', 'текст').ok);
  check('несуществующий номер правку не принимает', !editRule(office, `${webScope!.id}#9`, 'текст').ok);
  check('мусорный id правку не принимает', !editRule(office, 'просто-строка', 'текст').ok);

  // Руками дописанное правило офис видит и не затирает при своей записи.
  writeFileSync(resolve(webDir, 'RULES.md'),
    `${readFileSync(resolve(webDir, 'RULES.md'), 'utf8').trimEnd()}\n- Руками дописанное правило\n`, 'utf8');
  check('правило из файла видно офису', ruleScopes(office).find((s) => s.kind === 'repo')?.rules.length === 2);
  addRule(office, webScope!.id, 'Третье правило');
  check('запись офиса не потеряла ручное правило',
    readRulesFile(webDir).rules.includes('Руками дописанное правило'));

  const dropped = dropRule(office, `${webScope!.id}#2`);
  check('правило снялось', dropped.ok && dropped.rule.text === 'Руками дописанное правило');
  check('снятое правило ушло из файла',
    !readRulesFile(webDir).rules.includes('Руками дописанное правило'));

  // ------------------------------------------------------------- промпт
  const feBrief = rulesBrief(office, fe);
  const fe2Brief = rulesBrief(office, fe2);
  const beBrief = rulesBrief(office, be);
  const pmBrief = rulesBrief(office, null);
  check('фронтендер получил правило направления', feBrief.includes('Анимируем появление'));
  check('вторая копия получила то же самое', fe2Brief === feBrief);
  check('бэкендер правила фронтенда не получил', !beBrief.includes('Анимируем появление'));
  check('офисное правило получили все',
    feBrief.includes('Комментарии по-русски') && beBrief.includes('Комментарии по-русски'));
  check('менеджер видит все круги',
    pmBrief.includes('Анимируем появление') && pmBrief.includes('Комментарии по-русски'));
  check('в списке менеджера есть id правил', rulesText(office).includes(`${webScope!.id}#1`));

  // Правила роли: их место — бриф, и панель показывает их только на просмотр.
  office.updateRole(be, { brief: 'Пишет сервер.\n\n## Правила офиса\nМиграции — отдельной задачей' });
  const roleScope = ruleScopes(office).find((s) => s.kind === 'role');
  check('правило из брифа роли видно кругом', roleScope?.rules[0]?.text === 'Миграции — отдельной задачей');
  check('ролевой круг не правится здесь', roleScope?.editable === false);
  check('в ролевой круг нельзя писать', !addRule(office, roleScope!.id, 'текст').ok);
  check('менеджер видит и правила роли', rulesBrief(office, null).includes('Миграции — отдельной задачей'));
  check('исполнителю чужое ролевое правило не достаётся',
    !rulesBrief(office, fe).includes('Миграции — отдельной задачей'));

  // ------------------------------------------------- офис без своих правил
  const bare = getOffice('o-rules-bare');
  bare.projectDir = dir('bare');
  check('без файлов правил блок промпта пуст', rulesBrief(bare, null) === '');
  check('круг офиса есть и без файла', ruleScopes(bare)[0]?.id === 'office');

  // ------------------------------------------------------ два одинаковых имени
  const twinsRoot = dir('twins');
  const first = resolve(twinsRoot, 'a/web');
  const second = resolve(twinsRoot, 'b/web');
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  repo(first);
  repo(second);
  const twins = getOffice('o-rules-twins');
  twins.projectDir = repo(dir('twins-office'));
  for (const [title, at] of [['Первый', first], ['Второй', second]] as const) {
    const made = await twins.createRole({ title, brief: '', repoDir: at });
    if ('errors' in made) throw new Error(`${title}: ${made.errors.map((e) => e.message).join('; ')}`);
  }
  const ids = ruleScopes(twins).filter((s) => s.kind === 'repo').map((s) => s.id);
  check('две папки с одним именем получают разные id', new Set(ids).size === 2);

  unloadOfficeState('o-rules');
  unloadOfficeState('o-rules-bare');
  unloadOfficeState('o-rules-twins');
  for (const made of dirs) rmSync(made, { recursive: true, force: true });

  console.log(results.join('\n'));
  const failed = results.filter((r) => r.includes('❌'));
  console.log(failed.length ? `ПРОВАЛОВ: ${failed.length}` : 'ВСЕ ПРОВЕРКИ ПРОШЛИ');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
