/**
 * Архив офиса переживает перезапуск сервера (T-491).
 *
 * Сценарий бага: владелец убирает офис в архив, сервер перезапускается, а
 * приложение на каждом старте передаёт папку проекта в OFFICE_PROJECT_DIR —
 * и старт «находил или заводил» офис этой папки, снимая с него архив. Офис
 * возвращался в рейл сам.
 *
 * Здесь: архивируем офис, имитируем холодный старт (второй экземпляр модуля
 * реестра читает файл с диска заново) с той же папкой в окружении и проверяем,
 * что офис по-прежнему в архиве, текущим стал другой неархивный офис, а
 * явный возврат из архива по-прежнему работает.
 *
 * Запуск: npm run test:archiveboot
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

type Offices = typeof import('../src/server/offices');

const ROOT = resolve(tmpdir(), `office-archive-boot-${process.pid}`);
const STATE_FILE = resolve(ROOT, 'state.json');
const REGISTRY = resolve(ROOT, 'offices.json');
const DIR_A = resolve(ROOT, 'office');
const DIR_B = resolve(ROOT, 'other');

const results: string[] = [];
const check = (text: string, ok: boolean): void => { results.push(`${text}: ${ok}`); };

/** Холодный старт: модуль с другим адресом — своё состояние, реестр с диска. */
let restarts = 0;
async function restart(): Promise<Offices> {
  restarts += 1;
  const mod = await import(`../src/server/offices.ts?boot=${restarts}`) as Offices;
  mod.loadRegistry(DIR_A, STATE_FILE);
  return mod;
}

const onDisk = (): { currentId: string; offices: { id: string; archived?: boolean }[] } =>
  JSON.parse(readFileSync(REGISTRY, 'utf8'));

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(DIR_A, { recursive: true });
  mkdirSync(DIR_B, { recursive: true });

  // Первый запуск: офис папки из окружения и ещё один офис рядом.
  const first = await restart();
  const a = first.bootOffice({ name: 'Office', projectDir: DIR_A })!;
  check('первый старт поднял офис папки из окружения', a?.projectDir === DIR_A);
  const made = first.createOffice({ name: 'Другой', projectDir: DIR_B, mustExist: true });
  const bId = 'office' in made ? made.office.id : '';
  check('второй офис заведён', bId !== '');

  // Владелец убирает офис в архив.
  const op = first.archiveOffice(a.id);
  check('офис ушёл в архив', op.ok && first.officeArchived(a.id));
  check('в файле реестра стоит признак архива', onDisk().offices.find((o) => o.id === a.id)?.archived === true);

  // Перезапуск с той же папкой в окружении — так стартует приложение.
  for (let i = 1; i <= 3; i += 1) {
    const mod = await restart();
    const opened = mod.bootOffice({ name: 'Office', projectDir: DIR_A });
    check(`перезапуск ${i}: офис всё ещё в архиве`, mod.officeArchived(a.id));
    check(`перезапуск ${i}: архив цел и в файле`, onDisk().offices.find((o) => o.id === a.id)?.archived === true);
    check(`перезапуск ${i}: поднят другой неархивный офис`, opened?.id === bId);
    check(`перезапуск ${i}: текущим стал неархивный офис`, mod.currentOffice()?.id === bId);
    check(`перезапуск ${i}: записи-дубля той же папки нет`,
      onDisk().offices.filter((o) => o.id !== bId).length === 1);
  }

  // Повторная регистрация той же папки напрямую тоже архив не снимает.
  const again = await restart();
  const same = again.ensureOffice({ name: 'Office', projectDir: DIR_A });
  check('повторная регистрация вернула ту же запись', same.id === a.id);
  check('повторная регистрация архив не сняла', again.officeArchived(a.id));
  check('офис в архиве можно увидеть в списке (рейл показывает его в архиве)',
    again.offices().some((o) => o.id === a.id && o.archived === true));

  // Перезапуск без папки в окружении: текущим остаётся неархивный.
  const plain = await restart();
  check('старт без окружения поднимает неархивный офис', plain.bootOffice(null)?.id === bId);

  // Все офисы в архиве — старт ничего не поднимает и ничего не разархивирует.
  // Последний неархивный офис в архив не уходит, поэтому кладём признак
  // напрямую, как это делает запись реестра, правленная руками.
  plain.setOfficeArchived(bId, true);
  const allArchived = await restart();
  check('все в архиве: старт ничего не поднимает',
    allArchived.bootOffice({ name: 'Office', projectDir: DIR_A }) === null);
  check('все в архиве: архив не снят ни с одного офиса',
    onDisk().offices.every((o) => o.archived === true));
  allArchived.setOfficeArchived(bId, false);

  // Явное действие владельца — единственный путь из архива.
  const owner = await restart();
  const back = owner.unarchiveOffice(a.id);
  check('явный возврат из архива снимает признак', back.ok && !owner.officeArchived(a.id));
  const after = await restart();
  check('после возврата и перезапуска офис не в архиве', !after.officeArchived(a.id));
  check('после возврата старт с папкой поднимает этот офис',
    after.bootOffice({ name: 'Office', projectDir: DIR_A })?.id === a.id);

  rmSync(ROOT, { recursive: true, force: true });

  const failed = results.filter((r) => !r.endsWith('true'));
  for (const r of results) console.log(`  ${r.endsWith('true') ? '✅' : '❌'} ${r}`);
  if (results.length === 0) {
    console.error('не выполнено ни одной проверки — прогону верить нельзя');
    process.exit(2);
  }
  console.log(failed.length
    ? `ПРОВАЛЕНО: ${failed.length} из ${results.length}`
    : `Все проверки прошли: ${results.length}`);
  process.exit(failed.length ? 1 : 0);
}

void main().catch((err) => {
  console.error(`прогон сорвался: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(2);
});
