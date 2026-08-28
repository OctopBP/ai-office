// Проверка пакетов сотрудников: находится ли пакет роли и доезжают ли его
// скилы до сессии. npm run test:skills
//
// Проверок две, и они разного рода. Первая — наша: пакет на диске разбирается
// в имя плагина и полные имена скилов, тут хватает файлов во времянке.
// Вторая — контракт SDK: имя вида `плагин:скил` должно совпасть с тем, как
// сессия называет скил у себя. Проверить это можно только живой сессией,
// поэтому она за флагом: SKILLS_LIVE=1 npm run test:skills
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = mkdtempSync(resolve(tmpdir(), 'office-skills-'));
process.env.OFFICE_EMPLOYEES_DIR = root;

// Импорт после подмены пути: каталог пакетов читается на загрузке модуля.
const { employeePack, employeePlugins, employeeSkills, sessionTools } = await import('../src/server/skills');
const { blankRole } = await import('../src/server/roles');

/** Пакет на диске: манифест плагина и один скил. */
function makePack(id: string, opts: { name?: string; skill?: string; manifest?: boolean } = {}): void {
  const dir = resolve(root, id);
  if (opts.manifest !== false) {
    mkdirSync(resolve(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      resolve(dir, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: opts.name ?? id, version: '0.0.1', description: `пакет ${id}` }, null, 2),
    );
  }
  const slug = opts.skill ?? 'demo';
  mkdirSync(resolve(dir, 'skills', slug), { recursive: true });
  writeFileSync(
    resolve(dir, 'skills', slug, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: Проверочный навык пакета ${id}.\n---\n\nСкажи слово «пакет».\n`,
  );
}

makePack('withpack');
makePack('renamed', { name: 'my-plugin', skill: 'sprites' });
makePack('nomanifest', { manifest: false });

// Чужой плагин лежит НЕ в каталоге пакетов — на него только ссылаются.
const outside = mkdtempSync(resolve(tmpdir(), 'office-vendor-'));
for (const version of ['1.9.0', '1.10.0']) {
  const dir = resolve(outside, 'vendor', version);
  mkdirSync(resolve(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(resolve(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'vendor' }));
  for (const slug of ['alpha', 'beta']) {
    mkdirSync(resolve(dir, 'skills', slug), { recursive: true });
    writeFileSync(resolve(dir, 'skills', slug, 'SKILL.md'),
      `---\nname: ${slug}\ndescription: ${version}\n---\n`);
  }
}

/** Пакет, который только ссылается на чужой плагин: своих скилов нет. */
function makeRefPack(id: string, pack: Record<string, unknown>): void {
  const dir = resolve(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'pack.json'), JSON.stringify(pack, null, 2));
}

makeRefPack('refs', { use: [resolve(outside, 'vendor/*')] });
makeRefPack('picky', { use: [resolve(outside, 'vendor/*')], skills: ['beta'] });
makeRefPack('broken', { use: [resolve(outside, 'нет-такого/*')] });

const role = (id: string, tools?: string[]) => ({ ...blankRole(id), ...(tools ? { tools } : {}) });

let failed = 0;
const check = (what: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what.padEnd(46)} → ${JSON.stringify(got)}`
    + (ok ? '' : ` (ждали ${JSON.stringify(want)})`));
};

check('скилы пакета', employeeSkills(role('withpack')), ['withpack:demo']);
check('имя плагина из манифеста', employeeSkills(role('renamed')), ['my-plugin:sprites']);
check('пакета нет', employeeSkills(role('nopack')), undefined);
check('нет манифеста — пакета нет', employeeSkills(role('nomanifest')), undefined);
check('плагин отдаётся с skipMcpDiscovery',
  employeePlugins(role('withpack'))?.map((p) => [p.type, p.skipMcpDiscovery]), [['local', true]]);
check('плагина нет у роли без пакета', employeePlugins(role('nopack')), undefined);
check('Skill дописан урезанному набору',
  sessionTools(role('withpack', ['Read', 'Edit'])), ['Read', 'Edit', 'Skill']);
check('набор роли без пакета не трогаем',
  sessionTools(role('nopack', ['Read', 'Edit'])), ['Read', 'Edit']);
check('полный набор остаётся полным', sessionTools(role('withpack')), undefined);

// Ссылки на установленный плагин: копии в репозитории нет, скилы есть.
check('скилы чужого плагина по ссылке', employeeSkills(role('refs')), ['vendor:alpha', 'vendor:beta']);
check('маска берёт старшую версию',
  employeePack(role('refs'))?.dirs.map((d) => d.split('/').pop()), ['1.10.0']);
check('pack.skills отбирает нужное', employeeSkills(role('picky')), ['vendor:beta']);
check('ссылка в никуда — пакета нет', employeeSkills(role('broken')), undefined);
check('чужой плагин тоже без своего MCP',
  employeePlugins(role('refs'))?.map((p) => p.skipMcpDiscovery), [true]);

// ---------------------------------------------------------- живая сессия

if (process.env.SKILLS_LIVE === '1') {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const pack = employeePack(role('withpack'))!;
  console.log(`\n  живая сессия: ${pack.dirs.join(', ')}`);
  const session = query({
    prompt: 'ничего не делай',
    options: {
      cwd: root,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      plugins: employeePlugins(role('withpack')),
      skills: employeeSkills(role('withpack')),
      settingSources: [],
      maxTurns: 1,
    },
  });
  try {
    const commands = await session.supportedCommands();
    const names = commands.map((c) => c.name);
    const found = names.some((n) => n === 'withpack:demo' || n.endsWith(':demo') || n === 'demo');
    if (!found) failed += 1;
    console.log(`${found ? '  ok  ' : '  FAIL'} скил виден сессии`
      + ` → ${names.filter((n) => n.includes('demo')).join(', ') || '(нет)'}`);
    console.log(`       всего команд: ${names.length}`);
  } finally {
    await session.interrupt().catch(() => {});
  }
} else {
  console.log('\n  живая сессия пропущена (SKILLS_LIVE=1, чтобы проверить контракт SDK)');
}

rmSync(root, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });

console.log(failed ? `\nпровалено кейсов: ${failed}` : '\nвсе кейсы прошли');
process.exit(failed ? 1 : 0);
