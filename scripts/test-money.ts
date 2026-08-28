/**
 * Доска расходов: лимиты плана и расход задачи по дням. Без единого токена —
 * события `rate_limit_event` подделываем руками, расход складываем напрямую.
 *
 * Проверяется ровно то, на чём доска врёт незаметно: проценты и время сброса,
 * приехавшие в чужих единицах; окно неизвестного типа, приписанное к чужой
 * шкале; и задача из старого сохранения, у которой журнала по дням ещё нет.
 *
 * Запуск: npm run test:money
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Файл лимитов вычисляется от файла состояния на импорте модуля — значит,
// увести его в свою папку надо ДО импорта, иначе прогон прочитает и затрёт
// настоящий кеш лимитов пользователя. Отсюда динамические импорты: обычные
// поднялись бы выше этих строк.
const dir = mkdtempSync(resolve(tmpdir(), 'office-money-'));
const stateFile = resolve(dir, 'state.json');
process.env.OFFICE_STATE_FILE = stateFile;
process.env.OFFICE_LANG = 'ru';

const { limitsView, noteRateLimit, noteUsageReport } = await import('../src/server/limits');
const { openOfficeState, toTaskView } = await import('../src/server/state');
const { flush } = await import('../src/server/store');
const { dayKey, emptyUsage } = await import('../src/shared/types');

const results: string[] = [];

// ---------- лимиты плана ----------

results.push(`до первого события лимитов нет: ${limitsView().available === false}`);

// Живое событие выглядит так: доля окна от нуля до единицы и время сброса в
// секундах. Принять 0.81 за 0.81%, а секунды за миллисекунды — значит
// показать почти полное окно пустым, а сброс — в 1970 году.
const inTwoHours = Date.now() + 2 * 60 * 60 * 1000;
const firstChanged = noteRateLimit({
  status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.81,
  resetsAt: Math.floor(inTwoHours / 1000),
});
const afterFirst = limitsView();
const fiveHour = afterFirst.windows[0];
results.push(
  `первое событие меняет картинку: ${firstChanged}`,
  `лимиты стали известны: ${afterFirst.available === true}`,
  `окно одно и то самое: ${afterFirst.windows.length === 1 && fiveHour.kind === 'five_hour'}`,
  `доля стала процентами: ${Math.abs(fiveHour.utilization - 81) < 1e-9}`,
  `секунды превратились в миллисекунды: ${
    fiveHour.resetsAt !== null && Math.abs(fiveHour.resetsAt - inTwoHours) < 1000}`,
);

// То же самое второй раз — в UI слать нечего: событие прилетает на каждый
// ответ модели, а цифры меняются куда реже.
results.push(`повтор того же события ничего не меняет: ${noteRateLimit({
  status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.81,
  resetsAt: Math.floor(inTwoHours / 1000),
}) === false}`);

// Недельное окно — уже в миллисекундах и уже процентами: соседний вызов SDK
// за теми же цифрами отдаёт их так, и шкала обязана пережить такую замену.
const inThreeDays = Date.now() + 3 * 24 * 60 * 60 * 1000;
noteRateLimit({
  status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 42, resetsAt: inThreeDays,
});
const both = limitsView();
results.push(
  `миллисекунды остались собой: ${both.windows[1].resetsAt === inThreeDays}`,
  `проценты остались процентами: ${both.windows[1].utilization === 42}`,
  `порядок окон от короткого к длинному: ${
    both.windows[0].kind === 'five_hour' && both.windows[1].kind === 'seven_day'}`,
);

// Полное окно приходит единицей, а не сотней, и оно же — потолок шкалы.
noteRateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day_opus', utilization: 1 });
const full = limitsView().windows.find((w) => w.kind === 'seven_day_opus');
results.push(`полное окно — это сто процентов: ${full?.utilization === 100}`);

// Окно неизвестного типа приписать к чужой шкале нельзя — лучше не показать
// ничего, чем показать чужие проценты под знакомой подписью.
const unknownChanged = noteRateLimit({
  status: 'allowed_warning', rateLimitType: 'ten_year', utilization: 0.07,
});
results.push(
  `неизвестное окно не считается изменением: ${unknownChanged === false}`,
  `и не заводит своей шкалы: ${limitsView().windows.length === 3}`,
);

// Отказ по лимиту — это изменение, даже если проценты те же.
const rejected = noteRateLimit({ status: 'rejected' });
const afterReject = limitsView();
results.push(
  `отказ по лимиту виден: ${rejected === true && afterReject.status === 'rejected'}`,
  `время последних цифр известно: ${afterReject.updatedAt !== null}`,
);

// ---------- полная картина лимитов ----------

// Ответ /usage устроен иначе, чем событие: проценты в нём задокументированы
// как 0–100, время сброса — строкой ISO, а ключей больше, чем офис знает.
// Пятичасовое окно берётся только отсюда: событиями приезжает лишь то окно,
// в которое упираются сейчас, и на подписке это обычно недельное.
const reportChanged = noteUsageReport({
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 99, resets_at: '2026-08-28T16:39:59.571412+00:00' },
    seven_day: { utilization: 85, resets_at: '2026-08-30T09:59:59.571445+00:00' },
    seven_day_opus: null,
    // Ключей в ответе больше, чем окон у офиса, и устроены они по-разному:
    // чужое не должно превратиться в шкалу с непонятной подписью.
    nimbus_quill: { utilization: 0, resets_at: null },
    extra_usage: { is_enabled: false, monthly_limit: 0, used_credits: 0, utilization: null },
  },
});
const afterReport = limitsView();
const fh = afterReport.windows.find((w) => w.kind === 'five_hour');
const sd = afterReport.windows.find((w) => w.kind === 'seven_day');
results.push(
  `полная картина меняет шкалы: ${reportChanged}`,
  `пятичасовое окно приехало: ${fh?.utilization === 99}`,
  `строка ISO разобрана в дату: ${
    fh?.resetsAt === Date.parse('2026-08-28T16:39:59.571412+00:00')}`,
  `проценты из ответа не считаются долей: ${sd?.utilization === 85}`,
  `план запомнен: ${afterReport.plan === 'max'}`,
  // Три шкалы — те же, что были до ответа: пятичасовая и недельная в нём
  // обновились, а `nimbus_quill`, `extra_usage` и пустое окно Opus новых не
  // завели.
  `чужие ключи ответа шкалами не стали: ${afterReport.windows.length === 3}`,
);

// Проценты меньше единицы в этом ответе — это доли процента, а не доля окна:
// принять 0.5 за половину лимита значило бы напугать на ровном месте.
noteUsageReport({
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 0.5, resets_at: null } },
});
const tiny = limitsView().windows.find((w) => w.kind === 'five_hour');
results.push(`полпроцента остались полупроцентом: ${tiny?.utilization === 0.5}`);

// Ключ API: лимитов плана нет, и шкалам взяться неоткуда.
const apiKeyReport = noteUsageReport({ rate_limits_available: false, rate_limits: null });
results.push(`ответ без лимитов плана ничего не меняет: ${apiKeyReport === false}`);

// ---------- расход задачи по дням ----------

const office = openOfficeState({ id: 'o-money', projectDir: dir, stateFile }).state;
const task = office.createTask({
  title: 'счёт за день', description: '', criteria: [], roleId: 'backend',
});
const inst = office.instances.get('backend#1')!;
inst.currentTaskId = task.id;
office.addUsage('backend#1', {
  costUsd: 0.25, tokensIn: 1000, tokensOut: 200, cacheRead: 9000, cacheWrite: 500,
});
office.addUsage('backend#1', {
  costUsd: 0.25, tokensIn: 1000, tokensOut: 200, cacheRead: 9000, cacheWrite: 500,
});
const view = toTaskView(task);
results.push(
  `расход задачи за сегодня: ${view.today.costUsd === 0.5}`,
  `и он же за всё время: ${view.usage.costUsd === 0.5}`,
  `в журнале задачи ровно один день: ${Object.keys(task.daily).length === 1}`,
);

// Сохранение, сделанное до доски расходов, журнала по дням не знает. Такое
// приходится читать как есть: задача без `daily` не должна ронять офис на
// первом же ответе модели.
flush(stateFile);
const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as {
  tasks: Array<Record<string, unknown>>;
};
for (const t of saved.tasks) delete t.daily;
writeFileSync(stateFile, JSON.stringify(saved, null, 2), 'utf8');

const reopened = openOfficeState({ id: 'o-money-old', projectDir: dir, stateFile }).state;
const old = reopened.tasks.get(task.id)!;
const oldInst = reopened.instances.get('backend#1')!;
oldInst.currentTaskId = old.id;
let survived = true;
try {
  reopened.addUsage('backend#1', {
    costUsd: 0.1, tokensIn: 10, tokensOut: 5, cacheRead: 0, cacheWrite: 0,
  });
} catch {
  survived = false;
}
results.push(
  `задача из старого сохранения не роняет расход: ${survived}`,
  `и снова копит день: ${toTaskView(old).today.costUsd === 0.1}`,
  `а общая сумма задачи не потерялась: ${Math.abs(old.usage.costUsd - 0.6) < 1e-9}`,
);

// ---------- расход в списке офисов ----------

// Главное меню сравнивает офисы между собой, и цифры для этого берутся из
// той же сводки, что и «в работе»/«ждёт слияния», — в том числе по офисам,
// которые в этом процессе никто не открывал.
const { summarize, emptyActivity } = await import('../src/server/activity');
const spend = (cost: number) => ({ ...emptyUsage(), costUsd: cost });
const summary = summarize({
  tasks: [],
  usage: spend(12.5),
  daily: { [dayKey()]: spend(3.5), '2020-01-01': spend(9) },
});
results.push(
  `расход офиса попал в сводку: ${summary.usage.costUsd === 12.5}`,
  `за сегодня — только сегодняшний день: ${summary.today.costUsd === 3.5}`,
  `сводка без расхода — это нули, а не пусто: ${
    emptyActivity().usage.costUsd === 0 && emptyActivity().today.costUsd === 0}`,
  // Сохранения до доски расходов журнала не знают: сводка по ним обязана
  // получиться нулевой, а не отсутствующей.
  `старое сохранение сводится в нули: ${summarize({ tasks: [] }).today.costUsd === 0}`,
);

// Прошедшей считается только строка, кончающаяся на true: «не false» пропускало
// в зачёт всё, что вообще не булево, — например undefined из-за опечатки.
const failed = results.filter((r) => !r.endsWith('true'));
for (const r of results) console.log(`  ${r.endsWith('true') ? '✅' : '❌'} ${r}`);
console.log(failed.length
  ? `ПРОВАЛЕНО: ${failed.length} из ${results.length}`
  : `Все проверки прошли: ${results.length}`);
process.exit(failed.length ? 1 : 0);
