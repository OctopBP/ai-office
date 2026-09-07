/**
 * Раннер прогона (docs/design/workflows/spec.md §8): ведёт задачу по узлам
 * процесса. Сам он не знает ни про git, ни про агентов — только про узлы,
 * исходы, переходы и пределы петель. Что именно делает узел, говорят
 * действия (Executor), которые передаёт хозяин процесса; сегодня это
 * конвейер ревью (review.ts).
 *
 * Прогон ведётся одним обещанием от начала до конца, а не по узлу за проход
 * надзора: минута простоя на каждом звене складывается в час на большом плане.
 * Надзор его не двигает, а перезапускает, когда он встал.
 */
import type { OfficeState } from './state';
import {
  END, STUCK, edgeKey, firstNode, loopBodies, nodeOf,
  type Run, type RunArtifact, type Workflow, type WorkflowNode,
} from '../shared/workflow';

/** Чем кончился узел. Исход — ключ в `next`; записка и артефакт — для следующих. */
export interface StepResult {
  outcome: string;
  /** Почему так: становится причиной остановки, если исход ведёт в stuck. */
  note?: string;
  /** Повторять бессмысленно — нужно решение менеджера. */
  needsDecision?: boolean;
  /** Что узел оставляет после себя; кладётся в прогон под именем `out`. */
  artifact?: RunArtifact;
  /** Кто делал шаг — для `same` и `notSameAs` следующих узлов. */
  actor?: string;
}

export interface Halt {
  note: string;
  needsDecision?: boolean;
}

/** Действие узла: что делать и что сказать, когда петля из него исчерпана. */
export interface Executor<Ctx> {
  run(ctx: Ctx): Promise<StepResult>;
  /**
   * Петля, начавшаяся в этом узле, пройдена больше `max` раз. Хозяин процесса
   * знает, как это назвать («ревьюер вернул трижды») и что прибрать.
   */
  exhausted?(ctx: Ctx, last: StepResult, count: number, max: number): Promise<Halt> | Halt;
}

export interface RunHooks<Ctx> {
  /** Контекст узла — собирается заново на каждый узел: задача могла измениться. */
  context(node: WorkflowNode): Ctx;
  /** Вошли в узел — ещё до действия. Тут хозяин показывает стадию. */
  enter?(ctx: Ctx, node: WorkflowNode): void;
  /** Переход состоялся: не в stuck и не за предел петли. */
  transition?(ctx: Ctx, from: WorkflowNode, outcome: string, to: string): void;
  /** Прогон встал. Хозяин говорит об этом офису и, если надо, менеджеру. */
  stuck(ctx: Ctx, halt: Halt): void;
}

/** Новый прогон процесса — по задаче или по самому офису, на первом узле. */
export function newRun(workflow: Workflow, subject: Run['subject'], now = Date.now()): Run {
  const who = subject.taskId ?? subject.epicId ?? subject.flow ?? 'office';
  return {
    id: `${who}/${workflow.id}`,
    workflowId: workflow.id,
    version: workflow.version,
    subject: { ...subject },
    nodeId: firstNode(workflow).id,
    from: null,
    loops: {},
    artifacts: {},
    actors: {},
    waitingOn: null,
    status: 'running',
    needsDecision: false,
    note: '',
    startedAt: now,
    updatedAt: now,
  };
}

/**
 * Снова пустить вставший прогон — с того узла, где он встал, а не с начала:
 * шаги процесса стоят денег, и переделывать сделанное ради перезапуска
 * незачем. Счётчики петель остаются: они сбрасываются сами, когда в узел
 * приходят снаружи его петли (см. loopBodies), а те, что должны пережить
 * перезапуск, — вроде кругов ревью — так и переживают.
 */
export function resumeRun(run: Run): void {
  run.status = 'running';
  run.needsDecision = false;
  run.note = '';
  run.updatedAt = Date.now();
}

/** Чем узел делается: по действию из файла или по виду узла. */
export type Resolve<Ctx> = (node: WorkflowNode) => Executor<Ctx> | undefined;

/**
 * Провести прогон от текущего узла до конца или до остановки. Остановка —
 * исход, а не ошибка: обещание разрешается. Падение действия — ошибка:
 * прогон помечается вставшим, и ошибка уходит вызывающему.
 */
export async function drive<Ctx>(
  state: OfficeState, workflow: Workflow, run: Run,
  resolve: Resolve<Ctx>, hooks: RunHooks<Ctx>,
): Promise<void> {
  const bodies = loopBodies(workflow);
  const save = () => {
    run.updatedAt = Date.now();
    state.saveRun(run);
  };
  const halt = (ctx: Ctx, why: Halt) => {
    run.status = 'stuck';
    run.needsDecision = why.needsDecision ?? false;
    run.note = why.note;
    save();
    hooks.stuck(ctx, why);
  };

  try {
    for (;;) {
      // Пауза офиса останавливает и прогон: сливать в основную ветку, пока
      // пользователь нажал «стоп всему», — ровно то, чего он не просил.
      await state.whenResumed();

      const node = nodeOf(workflow, run.nodeId);
      if (!node) {
        throw new Error(state.say('wf.badNode', { workflow: workflow.id, node: run.nodeId }));
      }
      // Пришли снаружи петли — попытки по ней считаются заново.
      for (const tr of Object.values(node.next)) {
        if (tr.max === undefined) continue;
        const key = edgeKey(node.id, tr.to);
        if (!run.from || !bodies.get(key)?.has(run.from)) run.loops[key] = 0;
      }

      const ctx = hooks.context(node);
      hooks.enter?.(ctx, node);
      const executor = resolve(node);
      if (!executor) {
        throw new Error(state.say('wf.noExecutor', { node: node.id, run: node.run ?? '' }));
      }
      run.status = 'running';
      save();

      const result = await executor.run(ctx);
      if (node.out && result.artifact) run.artifacts[node.out] = result.artifact;
      if (result.actor) run.actors[node.id] = result.actor;
      run.status = 'running';
      run.waitingOn = null;

      const tr = node.next[result.outcome];
      if (!tr) {
        throw new Error(state.say('wf.badOutcome', { node: node.id, outcome: result.outcome }));
      }
      if (tr.max !== undefined) {
        const key = edgeKey(node.id, tr.to);
        const count = (run.loops[key] ?? 0) + 1;
        run.loops[key] = count;
        if (count > tr.max) {
          const why = executor.exhausted
            ? await executor.exhausted(ctx, result, count, tr.max)
            : { note: state.say('wf.exhausted', { node: node.id, max: tr.max }) };
          return halt(ctx, why);
        }
      }
      if (tr.to === STUCK) {
        return halt(ctx, { note: result.note ?? '', needsDecision: result.needsDecision });
      }

      hooks.transition?.(ctx, node, result.outcome, tr.to);
      run.from = node.id;
      run.nodeId = tr.to;
      if (tr.to === END) {
        run.status = 'done';
        save();
        return;
      }
      save();
    }
  } catch (err) {
    run.status = 'stuck';
    run.note = (err as Error).message;
    save();
    throw err;
  }
}
