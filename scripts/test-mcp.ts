// Проверка внешних MCP-серверов ролей: кому что подключается и что об этом
// сказано в промпте. npm run test:mcp
//
// Стоит проверять именно парой: сервер без строки в промпте роль не заметит, а
// строка не от той роли хуже отсутствия строки — фронтенд, которому сказано
// «делай макет в Figma», займётся не своим делом.
import { externalMcp, mcpBrief } from '../src/server/mcp';
import { defaultRole } from '../src/server/roles';
import type { Role } from '../src/server/roles';

const role = (id: string): Role => defaultRole(id, 'ru')!;

let failed = 0;
const check = (what: string, ok: boolean, got: string): void => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what.padEnd(48)} → ${got}`);
};

const servers = (r: Role): string[] => Object.keys(externalMcp(r));
const list = (r: Role): string => servers(r).join(', ') || '(нет)';

// Один сервер — два подписчика: макет рисует дизайнер, читает и фронтенд.
check('дизайнеру figma-bridge', servers(role('design')).includes('figma-bridge'), list(role('design')));
check('фронтенду тот же figma-bridge', servers(role('frontend')).includes('figma-bridge'), list(role('frontend')));
check('3D-художнику blender', servers(role('artist3d')).includes('blender'), list(role('artist3d')));
check('бэкенду ничего', servers(role('backend')).length === 0, list(role('backend')));

// Своё поле роли сильнее умолчания по id — иначе отключить сервер было бы нечем.
check('mcp: [] отключает всё', servers({ ...role('design'), mcp: [] }).length === 0,
  list({ ...role('design'), mcp: [] }));
check('неизвестное имя отбрасывается',
  servers({ ...role('design'), mcp: ['figma-bridge', 'нет-такого'] }).join() === 'figma-bridge',
  list({ ...role('design'), mcp: ['figma-bridge', 'нет-такого'] }));

// Строка в промпте — по роли, а не только по серверу.
const designBrief = mcpBrief(role('design'), 'ru');
const frontBrief = mcpBrief(role('frontend'), 'ru');
const blenderBrief = mcpBrief(role('artist3d'), 'ru');
check('дизайнеру сказано делать макет', designBrief.includes('макет ДЕЛАЙ'), `${designBrief.length} символов`);
check('фронтенду сказано не менять макет',
  frontBrief.includes('Менять макет не твоя работа'), `${frontBrief.length} символов`);
check('строки дизайнера и фронтенда разные', designBrief !== frontBrief && frontBrief.length > 0,
  designBrief === frontBrief ? 'совпали' : 'разные');
check('3D-художнику сказано про скрипт', blenderBrief.includes('tools/blender/'), `${blenderBrief.length} символов`);
check('роли без серверов — пустая строка', mcpBrief(role('backend'), 'ru') === '', '(пусто)');

console.log(failed ? `\nпровалено кейсов: ${failed}` : '\nвсе кейсы прошли');
process.exit(failed ? 1 : 0);
