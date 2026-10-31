/**
 * Адресная регрессия T-750: ошибка до зелёного хвоста, локальный вывод,
 * код/сигнал/таймаут и сохранение диагностики в карточке гейта.
 * Запуск: node --import tsx scripts/test-диагностика-проверки.ts
 */
import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runProjectCheck } from '../src/server/checks';
import { toGateView, type PreMergeReport } from '../src/server/premerge';

const каталоги: string[] = [];
const команда = (код: string) => `exec "${process.execPath}" -e '${код}'`;
try {
  const результат = await runProjectCheck(process.cwd(), команда(
    'console.log("❌ первая ошибка TOKEN");console.log("зелёный хвост\\n".repeat(900));console.error("stderr сохранён");process.exit(7)',
  ), 'ru', { slots: false, mask: (текст) => текст.replaceAll('TOKEN', '[скрыто]') });
  const д = результат.диагностика!;
  assert.ok(д?.файлВывода);
  каталоги.push(dirname(д.файлВывода));
  assert.equal(результат.ok, false);
  assert.equal(д.кодВыхода, 7);
  assert.equal(д.сигнал, null);
  assert.equal(д.таймаут, false);
  assert.equal(д.лимитМс, 300000);
  assert.equal(д.перваяОшибка, '❌ первая ошибка [скрыто]');
  assert.ok(результат.output.startsWith('Первая ошибка: ❌ первая ошибка [скрыто]'));
  assert.ok(результат.output.includes('начало вывода отброшено'));
  assert.ok(результат.output.length < 6500, 'полный вывод не попал в промпт');
  const вывод = await readFile(д.файлВывода, 'utf8');
  assert.ok(вывод.includes('❌ первая ошибка [скрыто]'));
  assert.ok(вывод.includes('зелёный хвост\n'.repeat(900)));
  assert.ok(вывод.includes('--- stderr ---\nstderr сохранён'));
  assert.ok(!вывод.includes('TOKEN'));
  assert.equal(д.выводОбрезан, false);
  assert.equal((await stat(д.файлВывода)).mode & 0o777, 0o600);
  const проверка = { command: 'проверка', ok: false, output: результат.output, files: [], durationMs: результат.durationMs, диагностика: д };
  const карточка = toGateView({
    ok: false, message: 'сбой', checks: [проверка], failed: проверка, overlaps: [], gateMs: 1,
  } as unknown as PreMergeReport);
  assert.deepEqual(JSON.parse(JSON.stringify(карточка)).failed.диагностика, д);

  for (const [код, параметры, таймаут, сигнал] of [
    ['setInterval(()=>{},1000)', { timeoutMs: 150 }, true, 'SIGTERM'],
    ['process.kill(process.pid,"SIGTERM")', {}, false, 'SIGTERM'],
    ['setInterval(()=>{},1000)', { signal: new AbortController().signal, timeoutMs: 150 }, true, 'SIGTERM'],
  ] as const) {
    const р = await runProjectCheck(process.cwd(), команда(код), 'ru', { slots: false, ...параметры });
    assert.equal(р.ok, false);
    assert.equal(р.диагностика?.таймаут, таймаут);
    assert.equal(р.диагностика?.сигнал, сигнал);
    assert.equal(р.диагностика?.кодВыхода, null);
    assert.ok(р.диагностика?.файлВывода);
    каталоги.push(dirname(р.диагностика!.файлВывода!));
  }
  console.log('Диагностика проверки: адресная регрессия пройдена.');
} finally {
  for (const каталог of каталоги) await rm(каталог, { recursive: true, force: true });
}
