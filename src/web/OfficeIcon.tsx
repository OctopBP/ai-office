/**
 * Иконка офиса на вебе: одна отрисовка аватарки на все места и блок её
 * настройки.
 *
 * Отрисовка здесь, а не в каждом экране, потому что мест уже три (рейл офисов,
 * карточки главного экрана, превью в настройках), а правило одно: есть
 * картинка — показываем её, нет — эмодзи, нет и его — инициал на цветной
 * подложке. Разъехавшись по файлам, это правило уже начинало расходиться:
 * адрес картинки собирали руками, без версии файла, и после замены браузер
 * показывал прежнюю.
 *
 * Адрес картинки берётся из `icon.value` как есть: сервер кладёт туда
 * `/api/office-icon?office=<id>&v=<версия>` (src/server/offices.ts →
 * officeIconUrl), и версия в нём — единственное, что заставляет браузер
 * перечитать файл после замены.
 */
import { useRef, useState } from 'react';
import type { OfficeView } from '../shared/types';
import { setOfficeIcon, uploadOfficeIcon, useStore } from './store';
import { officeAvatarColor, officeAvatarInk } from './officeColor';
import { t } from './i18n';

/**
 * Что принимает ручка загрузки и каков её потолок. Значения повторяют
 * src/server/offices.ts (UPLOAD_TYPES, ICON_MAX_BYTES) намеренно: тащить в
 * сборку веба модуль сервера ради двух констант нельзя, а проверка здесь —
 * только чтобы не гонять по сети заведомо негодный файл. Решает всё равно
 * сервер, и его отказ мы показываем как есть.
 */
const ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const ICON_MAX_BYTES = 1024 * 1024;

/** Буква на иконке офиса: первый символ названия, в верхнем регистре. */
export function officeInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}

/**
 * Содержимое аватарки офиса: картинка, эмодзи или инициал. Сама подложка —
 * на вызывающем: у рейла и карточек разные размеры и скругления, общий тут
 * только выбор, что рисовать внутри.
 *
 * `imgClass` задаёт вписывание картинки в форму подложки (object-fit: cover),
 * поэтому у каждого места он свой.
 */
export function OfficeAvatarIcon({ office, imgClass }: { office: OfficeView; imgClass: string }) {
  const icon = office.icon;
  // Картинка впереди эмодзи: в состоянии офиса живёт что-то одно, но если
  // когда-нибудь приедут оба, показать надо более явный выбор человека.
  if (icon?.kind === 'image') return <img className={imgClass} src={icon.value} alt="" />;
  if (icon?.kind === 'emoji') return <>{icon.value}</>;
  return <>{officeInitial(office.name)}</>;
}

/**
 * Блок «Иконка офиса» в настройках: что стоит сейчас, выбор файла и сброс.
 * Оптимистичного показа нет — новая иконка появляется, когда сервер пришлёт
 * обновлённый список офисов; до тех пор кнопка занята и подписана «Загружаю…».
 */
export function OfficeIconSetting() {
  const office = useStore((s) => s.offices.find((o) => o.current));
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!office) return null;

  const send = async (picked: File | undefined): Promise<void> => {
    if (!picked) return;
    setError(null);
    if (picked.size > ICON_MAX_BYTES) {
      setError(t('settings.icon.tooBig', {
        max: Math.round(ICON_MAX_BYTES / 1024), got: Math.ceil(picked.size / 1024),
      }));
      return;
    }
    if (!ICON_TYPES.includes(picked.type)) {
      setError(t('settings.icon.badType', { type: picked.type || t('common.none') }));
      return;
    }
    setBusy(true);
    const problem = await uploadOfficeIcon(office.id, picked);
    setBusy(false);
    setError(problem);
  };

  return (
    <>
      <h4 className="section-title">{t('settings.icon.title')}</h4>
      <div className="office-icon-setting">
        <span className="office-card-avatar"
          style={{ background: officeAvatarColor(office.id), color: officeAvatarInk(office.id) }}>
          <OfficeAvatarIcon office={office} imgClass="office-card-icon-img" />
        </span>
        <div className="office-icon-setting-actions">
          <button disabled={busy} onClick={() => file.current?.click()}>
            {t(busy ? 'settings.icon.uploading' : office.icon?.kind === 'image'
              ? 'settings.icon.replace' : 'settings.icon.upload')}
          </button>
          <button className="mini" disabled={busy || !office.icon}
            onClick={() => { setError(null); setOfficeIcon(office.id, null); }}>
            {t('settings.icon.reset')}
          </button>
        </div>
        <input ref={file} type="file" className="office-icon-file" accept={ICON_TYPES.join(',')}
          onChange={(e) => {
            const picked = e.target.files?.[0];
            // Поле чистим сразу: иначе повторный выбор того же файла (скажем,
            // после неудачной загрузки) не считается изменением и не сработает.
            e.target.value = '';
            void send(picked);
          }} />
      </div>
      {error && <p className="hint error">{error}</p>}
      <p className="hint muted">{t('settings.icon.hint')}</p>
    </>
  );
}
