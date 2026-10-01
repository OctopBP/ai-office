import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CUSTOM_NAME_MAX, type CustomApi } from '../shared/providers';
import type { ProviderLoginError, ProviderView } from '../shared/types';
import { forgetProviderModels } from './ProviderPick';
import { loginProvider, probeProvider, useStore } from './store';
import { t, type UiKey } from './i18n';

/**
 * Свой API в формате OpenAI (docs/design/T-189/ui.md §6): группа на вкладке
 * «Провайдеры» с кнопкой «Добавить» и та же форма в карточке по «Изменить».
 * Провайдер в v1 один — `custom` (§0), поэтому форма правит его, а не
 * создаёт новый. Всё проверяет сервер: проба `GET {адрес}/models` и вход
 * тем же запросом; форма только показывает итог и подсвечивает поле.
 */

/**
 * Пресеты — известные сервисы с готовым адресом. Встроенные карточки (xAI,
 * DeepSeek, OpenRouter, Ollama) сюда не входят: у них своя карточка.
 */
interface Preset { id: string; name: string; url: string; local?: boolean }

const PRESETS: Preset[] = [
  { id: 'cerebras', name: 'Cerebras', url: 'https://api.cerebras.ai/v1' },
  { id: 'fireworks', name: 'Fireworks AI', url: 'https://api.fireworks.ai/inference/v1' },
  { id: 'groq', name: 'Groq', url: 'https://api.groq.com/openai/v1' },
  { id: 'mistral', name: 'Mistral', url: 'https://api.mistral.ai/v1' },
  { id: 'together', name: 'Together AI', url: 'https://api.together.xyz/v1' },
  { id: 'lmstudio', name: 'LM Studio', url: 'http://127.0.0.1:1234/v1', local: true },
  { id: 'litellm', name: 'LiteLLM', url: 'http://127.0.0.1:4000/v1', local: true },
  { id: 'vllm', name: 'vLLM', url: 'http://127.0.0.1:8000/v1', local: true },
];

const OWN = '';

/** Адрес без хвоста — как его сохранит сервер; по нему узнаём пресет при правке. */
const trimUrl = (raw: string): string => raw.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');

/**
 * Годится ли адрес (§6.2): `https://…`, а `http://` — только для этой машины
 * и локальной сети: ключ по открытому каналу в интернет не отправляем.
 */
function validUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return false; }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.endsWith('.local')
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/** Пусто — поля нет; иначе неотрицательное число или NaN — ошибка. */
const num = (raw: string): number | undefined => {
  const s = raw.trim().replace(',', '.');
  return s ? Number(s) : undefined;
};

/** Какое поле подсветить и что сказать — по коду ошибки сервера. */
const ERROR_TEXT: Record<ProviderLoginError, UiKey> = {
  rejected: 'providers.custom.err401',
  'not-found': 'providers.custom.err404',
  network: 'providers.custom.errNet',
  address: 'providers.custom.errUrl',
  model: 'providers.custom.errModel',
  keychain: 'providers.key.errKeychain',
  unsupported: 'providers.key.errUnsupported',
};

type Field = 'name' | 'url' | 'key' | 'model' | 'advanced';

const FIELD_OF: Partial<Record<ProviderLoginError, Field>> = {
  rejected: 'key', 'not-found': 'url', network: 'url', address: 'url', model: 'model',
};

type Probe =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; models: string[] | null }
  | { kind: 'error'; code: ProviderLoginError };

/**
 * Форма своего API. `p` — карточка провайдера: если адрес уже задан, это
 * правка (поля заполнены, пустой ключ значит «не менять»), иначе добавление.
 */
