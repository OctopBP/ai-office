/**
 * Проверки планировщика: порядок фич, зависимости, фокус, согласие человека
 * и закрытие фичи. Всё это — чистая логика plan.ts, и гонять её сценариями
 * с живой моделью дорого, медленно и ненадёжно.
 *
 * Живых исполнителей здесь нет: раздача подменена заглушкой (setPlanAgents),
 * которая просто записывает, кого офис попытался запустить. Проверяем именно
 * решение «что отдать сейчас», а не то, как стартует сессия.
 *
 * Запуск: npm run test:plan
 */
import { getOffice, unloadOfficeState } from '../src/server/state';
import { approveEpic, cancelEpic, createPlan, dispatch, setPlanAgents } from '../src/server/plan';

// Тексты офиса сверяем по-русски — значит, и офис должен быть русским.
process.env.OFFICE_LANG = 'ru';

const office = getOffice('o-plan');

/**
 * Кого офис пытался запустить с прошлой проверки — с пометкой офиса.
 * Пометка обязательна: заглушка одна на процесс, а офисов в проверке
 * несколько, и без неё запуск в соседнем офисе засчитывался бы этому.
 */
let started: string[] = [];

/**
 * Заглушка раздачи: помечаем задачу как взятую в работу и запоминаем её.
 * Именно это делает настоящий officeAssign — с точки зрения плана важно, что
 * задача ушла из очереди, а не какой сессией она исполняется.
 */
setPlanAgents({
  assign: (state, taskId) => {
    started.push(`${state.officeId}/${taskId}`);
    state.updateTask(taskId, { status: 'in_progress', assigneeId: 'stub#1' });
    return { ok: true, message: 'stub#1' };
  },
  notifyPm: () => { /* сообщения менеджеру здесь не проверяем */ },
});

/** Довести задачу до основной ветки — так, как это делает конвейер. */
function merge(taskId: string): void {
  office.updateTask(taskId, {
    status: 'done', merged: true, branch: `task/${taskId}`, finishedAt: Date.now(),
  });
  dispatch(office);
}

/** Что запустилось в главном офисе проверки. Чужие офисы сюда не попадают. */
const took = (): string[] => {
  const list = started.filter((id) => id.startsWith('o-plan/')).map((id) => id.slice(7)).sort();
  started = [];
  return list;
};

