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

// ---------- лимит исчерпан: ожидание сброса и продолжение ----------

// Исполнителя отбил лимит плана. Задача не провалилась и не остановлена
// человеком — она ждёт сброса окна, и ждать должен офис, а не пользователь:
// пока сброс не наступил, никого не дёргаем и раз в час говорим, чего ждём;
// наступил — зовём менеджера, а промолчит — продолжаем сами.
const { superviseOffice, forgetLimitChecks } = await import('../src/server/supervisor');
const { setPipelineAgents } = await import('../src/server/review');
const { limitBlock } = await import('../src/server/limits');

const pmInbox: string[] = [];
setPipelineAgents({
  async review() {
    return { verdict: 'changes', text: '', reviewerId: null, error: 'здесь ревью нет' };
  },
  async rework() { return { ok: false, message: 'здесь доработки нет' }; },
  notifyPm(_state, text) { pmInbox.push(text); },
});
// Исполнители заглушены: продолжение задачи должно дойти до старта, а не до сессии.
office.dryRun = true;
office.settings.ritualsEnabled = false;
inst.currentTaskId = null;
forgetLimitChecks();

const resetSec = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
noteRateLimit({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: resetSec });
results.push(
  `отказ запоминается вместе со временем сброса: ${limitBlock()?.resetsAt === resetSec * 1000}`,
);

const halted = office.createTask({
  title: 'встала по лимиту', description: '', criteria: [], roleId: 'backend',
});
office.updateTask(halted.id, {
  status: 'blocked', assigneeId: 'backend#1', limitedAt: Date.now(), result: 'встала',
});
const waitingLines = () => office.chat.filter((c) => c.text.includes('Сброс в')).length;
await superviseOffice(office);
results.push(
  `пока сброс не наступил, офис только говорит, чего ждёт: ${waitingLines() === 1}`,
  `задачу при этом не трогает: ${office.tasks.get(halted.id)?.status === 'blocked'}`,
  `и менеджера не зовёт — его ход упёрся бы в тот же лимит: ${pmInbox.length === 0}`,
);
await superviseOffice(office);
results.push(`второй проход в тот же час молчит: ${waitingLines() === 1}`);

// Сброс наступил: SDK назвал время, и оно прошло, а новых событий ещё нет —
// они появятся только с первым запросом, который и надо решиться сделать.
noteRateLimit({
  status: 'rejected', rateLimitType: 'five_hour', utilization: 1,
  resetsAt: Math.floor(Date.now() / 1000) - 1,
});
results.push(`сброс по часам снимает отказ: ${limitBlock() === null}`);
await superviseOffice(office);
const told = office.tasks.get(halted.id)!;
results.push(
  `после сброса офис зовёт менеджера продолжить: ${
    pmInbox.some((m) => m.includes('resume_task') && m.includes(halted.id))}`,
  `и даёт ему время, а не продолжает сразу: ${told.status === 'blocked' && told.attention !== null}`,
);
await superviseOffice(office);
results.push(`второй раз подряд менеджера не зовёт: ${
  pmInbox.filter((m) => m.includes('resume_task')).length === 1}`);

// Менеджер промолчал дольше отведённого — офис продолжает задачу сам.
office.updateTask(halted.id, { attention: Date.now() - 11 * 60 * 1000 });
await superviseOffice(office);
const resumed = office.tasks.get(halted.id)!;
results.push(
  `менеджер промолчал — офис продолжил задачу сам: ${
    resumed.status !== 'blocked' && resumed.limitedAt === null}`,
  `тем же исполнителем, что её вёл: ${resumed.assigneeId === 'backend#1'}`,
  `и сказал об этом в чат: ${office.chat.some((c) => c.text.includes('продолжаю сам'))}`,
  `и менеджеру: ${pmInbox.some((m) => m.includes('продолжил её сам'))}`,
);

// Разрешённый запрос снимает отказ, даже если названный срок сброса не прошёл.
noteRateLimit({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: resetSec });
noteRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1 });
results.push(`разрешённый запрос снимает отказ раньше срока: ${limitBlock() === null}`);

// ---------- детализация трат ----------

