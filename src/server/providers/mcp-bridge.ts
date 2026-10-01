/**
 * Мост MCP: инструменты офиса для движков, которые не умеют серверы в
 * процессе (spec провайдеров §5.4). OpenCode получает их как удалённый MCP
 * по Streamable HTTP.
 *
 * Мост — на сессию: свой порт на 127.0.0.1 и свой токен. Так агент видит
 * ровно каталог своей сессии, а не инструменты соседей. Токен идёт в
 * заголовке `Authorization: Bearer`, а не в адресе, — адреса попадают в логи.
 * В памяти лежит только хеш токена.
 *
 * Сервер MCP без состояния: на каждый запрос — свой транспорт. Движок может
 * переподключиться (перезапуск MCP-клиента) и снова прислать `initialize`,
 * а транспорт с состоянием на второй `initialize` отвечает ошибкой.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { OfficeTool } from './codex-tools';

export interface Bridge {
  url: string;
  /** Заголовок, с которым движок ходит в мост. Значение — только в конфиг движка. */
  authorization: string;
  close(): Promise<void>;
}

/**
 * Имя инструмента для движка. Имена офиса вида `mcp__office__say` движок
 * получил бы ещё с префиксом сервера; провайдеры OpenAI принимают только
 * `[a-zA-Z0-9_-]{1,64}`. Обратный перевод — по таблице моста.
 */
export const wireName = (name: string): string => name.replace(/^mcp__/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);

/** Вызов инструмента: шлюз разрешений и учёт ходов живут у вызывающего. */
export type BridgeCall = (tool: OfficeTool, input: Record<string, unknown>) => Promise<{
  content: Array<Record<string, unknown>>; isError?: boolean;
}>;

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

export async function startBridge(tools: OfficeTool[], call: BridgeCall): Promise<Bridge> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha(token);
  const byWire = new Map<string, OfficeTool>();
  for (const tool of tools) {
    let name = wireName(tool.name);
    // Два инструмента с одинаковым именем после чистки — второму номер.
    for (let i = 2; byWire.has(name); i++) name = `${wireName(tool.name).slice(0, 56)}_${i}`;
    byWire.set(name, tool);
  }

  const mcpServer = (): Server => {
    const server = new Server({ name: 'ai-office', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...byWire].map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: { type: 'object', ...t.inputSchema } as { type: 'object'; [k: string]: unknown },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = byWire.get(req.params.name);
      if (!tool) return { content: [{ type: 'text', text: `Tool not assigned to this role: ${req.params.name}` }], isError: true };
      try {
        return await call(tool, (req.params.arguments ?? {}) as Record<string, unknown>) as never;
      } catch (err) {
        return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    });
    return server;
  };

  const authorized = (req: IncomingMessage): boolean => {
    const header = String(req.headers.authorization ?? '');
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    return timingSafeEqual(sha(given), tokenHash);
  };

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end(); return; }
    if (!authorized(req)) { res.writeHead(401).end(); return; }
    if (req.method !== 'POST') {
      // Без состояния нет потока уведомлений сервера (GET) и нечего закрывать (DELETE).
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const server = mcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    void server.connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((err: Error) => {
        if (!res.headersSent) res.writeHead(500).end(err.message);
      });
  });
  // Вызов инструмента длится сколько угодно: ответ владельца на вопрос — минуты.
  http.requestTimeout = 0;
  http.headersTimeout = 60_000;

  await new Promise<void>((done, fail) => {
    http.once('error', fail);
    http.listen(0, '127.0.0.1', () => { http.off('error', fail); done(); });
  });
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    authorization: `Bearer ${token}`,
    close: () => new Promise<void>((done) => {
      http.closeAllConnections();
      http.close(() => done());
    }),
  };
}
