/**
 * Свои агенты офиса (src/server/myagents.ts, T-623): создание пакетом в
 * данных офиса, ошибки по полям, правка, «создать на основе» роли, удаление
 * и HTTP-маршруты `/api/my-agents*`.
 *
 * Офис пишет во временную папку: живое состояние не трогаем.
 *
 * Запуск: npm run test:customagents
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { MyAgentView } from '../src/shared/myagent';
import type { FieldError } from '../src/shared/types';
import {
  createFromRole, createMyAgent, deleteMyAgent, getMyAgent, handleMyAgentsHttp, listMyAgents, LOCAL_META,
  updateMyAgent, type MyAgentCtx, type MyAgentsHttpEnv,
} from '../src/server/myagents';
import { loadPackage, validatePackage } from '../src/server/packages';
import { defaultRoles, type Role } from '../src/server/roles';
import { getOffice } from '../src/server/state';

process.env.OFFICE_LANG = 'ru';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'office-myagents-'));
const state = getOffice('test-custom-agents');
state.setStateFile(join(tmp, 'o-test.json'));
const root = state.agentsDir();

const BRIEF = 'Ты геймдизайнер настольных игр: пишешь правила, считаешь баланс, готовишь карточки.';
const roles: Role[] = [];
const ctx: MyAgentCtx = { lang: 'ru', mcpIds: ['figma-bridge'], roles };
const fields = (errors: FieldError[]): string[] => errors.map((e) => e.field).sort();

/** Запрос к ручке без сети: тело — поток, ответ собирается в объект. */
async function call(method: string, url: string, body?: unknown): Promise<{ code: number; body: any }> {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  req.method = method;
  req.url = url;
  const [path, query = ''] = url.split('?');
  let code = 0;
  let text = '';
  const done = new Promise<void>((ok) => {
    const res = {
      headersSent: false,
      writeHead(c: number) { code = c; res.headersSent = true; return res; },
      end(s: string) { text = s; ok(); },
    };
    const env: MyAgentsHttpEnv = { office: () => ({ root, ctx, role: (id) => roles.find((r) => r.id === id) }) };
    assert.equal(handleMyAgentsHttp(req, res as unknown as ServerResponse, path, query, env), true);
  });
  req.end(body === undefined ? '' : JSON.stringify(body));
  await done;
  return { code, body: JSON.parse(text) };
}

