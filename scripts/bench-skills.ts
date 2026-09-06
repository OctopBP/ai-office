/**
 * Стенд: срабатывают ли скилы базовой роли. `npm run bench -- design [n]`
 *
 * Случаи лежат в пакете роли — `packages/@office/<роль>/bench/cases.json`.
 * Сам прогон — в `src/server/bench.ts`; для пакета вне репозитория тот же
 * стенд запускает `office-agent bench <папка>`.
 */
import { formatOutcome, readBenchCases, runBenchCase } from '../src/server/bench';
import { externalMcp, DEFAULT_MCP_SERVERS } from '../src/server/mcp';
import { loadPackage } from '../src/server/packages';
import { basePackageName, defaultRole } from '../src/server/roles';
import { employeeSkills } from '../src/server/skills';
import type { Lang } from '../src/shared/i18n';
import type { Settings } from '../src/shared/types';

const roleId = process.argv[2] ?? 'design';
/** Номер случая, если нужен один: прогон стоит денег, и повторять всё незачем. */
const only = process.argv[3] ? Number(process.argv[3]) : null;
const lang: Lang = 'ru';

const pkg = loadPackage(basePackageName(roleId));
const role = defaultRole(roleId, lang);
if (!pkg || !role) {
  console.error(`Пакета @office/${roleId} нет среди встроенных.`);
  process.exit(2);
}
const cases = readBenchCases(pkg.dir);
if (!cases.length) {
  console.error(`У пакета ${pkg.name} нет случаев: положите их в bench/cases.json.`);
  process.exit(2);
}
const skills = employeeSkills(role);
if (!skills?.length) {
  console.error(`У роли «${roleId}» нет скилов — мерить нечего.`);
  process.exit(2);
}

const settings = { mcpServers: DEFAULT_MCP_SERVERS } as Settings;
const short = (name: string): string => name.split(':').pop() ?? name;
console.log(`Стенд роли «${role.title}»`);
console.log(`  скилы:   ${skills.map(short).join(', ')}`);
console.log(`  серверы: ${Object.keys(externalMcp(settings, role)).join(', ') || '(нет)'}`);
console.log('  вызовы, кроме безопасного чтения, отклоняются — чужие данные не трогаем\n');

const picked = only ? cases.filter((_, i) => i + 1 === only) : cases;
if (!picked.length) {
  console.error(`Случая №${only} у роли нет: их ${cases.length}.`);
  process.exit(2);
}

let failed = 0;
let spent = 0;
for (const c of picked) {
  const outcome = await runBenchCase(role, c, { lang, settings });
  if (!outcome.ok) failed += 1;
  spent += outcome.costUsd;
  console.log(formatOutcome(outcome));
}
console.log(failed
  ? `провалено случаев: ${failed} из ${picked.length}, потрачено $${spent.toFixed(4)}`
  : `все ${picked.length} прошли, потрачено $${spent.toFixed(4)}`);
process.exit(failed ? 1 : 0);
