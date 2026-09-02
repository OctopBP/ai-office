/**
 * Каталог внешних MCP-серверов офиса — раздел «Инструменты» в настройках.
 *
 * Смысл экрана: дать роли инструмент, которого нет в самом Claude Code, не
 * трогая исходники. Сессии агентов поднимаются без настроек Claude Code
 * пользователя, поэтому что у роли под руками — решает этот список, а роли
 * подписываются на серверы в своём редакторе.
 *
 * Проверка живёт на сервере (`checkMcpServers`), а не здесь: то же значение
 * приезжает и из правленого руками файла состояния, и дублировать правила в
 * двух местах — верный способ развести их. Форма только не даёт собрать
 * заведомую бессмыслицу вроде stdio без команды.
 */
import { t } from './i18n';
import { useStore } from './store';
import type { McpServerDef, McpServerState } from '../shared/types';

/** Пустой сервер: с него начинается «добавить». */
const BLANK: McpServerDef = {
  id: '', title: '', transport: 'stdio', command: '', args: [], url: '',
  env: {}, alwaysLoad: true, disabled: false,
};

/** Переменные окружения одной строкой на пару — так их и правят руками. */
const envToText = (env: Record<string, string>): string =>
  Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');

const envFromText = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key) out[key] = line.slice(at + 1).trim();
  }
  return out;
};

/** Просьба пакета: сервер и роли, которым он нужен. */
export interface McpRequest {
  server: McpServerDef;
  roles: string[];
}

/** Чем поднимается сервер — одной строкой, как это увидит человек. */
const howItStarts = (s: McpServerDef): string =>
  (s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url);

/**
 * Подпись состояния сервера. Отдельная строка, а не иконка молча: человеку
 * нужна причина («плагин не открыт», «команда не найдена»), иначе статус
 * заменяет одну догадку другой.
 */
function Status({ state }: { state: McpServerState | undefined }) {
  if (!state) return <span className="mcp-status unknown">{t('settings.mcp.status.unknown')}</span>;
  return (
    <span className={`mcp-status ${state.status}`} title={state.error || undefined}>
      {t(`settings.mcp.status.${state.status}`)}
      {state.status === 'failed' && state.error ? `: ${state.error}` : ''}
    </span>
  );
}

export function McpCatalog({ servers, requests, onChange }: {
  servers: McpServerDef[];
  /** Серверы, которых просят пакеты сотрудников и которых ещё нет в каталоге. */
  requests: McpRequest[];
  onChange: (next: McpServerDef[]) => void;
}) {
  const patch = (index: number, fields: Partial<McpServerDef>): void =>
    onChange(servers.map((s, i) => (i === index ? { ...s, ...fields } : s)));
  // Что о серверах сообщили живые сессии. Пусто — ещё никто не работал.
  const status = useStore((s) => s.mcpStatus);

  return (
    <>
      <h4 className="section-title">{t('settings.mcp.title')}</h4>
      <p className="hint muted">{t('settings.mcp.hint')}</p>

      {requests.length > 0 && (
        <div className="mcp-asks">
          <span className="group-title">{t('settings.mcp.asked')}</span>
          {/* Команда показана до нажатия намеренно: добавить сервер из пакета
              значит согласиться запускать этот процесс на своей машине. */}
          {requests.map((req) => (
            <div key={req.server.id} className="mcp-ask">
              <div>
                <b>{req.server.title || req.server.id}</b>
                <span className="muted"> — {req.roles.join(', ')}</span>
                <div className="mono hint">{howItStarts(req.server)}</div>
              </div>
              <button onClick={() => onChange([...servers, req.server])}>
                {t('settings.mcp.ask.add')}
              </button>
            </div>
          ))}
          <span className="hint">{t('settings.mcp.ask.hint')}</span>
        </div>
      )}

      <div className="mcp-list">
        {servers.map((srv, i) => (
          <div key={i} className={`mcp-item${srv.disabled ? ' off' : ''}`}>
            <div className="mcp-head">
              <input
                className="mcp-id mono" value={srv.id} placeholder={t('settings.mcp.id')}
                onChange={(e) => patch(i, { id: e.target.value.trim() })}
              />
              <input
                className="mcp-title" value={srv.title} placeholder={t('settings.mcp.name')}
                onChange={(e) => patch(i, { title: e.target.value })}
              />
              <select
                value={srv.transport}
                onChange={(e) => patch(i, { transport: e.target.value as McpServerDef['transport'] })}
              >
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
              <button
                className="link-danger"
                onClick={() => onChange(servers.filter((_, k) => k !== i))}
              >
                {t('settings.mcp.remove')}
              </button>
            </div>

            <Status state={status[srv.id]} />

            {srv.transport === 'stdio' ? (
              <label>{t('settings.mcp.command')}
                <input
                  className="mono" value={[srv.command, ...srv.args].join(' ')}
                  placeholder="npx -y @scope/server"
                  onChange={(e) => {
                    const parts = e.target.value.trim().split(/\s+/).filter(Boolean);
                    patch(i, { command: parts[0] ?? '', args: parts.slice(1) });
                  }}
                />
              </label>
            ) : (
              <label>{t('settings.mcp.url')}
                <input
                  className="mono" value={srv.url} placeholder="https://example.com/mcp"
                  onChange={(e) => patch(i, { url: e.target.value.trim() })}
                />
              </label>
            )}

            <label>
              {srv.transport === 'stdio' ? t('settings.mcp.env') : t('settings.mcp.headers')}
              <textarea
                className="mono" rows={2} value={envToText(srv.env)}
                placeholder={'TOKEN=${MY_TOKEN}'}
                onChange={(e) => patch(i, { env: envFromText(e.target.value) })}
              />
              <span className="hint">{t('settings.mcp.env.hint')}</span>
            </label>

            <div className="mcp-flags">
              <label className="checkbox">
                <input
                  type="checkbox" checked={srv.alwaysLoad}
                  onChange={(e) => patch(i, { alwaysLoad: e.target.checked })}
                />
                {t('settings.mcp.alwaysLoad')}
              </label>
              <label className="checkbox">
                <input
                  type="checkbox" checked={!srv.disabled}
                  onChange={(e) => patch(i, { disabled: !e.target.checked })}
                />
                {t('settings.mcp.enabled')}
              </label>
            </div>
          </div>
        ))}
      </div>

      {servers.length > 0 && <p className="hint muted">{t('settings.mcp.status.hint')}</p>}

      <button onClick={() => onChange([...servers, { ...BLANK }])}>
        {t('settings.mcp.add')}
      </button>
    </>
  );
}