try {
  let created: MyAgentView;

  await check('создание: пакет @local в данных офиса проходит валидатор', () => {
    const r = createMyAgent(root, {
      title: 'Геймдизайнер настольных игр', summary: 'Правила и баланс', emoji: '🎲', color: '#7c3aed',
      brief: BRIEF, tools: ['Read', 'Write', 'Edit'], mcp: ['figma-bridge'], zone: 'design',
      skills: [{ name: 'balance', description: 'Когда считаешь баланс', text: 'Считай ожидание выигрыша.' }],
    }, ctx);
    assert.ok(r.ok, JSON.stringify(r));
    created = r.agent;
    assert.match(created.name, /^@local\/[a-z0-9-]+$/, 'имя пакета выведено из названия');
    assert.equal(created.dir, resolve(root, '@local', created.name.split('/')[1]));
    assert.ok(created.dir.startsWith(join(tmp, 'o-test.agents')));
    assert.equal(created.version, '0.1.0');
    assert.equal(created.zone, 'design');
    assert.deepEqual(created.draft.tools, ['Read', 'Write', 'Edit']);
    assert.deepEqual(created.draft.mcp, ['figma-bridge']);
    assert.equal(created.draft.skills?.[0]?.name, 'balance');
    assert.equal(created.draft.brief, BRIEF);
    assert.ok(existsSync(join(created.dir, 'agent.json')));
    assert.ok(existsSync(join(created.dir, 'brief', 'ru.md')));
    assert.equal(JSON.parse(readFileSync(join(created.dir, LOCAL_META), 'utf8')).zone, 'design');
    assert.deepEqual(validatePackage(created.dir).filter((p) => p.level === 'error'), []);
    // Пакет грузится и тем путём, каким его найдёт роль по RoleLink.local.
    assert.equal(loadPackage(created.name, root)?.name, created.name);
    assert.equal(listMyAgents(root, ctx).length, 1);
  });

  await check('явный id; неизвестный инструмент — предупреждение, не ошибка', () => {
    const r = createMyAgent(root, { id: 'lawyer', title: 'Юрист', brief: BRIEF, tools: ['Read', 'Teleport'] }, ctx);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.agent.name, '@local/lawyer');
    assert.deepEqual(fields(r.warnings), ['tools']);
    assert.match(r.warnings[0].message, /Teleport/);
  });

  await check('повтор id и пустые поля — ошибки по полям', () => {
    const dup = createMyAgent(root, { id: 'lawyer', title: 'Юрист 2', brief: BRIEF }, ctx);
    assert.ok(!dup.ok);
    assert.deepEqual(fields(dup.errors), ['id']);
    const empty = createMyAgent(root, { title: '  ', brief: '' }, ctx);
    assert.ok(!empty.ok);
    assert.deepEqual(fields(empty.errors), ['brief', 'title']);
    assert.ok(empty.errors.every((e) => e.message.length > 0));
    const sameTitle = createMyAgent(root, { title: 'юрист', brief: BRIEF }, ctx);
    assert.ok(!sameTitle.ok);
    assert.deepEqual(fields(sameTitle.errors), ['title']);
  });

  await check('неизвестный MCP, пустой список инструментов, плохой скил — отказ по полям', () => {
    const r = createMyAgent(root, {
      title: 'Тестировщик', brief: BRIEF, mcp: ['unity'], tools: [], color: 'red',
      skills: [{ name: 'Плохое имя', description: '', text: '' }],
    }, ctx);
    assert.ok(!r.ok);
    assert.deepEqual(fields(r.errors), ['color', 'mcp', 'skills.0.name', 'skills.0.text', 'tools']);
    assert.equal(listMyAgents(root, ctx).length, 2, 'отказ ничего не пишет');
  });

  await check('правка: меняется присланное, версия растёт, id и скилы прежние', () => {
    const id = created.name.split('/')[1];
    const r = updateMyAgent(root, id, { brief: `${BRIEF} Отвечаешь кратко.`, zone: null, id: 'renamed' }, ctx);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.agent.name, created.name);
    assert.equal(r.agent.version, '0.1.1');
    assert.match(r.agent.draft.brief, /кратко/);
    assert.equal(r.agent.title, 'Геймдизайнер настольных игр');
    assert.equal(r.agent.zone, null);
    assert.equal(r.agent.draft.skills?.length, 1);
    assert.deepEqual(r.agent.draft.mcp, ['figma-bridge']);
    const bad = updateMyAgent(root, id, { title: '' }, ctx);
    assert.ok(!bad.ok);
    assert.deepEqual(fields(bad.errors), ['title']);
    assert.equal(getMyAgent(root, id, ctx)?.version, '0.1.1', 'отказ правки не трогает пакет');
    assert.ok(!updateMyAgent(root, 'nobody', { title: 'X' }, ctx).ok);
  });

  await check('«создать на основе» роли: копия её настроек плюс правки', () => {
    const source = defaultRoles('ru').find((r) => !r.isManager)!;
    assert.ok(source, 'в офисе по умолчанию есть исполнитель');
    const r = createFromRole(root, source, { title: `${source.title} для игр`, zone: 'dev' }, ctx);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.agent.title, `${source.title} для игр`);
    assert.equal(r.agent.draft.brief, source.brief.trim());
    assert.equal(r.agent.draft.isolate, source.isolate);
    assert.equal(r.agent.zone, 'dev');
    assert.deepEqual(validatePackage(r.agent.dir).filter((p) => p.level === 'error'), []);
    const manager = defaultRoles('ru').find((x) => x.isManager)!;
    const no = createFromRole(root, manager, {}, ctx);
    assert.ok(!no.ok);
    assert.deepEqual(fields(no.errors), ['roleId']);
  });

  await check('удаление: нанятого нельзя, свободного — можно', () => {
    roles.push({ ...defaultRoles('ru').find((r) => !r.isManager)!, id: 'lawyer-1',
      package: { name: '@local/lawyer', version: '0.1.0', local: root, overrides: {}, briefExtra: '' } });
    const busy = deleteMyAgent(root, 'lawyer', ctx);
    assert.ok(!busy.ok);
    assert.match(busy.errors[0].message, /lawyer-1/);
    roles.length = 0;
    const r = deleteMyAgent(root, 'lawyer', ctx);
    assert.ok(r.ok);
    assert.equal(getMyAgent(root, 'lawyer', ctx), null);
    assert.ok(!existsSync(join(root, '@local', 'lawyer')));
    assert.ok(!deleteMyAgent(root, 'lawyer', ctx).ok);
  });

  await check('HTTP: список, создание, правка, на основе, удаление', async () => {
    const list = await call('GET', '/api/my-agents');
    assert.equal(list.code, 200);
    assert.equal(list.body.agents.length, 2);

    const fail = await call('POST', '/api/my-agents', { draft: { title: '', brief: '' } });
    assert.equal(fail.code, 400);
    assert.deepEqual(fields(fail.body.errors), ['brief', 'title']);

    const made = await call('POST', '/api/my-agents', { draft: { id: 'writer', title: 'Редактор', brief: BRIEF, zone: 'docs' } });
    assert.equal(made.code, 201, JSON.stringify(made.body));
    assert.equal(made.body.agent.name, '@local/writer');
    assert.equal(made.body.agent.zone, 'docs');

    const put = await call('PUT', '/api/my-agents/writer', { patch: { summary: 'Тексты и вычитка' } });
    assert.equal(put.code, 200);
    assert.equal(put.body.agent.summary, 'Тексты и вычитка');
    assert.equal((await call('PUT', '/api/my-agents/ghost', { patch: {} })).code, 404);

    roles.push(defaultRoles('ru').find((r) => !r.isManager)!);
    const draft = await call('GET', `/api/my-agents/draft?roleId=${roles[0].id}`);
    assert.equal(draft.code, 200);
    assert.equal(draft.body.draft.title, roles[0].title);
    const from = await call('POST', '/api/my-agents/from-role', { roleId: roles[0].id, patch: { title: 'Копия по HTTP' } });
    assert.equal(from.code, 201, JSON.stringify(from.body));
    roles.length = 0;

    assert.equal((await call('DELETE', '/api/my-agents/writer')).code, 200);
    assert.equal((await call('DELETE', '/api/my-agents/writer')).code, 404);
    assert.equal((await call('GET', '/api/my-agents')).body.agents.length, 3);
    assert.equal((await call('POST', '/api/my-agents', 'не объект')).code, 400);
  });

  console.log(`\nСвои агенты: ${passed} проверок прошло`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
