/**
 * Пункты `done` процессов на языке общения офиса (T-681): двуязычный пункт
 * `{ ru, en }` уходит агенту на нужном языке, старый пункт строкой — как есть
 * на любом языке. Заодно — что все базовые процессы уже двуязычные и что
 * строка вердикта из шаблонов отчёта QA на обоих языках разбирается.
 *
 * Без сети, без агентов и без живого офиса.
 * Запуск: npm run test:workflow-done-lang
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { doneList, verdictOf } from '../src/server/review';
import { doneText, parseWorkflow } from '../src/shared/workflow';

let failed = 0;
let passed = 0;
const check = (what: string, ok: boolean, detail = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? '✅' : '❌'} ${what}${ok || !detail ? '' : ` — ${detail}`}`);
};

const root = resolve(import.meta.dirname, '..');
const CYRILLIC = /[А-Яа-яЁё]/;

/** Процесс из одного шага с данными пунктами `done` — как его прочтёт офис. */
const oneStep = (done: unknown[]) => parseWorkflow({
  id: 'probe', version: 1, trigger: { on: 'task.finished' },
  nodes: [{ id: 'work', kind: 'step', needs: ['code.write'], done, next: { done: 'end' } }],
});

console.log('▶ Двуязычный пункт: язык общения выбирает текст');
{
  const wf = oneStep([
    { ru: 'Отчёт записан', en: 'The report is written' },
    { ru: 'Находки разобраны', en: 'Findings are sorted out' },
  ]);
  const node = wf.nodes[0];
  check('по-русски', doneList(node, 'ru') === '1. Отчёт записан\n2. Находки разобраны', doneList(node, 'ru'));
  check('по-английски', doneList(node, 'en') === '1. The report is written\n2. Findings are sorted out', doneList(node, 'en'));
  check('в английском списке нет кириллицы', !CYRILLIC.test(doneList(node, 'en')));
}

console.log('▶ Старый формат строкой не ломается');
{
  const wf = oneStep(['Макет согласован владельцем', 'Ещё пункт']);
  const node = wf.nodes[0];
  const want = '1. Макет согласован владельцем\n2. Ещё пункт';
  check('разбирается и отдаётся как есть по-русски', doneList(node, 'ru') === want, doneList(node, 'ru'));
  check('на английском — тот же текст, без падения', doneList(node, 'en') === want, doneList(node, 'en'));
  check('doneText для строки — сама строка', doneText('как есть', 'en') === 'как есть');
}

console.log('▶ Смесь форматов в одном узле');
{
  const node = oneStep(['Свой пункт', { ru: 'Второй', en: 'Second' }]).nodes[0];
  check('строка как есть, объект по языку', doneList(node, 'en') === '1. Свой пункт\n2. Second', doneList(node, 'en'));
}

console.log('▶ Неполный двуязычный пункт отклоняется');
{
  const rejects = (done: unknown[]) => {
    try { oneStep(done); return false; } catch { return true; }
  };
  check('без en', rejects([{ ru: 'Только русский' }]));
  check('пустой en', rejects([{ ru: 'Пункт', en: '' }]));
  check('лишний язык', rejects([{ ru: 'Пункт', en: 'Item', de: 'Punkt' }]));
}

console.log('▶ Базовые процессы workflows/*.json');
{
  const dir = resolve(root, 'workflows');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const wf = parseWorkflow(JSON.parse(readFileSync(resolve(dir, file), 'utf8')), file);
    for (const node of wf.nodes.filter((n) => n.done?.length)) {
      const where = `${file} → ${node.id}`;
      const plain = node.done!.filter((d) => typeof d === 'string');
      check(`${where}: все пункты двуязычные`, plain.length === 0, JSON.stringify(plain));
      const en = doneList(node, 'en');
      check(`${where}: английский без кириллицы`, !CYRILLIC.test(en.replace(/«Вердикт: (PASS|FAIL)»|"Вердикт: (PASS|FAIL)"/g, '')), en);
      check(`${where}: русский и английский различаются`, doneList(node, 'ru') !== en);
    }
  }
  // Шаг QA называет путь отчёта и строку вердикта на обоих языках —
  // по ним шаг и разбирается (`verdict` узла и verdictOf).
  const qa = parseWorkflow(JSON.parse(readFileSync(resolve(dir, 'feature-qa.json'), 'utf8'))).nodes
    .find((n) => n.id === 'qa')!;
  check('QA: путь отчёта прежний', qa.verdict === 'docs/qa/{task}/report.md', qa.verdict);
  for (const [lang, word] of [['ru', 'Вердикт'], ['en', 'Verdict']] as const) {
    const text = doneList(qa, lang);
    check(`QA (${lang}): путь docs/qa/ в пунктах`, text.includes('docs/qa/') && text.includes('/report.md'));
    check(`QA (${lang}): названа строка «${word}: PASS»`, text.includes(`${word}: PASS`) && text.includes(`${word}: FAIL`));
    check(`QA (${lang}): такую строку офис разбирает`,
      verdictOf(`**${word}: PASS**`) === 'pass' && verdictOf(`**${word}: FAIL**`) === 'fail');
  }
}

console.log('▶ Шаблоны отчёта QA: заголовки по языку, вердикт разбирается');
{
  const skill = resolve(root, 'packages/@office/qa/skills/qa-report');
  const read = (name: string) => readFileSync(resolve(skill, name), 'utf8');
  for (const [lang, word] of [['ru', 'Вердикт'], ['en', 'Verdict']] as const) {
    const report = read(`report.${lang}.md`);
    const criteria = read(`criteria.${lang}.md`);
    check(`report.${lang}.md: строка «${word}»`, report.includes(`**${word}: PASS | FAIL**`));
    check(`report.${lang}.md: незаполненный шаблон — не вердикт`, verdictOf(report) === null);
    check(`report.${lang}.md: заполненный PASS читается`,
      verdictOf(report.replace('PASS | FAIL', 'PASS')) === 'pass');
    check(`report.${lang}.md: заполненный FAIL читается`,
      verdictOf(report.replace('PASS | FAIL', 'FAIL')) === 'fail');
    if (lang === 'en') {
      // Уровни, PASS/FAIL и ✅/❌ не переводятся — всё прочее английское.
      check('report.en.md без кириллицы', !CYRILLIC.test(report));
      check('criteria.en.md без кириллицы', !CYRILLIC.test(criteria));
    } else {
      check(`criteria.ru.md по-русски`, CYRILLIC.test(criteria));
    }
  }
  const md = read('SKILL.md');
  check('SKILL.md: заголовки — на языке реализации', md.includes('языке реализации'));
  check('SKILL.md: ссылки на оба шаблона',
    ['report.ru.md', 'report.en.md', 'criteria.ru.md', 'criteria.en.md'].every((f) => md.includes(`](${f})`)));
  check('SKILL.md: оба варианта строки вердикта', md.includes('**Вердикт: PASS**') && md.includes('**Verdict: PASS**'));
}

console.log(failed ? `\nПровалено: ${failed} из ${passed + failed}` : `\nВсе проверки прошли: ${passed}`);
process.exit(failed ? 1 : 0);
