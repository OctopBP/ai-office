/**
 * Что умеет роль — в list_team и в промпте менеджера (T-695), без единого
 * токена: роль с MCP figcraft видна с подписью, роль без серверов вывод не
 * ломает, сводка в промпте укладывается в строку на роль.
 *
 * Запуск: npm run test:abilities
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openOfficeState, unloadOfficeState } from '../src/server/state';
import { abilitiesPrompt, pmPrompt, teamSummary } from '../src/server/agents';
import {
  abilitiesBlock, abilitiesBrief, abilitiesLine, BRIEF_LINE_MAX, oneLine, type RoleAbilities,
} from '../src/server/abilities';
import { DEFAULT_MCP_SERVERS, mcpAbout } from '../src/server/mcp';
import { hasKey, t } from '../src/server/i18n';

const results: string[] = [];
const check = (what: string, ok: boolean) => {
  results.push(`  ${ok ? '✅' : '❌'} ${what}`);
};

const base = resolve(tmpdir(), `office-test-abilities-${process.pid}`);
const projectDir = resolve(base, 'office');
mkdirSync(projectDir, { recursive: true });

results.push('каталог MCP: описания:');
for (const def of DEFAULT_MCP_SERVERS) {
  check(`${def.id}: есть строка на русском и на английском`,
    hasKey(`mcp.${def.id}.about`) && /[а-яё]/i.test(mcpAbout(def, 'ru')) && mcpAbout(def, 'en') !== def.id);
}
check('свой сервер без строки в словаре — подпись', mcpAbout({ ...DEFAULT_MCP_SERVERS[0], id: 'notion', title: 'Notion' }, 'ru') === 'Notion');
check('свой сервер без подписи — id', mcpAbout({ ...DEFAULT_MCP_SERVERS[0], id: 'notion', title: '' }, 'ru') === 'notion');
check('описание обрезается до одного предложения', oneLine('Первое. Второе предложение.') === 'Первое.');
check('длинное описание обрезается с многоточием', oneLine('а'.repeat(500)).length === 110 && oneLine('а'.repeat(500)).endsWith('…'));

results.push('list_team в живом офисе:');
const office = openOfficeState({ id: 'o-abilities', projectDir, stateFile: resolve(base, 'state.json') }).state;
office.dryRun = true;
// Офис нового сервера заводится на языке системы — проверка идёт на русском.
office.settings.chatLanguage = 'ru';
const [designer, plain] = office.workerRoles();
designer.mcp = ['figcraft'];
plain.mcp = [];
const team = teamSummary(office);
const lineOf = (id: string) => team.split('\n- ').find((l) => l.replace(/^- /, '').startsWith(`${id} (`)) ?? '';
const about = t('ru', 'mcp.figcraft.about');
check('роль с figcraft — сервер с подписью', lineOf(designer.id).includes(`MCP figcraft — ${about}`));
check('у роли есть блок «умеет»', lineOf(designer.id).includes(`${office.say('prompt.team.abilities')}:`));
check('роль без серверов — строка «только встроенные»', lineOf(plain.id).includes(office.say('prompt.team.nothing'))
  || !lineOf(plain.id).includes('MCP '));
check('все роли в выводе', office.workerRoles().every((r) => team.includes(`- ${r.id} (`)));
check('брифов целиком нет — строк не больше разумного', team.split('\n').length < office.workerRoles().length * 20);

results.push('сводка в промпте менеджера:');
const brief = abilitiesPrompt(office);
check('сводка в системном промпте', pmPrompt(office, true).includes(brief.trim()));
check('figcraft в сводке с подписью', brief.includes(`- ${designer.id}: MCP figcraft (${about})`));
check('правило «сначала сверься, потом спрашивай»', brief.includes('сначала сверься с этой сводкой и list_team'));
const roleLines = brief.split('\n').filter((l) => l.startsWith('- '));
check('не больше строки на роль', roleLines.length <= office.workerRoles().length);
check('роль без серверов в сводку не идёт', !roleLines.some((l) => l.startsWith(`- ${plain.id}:`)));
unloadOfficeState('o-abilities');

results.push('тексты на готовых данных:');
const say = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) => t('ru', key, vars);
const empty: RoleAbilities = { package: null, packageAbout: '', servers: [], skills: [], plugins: [] };
check('пустая роль: блок в одну строку', abilitiesBlock(empty, say).split('\n').length === 1);
check('пустая роль: строки сводки нет', abilitiesLine('x', empty, say) === '');
const none = abilitiesBrief([{ id: 'x', abilities: empty }], say);
check('ничего не подключено — сводка с правилом и пометкой «ни у одной роли»',
  none.includes(say('prompt.pm.abilitiesNone')) && none.includes('сначала сверься'));
const rich: RoleAbilities = {
  package: '@office/designer@0.3.0',
  packageAbout: 'Дизайнер интерфейсов.',
  servers: DEFAULT_MCP_SERVERS.map((s) => ({ id: s.id, about: mcpAbout(s, 'ru') })),
  skills: Array.from({ length: 30 }, (_, i) => ({ name: `figma:skill-${i}`, about: `Навык ${i}.`, builtin: false }))
    .concat({ name: 'dataviz', about: '', builtin: true }),
  plugins: ['figma'],
};
const block = abilitiesBlock(rich, say);
check('пакет с версией и описанием', block.includes('пакет @office/designer@0.3.0 — Дизайнер интерфейсов.'));
check('скил с описанием', block.includes('скил figma:skill-0 — Навык 0.'));
check('встроенный скил помечен', block.includes('скил dataviz — встроенный'));
check('плагины по именам', block.includes('плагины: figma'));
check('по строке на сервер и скил', block.split('\n').length === 1 + 1 + rich.servers.length + rich.skills.length + 1);
const line = abilitiesLine('designer', rich, say);
check(`строка сводки не длиннее ${BRIEF_LINE_MAX}`, line.length <= BRIEF_LINE_MAX && !line.includes('\n'));
const many = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, abilities: rich }));
const big = abilitiesBrief(many, say);
check('сводка 12 ролей: строк ≤ роли + шапка и правило', big.split('\n').length <= 12 + 5);
check('сводка 12 ролей: не больше ~4 КБ', big.length <= 12 * BRIEF_LINE_MAX + 1000);

rmSync(base, { recursive: true, force: true });
console.log(results.join('\n'));
const failed = results.filter((l) => l.includes('❌')).length;
console.log(failed ? `\n❌ провалено: ${failed}` : '\n✅ всё прошло');
process.exit(failed ? 1 : 0);
