import { окноЛимита, type LimitsView, type ProviderView, type РасходОкна } from '../../shared/types';
import { freshness, resetLine } from '../money';
import { locale, t } from '../i18n';

/** Локальное округление рейла; общий формат денег не меняется. */
export function суммаРейла(расход: РасходОкна | undefined, устарел = false): string {
  if (!расход || расход.costStatus === 'unavailable' || расход.costUsd === null || !Number.isFinite(расход.costUsd)) return '—';
  return `${устарел || расход.historyPartial || расход.costStatus === 'partial' ? '≈' : ''}$${(Math.round(расход.costUsd * 10) / 10).toFixed(1)}`;
}

export function данныеСтроки(
  лимиты: LimitsView, провайдер: ProviderView | null, период: '5h' | '1w', сейчас: number,
) {
  const подписка = провайдер?.status.state === 'ready' && провайдер.status.auth !== 'api-key';
  // Нулевое «сейчас» позволяет получить прошлое окно исключительно для пояснения сброса.
  const прошлое = провайдер ? окноЛимита(лимиты, провайдер.id, период, 0) : null;
  const окно = подписка && лимиты.available && провайдер ? окноЛимита(лимиты, провайдер.id, период, сейчас) : null;
  const свежий = окно && сейчас - окно.updatedAt <= (период === '5h' ? 300 : 10080) * 60_000;
  const процент = свежий && Number.isFinite(окно.utilization) && окно.utilization >= 0 && окно.utilization <= 100
    ? окно.utilization : null;
  const сброс = подписка ? окно ?? прошлое : null;
  const время = сброс ? resetLine(сброс, сейчас) : t('limits.resetUnknown');
  const точно = сброс?.resetsAt != null && Number.isFinite(сброс.resetsAt)
    ? new Date(сброс.resetsAt).toLocaleString(locale(), {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }) : t('rail.spend.resetUnknown');
  return {
    процент,
    строки: [
      t('rail.spend.provider', { provider: провайдер?.label ?? t('shell.provider.none') }),
      процент === null ? t(подписка ? 'rail.spend.percentUnknown' : 'rail.spend.noWindow')
        : t('rail.spend.percent', { percent: процент }),
      время,
      t('rail.spend.resetAt', { at: точно }),
      ...(сброс ? [freshness(сброс.updatedAt, сейчас)] : []),
    ],
  };
}
