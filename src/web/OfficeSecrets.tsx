import { useCallback, useEffect, useRef, useState } from 'react';
import type { SecretMeta } from '../shared/types';
import { locale, t } from './i18n';
import { useStore } from './store';

/**
 * Переменные окружения офиса. Значение уходит на сервер и больше нигде не
 * живёт: ни в сторе, ни в localStorage, ни в списке (сервер его и не отдаёт).
 * Список — локальное состояние компонента; поле значения очищается сразу
 * после ответа сервера.
 */

const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** Привести ввод к UPPER_SNAKE: регистр, пробелы и дефисы в «_», лишнее выкинуть. */
const toSnake = (raw: string): string =>
  raw.toUpperCase().replace(/[\s-]+/g, '_').replace(/[^A-Z0-9_]/g, '').slice(0, 64);

const query = (office: string): string => `?office=${encodeURIComponent(office)}`;

async function problemOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch { /* тело не JSON */ }
  return t('settings.secrets.failed', { status: res.status });
}

export function OfficeSecrets() {
  const officeId = useStore((s) => s.offices.find((o) => o.current)?.id);
  const [list, setList] = useState<SecretMeta[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!officeId) return;
    try {
      const res = await fetch(`/api/secrets${query(officeId)}`);
      if (!res.ok) { setError(await problemOf(res)); return; }
      setList(((await res.json()) as { secrets: SecretMeta[] }).secrets);
    } catch {
      setError(t('settings.secrets.offline'));
    }
  }, [officeId]);

  useEffect(() => { void load(); }, [load]);

  if (!officeId) return null;

  const save = async (): Promise<void> => {
    setError(null);
    if (!NAME_RE.test(name)) { setError(t('settings.secrets.badName')); return; }
    if (value === '') { setError(t('settings.secrets.emptyValue')); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/secrets${query(officeId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, value }),
      });
      if (!res.ok) { setError(await problemOf(res)); return; }
      setValue('');
      setName('');
      setReplacing(null);
      await load();
    } catch {
      setError(t('settings.secrets.offline'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (n: string): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/secrets/${encodeURIComponent(n)}${query(officeId)}`, { method: 'DELETE' });
      if (!res.ok) { setError(await problemOf(res)); return; }
      setConfirmDel(null);
      if (replacing === n) { setReplacing(null); setName(''); setValue(''); }
      await load();
    } catch {
      setError(t('settings.secrets.offline'));
    } finally {
      setBusy(false);
    }
  };

  // Файл читается в браузере; уходит только содержимое, имя файла не хранится.
  const pick = async (picked: File | undefined): Promise<void> => {
    if (!picked) return;
    setError(null);
    try {
      setValue(await picked.text());
    } catch {
      setError(t('settings.secrets.fileFailed'));
    }
    if (file.current) file.current.value = '';
  };

  const replace = (n: string): void => {
    setReplacing(n);
    setName(n);
    setValue('');
    setError(null);
  };

  const date = (ms: number): string => new Date(ms).toLocaleString(locale(), {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <div className="office-secrets">
      {list.length === 0 ? (
        <p className="form-hint">{t('settings.secrets.empty')}</p>
      ) : (
        <ul className="secret-list">
          {list.map((s) => (
            <li key={s.name} className="secret-row">
              <code className="secret-name">{s.name}</code>
              <span className="secret-mask" aria-label={t('settings.secrets.hidden')}>••••••</span>
              <span className="secret-date">{t('settings.secrets.changed', { date: date(s.updatedAt) })}</span>
              <span className="secret-actions">
                {confirmDel === s.name ? (
                  <>
                    <span className="form-hint">{t('settings.secrets.confirm', { name: s.name })}</span>
                    <button className="mini" disabled={busy} onClick={() => void remove(s.name)}>
                      {t('settings.secrets.confirmYes')}
                    </button>
                    <button className="mini" disabled={busy} onClick={() => setConfirmDel(null)}>
                      {t('common.cancel')}
                    </button>
                  </>
                ) : (
                  <>
                    <button className="mini" disabled={busy} onClick={() => replace(s.name)}>
                      {t('settings.secrets.replace')}
                    </button>
                    <button className="mini" disabled={busy} onClick={() => setConfirmDel(s.name)}>
                      {t('settings.secrets.delete')}
                    </button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <form
        className="secret-form"
        autoComplete="off"
        onSubmit={(e) => { e.preventDefault(); void save(); }}
      >
        <input
          value={name}
          readOnly={replacing !== null}
          placeholder={t('settings.secrets.namePlaceholder')}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setName(toSnake(e.target.value))}
        />
        <textarea
          className="secret-value"
          rows={3}
          value={value}
          placeholder={replacing ? t('settings.secrets.newValue') : t('settings.secrets.valuePlaceholder')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="secret-form-actions">
          <button type="submit" disabled={busy || !name || !value}>
            {t(replacing ? 'settings.secrets.saveReplace' : 'settings.secrets.add')}
          </button>
          <button type="button" className="mini" disabled={busy} onClick={() => file.current?.click()}>
            {t('settings.secrets.fromFile')}
          </button>
          {replacing && (
            <button type="button" className="mini" onClick={() => { setReplacing(null); setName(''); setValue(''); }}>
              {t('common.cancel')}
            </button>
          )}
          <input ref={file} type="file" hidden onChange={(e) => void pick(e.target.files?.[0])} />
        </div>
        {error && <span className="form-hint error" role="alert">{error}</span>}
      </form>
    </div>
  );
}
