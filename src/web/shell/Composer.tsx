import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { accessLabel, openProviderSettings, pushToast, send, useInputDraft, useStore } from '../store';
import { money } from '../money';
import { t } from '../i18n';
import { Icon } from '../icons';
import { Hint, Tooltip } from '../Tooltip';
import { HOTKEY } from '../hotkeys';
import { ChatPeer } from '../ChatPeer';
import { displayInstance } from '../instanceName';
import { addFiles, clearSent, filesOf, isUploading, namedPaste, readyIds, removeFile, retryFile, useAttachments } from '../chat/attachments';
import { formatSize } from '../result/api';

/**
 * Курсор в композер просят снаружи — клавиша Enter и кнопка нового чата.
 * Ссылка модульная, а не через контекст: композер на экране один,
 * а звонящие ему — в разных ветках дерева.
 */
let focus: (() => void) | null = null;
export const focusComposer = (): void => {
  // Просьба о курсоре приходит вместе со сменой вида, а композер в «Чате» —
  // другой экземпляр, чем плавающий (на «Доске» его нет вовсе). Сейчас `focus`
  // ещё смотрит на старый, который вот-вот размонтируется, — поэтому всегда
  // ждём кадр, к нему React уже поставит нужный.
  requestAnimationFrame(() => focus?.());
};

/**
 * Композер — задача ставится словами из любого вида. Обычно он плавает внизу
 * экрана, а в виде «Чат» встроен в колонку переписки и служит полем ввода треда. Чипы под
 * полем показывают, с чем задача уйдёт, — модель менеджера, режим правок,
 * бюджет; меняются они в настройках, чип туда и ведёт.
 */