// Накопители отвечают «сколько», детализация — «на что и когда». Проверяется
// то, на чём она врёт незаметно: потерянное поле записи, свёртка, съедающая
// деньги, и постраничность, у которой агрегаты зависят от страницы.
const {
  pageSpend, foldSpend, dayStart, PAGE_SPEND, PAGE_SPEND_MAX, SPEND_MAX,
  SPEND_RAW_DAYS, SPEND_KEEP_DAYS,
} = await import('../src/server/spend');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const spDir = mkdtempSync(resolve(tmpdir(), 'office-spend-'));
const spStateFile = resolve(spDir, 'state.json');
const spOffice = openOfficeState({ id: 'o-spend', projectDir: spDir, stateFile: spStateFile }).state;
const spTask = spOffice.createTask({
  title: 'траты по времени', description: '', criteria: [], roleId: 'backend',
});
const spInst = spOffice.instances.get('backend#1')!;
spInst.currentTaskId = spTask.id;

spOffice.addUsage('backend#1', {
  costUsd: 0.4, tokensIn: 120, tokensOut: 30, cacheRead: 900, cacheWrite: 10,
}, 'claude-opus-5');
const spFirst = spOffice.spendList()[0];
results.push(
  `трата легла отдельной записью: ${spOffice.spendList().length === 1}`,
  `у записи есть момент времени: ${typeof spFirst?.at === 'number' && spFirst.at > 0}`,
  `и офис: ${spFirst?.office === 'o-spend'}`,
  `и задача: ${spFirst?.taskId === spTask.id}`,
  `и роль с исполнителем: ${spFirst?.roleId === 'backend' && spFirst.instanceId === 'backend#1'}`,
  `и модель, как её назвал SDK: ${spFirst?.model === 'claude-opus-5'}`,
  `и токены с суммой: ${spFirst?.usage.tokensIn === 120 && spFirst.usage.tokensOut === 30
    && spFirst.usage.cacheRead === 900 && spFirst.usage.costUsd === 0.4}`,
);

// SDK модель не назвал — колонку заполняет роль: это хуже точного ответа, но
// лучше пустого места.
spOffice.addUsage('backend#1', {
  costUsd: 0.2, tokensIn: 50, tokensOut: 10, cacheRead: 0, cacheWrite: 0,
});
const spRoleModel = spOffice.role('backend')?.model ?? null;
results.push(`без модели от SDK берётся модель роли: ${
  spOffice.spendList()[1]?.model === spRoleModel && spRoleModel !== null}`);

// Ход, который ничего не стоил, строкой не становится: таких результатов SDK
// присылает немало, и нули только разбавляли бы таблицу.
const spBeforeEmpty = spOffice.spendList().length;
spOffice.addUsage('backend#1', emptyUsage());
results.push(`нулевая трата записи не заводит: ${spOffice.spendList().length === spBeforeEmpty}`);

// Разговор с менеджером и ритуалы идут вне задачи — деньги на них уходят те же.
spInst.currentTaskId = null;
spOffice.addUsage('backend#1', {
  costUsd: 0.05, tokensIn: 5, tokensOut: 1, cacheRead: 0, cacheWrite: 0,
}, 'claude-haiku-4-5-20251001');
results.push(`трата вне задачи тоже записана: ${
  spOffice.spendList().length === 3 && spOffice.spendList()[2]?.taskId === null}`);

// ---------- маршрут GET /api/spend ----------

// Время трат расставляем руками: иначе все три попадут в один час и проверить
// шаг группировки будет нечем. Полдень сегодняшних суток взят опорой, чтобы
// прогон в 23:50 не перекинул часть записей на завтра.
const spNoon = dayStart(Date.now()) + 12 * HOUR_MS;
const spAsked = spNoon + 30 * 60 * 1000;
spOffice.spendList()[0]!.at = spNoon - 2 * HOUR_MS;
spOffice.spendList()[1]!.at = spNoon + 10 * 60 * 1000;
spOffice.spendList()[2]!.at = spNoon + 20 * 60 * 1000;

