/**
 * Стенд: срабатывают ли скилы роли. `npm run bench -- design`
 *
 * Скил живёт не тем, что он написан, а тем, что модель открывает его вовремя.
 * Проверить это вычиткой нельзя: срабатывание решает описание в заголовке
 * SKILL.md, и понять, ловит ли оно нужные запросы и не ловит ли лишние, можно
 * только прогоном. Отсюда и стенд — самая дешёвая его форма.
 *
 * Что он меряет: на типовом запросе роли — какие скилы модель открыла, какие
 * инструменты попыталась вызвать, сколько ходов и денег ушло. Чего он НЕ
 * меряет: получилась ли работа. Для этого нужна настоящая задача и открытые
 * приложения за мостами.
 *
 * Прогон стоит денег: это живые сессии. Ходов на случай немного, но случаев
 * несколько — считайте центы, а не доли цента.
 *
 * ЧУЖИХ ДАННЫХ СТЕНД НЕ ТРОГАЕТ. Роль получает свои настоящие серверы, а
 * значит и мост в открытый файл Figma, — поэтому каждый вызов проходит через
 * наш же классификатор рисков, и всё, кроме безопасного чтения, отклоняется.
 * Отказ виден в отчёте: попытка вызвать `create_frame` — это тоже результат,
 * и она не должна стоить пользователю изменённого макета.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { externalMcp, mcpBrief } from '../src/server/mcp';
import { classify } from '../src/server/permissions';
import { defaultRole, type Role } from '../src/server/roles';
import { employeePlugins, employeeSkills, sessionTools } from '../src/server/skills';
import { t } from '../src/server/i18n';
import { DEFAULT_MCP_SERVERS } from '../src/server/mcp';
import type { Lang } from '../src/shared/i18n';
import type { Settings } from '../src/shared/types';

/** Случай стенда: запрос роли и чего мы от него ждём. */
interface Case {
  what: string;
  prompt: string;
  /** Скилы, которые обязаны открыться. */
  expect: string[];
  /** Скилы, которых здесь быть не должно: срабатывание не по делу тоже дефект. */
  avoid?: string[];
}

const CASES: Record<string, Case[]> = {
  design: [
    {
      what: 'просят собрать экран',
      prompt: 'Собери в Figma экран настроек: заголовок, три поля ввода и кнопку «Сохранить».',
      expect: ['figma-screen'],
    },
    {
      what: 'спрашивают про цвета и отступы',
      prompt: 'Какие цвета и отступы взять для карточки товара, чтобы она не выбивалась из файла?',
      expect: ['figma-tokens'],
    },
    {
      what: 'работа без Figma вообще',
      prompt: 'Запиши в отчёте, из каких трёх экранов состоит онбординг. Ничего рисовать не надо.',
      expect: [],
      // Скил в контексте каждой сессии стоит денег; открывать его на вопрос,
      // где он не нужен, — это налог, а не помощь.
      avoid: ['figma-screen', 'figma-tokens'],
    },
  ],
};

const roleId = process.argv[2] ?? 'design';
/** Номер случая, если нужен один: прогон стоит денег, и повторять всё незачем. */
const only = process.argv[3] ? Number(process.argv[3]) : null;
const lang: Lang = 'ru';
const cases = CASES[roleId];
if (!cases) {
  console.error(`Для роли «${roleId}» случаев не заведено. Есть: ${Object.keys(CASES).join(', ')}`);
  process.exit(2);
}
const role: Role | undefined = defaultRole(roleId, lang);
if (!role) {
  console.error(`Роли «${roleId}» нет среди базовых.`);
  process.exit(2);
}

/** Настройки офиса стенду нужны одним полем — каталогом серверов. */
const settings = { mcpServers: DEFAULT_MCP_SERVERS } as Settings;

const skills = employeeSkills(role);
if (!skills?.length) {
  console.error(`У роли «${roleId}» нет пакета со скилами — мерить нечего.`);
  process.exit(2);
}

const short = (name: string): string => name.split(':').pop() ?? name;

