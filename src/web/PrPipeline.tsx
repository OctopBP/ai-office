import { PR_STAGE_LABEL, prStageClass, retryPipeline, showDiff, useStore } from './store';
import type { PullRequestView } from '../shared/types';

/**
 * Конвейер ревью: что офис делает со сданными задачами прямо сейчас.
 * Это не список дел для пользователя — вмешиваться нужно только там, где
 * стадия «встало»: всё остальное едет само.
 */
const clock = (at: number): string =>
  new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

function order(a: PullRequestView, b: PullRequestView): number {
  // Вставшие — наверх: это единственное, что ждёт человека.
  if ((a.stage === 'stuck') !== (b.stage === 'stuck')) return a.stage === 'stuck' ? -1 : 1;
  return b.updatedAt - a.updatedAt;
}

export function PrPipeline() {
  const prs = useStore((s) => s.prs);
  const auto = useStore((s) => s.settings.autoPipeline);
  const list = Object.values(prs).sort(order);
  const live = list.filter((p) => p.stage !== 'merged');

  if (!auto) {
    return (
      <p className="empty">
        Конвейер ревью выключен в настройках — ветки задач сливает человек, вручную, внизу.
      </p>
    );
  }
  if (list.length === 0) {
    return <p className="empty">Сданных задач в работе нет: конвейеру нечего вести.</p>;
  }

  return (
    <div className="pr-list">
      <div className="mq-head muted small">
        Конвейер ревью
        {live.length > 0 && <span className="muted small">в работе: {live.length}</span>}
      </div>
      <p className="muted small pr-hint">
        Офис ведёт это сам: подтягивает основную ветку, гоняет проверки, зовёт ревьюера,
        вливает и убирает ветку. Вставшее перезапускает сам, а чего не может — передаёт
        менеджеру. Смотреть сюда не обязательно.
      </p>

      {list.map((pr) => {
        const last = pr.reviews[pr.reviews.length - 1];
        return (
          <div key={pr.id} className={`mq-item ${pr.stage === 'stuck' ? 'conflict' : pr.stage === 'merged' ? 'merged' : ''}`}>
            <div className="mq-item-row">
              <span className="mono muted">{pr.taskId}</span>
              <span className="mq-title">{pr.title}</span>
              {pr.rounds > 0 && (
                <span className="muted small" title="Сколько раз ревьюер возвращал работу">
                  круг {pr.rounds + 1}
                </span>
              )}
              <span className={`chip merge-chip ${prStageClass(pr.stage)}`}>
                {PR_STAGE_LABEL[pr.stage]}
              </span>
            </div>

            <div className="mq-reason pr-note">{pr.note}</div>

            {pr.stage === 'stuck' && (
              <div className={`pr-watch ${pr.needsDecision ? 'bad' : ''}`}>
                {pr.needsDecision
                  ? 'Сам не разберётся — менеджеру сказали, решение за ним.'
                  : `Офис пробует снова сам${pr.nextTryAt ? ` — в ${clock(pr.nextTryAt)}` : ''}` +
                    `${pr.retries ? ` (попыток уже ${pr.retries})` : ''}.`}
              </div>
            )}

            {last && (
              <div className={`pr-review ${last.verdict === 'approve' ? 'ok' : 'bad'}`}>
                <b>{last.verdict === 'approve' ? 'Ревьюер: можно вливать' : 'Ревьюер: нужна доработка'}</b>
                <p>{last.text}</p>
              </div>
            )}

            <div className="pr-actions">
              <span className="mono small muted">{pr.branch} → {pr.base}</span>
              {pr.url && (
                <a className="mini" href={pr.url} target="_blank" rel="noreferrer">
                  PR #{pr.number}
                </a>
              )}
              {pr.stage !== 'merged' && (
                <button type="button" className="mini" onClick={() => showDiff(pr.taskId)}>diff</button>
              )}
              {pr.stage === 'stuck' && (
                <button type="button" className="mini" onClick={() => retryPipeline(pr.taskId)}>
                  попробовать снова
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
