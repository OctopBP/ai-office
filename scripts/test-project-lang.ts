/**
 * Файлы, которые офис сам кладёт в репозиторий проекта, пишутся на языке
 * РЕАЛИЗАЦИИ, а не общения (аудит D-10, пункты 5–8, 10, 11): шапка `RULES.md`,
 * README папок ролей и корня, README и CHANGELOG заготовки пакета. Бриф роли
 * написан на языке общения — заголовок правил в нём на нём же, а читаются
 * оба варианта заголовка.
 *
 * Офис здесь нарочно «разноязычный»: общение по-русски, реализация по-английски,
 * — иначе перепутанные языки не отличить.
 *
 * Запуск: npm run test:project-lang
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { t } from '../src/server/i18n';
import { scaffoldPackage } from '../src/server/export';
import { createMyAgent, type MyAgentCtx } from '../src/server/myagents';
import { addRule, findRoleRules, readRulesFile, ROLE_RULES_HEADERS, roleRulesText, ruleScopes } from '../src/server/rules';
import { ensureRoleRepo, seedReadme } from '../src/server/setup';
import { vcsText } from '../src/server/vcs-messages';
import { applyProposal } from '../src/server/selfchange';
import { getOffice, unloadOfficeState } from '../src/server/state';
import { ruleProposal } from '../src/server/rituals';

process.env.OFFICE_LANG = 'ru';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'office-project-lang-'));
const sub = (name: string): string => {
  const at = resolve(tmp, name);
  execFileSync('mkdir', ['-p', at]);
  return at;
};
const git = (at: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: at, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo(at: string): string {
  git(at, 'init', '-q', '-b', 'main');
  git(at, 'config', 'user.email', 'office@local');
  git(at, 'config', 'user.name', 'AI Office');
  writeFileSync(resolve(at, 'README.md'), '# repo\n');
  git(at, 'add', '-A');
  git(at, 'commit', '-qm', 'init');
  return at;
}

/** Офис с заданными языками общения и реализации, в своей временной папке. */
function office(id: string, chat: 'ru' | 'en', code: 'ru' | 'en') {
  const state = getOffice(id);
  state.setStateFile(join(tmp, `${id}.json`));
  state.projectDir = repo(sub(id));
  state.dryRun = true;
  state.settings.language = chat;
  state.settings.chatLanguage = chat;
  state.settings.codeLanguage = code;
  return state;
}

