import { assignDirect, fire, hire, mergeTask, retryTask, stopTask, useStore } from './store';
import { agentSpriteName, spriteOf } from './sprites';
import type { TaskView } from '../shared/types';

const money = (v: number) => `$${v.toFixed(v < 1 ? 3 : 2)}`;
const tokens = (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v));

function elapsed(from: number | null, to: number | null): string {
  if (!from) return '';
  const ms = (to ?? Date.now()) - from;
  const min = Math.floor(ms / 60000);
  if (min < 1) return `${Math.max(1, Math.round(ms / 1000))} сек`;
  if (min < 60) return `${min} мин`;
  return `${Math.floor(min / 60)} ч ${min % 60} мин`;
}

const STATUS_RU: Record<TaskView['status'], string> = {
  backlog: 'в очереди', assigned: 'назначена', in_progress: 'в работе',
  review: 'на проверке', blocked: 'остановлена', done: 'готово', failed: 'провал',
};

const TOOL_ICON: Record<string, string> = {
  Bash: '⚙', Read: '📖', Edit: '✏️', Write: '📄', Grep: '🔍', Glob: '🔍',
  WebSearch: '🌐', WebFetch: '🌐', TodoWrite: '🗒',
};

export function AgentDrawer() {
  const selected = useStore((s) => s.selected);
  const instances = useStore((s) => s.instances);
  const roles = useStore((s) => s.roles);
  const tasksMap = useStore((s) => s.tasks);
  const log = useStore((s) => s.log);
  const settings = useStore((s) => s.settings);
  const select = useStore((s) => s.select);
  const setThread = useStore((s) => s.setThread);
  const theme = useStore((s) => s.theme);

  const inst = selected ? instances[selected] : null;
  if (!inst) return null;
  const role = roles.find((r) => r.id === inst.roleId);

  const all = Object.values(tasksMap);
  const mine = all.filter((t) => t.assigneeId === inst.id).sort((a, b) => a.createdAt - b.createdAt);
  const current = inst.currentTaskId ? tasksMap[inst.currentTaskId] : null;
  // Задачи своей роли, которые ещё никто не взял — их можно отдать этому агенту.
  const free = all.filter((t) => !t.assigneeId && t.status === 'backlog' && t.roleId === inst.roleId);
  const trail = log.filter((l) => l.agentId === inst.id).slice(-14);

  const done = mine.filter((t) => t.status === 'done').length;
  const running = mine.filter((t) => t.status === 'in_progress').length;

  const cap = settings.taskBudgetUsd;
  const usedShare = cap && current ? Math.min(100, (current.costUsd / cap) * 100) : 0;

  return (
    <aside className="drawer">
      <header className="drawer-head">
        <img className="ava" src={spriteOf(theme, agentSpriteName(inst.roleId, inst.id))} alt="" />
        <div className="drawer-who">
          <h2>{inst.id}</h2>
          <div className="muted">
            {role?.title} · {role?.model.replace('claude-', '')} · место #{inst.desk.index}
          </div>
          <div className={`chip ${inst.state}`}>
            {inst.note ?? STATUS_RU[current?.status ?? 'backlog'] ?? inst.state}
            {current && ` · ${elapsed(current.startedAt, null)} · ${current.id}`}
          </div>
        </div>
        <button className="icon" onClick={() => select(null)} title="Закрыть">✕</button>
      </header>

      <section>
        <h3>Сейчас делает</h3>
        {current ? (
          <div className="card">
            <div className="card-head"><b>{current.id}</b> {current.title}</div>
            <div className="muted small">
              {elapsed(current.startedAt, null)} · {money(current.costUsd)} ·{' '}
              {tokens(current.tokensIn + current.tokensOut)} tok
              {current.branch && <> · ветка <code className="mono">{current.branch}</code></>}
            </div>
            {current.acceptanceCriteria && (
              <div className="criteria">Критерий: {current.acceptanceCriteria}</div>
            )}
            {cap !== null && (
              <div className="budget">
                <div className="bar"><i style={{ width: `${usedShare}%` }} /></div>
                <span className="muted small">
                  бюджет задачи {money(cap)} · {Math.round(usedShare)}%
                </span>
              </div>
            )}
          </div>
        ) : (
          <p className="muted small">Свободен, задач в работе нет.</p>
        )}
      </section>

      <section>
        <h3>
          Задачи агента
          <span className="muted"> · {done} сделано · {running} в работе · {free.length} свободных</span>
        </h3>
        {mine.length === 0 && free.length === 0 && <p className="muted small">Пока ничего.</p>}
        {mine.map((t) => (
          <div key={t.id} className={`row ${t.status}`}>
            <span className="mono dim">{t.id}</span>
            <span className="row-title">{t.title}</span>
            <span className="muted small">{STATUS_RU[t.status]}</span>
            {t.costUsd > 0 && <span className="muted small">{money(t.costUsd)}</span>}
            {t.status === 'in_progress' && (
              <button className="mini stop" onClick={() => stopTask(t.id)}>стоп</button>
            )}
            {(t.status === 'failed' || t.status === 'blocked') && (
              <button className="mini" onClick={() => retryTask(t.id)}>заново</button>
            )}
            {t.status === 'done' && t.branch && !t.merged && (
              <button className="mini" onClick={() => mergeTask(t.id)}>смержить</button>
            )}
          </div>
        ))}
        {free.map((t) => (
          <div key={t.id} className="row backlog">
            <span className="mono dim">{t.id}</span>
            <span className="row-title">{t.title}</span>
            <button className="mini go" onClick={() => assignDirect(t.id, inst.id)}>запустить</button>
          </div>
        ))}
        {free.length > 0 && (
          <p className="muted small">Запуск отсюда идёт мимо менеджера — он получит уведомление.</p>
        )}
      </section>

      <section>
        <h3>Транскрипт <span className="muted">· последние {trail.length}</span></h3>
        <div className="trail">
          {trail.length === 0 && <p className="muted small">Пока пусто.</p>}
          {trail.map((l) => {
            const tool = l.text.split(':')[0];
            return (
              <div key={l.id} className={`trail-row ${l.kind}`}>
                <span className="dim mono">
                  {new Date(l.at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="ico">{l.kind === 'tool' ? TOOL_ICON[tool] ?? '•' : l.kind === 'error' ? '⚠️' : '💬'}</span>
                <span className="trail-text">{l.text}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h3>Расходы</h3>
        <div className="muted small">
          {money(inst.costUsd)} за всё время агента
          {current && <> · {money(current.costUsd)} на текущую задачу</>}
        </div>
      </section>

      <div className="drawer-actions">
        <button onClick={() => { setThread(inst.id); select(null); }}>💬 Поговорить</button>
        {role && !role.isManager && (
          <button disabled={role.active >= role.maxInstances} onClick={() => hire(inst.roleId)}>
            ⧉ Клонировать
          </button>
        )}
        {current && (
          <button className="danger" onClick={() => stopTask(current.id)}>⏹ Остановить задачу</button>
        )}
      </div>
      {role && !role.isManager && (
        <button className="link-danger" onClick={() => { fire(inst.id); select(null); }}>
          Уволить
        </button>
      )}
    </aside>
  );
}
