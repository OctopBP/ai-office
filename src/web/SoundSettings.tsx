import { useEffect, useId, useState } from 'react';
import {
  getSoundSettings, preview, setSoundSettings, subscribeSoundSettings,
  type SoundMode, type SoundSettings as Settings,
} from './sound';
import { t } from './i18n';

const MODES: [SoundMode, 'settings.sound.mode.important' | 'settings.sound.mode.all'][] = [
  ['important', 'settings.sound.mode.important'],
  ['all', 'settings.sound.mode.all'],
];

/** Звук офиса: хранится на этом компьютере через модуль sound, применяется сразу. */
export function SoundSettings() {
  const [s, setS] = useState<Settings>(getSoundSettings);
  useEffect(() => subscribeSoundSettings(setS), []);
  const volumeId = useId();
  const percent = Math.round(s.volume * 100);

  return (
    <>
      <div className="form-row">
        <div className="form-row-label"><span>{t('settings.sound.title')}</span></div>
        <div className="form-row-control">
          <label className="form-check">
            <input type="checkbox" checked={s.enabled}
              onChange={(e) => setSoundSettings({ enabled: e.target.checked })} />
            <span className="form-check-text">
              {t('settings.sound.enabled')}
              <span className="form-hint">{t('settings.sound.enabled.hint')}</span>
            </span>
          </label>
        </div>
      </div>
      <div className={`form-row${s.enabled ? '' : ' off'}`}>
        <div className="form-row-label"><label htmlFor={volumeId}>{t('settings.sound.volume')}</label></div>
        <div className="form-row-control">
          <div className="settings-range">
            <input id={volumeId} type="range" min={0} max={100} step={5} value={percent}
              disabled={!s.enabled}
              onChange={(e) => setSoundSettings({ volume: Number(e.target.value) / 100 })} />
            <b className="mono">{percent}%</b>
          </div>
        </div>
      </div>
      <div className={`form-row${s.enabled ? '' : ' off'}`}>
        <div className="form-row-label"><span>{t('settings.sound.mode')}</span></div>
        <div className="form-row-control">
          <div className="seg" role="group" aria-label={t('settings.sound.mode')}>
            {MODES.map(([mode, label]) => (
              <button key={mode} type="button" disabled={!s.enabled}
                className={s.mode === mode ? 'on' : ''} aria-pressed={s.mode === mode}
                onClick={() => setSoundSettings({ mode })}>
                {t(label)}
              </button>
            ))}
          </div>
          <span className="form-hint">{t('settings.sound.mode.hint')}</span>
        </div>
      </div>
      <div className="form-row">
        <div className="form-row-label" />
        <div className="form-row-control">
          <button type="button" className="ghost" disabled={!s.enabled}
            onClick={() => preview('done')}>
            {t('settings.sound.test')}
          </button>
        </div>
      </div>
    </>
  );
}
