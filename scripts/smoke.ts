// Проверка, что Agent SDK авторизован и работает. npm run smoke
import { query } from '@anthropic-ai/claude-agent-sdk';

const t0 = Date.now();
for await (const m of query({
  prompt: 'Ответь ровно одним словом: работает',
  options: { model: 'claude-haiku-4-5', tools: [], settingSources: [], maxTurns: 1 },
})) {
  if (m.type === 'system' && m.subtype === 'init') {
    console.log('INIT ok | apiKeySource:', m.apiKeySource, '| cwd:', m.cwd);
  }
  if (m.type === 'result') {
    console.log('RESULT:', m.subtype, '|', 'result' in m ? m.result : '', '| $', m.total_cost_usd);
  }
}
console.log('elapsed ms:', Date.now() - t0);