console.log(`Стенд роли «${role.title}»`);
console.log(`  скилы:   ${skills.map(short).join(', ')}`);
console.log(`  серверы: ${Object.keys(externalMcp(settings, role)).join(', ') || '(нет)'}`);
console.log('  вызовы, кроме безопасного чтения, отклоняются — чужие данные не трогаем\n');

let failed = 0;
let spent = 0;

const picked = only ? cases.filter((_, i) => i + 1 === only) : cases;
if (!picked.length) {
  console.error(`Случая №${only} у роли нет: их ${cases.length}.`);
  process.exit(2);
}

for (const c of picked) {
  const opened = new Set<string>();
  const called: string[] = [];
  const denied: string[] = [];
  let turns = 0;
  let cost = 0;

  const session = query({
    prompt: c.prompt,
    options: {
      model: role.model,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        // Тот же системный промпт, что у исполнителя, минус бриф проекта:
        // он про конкретный офис, а на срабатывание скила не влияет.
        append: [t(lang, 'prompt.worker.system', { role: role.title }), role.brief].join('\n')
          + mcpBrief(settings, role, lang),
      },
      cwd: process.cwd(),
      tools: sessionTools(role),
      plugins: employeePlugins(role),
      skills,
      mcpServers: externalMcp(settings, role),
      permissionMode: 'default',
      canUseTool: async (toolName, input) => {
        const verdict = classify(toolName, input, process.cwd(), lang);
        if (verdict.risk === 'safe') return { behavior: 'allow', updatedInput: input };
        denied.push(toolName);
        return { behavior: 'deny', message: 'Стенд: меняющие вызовы здесь запрещены.' };
      },
      settingSources: [],
      // Скил открывается на первом-втором ходу; дальше платить незачем.
      maxTurns: 4,
    },
  });

  // Потолок ходов SDK отдаёт исключением, а для стенда это обычный исход:
  // скил открывается на первом-втором ходу, и упереться в потолок — значит
  // «работал дальше», а не «сорвалось». Ронять из-за этого прогон нельзя:
  // остальные случаи остались бы непроверенными.
  let stopped = '';
  try {
    for await (const msg of session) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type !== 'tool_use') continue;
          called.push(block.name);
          if (block.name === 'Skill') {
            const asked = (block.input as { command?: string; skill?: string; name?: string });
            opened.add(short(String(asked.command ?? asked.skill ?? asked.name ?? '?')));
          }
        }
        turns += 1;
      }
      if (msg.type === 'result') cost = (msg as { total_cost_usd?: number }).total_cost_usd ?? 0;
    }
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    stopped = /maximum number of turns/i.test(text) ? `дошёл до потолка ходов (${4})` : text;
  }
  spent += cost;

  const missing = c.expect.filter((s) => !opened.has(s));
  const extra = (c.avoid ?? []).filter((s) => opened.has(s));
  const ok = !missing.length && !extra.length;
  if (!ok) failed += 1;

  console.log(`${ok ? '  ok  ' : '  FAIL'} ${c.what}`);
  console.log(`       открыл скилы: ${[...opened].join(', ') || '(ни одного)'}`);
  // Именно попытки: инструмент не из набора роли CLI отсекает сам, до
  // нашего обработчика разрешений, — и в отчёте это тоже полезно видеть.
  console.log(`       пробовал звать: ${[...new Set(called)].join(', ') || '(ни одного)'}`);
  if (denied.length) console.log(`       отклонено:    ${[...new Set(denied)].join(', ')}`);
  if (missing.length) console.log(`       не открыл, а должен был: ${missing.join(', ')}`);
  if (extra.length) console.log(`       открыл зря: ${extra.join(', ')}`);
  if (stopped) console.log(`       остановился: ${stopped}`);
  console.log(`       ходов ${turns}, $${cost.toFixed(4)}\n`);
}

console.log(failed
  ? `провалено случаев: ${failed} из ${picked.length}, потрачено $${spent.toFixed(4)}`
  : `все ${picked.length} прошли, потрачено $${spent.toFixed(4)}`);
process.exit(failed ? 1 : 0);
