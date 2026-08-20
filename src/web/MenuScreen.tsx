import { useMemo, useState } from 'react';
import menuBg from '../../design/sprites/out/menu_bg.png';
import { formatLastOpened, retryConnect, sortedOffices, useStore } from './store';

/**
 * Стартовый экран приложения: выбор существующего офиса или создание нового.
 * До входа в офис комната (Office.tsx) не монтируется — вся логика входа
 * и создания живёт в сторе (enterOffice/requestCreateOffice), здесь только
 * отрисовка её состояний. См. docs/design/office-menu/spec.md.
 */
export function MenuScreen() {
  const offices = useStore((s) => s.offices);
  const booted = useStore((s) => s.booted);
  const connected = useStore((s) => s.connected);
  const connectFailed = useStore((s) => s.connectFailed);
  const pending = useStore((s) => s.pending);
  const pendingLabel = useStore((s) => s.pendingLabel);
  const menuNotice = useStore((s) => s.menuNotice);
  const enterOffice = useStore((s) => s.enterOffice);
  const requestCreateOffice = useStore((s) => s.requestCreateOffice);
  const dismissMenuNotice = useStore((s) => s.dismissMenuNotice);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');

  const list = useMemo(() => sortedOffices(offices), [offices]);
  const empty = booted && list.length === 0;
  const showForm = creating || empty;

  const startCreate = () => {
    setName(''); setDir(''); dismissMenuNotice(); setCreating(true);
  };
  const cancelCreate = () => { setCreating(false); dismissMenuNotice(); };
  const submitCreate = () => {
    if (!dir.trim() || pending === 'create') return;
    requestCreateOffice(name, dir);
  };
  // Начали переписывать форму после неудачной попытки — старая ошибка уже не про этот ввод.
  const clearCreateError = () => { if (menuNotice?.kind === 'create-error') dismissMenuNotice(); };

  return (
    <div className="menu-screen" style={{ backgroundImage: `url(${menuBg})` }}>
      <div className="menu-veil" />

      <header className="menu-title">
        <h1>AI OFFICE</h1>
        <p>выберите или создайте офис</p>
      </header>

      <div className="menu-panel pixel">
        {!booted && !connectFailed && (
          <>
            <h2>Ваши офисы</h2>
            <p className="muted menu-loading">Открываем офис<Dots /></p>
          </>
        )}

        {!booted && connectFailed && (
          <div className="menu-conn-error">
            <h2>Ваши офисы</h2>
            <p>Не удаётся подключиться к серверу офиса.</p>
            <button className="primary" onClick={retryConnect}>Повторить</button>
          </div>
        )}

        {booted && pending === 'enter' && (
          <>
            <h2>Ваши офисы</h2>
            <p className="muted menu-loading">Входим в «{pendingLabel}»<Dots /></p>
          </>
        )}

        {booted && pending !== 'enter' && (
          <>
            <h2>{showForm ? 'Новый офис' : 'Ваши офисы'}</h2>

            {!showForm && (
              <>
                <div className="offices menu-offices">
                  {list.map((o) => (
                    <div
                      key={o.id}
                      className={`office-row menu-office-row ${o.current ? 'current' : ''}`}
                      onClick={() => enterOffice(o.id)}
                    >
                      <div className="menu-office-icon" aria-hidden>🏢</div>
                      <div className="office-who">
                        <b>{o.name}</b>
                        <div className="muted mono" title={o.projectDir}>{o.projectDir}</div>
                        <div className="muted small">Открывался: {formatLastOpened(o.lastOpenedAt)}</div>
                      </div>
                      {o.current ? (
                        <span className="chip done">открыт сейчас</span>
                      ) : (
                        <button className="mini go" onClick={(e) => { e.stopPropagation(); enterOffice(o.id); }}>
                          Открыть
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {menuNotice?.kind === 'blocked' && <p className="menu-error">{menuNotice.text}</p>}

                <div className="modal-actions">
                  <button className="primary" onClick={startCreate}>＋ Новый офис</button>
                </div>
              </>
            )}

            {showForm && (
              <>
                {empty && <p className="empty">Офисов пока нет</p>}

                <label>Название
                  <input value={name} placeholder="Новый проект" disabled={pending === 'create'}
                    onChange={(e) => { clearCreateError(); setName(e.target.value); }} />
                </label>
                <label>Директория проекта
                  <input value={dir} placeholder="/Users/you/projects/my-app" disabled={pending === 'create'}
                    onChange={(e) => { clearCreateError(); setDir(e.target.value); }} />
                  <span className="hint muted">
                    Абсолютный путь. Если папки нет, офис создаст её и заведёт git-репозиторий —
                    без него не работает изоляция задач по веткам.
                  </span>
                </label>

                {menuNotice?.kind === 'create-error' && <p className="menu-error">{menuNotice.text}</p>}

                <div className="modal-actions">
                  {!empty && (
                    <button onClick={cancelCreate} disabled={pending === 'create'}>Отмена</button>
                  )}
                  <button className="primary" disabled={!dir.trim() || pending === 'create'} onClick={submitCreate}>
                    {pending === 'create' ? <Dots /> : 'Создать и открыть'}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <footer className="menu-footer muted">
        {connected ? 'подключено к серверу офиса' : 'переподключение к серверу…'}
      </footer>
    </div>
  );
}

function Dots() {
  return <span className="menu-dots"><span /><span /><span /></span>;
}