async function main(): Promise<void> {
  const mixed = office('o-lang-mixed', 'ru', 'en');

  console.log('помощник');
  await check('projectSay — язык реализации, say — язык общения', () => {
    assert.equal(mixed.projectSay('rules.fileHead'), t('en', 'rules.fileHead'));
    assert.equal(mixed.say('rules.fileHead'), t('ru', 'rules.fileHead'));
  });

  console.log('RULES.md');
  await check('шапка нового RULES.md — на языке реализации', () => {
    const added = addRule(mixed, 'office', 'Commit messages in English');
    assert.ok(added.ok, JSON.stringify(added));
    const doc = readRulesFile(mixed.projectDir);
    assert.equal(doc.head, t('en', 'rules.fileHead'));
    assert.deepEqual(doc.rules, ['Commit messages in English']);
  });
  await check('шапку существующего файла не переписываем', () => {
    const other = office('o-lang-head', 'ru', 'en');
    writeFileSync(resolve(other.projectDir, 'RULES.md'), '# Свои правила\n\n- Первое\n');
    assert.ok(addRule(other, 'office', 'Second').ok);
    assert.equal(readRulesFile(other.projectDir).head, '# Свои правила');
    unloadOfficeState('o-lang-head');
  });

  console.log('заголовок правил в брифе');
  await check('оба заголовка находятся, упоминание внутри фразы — нет', () => {
    assert.equal(roleRulesText('Бриф.\n\n## Правила офиса\n- а\n- б'), '\n- а\n- б');
    assert.equal(roleRulesText('Brief.\n\n## Office rules\n- a'), '\n- a');
    assert.equal(findRoleRules('Читай «## Правила офиса» в конце.'), null);
    assert.equal(roleRulesText('Бриф без правил.'), '');
  });

  const make = async (state: ReturnType<typeof office>, title: string, brief: string): Promise<string> => {
    const made = await state.createRole({ title, brief });
    if ('errors' in made) throw new Error(`${title}: ${made.errors.map((e) => e.message).join('; ')}`);
    return made.role.id;
  };
  const accept = (state: ReturnType<typeof office>, roleId: string, text: string) => {
    const p = state.addProposal(ruleProposal({ roleId, rationale: 'T-1, T-2', text, kind: 'how' }));
    assert.equal(applyProposal(state, p), null);
  };
  const roleRuleTexts = (state: ReturnType<typeof office>, roleId: string): string[] =>
    ruleScopes(state).find((s) => s.id === `role:${roleId}`)?.rules.map((r) => r.text) ?? [];

  await check('русский офис: правило под «## Правила офиса»', async () => {
    const id = await make(mixed, 'Бэкендер', 'Ты бэкендер.');
    accept(mixed, id, 'Прогоняй typecheck.');
    accept(mixed, id, 'Пиши тесты.');
    const brief = mixed.role(id)!.brief;
    assert.ok(brief.endsWith(`${ROLE_RULES_HEADERS.ru}\nПрогоняй typecheck.\nПиши тесты.`), brief);
    assert.deepEqual(roleRuleTexts(mixed, id), ['Прогоняй typecheck.', 'Пиши тесты.']);
  });

  const english = office('o-lang-en', 'en', 'ru');
  await check('английский офис: правило под «## Office rules»', async () => {
    const id = await make(english, 'Backend', 'You are a backend developer.');
    accept(english, id, 'Run typecheck.');
    const brief = english.role(id)!.brief;
    assert.ok(brief.endsWith(`${ROLE_RULES_HEADERS.en}\nRun typecheck.`), brief);
    assert.ok(!brief.includes(ROLE_RULES_HEADERS.ru));
    assert.deepEqual(roleRuleTexts(english, id), ['Run typecheck.']);
  });
  await check('правила под старым русским заголовком не пропадают и пополняются', async () => {
    const id = await make(english, 'Legacy', `Brief.\n\n${ROLE_RULES_HEADERS.ru}\nOld rule.`);
    accept(english, id, 'New rule.');
    const brief = english.role(id)!.brief;
    assert.ok(!brief.includes(ROLE_RULES_HEADERS.en), 'второго заголовка не заводим');
    assert.deepEqual(roleRuleTexts(english, id), ['Old rule.', 'New rule.']);
  });

  console.log('README');
  await check('README новой папки роли — на языке реализации, отказы — на языке ответа', async () => {
    const dir = resolve(tmp, 'wizard', 'web');
    assert.equal(await ensureRoleRepo(dir, 'ru', 'en'), null);
    assert.equal(readFileSync(resolve(dir, 'README.md'), 'utf8'), t('en', 'setup.readme', { name: 'web' }));
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim();
    assert.equal(subject, vcsText('en', 'initCommit'), 'первый коммит — тоже на языке реализации');
    const file = resolve(tmp, 'wizard', 'file');
    writeFileSync(file, 'x');
    assert.equal(await ensureRoleRepo(file, 'ru', 'en'), t('ru', 'offices.notADir', { dir: file }));
  });
  await check('README корня — языком реализации офиса, готовый не трогаем', () => {
    const dir = sub('root');
    assert.equal(seedReadme(dir, mixed.projectSay('boot.readme')), null);
    assert.equal(readFileSync(resolve(dir, 'README.md'), 'utf8'), t('en', 'boot.readme'));
    writeFileSync(resolve(dir, 'README.md'), '# mine\n');
    assert.equal(seedReadme(dir, english.projectSay('boot.readme')), null);
    assert.equal(readFileSync(resolve(dir, 'README.md'), 'utf8'), '# mine\n');
    assert.ok(seedReadme(resolve(tmp, 'нет-такой', 'папки'), 'x'), 'провал записи — причина, а не исключение');
  });

  console.log('пакеты');
  await check('заготовка пакета для маркета — по-английски по умолчанию', () => {
    const dir = resolve(tmp, 'pkg-en');
    scaffoldPackage(dir, { name: '@alice/writer', title: { en: 'Writer', ru: 'Писатель' } });
    assert.match(readFileSync(resolve(dir, 'README.md'), 'utf8'), /^# Writer\n[\s\S]*## Install/);
    assert.match(readFileSync(resolve(dir, 'CHANGELOG.md'), 'utf8'), /- First version\./);
  });
  await check('заготовка с docsLang ru — README и CHANGELOG по-русски', () => {
    const dir = resolve(tmp, 'pkg-ru');
    scaffoldPackage(dir, { name: '@alice/writer', title: { en: 'Writer', ru: 'Писатель' }, docsLang: 'ru' });
    const readme = readFileSync(resolve(dir, 'README.md'), 'utf8');
    assert.match(readme, /^# Писатель\n[\s\S]*## Установка/);
    assert.ok(!readme.includes('## Install'));
    assert.match(readFileSync(resolve(dir, 'CHANGELOG.md'), 'utf8'), /- Первая версия\./);
  });
  await check('свой агент: бриф под ключом языка общения, README — языком реализации', () => {
    const root = resolve(tmp, 'agents');
    const ctx: MyAgentCtx = { lang: 'ru', codeLang: 'en', mcpIds: [], roles: [] };
    const r = createMyAgent(root, { id: 'lawyer', title: 'Юрист', brief: 'Ты юрист: читаешь договоры и находишь риски.' }, ctx);
    assert.ok(r.ok, JSON.stringify(r));
    const dir = r.agent.dir;
    assert.ok(existsSync(resolve(dir, 'brief', 'ru.md')));
    assert.ok(!existsSync(resolve(dir, 'brief', 'en.md')));
    assert.equal(JSON.parse(readFileSync(resolve(dir, 'agent.json'), 'utf8')).title.ru, 'Юрист');
    assert.match(readFileSync(resolve(dir, 'README.md'), 'utf8'), /## Install/);
    assert.match(readFileSync(resolve(dir, 'CHANGELOG.md'), 'utf8'), /First version\./);
  });
  await check('свой агент без codeLang — README на языке общения', () => {
    const root = resolve(tmp, 'agents-old');
    const r = createMyAgent(root, { id: 'lawyer', title: 'Юрист', brief: 'Ты юрист: читаешь договоры и находишь риски.' },
      { lang: 'ru', mcpIds: [], roles: [] });
    assert.ok(r.ok, JSON.stringify(r));
    assert.match(readFileSync(resolve(r.agent.dir, 'README.md'), 'utf8'), /## Установка/);
  });

  unloadOfficeState('o-lang-mixed');
  unloadOfficeState('o-lang-en');
  console.log(`\nпройдено: ${passed}`);
}

main().then(
  () => { rmSync(tmp, { recursive: true, force: true }); process.exit(0); },
  (err) => { console.error(err); rmSync(tmp, { recursive: true, force: true }); process.exit(1); },
);