export function Composer({ onSettings, inline = false }: {
  onSettings: () => void;
  /** Встроен в колонку переписки («Чат»), а не плавает внизу окна. */
  inline?: boolean;
}) {
  const thread = useStore((s) => s.thread);
  const instances = useStore((s) => s.instances);
  const roles = useStore((s) => s.roles);
  const settings = useStore((s) => s.settings);
  const connected = useStore((s) => s.connected);
  const view = useStore((s) => s.view);
  // Ни один провайдер не подключён (§3.3 T-189): офис смотрят, но задачу не ставят.
  const noProvider = useStore((s) => s.providers?.noneReady === true);
  // Свежий пустой чат с менеджером зовёт начать разговор, а не ставить задачу.
  const freshChat = useStore((s) => s.thread === 'pm#1' && (s.pmChatDraft || (s.pmChatId !== null
    && !s.chat.some((e) => e.chatId === s.pmChatId))));
  // Черновик — в сторе: на виде «Доска» композера на экране нет, и локальное
  // состояние теряло бы недописанное при каждой смене вида.
  const draft = useInputDraft();
  const setDraft = useStore((s) => s.setInputDraft);
  const input = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const attached = useAttachments((s) => s.items);
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => { setMenuOpen(false); input.current?.focus(); };

  // Меню закрывается кликом вне и Esc; курсор возвращается в поле.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuBox.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeMenu();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen]);

  useEffect(() => {
    focus = () => input.current?.focus();
    return () => { focus = null; };
  }, []);

  // Композер плавает над видами и растёт с многострочным вводом, поэтому его
  // высоту нельзя прибить числом в css: под ней прячется низ ленты чата, чипы
  // камеры и тосты. Отдаём измеренную высоту переменной `--composer-h` — от
  // неё все они отмеряют свой нижний край (см. shell.css).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const root = document.documentElement;
    let last = -1;
    // offsetHeight, а не contentRect: нужна высота с рамкой и отступами. Он же
    // целый, поэтому дробные колебания не дёргают всё, что висит над полем.
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (h === last) return;
      last = h;
      root.style.setProperty('--composer-h', `${h}px`);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--composer-h');
    };
  }, []);

  // Поле растёт с текстом до четырёх-пяти строк, дальше прокручивается.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = '0';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const meeting = thread === 'meeting';
  // Файлы прикладываются только к реплике менеджеру.
  const canAttach = thread === 'pm#1' && !noProvider;
  const uploading = isUploading(attached);
  const ids = readyIds(attached);

  // Перетаскивание на всё окно: без preventDefault браузер (и Electron) открыл
  // бы файл вместо приложения. Подсветка — пока над окном файлы.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    let depth = 0;
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = canAttach ? 'copy' : 'none';
    };
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; if (canAttach) setDragging(true); } };
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDragging(false); } };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (canAttach) addFiles(filesOf(e.dataTransfer));
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      setDragging(false);
    };
  }, [canAttach]);

  const submit = () => {
    const text = draft.trim();
    if ((!text && !ids.length) || uploading || meeting || !connected || noProvider) return;
    // Вне вида «Чат» открытого чата на экране нет — реплика менеджеру
    // заводит новый, а не уходит в тот, что выделяли когда-то раньше.
    send(text, { newChat: view !== 'chat', attachments: ids });
    setDraft('');
    clearSent();
    // Из «Офиса» и «Доски» вид не меняем: человек смотрел на офис — пусть и
    // дальше смотрит. Вместо перескока — короткое подтверждение, а о том, что
    // менеджер ответил, скажет точка на сегменте «Чат».
    if (view !== 'chat') {
      pushToast({
        id: `sent:${Date.now()}`, kind: 'info',
        title: t('toast.sent'),
        detail: text.length > 80 ? `${text.slice(0, 80)}…` : (text || t('attach.count', { n: ids.length })),
        ttl: 2500,
      });
    }
  };

  const placeholder = noProvider ? t('providers.composer.disabled')
    : meeting ? t('shell.composer.meeting')
    : thread === 'pm#1' ? t(freshChat && view === 'chat' ? 'shell.composer.newChat' : 'shell.composer.placeholder')
    : t('shell.composer.agent', { who: displayInstance(thread, instances, roles) });
  const model = roles.find((r) => r.id === 'pm')?.model;
  const cap = settings.globalBudgetUsd;
  const items: [string, string, string][] = [
    ['model', t('shell.more.model'), model ?? '—'],
    ['edits', t('shell.more.edits'), accessLabel(settings.officePermissionMode)],
    ['budget', t('shell.more.budget'), cap !== null ? money(cap) : t('shell.more.noBudget')],
  ];

  return (
    <div className={`shell-composer float${inline ? ' inline' : ''}`} ref={box}>
      {/* В виде «Чат» собеседник уже стоит над лентой — второй раз не показываем. */}
      {noProvider && (
        <div className="shell-composer-gate" role="status">
          <span className="shell-composer-gate-dot" aria-hidden />
          <span>{t('providers.composer.banner')}</span>
          <button type="button" className="link" onClick={openProviderSettings}>{t('providers.composer.action')}</button>
        </div>
      )}
      {view !== 'chat' && <ChatPeer compact />}
      {dragging && createPortal(
        <div className="attach-drop" role="status"><span>{t('attach.drop')}</span></div>, document.body)}
      {attached.length > 0 && (
        <ul className="attach-chips" aria-label={t('attach.list')}>
          {attached.map((a) => (
            <li key={a.key} className={`attach-chip ${a.status}`}>
              {a.preview
                ? <img className="attach-thumb" src={a.preview} alt="" />
                : <Icon name={a.mime.startsWith('image/') ? 'photo' : 'file'} size={16} />}
              <span className="attach-meta">
                <span className="attach-name" title={a.name}>{a.name}</span>
                {a.status === 'error'
                  ? <span className="attach-err" role="alert"><Icon name="alert-triangle" size={12} /> {a.error}</span>
                  : <span className="attach-size">
                    {a.status === 'uploading' ? <><i className="spinner" /> {t('attach.uploading')}</> : formatSize(a.size)}
                  </span>}
              </span>
              {a.status === 'error' && a.retry && (
                <button type="button" className="mini" onClick={() => retryFile(a.key)}>{t('attach.retry')}</button>
              )}
              <button type="button" className="attach-x" aria-label={t('attach.remove', { name: a.name })}
                title={t('attach.remove', { name: a.name })} onClick={() => removeFile(a.key)}>
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="shell-composer-row">
        <input ref={picker} type="file" multiple hidden onChange={(e) => {
          addFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }} />
        {canAttach && (
          <button type="button" className="sq shell-attach" aria-label={t('attach.add')} title={t('attach.add')}
            onClick={() => picker.current?.click()}>
            <Icon name="paperclip" size={16} />
          </button>
        )}
        <textarea
          ref={input} value={draft} rows={1} placeholder={placeholder} disabled={meeting || noProvider}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const pasted = canAttach ? filesOf(e.clipboardData) : [];
            if (!pasted.length) return;
            e.preventDefault();
            addFiles(pasted.map(namedPaste));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
            // Escape отдаёт клавиши обратно офису: пока курсор в поле, хоткеи
            // молчат, и без этого из композера было бы не выйти без мыши.
            if (e.key === 'Escape') input.current?.blur();
            e.stopPropagation();
          }}
        />
        <div className="shell-composer-more" ref={menuBox}>
          <button
            type="button" className="sq shell-more" aria-haspopup="menu" aria-expanded={menuOpen}
            aria-label={t('shell.more')} title={t('shell.more')} onClick={() => setMenuOpen((o) => !o)}
          >
            <Icon name="dots" size={16} />
          </button>
          {menuOpen && (
            <div className="shell-composer-menu float" role="menu" aria-label={t('shell.more.title')}>
              <div className="shell-composer-menu-title">{t('shell.more.title')}</div>
              {items.map(([key, label, value]) => (
                <button
                  key={key} type="button" role="menuitem" className="shell-composer-menu-item"
                  title={t('shell.chip.hint')} onClick={() => { closeMenu(); onSettings(); }}
                >
                  <span className="shell-composer-menu-label">{label}</span>
                  <span className="shell-composer-menu-value">{value}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <Tooltip tip={<><Hint label={t('shell.send')} keys={HOTKEY.task} /><Hint label={t('shell.newline')} keys="SHIFT+ENTER" /></>}>
          <button className="sq primary shell-send" onClick={submit} disabled={!connected || meeting || noProvider || uploading || (!draft.trim() && !ids.length)}
            title={uploading ? t('attach.wait') : undefined}>
            <Icon name="arrow-up" size={16} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