export function CustomApiForm({ p, onClose }: { p: ProviderView; onClose: () => void }) {
  const fid = useId();
  const editing = Boolean(p.baseUrl);
  const saved = p.custom ?? {};
  const all = useStore((s) => s.providers);
  const others = (all?.providers ?? []).filter((o) => o.id !== p.id);
  const result = useStore((s) => s.providerLogin[p.id]);

  const [preset, setPreset] = useState(() => PRESETS.find((x) => x.url === p.baseUrl)?.id ?? OWN);
  const [name, setName] = useState(saved.name ?? '');
  const [url, setUrl] = useState(p.baseUrl ?? '');
  const [key, setKey] = useState('');
  const [shown, setShown] = useState(false);
  const [model, setModel] = useState(saved.model ?? '');
  const [models, setModels] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState(Boolean(saved.contextWindow || saved.price));
  const [context, setContext] = useState(saved.contextWindow ? String(saved.contextWindow) : '');
  const [priceIn, setPriceIn] = useState(saved.price ? String(saved.price.input) : '');
  const [priceOut, setPriceOut] = useState(saved.price ? String(saved.price.output) : '');
  const [probe, setProbe] = useState<Probe>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState<{ field: Field; text: string } | null>(null);
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => { first.current?.focus(); }, []);

  // Итог входа приходит событием `provider.login`: пока его нет — «Проверяю…».
  useEffect(() => {
    if (!saving || !result) return;
    setSaving(false);
    if (result.ok) {
      forgetProviderModels(p.id);
      onClose();
      return;
    }
    const field = FIELD_OF[result.code];
    setInvalid({ field: field ?? 'url', text: t(ERROR_TEXT[result.code], { model: model.trim() }) });
  }, [saving, result, onClose, p.id, model]);

  const presetOf = PRESETS.find((x) => x.id === preset);
  const pickPreset = (id: string) => {
    const next = PRESETS.find((x) => x.id === id);
    // Название подставляем, только если его не писали руками.
    if (!name.trim() || name === presetOf?.name) setName(next?.name ?? '');
    setUrl(next?.url ?? '');
    setPreset(id);
    setModels([]);
    setProbe({ kind: 'idle' });
    setInvalid(null);
  };
  const editUrl = (value: string) => {
    setUrl(value);
    // Вписали другой адрес — это уже не пресет.
    if (presetOf && trimUrl(value) !== presetOf.url) setPreset(OWN);
    setProbe({ kind: 'idle' });
  };

  const urlTail = /\/chat\/completions\/?$/.test(url.trim());

  /** Ошибка заполнения до похода на сервер; null — можно отправлять. */
  const check = (needModel: boolean): { field: Field; text: string } | null => {
    const label = name.trim();
    if (label && others.some((o) => o.label.toLocaleLowerCase() === label.toLocaleLowerCase())) {
      return { field: 'name', text: t('providers.custom.errName') };
    }
    if (!validUrl(url)) return { field: 'url', text: t('providers.custom.errUrl') };
    if (needModel && !model.trim()) return { field: 'model', text: t('providers.custom.errModelEmpty') };
    const ctx = num(context);
    const pin = num(priceIn);
    const pout = num(priceOut);
    const bad = (v: number | undefined) => v !== undefined && !(Number.isFinite(v) && v >= 0);
    if (bad(ctx) || ctx === 0 || bad(pin) || bad(pout) || (pin === undefined) !== (pout === undefined)) {
      return { field: 'advanced', text: t('providers.custom.errNumber') };
    }
    return null;
  };

  const loadList = async () => {
    const problem = check(false);
    if (problem?.field === 'url') { setInvalid(problem); return; }
    setInvalid(null);
    setProbe({ kind: 'checking' });
    const r = await probeProvider(p.id, trimUrl(url), key);
    if (!r.ok) {
      setProbe({ kind: 'error', code: r.code });
      setInvalid({ field: FIELD_OF[r.code] ?? 'url', text: t(ERROR_TEXT[r.code], { model: model.trim() }) });
      return;
    }
    setProbe({ kind: 'ok', models: r.models });
    setModels(r.models ?? []);
    if (!model.trim() && r.models?.[0]) setModel(r.models[0]);
  };

  const save = () => {
    if (saving) return;
    const problem = check(true);
    if (problem) {
      setInvalid(problem);
      if (problem.field === 'advanced') setAdvanced(true);
      return;
    }
    setInvalid(null);
    const pin = num(priceIn);
    const pout = num(priceOut);
    const ctx = num(context);
    const meta: CustomApi = {
      ...(name.trim() ? { name: name.trim() } : {}),
      model: model.trim(),
      ...(ctx ? { contextWindow: Math.round(ctx) } : {}),
      ...(pin !== undefined && pout !== undefined ? { price: { input: pin, output: pout } } : {}),
    };
    setSaving(true);
    loginProvider(p.id, key, trimUrl(url), meta);
  };

  const enter = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
  const bad = (field: Field) => (invalid?.field === field ? true : undefined);
  const err = (field: Field) => invalid?.field === field && (
    <span className="form-hint error" role="alert">{invalid.text}</span>
  );
  const busy = saving || probe.kind === 'checking';

  return (
    <div className="custom-api" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="form-rows">
        <Row id={`${fid}-preset`} label={t('providers.custom.preset')} hint={t('providers.custom.preset.hint')}>
          <select id={`${fid}-preset`} ref={first} value={preset} onChange={(e) => pickPreset(e.target.value)}>
            <option value={OWN}>{t('providers.custom.preset.own')}</option>
            <optgroup label={t('providers.custom.preset.cloud')}>
              {PRESETS.filter((x) => !x.local).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </optgroup>
            <optgroup label={t('providers.custom.preset.local')}>
              {PRESETS.filter((x) => x.local).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </optgroup>
          </select>
        </Row>
        <Row id={`${fid}-name`} label={t('providers.custom.name')} hint={t('providers.custom.name.hint')} error={err('name')}>
          <input id={`${fid}-name`} type="text" maxLength={CUSTOM_NAME_MAX} value={name} aria-invalid={bad('name')}
            placeholder={t('providers.custom.title')} onChange={(e) => setName(e.target.value)} onKeyDown={enter} />
        </Row>
        <Row id={`${fid}-url`} label={t('providers.custom.url')}
          hint={urlTail ? t('providers.custom.url.tail') : t('providers.custom.url.hint')} error={err('url')}>
          <input id={`${fid}-url`} className="mono" type="url" inputMode="url" autoComplete="off" spellCheck={false}
            value={url} placeholder={t('providers.custom.url.placeholder')} aria-invalid={bad('url')}
            onChange={(e) => editUrl(e.target.value)} onKeyDown={enter} />
        </Row>
        <Row id={`${fid}-key`} label={t('providers.key.label')} error={err('key')}
          hint={editing && p.key
            ? t('providers.custom.key.keep', { tail: p.key.tail })
            : t(presetOf?.local || !presetOf ? 'providers.custom.key.optional' : 'providers.key.hint')}>
          <div className="provider-key-row">
            <input id={`${fid}-key`} className="mono" type={shown ? 'text' : 'password'} autoComplete="off"
              spellCheck={false} value={key} aria-invalid={bad('key')}
              placeholder={editing && p.key ? `…${p.key.tail}` : ''}
              onChange={(e) => setKey(e.target.value)} onKeyDown={enter} />
            <button type="button" className="mini ghost" aria-pressed={shown} onClick={() => setShown((v) => !v)}>
              {t(shown ? 'providers.key.hide' : 'providers.key.show')}
            </button>
          </div>
        </Row>
        <Row id={`${fid}-model`} label={t('providers.custom.model')} hint={t('providers.custom.model.hint')} error={err('model')}>
          <div className="provider-key-row">
            <input id={`${fid}-model`} className="mono" list={`${fid}-models`} autoComplete="off" spellCheck={false}
              value={model} aria-invalid={bad('model')} onChange={(e) => setModel(e.target.value)} onKeyDown={enter} />
            <datalist id={`${fid}-models`}>
              {models.map((m) => <option key={m} value={m} />)}
            </datalist>
            <button type="button" disabled={busy} onClick={() => void loadList()}>
              {probe.kind === 'checking' ? <><span className="spinner" /> {t('providers.custom.checking')}</> : t('providers.custom.loadModels')}
            </button>
          </div>
          {probe.kind === 'ok' && (
            <span className="form-hint" role="status">
              {probe.models?.length ? t('providers.custom.ok', { n: probe.models.length }) : t('providers.custom.okNoList')}
            </span>
          )}
        </Row>
      </div>
      <details className="custom-api-more" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
        <summary>{t('providers.custom.advanced')}</summary>
        <div className="form-rows">
          <Row id={`${fid}-ctx`} label={t('providers.custom.context')} hint={t('providers.custom.context.hint')}>
            <input id={`${fid}-ctx`} type="text" inputMode="numeric" value={context} placeholder="128000"
              aria-invalid={bad('advanced')} onChange={(e) => setContext(e.target.value)} onKeyDown={enter} />
          </Row>
          <Row id={`${fid}-pin`} label={t('providers.custom.price')} hint={t('providers.custom.price.hint')} error={err('advanced')}>
            <div className="custom-api-price">
              <label htmlFor={`${fid}-pin`}>{t('providers.custom.price.in')}</label>
              <input id={`${fid}-pin`} type="text" inputMode="decimal" value={priceIn} placeholder="0.60"
                aria-invalid={bad('advanced')} onChange={(e) => setPriceIn(e.target.value)} onKeyDown={enter} />
              <label htmlFor={`${fid}-pout`}>{t('providers.custom.price.out')}</label>
              <input id={`${fid}-pout`} type="text" inputMode="decimal" value={priceOut} placeholder="2.40"
                aria-invalid={bad('advanced')} onChange={(e) => setPriceOut(e.target.value)} onKeyDown={enter} />
            </div>
          </Row>
        </div>
      </details>
      <div className="provider-actions">
        <button type="button" className="primary" disabled={busy} onClick={save}>
          {saving ? <><span className="spinner" /> {t('providers.custom.checking')}</> : t('providers.custom.save')}
        </button>
        <button type="button" onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}

function Row({ id, label, hint, error, children }: {
  id: string;
  label: string;
  hint?: string;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="form-row">
      <div className="form-row-label"><label htmlFor={id}>{label}</label></div>
      <div className="form-row-control">
        {children}
        {error || (hint && <span className="form-hint">{hint}</span>)}
      </div>
    </div>
  );
}

/**
 * Группа «Свой API» на вкладке (§2.1): описание и кнопка, форма раскрывается
 * тут же, не модалкой. Когда свой API уже подключён, он живёт карточкой в
 * «Подключениях» — правка и удаление там, в меню ⋯.
 */
export function CustomApiGroup({ p }: { p: ProviderView | undefined }) {
  const [open, setOpen] = useState(false);
  const added = Boolean(p?.baseUrl);
  // Сохранили — карточка появилась в «Подключениях», форма здесь больше не нужна.
  useEffect(() => { if (added) setOpen(false); }, [added]);
  return (
    <section className="form-section" id="provider-custom">
      <header className="form-section-head">
        <h3 className="form-section-title">{t('providers.custom.title')}</h3>
        <p className="form-section-desc">{t('providers.custom.desc')}</p>
      </header>
      {added && p ? (
        <p className="form-hint">{t('providers.custom.added', { name: p.label })}</p>
      ) : open && p ? (
        <CustomApiForm p={p} onClose={() => setOpen(false)} />
      ) : (
        <button type="button" disabled={!p} onClick={() => setOpen(true)}>+ {t('providers.custom.add')}</button>
      )}
    </section>
  );
}
