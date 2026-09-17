import { useEffect, useState } from 'react';
import { recheckEnv, useStore } from '../store';
import { t } from '../i18n';
import { Icon } from '../icons';

/**
 * Полоса блокировки окружения: критичная проверка (ключ модели, рабочая
 * директория) провалена — офис не возьмёт ни одной задачи, пока это не
 * починят. Видна на любом экране офиса, поверх рейла и вида.
 *
 * Пока проверки ещё не считали (`env.at === 0`), молчим: на этот момент офис
 * о своём окружении не знает ничего сам — та же логика, что у `envBlock` на
 * сервере (`src/server/envcheck.ts`). Как только все критичные проверки
 * зеленеют, баннер пропадает сам — отдельного «скрыть» не нужно.
 */
export function EnvBanner() {
  const env = useStore((s) => s.env);
  const [checking, setChecking] = useState(false);

  const failed = env.at === 0 ? [] : env.checks.filter((c) => c.critical && c.status === 'fail');

  // Свежий отчёт после «перепроверить» приходит через WS и меняет env.at —
  // это и есть сигнал, что запрос долетел и кнопку можно разблокировать.
  useEffect(() => setChecking(false), [env.at]);

  if (!failed.length) return null;

  return (
    <div className="env-banner" role="alert">
      <div className="env-banner-rows">
        {failed.map((check) => (
          <div className="env-banner-row" key={check.id}>
            <Icon name="alert-triangle" size={16} />
            <div className="env-banner-text">
              <b>{check.title}</b>
              <span>{check.detail}</span>
              {check.fix && <span className="env-banner-fix">{check.fix}</span>}
            </div>
          </div>
        ))}
      </div>
      <button
        className="env-banner-recheck"
        onClick={() => { setChecking(true); recheckEnv(); }}
        disabled={checking}
      >
        {checking ? t('env.banner.checking') : t('env.banner.recheck')}
      </button>
    </div>
  );
}
