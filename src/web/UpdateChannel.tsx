import { useEffect, useState } from 'react';
import { t, type UiKey } from './i18n';
import type { AppVersionInfo, UpdateChannel } from '../shared/desktop';

const CHANNELS: Array<[UpdateChannel, UiKey, UiKey]> = [
  ['stable', 'settings.channel.stable', 'settings.channel.stable.hint'],
  ['beta', 'settings.channel.beta', 'settings.channel.beta.hint'],
  ['alpha', 'settings.channel.alpha', 'settings.channel.alpha.hint'],
];

/** Мост обновлений; в браузере и в старых версиях приложения его нет. */
export const updatesBridge = () =>
  (typeof window !== 'undefined' ? window.officeDesktop?.updates : undefined);

/** Есть ли в приложении управление каналом (старый мост без getChannel — нет). */
export const hasChannelBridge = () => typeof updatesBridge()?.getChannel === 'function';

/** Метка пререлиза рядом с номером версии: «бета» / «альфа». Пусто — стабильная. */
export function prereleaseLabel(info: AppVersionInfo | null): string | null {
  if (!info?.isPrerelease) return null;
  return info.prerelease.startsWith('alpha') ? t('settings.channel.tag.alpha') : t('settings.channel.tag.beta');
}

/** Версия приложения с меткой пререлиза; без моста ничего не рисует. */
export function AppVersion() {
  const [info, setInfo] = useState<AppVersionInfo | null>(null);
  useEffect(() => {
    const bridge = updatesBridge();
    if (typeof bridge?.getVersion !== 'function') return;
    let alive = true;
    bridge.getVersion().then((v) => { if (alive) setInfo(v); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!info) return null;
  const label = prereleaseLabel(info);
  return (
    <span className="app-version">
      {t('settings.channel.version', { version: info.version })}
      {label && <span className="app-version-tag">{label}</span>}
    </span>
  );
}

/**
 * Переключатель канала обновлений. Смена применяется сразу, как и прочее на
 * вкладке «Устройство»: решает главный процесс, отказ показываем его текстом.
 */
export function UpdateChannelSetting() {
  const bridge = updatesBridge();
  const [channel, setChannel] = useState<UpdateChannel | null>(null);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    bridge.getChannel().then((c) => { if (alive) setChannel(c); }).catch(() => {});
    return () => { alive = false; };
  }, [bridge]);

  if (!bridge || typeof bridge.setChannel !== 'function') return null;

  const choose = async (next: UpdateChannel) => {
    if (next === channel || pending) return;
    setPending(true);
    setRefusal(null);
    try {
      const res = await bridge.setChannel(next);
      if (res.ok) setChannel(next);
      else setRefusal(res.message);
    } catch (err) {
      setRefusal(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="channel-list" role="radiogroup" aria-label={t('settings.channel.title')}>
      {CHANNELS.map(([id, label, hint]) => (
        <label key={id} className="form-check">
          <input type="radio" name="update-channel" checked={channel === id}
            disabled={pending || channel === null} onChange={() => choose(id)} />
          <span className="form-check-text">
            {t(label)}
            <span className="form-hint">{t(hint)}</span>
          </span>
        </label>
      ))}
      {refusal && (
        <span className="form-hint error" role="alert">{t('settings.channel.refused', { reason: refusal })}</span>
      )}
    </div>
  );
}