// Параметры приходят из URL строками — так их и подаём.
const spPage1 = pageSpend(spOffice, { step: 'hour', limit: '2' }, spAsked);
results.push(
  `страница отдаёт столько строк, сколько попросили: ${spPage1.items.length === 2}`,
  `от свежих к старым: ${spPage1.items[0]?.id === 'S-3' && spPage1.items[1]?.id === 'S-2'}`,
  `есть чем спросить следующую: ${spPage1.hasMore && spPage1.nextCursor === 'S-2'}`,
  `строк в периоде всего три: ${spPage1.rows === 3}`,
  `итог считается по периоду, а не по странице: ${Math.abs(spPage1.total.costUsd - 0.65) < 1e-9}`,
  `часовых интервалов два: ${spPage1.buckets.length === 2}`,
  `свежий интервал первый, и в нём две записи: ${
    spPage1.buckets[0]?.entries === 2 && Math.abs(spPage1.buckets[0].usage.costUsd - 0.25) < 1e-9}`,
);

const spPage2 = pageSpend(spOffice, { step: 'hour', limit: '2', cursor: spPage1.nextCursor }, spAsked);
results.push(
  `по курсору приходит остаток: ${spPage2.items.length === 1 && spPage2.items[0]?.id === 'S-1'}`,
  `и он последний: ${spPage2.hasMore === false && spPage2.nextCursor === null}`,
  `агрегаты от страницы не зависят: ${spPage2.buckets.length === 2 && spPage2.rows === 3}`,
);

const spByDay = pageSpend(spOffice, { step: 'day' }, spAsked);
results.push(`шаг в сутки сводит всё в один интервал: ${
  spByDay.buckets.length === 1 && spByDay.buckets[0]?.entries === 3}`);

const spNarrow = pageSpend(spOffice, { from: String(spNoon), to: String(spAsked), step: 'hour' }, spAsked);
results.push(`период отсекает то, что было раньше: ${spNarrow.rows === 2 && spNarrow.from === spNoon}`);

// Перепутанные местами границы меняются обратно: пустой период молча — это
// «трат нет», и человек поверит.
const spSwapped = pageSpend(spOffice, { from: String(spAsked), to: String(spNoon), step: 'hour' }, spAsked);
results.push(`перепутанные границы меняются обратно: ${spSwapped.rows === 2}`);

// Мусор в параметрах — не повод падать: худшее, что он может сделать, — это
// вернуть период и страницу по умолчанию.
const spJunk = pageSpend(
  spOffice, { from: 'вчера', to: '', step: 'век', limit: '-5', cursor: 'нет такого' }, spAsked,
);
results.push(
  `мусор в параметрах выдачу не роняет: ${spJunk.rows === 3}`,
  `и приводится к умолчаниям: ${spJunk.step === 'day' && spJunk.limit === PAGE_SPEND}`,
);
results.push(`больше предела за раз не отдаём: ${
  pageSpend(spOffice, { limit: '100000' }, spAsked).limit === PAGE_SPEND_MAX}`);

// ---------- свёртка и предел хранения ----------