async function main(): Promise<void> {
  office.seed();
  office.settings.planApproval = true;
  office.settings.focusEpics = 1;
  office.settings.autoPipeline = true;
  const results: string[] = [];

  // Три фичи одним планом: ровно тот случай, ради которого всё затевалось.
  const plan = createPlan(office, [
    {
      title: 'Заметки',
      goal: 'Пользователь может вести заметки',
      tasks: [
        {
          key: 'api', title: 'API заметок', description: 'CRUD',
          acceptanceCriteria: ['роуты есть'], roleId: 'backend',
        },
        {
          key: 'ui', title: 'Экран заметок', description: 'список и форма',
          acceptanceCriteria: ['экран есть'], roleId: 'frontend', dependsOn: ['api'],
        },
      ],
    },
    {
      title: 'Поиск',
      goal: 'Заметки можно искать',
      tasks: [{
        key: 'search', title: 'Поиск по заметкам', description: 'полнотекстовый',
        acceptanceCriteria: ['ищет'], roleId: 'backend',
      }],
    },
    {
      title: 'Экспорт',
      goal: 'Заметки можно выгрузить',
      tasks: [{
        key: 'export', title: 'Экспорт в markdown', description: 'выгрузка',
        acceptanceCriteria: ['выгружает'], roleId: 'backend',
      }],
    },
  ]);

  const epics = office.epicList();
  results.push(
    `план заведён: ${plan.ok}`,
    `фич на доске три: ${epics.length === 3}`,
    `порядок фич сохранён: ${epics.map((e) => e.title).join(',') === 'Заметки,Поиск,Экспорт'}`,
    `все задачи заведены плановыми: ${[...office.tasks.values()].every((t) => t.status === 'planned')}`,
  );

  // 1. Согласия нет — офис не начинает ничего, даже первую фичу.
  dispatch(office);
  results.push(
    `без «поехали» никто не работает: ${took().length === 0}`,
    `первая фича так и стоит в плане: ${office.epics.get('F-1')?.status === 'planned'}`,
  );

  // 2. Согласовали первую — пошла только та задача, у которой нет зависимостей.
  approveEpic(office, 'F-1');
  const first = took();
  results.push(
    `после согласия фича пошла в работу: ${office.epics.get('F-1')?.status === 'active'}`,
    `запущена только независимая задача: ${first.join(',') === 'T-1'}`,
    `зависимая ждёт: ${office.tasks.get('T-2')?.status === 'planned'}`,
    `фокус в единицу держит вторую фичу: ${office.epics.get('F-2')?.status === 'planned'}`,
  );

  // 3. Влили первую — созрела вторая задача той же фичи.
  merge('T-1');
  results.push(`влитая зависимость отпускает задачу: ${took().join(',') === 'T-2'}`);

  // 4. Фича закрывается сама, когда вся её работа в основной ветке, — и
  //    следующая согласованная начинается без чьей-либо команды.
  approveEpic(office, 'F-2');
  const secondBeforeMerge = office.epics.get('F-2')?.status;
  merge('T-2');
  results.push(
    `согласованная вторая ждёт, пока идёт первая: ${secondBeforeMerge === 'planned'}`,
    `первая фича закрылась сама: ${office.epics.get('F-1')?.status === 'done'}`,
    `освободившееся место занято второй: ${office.epics.get('F-2')?.status === 'active'}`,
    `её задача пошла в работу: ${took().join(',') === 'T-3'}`,
    `третья фича по-прежнему ждёт: ${office.epics.get('F-3')?.status === 'planned'}`,
  );

  // 5. Согласие человека сильнее порядка: одобренную фичу офис берёт, даже
  //    если предыдущая так и осталась без согласия.
  const jump = getOffice('o-plan-5');
  jump.seed();
  jump.settings.planApproval = true;
  jump.settings.focusEpics = 1;
  createPlan(jump, ['Первая', 'Вторая'].map((name, i) => ({
    title: name,
    goal: `цель ${name}`,
    tasks: [{
      key: `j${i}`, title: `задача ${name}`, description: 'работа',
      acceptanceCriteria: ['сделано'], roleId: 'backend',
    }],
  })));
  approveEpic(jump, 'F-2');
  results.push(
    `одобренная вторая пошла вперёд неодобренной первой: ${jump.epics.get('F-2')?.status === 'active'}`,
    `а неодобренная первая осталась в плане: ${jump.epics.get('F-1')?.status === 'planned'}`,
  );
  unloadOfficeState('o-plan-5');

  // 6. Снятая фича не раздаётся никогда — даже когда место освободилось.
  cancelEpic(office, 'F-3', 'передумали');
  merge('T-3');
  const leftovers = took();
  results.push(
    `снятая фича не начинается: ${office.epics.get('F-3')?.status === 'cancelled'}`,
    `её задачи не раздаются: ${leftovers.length === 0 && office.tasks.get('T-4')?.status === 'planned'}`,
  );

  // 7. Фокус в двойку: две фичи идут одновременно, третья ждёт.
  const wide = getOffice('o-plan-2');
  wide.seed();
  wide.settings.planApproval = false;       // согласие не спрашиваем
  wide.settings.focusEpics = 2;
  createPlan(wide, ['A', 'B', 'C'].map((name, i) => ({
    title: name,
    goal: `цель ${name}`,
    tasks: [{
      key: `k${i}`, title: `задача ${name}`, description: 'работа',
      acceptanceCriteria: ['сделано'], roleId: 'backend',
    }],
  })));
  const active = wide.epicList().filter((e) => e.status === 'active').map((e) => e.title);
  results.push(
    `без согласия план стартует сам: ${active.length === 2}`,
    `и ровно по фокусу, в порядке плана: ${active.join(',') === 'A,B'}`,
  );

  // 8. Круг в зависимостях ловится до заведения, а не превращается в две
  //    задачи, которые молча не начнутся никогда.
  const loop = getOffice('o-plan-3');
  loop.seed();
  const cycle = createPlan(loop, [{
    title: 'Круг',
    goal: 'проверка',
    tasks: [
      {
        key: 'a', title: 'A', description: 'a',
        acceptanceCriteria: ['a'], roleId: 'backend', dependsOn: ['b'],
      },
      {
        key: 'b', title: 'B', description: 'b',
        acceptanceCriteria: ['b'], roleId: 'backend', dependsOn: ['a'],
      },
    ],
  }]);
  results.push(
    `круг зависимостей отклонён: ${!cycle.ok}`,
    `и доска от него не пострадала: ${loop.tasks.size === 0 && loop.epics.size === 0}`,
  );

  // 9. Отказ на полпути не оставляет половину плана: вторая фича с неизвестной
  //    ролью роняет весь вызов, а первая не должна осесть на доске.
  const half = getOffice('o-plan-4');
  half.seed();
  const bad = createPlan(half, [
    {
      title: 'Хорошая',
      goal: 'цель',
      tasks: [{
        key: 'ok', title: 'задача', description: 'работа',
        acceptanceCriteria: ['сделано'], roleId: 'backend',
      }],
    },
    {
      title: 'Плохая',
      goal: 'цель',
      tasks: [{
        key: 'bad', title: 'задача', description: 'работа',
        acceptanceCriteria: ['сделано'], roleId: 'нет-такой-роли',
      }],
    },
  ]);
  results.push(
    `план с неизвестной ролью отклонён: ${!bad.ok}`,
    `и не завёлся наполовину: ${half.epics.size === 0 && half.tasks.size === 0}`,
  );

  unloadOfficeState('o-plan');
  unloadOfficeState('o-plan-2');
  unloadOfficeState('o-plan-3');
  unloadOfficeState('o-plan-4');

  // Прошедшей считается только строка, кончающаяся на true: строка, где вместо
  // булева оказалось undefined, — это не «не false», а несостоявшаяся проверка.
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