const spNow = Date.now();
const spEntry = (seq: number, at: number, extra: Partial<{ taskId: string | null; model: string | null }> = {}) => ({
  id: `S-${seq}`,
  at,
  office: 'o-spend',
  taskId: 'T-1' as string | null,
  roleId: 'backend',
  instanceId: 'backend#1',
  model: 'claude-opus-5' as string | null,
  usage: { costUsd: 1, tokensIn: 10, tokensOut: 2, cacheRead: 0, cacheWrite: 0 },
  ...extra,
});
const spOldDay = spNow - (SPEND_RAW_DAYS + 3) * DAY_MS;
const spFolded = foldSpend([
  spEntry(1, spOldDay),
  spEntry(2, spOldDay + HOUR_MS),
  spEntry(3, spOldDay + 2 * HOUR_MS),
  // Та же дата, но другая задача: свёртка посуточная, а не «всё в одну кучу».
  spEntry(4, spOldDay + 3 * HOUR_MS, { taskId: 'T-2' }),
  // Старше срока хранения — такому в файле состояния делать нечего.
  spEntry(5, spNow - (SPEND_KEEP_DAYS + 5) * DAY_MS),
  spEntry(6, spNow - HOUR_MS),
], spNow);
const spRolled = spFolded.find((e) => e.id === 'S-1');
results.push(
  `свёртка оставила три записи из шести: ${spFolded.length === 3}`,
  `траты одних суток по одной задаче слились: ${spRolled?.rolled === 3}`,
  `и деньги при этом не потерялись: ${spRolled?.usage.costUsd === 3 && spRolled.usage.tokensIn === 30}`,
  `свёрнутая запись встала на полночь своих суток: ${spRolled?.at === dayStart(spOldDay)}`,
  `у соседней задачи своя свёртка: ${
    spFolded.find((e) => e.taskId === 'T-2')?.rolled === 1}`,
  `запись старше срока хранения выброшена: ${!spFolded.some((e) => e.id === 'S-5')}`,
  `свежая осталась детальной: ${spFolded.find((e) => e.id === 'S-6')?.rolled === undefined}`,
  `порядок по номеру записи сохранился: ${
    spFolded.map((e) => e.id).join() === 'S-1,S-4,S-6'}`,
);

// Свёртка по дате не спасёт от аномального потока записей за одни сутки —
// на этот случай есть жёсткий предел, и режет он самые старые.
const spFlood = foldSpend(
  Array.from({ length: SPEND_MAX + 10 }, (_, i) => spEntry(i + 1, spNow - HOUR_MS)), spNow,
);
results.push(`жёсткий предел режет самые старые: ${
  spFlood.length === SPEND_MAX && spFlood[0]?.id === 'S-11'}`);

// ---------- перезапуск ----------

flush(spStateFile);
const spSaved = JSON.parse(readFileSync(spStateFile, 'utf8')) as { spend?: unknown[]; spendSeq?: number };
results.push(
  `траты попали в файл состояния: ${spSaved.spend?.length === 3}`,
  `и счётчик номеров вместе с ними: ${spSaved.spendSeq === 3}`,
);

const spBack = openOfficeState({ id: 'o-spend-again', projectDir: spDir, stateFile: spStateFile }).state;
const spBackFirst = spBack.spendList()[0];
results.push(
  `траты пережили перезапуск: ${spBack.spendList().length === 3}`,
  `вместе с задачей и моделью: ${
    spBackFirst?.taskId === spTask.id && spBackFirst.model === 'claude-opus-5'}`,
);
spBack.instances.get('backend#1')!.currentTaskId = null;
spBack.addUsage('backend#1', {
  costUsd: 0.01, tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0,
});
results.push(`после перезапуска номера продолжаются, а не начинаются заново: ${
  spBack.spendList()[3]?.id === 'S-4'}`);

// Сохранение, сделанное до детализации, трат не знает: такое надо читать как
// есть, а не падать на отсутствующем поле.
const spNoField = { ...spSaved };
delete spNoField.spend;
delete spNoField.spendSeq;
writeFileSync(spStateFile, JSON.stringify(spNoField, null, 2), 'utf8');
const spLegacy = openOfficeState({ id: 'o-spend-legacy', projectDir: spDir, stateFile: spStateFile }).state;
spLegacy.instances.get('backend#1')!.currentTaskId = null;
spLegacy.addUsage('backend#1', {
  costUsd: 0.02, tokensIn: 2, tokensOut: 1, cacheRead: 0, cacheWrite: 0,
});
results.push(`старое сохранение поднимается с пустой детализацией: ${
  spLegacy.spendList().length === 1 && spLegacy.spendList()[0]?.id === 'S-1'}`);

// Прошедшей считается только строка, кончающаяся на true: «не false» пропускало
// в зачёт всё, что вообще не булево, — например undefined из-за опечатки.
const failed = results.filter((r) => !r.endsWith('true'));
for (const r of results) console.log(`  ${r.endsWith('true') ? '✅' : '❌'} ${r}`);
console.log(failed.length
  ? `ПРОВАЛЕНО: ${failed.length} из ${results.length}`
  : `Все проверки прошли: ${results.length}`);
process.exit(failed.length ? 1 : 0);
