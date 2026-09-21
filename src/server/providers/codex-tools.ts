import { readFile, writeFile, mkdir, realpath, readdir } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { localTools, type SessionOptions } from './index';
import type { CodexRpc } from './rpc';

export interface OfficeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (input: Record<string, any>) => Promise<any>;
}
const text = (value: string) => ({ content: [{ type: 'text', text: value }] });

/** Resolve existing ancestors too: a symlink must not turn an in-workspace write into an escape. */
export async function writablePath(cwd: string, file: string): Promise<string> {
  const root = await realpath(cwd);
  const path = resolve(cwd, file);
  let ancestor = path;
  const missing: string[] = [];
  for (;;) {
    try { ancestor = await realpath(ancestor); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      if (dirname(ancestor) === ancestor) throw e;
      missing.unshift(ancestor.slice(dirname(ancestor).length + 1));
      ancestor = dirname(ancestor);
    }
  }
  const resolved = resolve(ancestor, ...missing);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel) || rel.split('/').includes('.git')) {
    throw new Error('Write outside the session workspace is blocked');
  }
  return resolved;
}

export async function readablePath(roots: string[], cwd: string, file: string): Promise<string> {
  const path = await realpath(resolve(cwd, file));
  for (const root of roots) {
    const rel = relative(await realpath(root), path);
    if (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) return path;
  }
  throw new Error('Read outside the session workspace is blocked');
}

export async function codexTools(options: SessionOptions, rpc: CodexRpc) {
  const cwd = options.cwd ?? process.cwd();
  const readableRoots = [cwd, ...(options.additionalDirectories ?? [])];
  const tools: OfficeTool[] = [];
  const clients: Client[] = [];
  const statuses: Array<{ name: string; status: string; error?: string }> = [];
  const add = (name: string, description: string, shape: z.ZodRawShape, run: OfficeTool['run']) => {
    const schema = z.object(shape);
    tools.push({ name, description, inputSchema: z.toJSONSchema(schema), run: input => run(schema.parse(input)) });
  };
  const enabled = (name: string) => !Array.isArray(options.tools) || options.tools.includes(name);
  const execute = async (command: string[], timeoutMs = 120_000) => {
    const result = await rpc.request('command/exec', { command, cwd, timeoutMs,
      outputBytesCap: 100_000,
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    }, timeoutMs + 10_000);
    return text(`${result.stdout}${result.stderr}${result.exitCode ? `\nExit code: ${result.exitCode}` : ''}`);
  };
  if (enabled('Read')) add('Read', 'Read a UTF-8 file. Offset and limit are in lines.', {
    file_path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(5000).optional(),
  }, async i => text((await readFile(await readablePath(readableRoots, cwd, i.file_path), 'utf8')).split('\n')
    .slice((i.offset ?? 1) - 1, (i.offset ?? 1) - 1 + (i.limit ?? 2000)).join('\n')));
  if (enabled('Write')) add('Write', 'Write a UTF-8 file inside the session workspace.', {
    file_path: z.string(), content: z.string(),
  }, async i => { const path = await writablePath(cwd, i.file_path); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, i.content); return text('Written'); });
  if (enabled('Edit')) add('Edit', 'Replace an exact string in a workspace file. Fails on ambiguous matches.', {
    file_path: z.string(), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional(),
  }, async i => {
    const path = await writablePath(cwd, i.file_path); const before = await readFile(path, 'utf8');
    const parts = before.split(i.old_string);
    if (parts.length === 1 || (!i.replace_all && parts.length !== 2)) throw new Error('Text missing or not unique');
    await writeFile(path, parts.join(i.new_string)); return text('Edited');
  });
  if (enabled('Bash')) add('Bash', 'Run a shell command in the Codex OS sandbox. Writes stay in the workspace.', {
    command: z.string(), timeout: z.number().int().min(1).max(600_000).optional(),
  }, i => execute(['/bin/bash', '-lc', i.command], i.timeout));
  if (enabled('Glob')) add('Glob', 'List files matching a glob using ripgrep.', {
    pattern: z.string(), path: z.string().optional(),
  }, async i => execute(['rg', '--files', '--hidden', '-g', i.pattern, '--', await readablePath(readableRoots, cwd, i.path ?? '.') ]));
  if (enabled('Grep')) add('Grep', 'Search file contents with a regular expression using ripgrep.', {
    pattern: z.string(), path: z.string().optional(), glob: z.string().optional(),
  }, async i => execute(['rg', '-n', '--max-count', '100', ...(i.glob ? ['-g', i.glob] : []), '--', i.pattern,
    await readablePath(readableRoots, cwd, i.path ?? '.') ]));
  if (enabled('TodoWrite')) add('TodoWrite', 'Record a progress checklist for the current task.', {
    todos: z.array(z.object({ content: z.string(), status: z.string(), activeForm: z.string().optional() })),
  }, async i => text(JSON.stringify(i.todos)));

  const skills = new Map<string, string>();
  for (const plugin of options.plugins ?? []) {
    if (plugin.type !== 'local') continue;
    let name: string;
    try { name = JSON.parse(await readFile(resolve(plugin.path, '.claude-plugin/plugin.json'), 'utf8')).name; }
    catch { continue; }
    for (const entry of await readdir(resolve(plugin.path, 'skills'), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const file = resolve(plugin.path, 'skills', entry.name, 'SKILL.md');
      const body = await readFile(file, 'utf8').catch(() => '');
      const skillName = body.match(/^name:\s*["']?([^\n"']+)/m)?.[1]?.trim() ?? entry.name;
      const id = `${name}:${skillName}`;
      if (options.skills === 'all' || options.skills?.includes(id)) skills.set(id, file);
    }
  }
  if (skills.size) add('Skill', `Open an assigned skill before following its instructions. Available: ${[...skills.keys()].join(', ')}`, {
    skill: z.string(),
  }, async i => {
    const path = skills.get(i.skill); if (!path) throw new Error('Skill is not assigned to this role');
    return text(`Skill directory: ${dirname(path)}\n\n${await readFile(path, 'utf8')}`);
  });

  for (const [name, config] of Object.entries(options.mcpServers ?? {})) {
    if ('type' in config && config.type === 'sdk') {
      const definitions = localTools.get(config);
      if (!definitions) throw new Error(`Unregistered office tools: ${name}`);
      for (const def of definitions) {
        const schema = z.object(def.inputSchema);
        tools.push({ name: `mcp__${name}__${def.name}`, description: def.description,
          inputSchema: z.toJSONSchema(schema), run: i => def.handler(schema.parse(i), {}) });
      }
      continue;
    }
    const client = new Client({ name: 'ai-office', version: '1.0.0' });
    clients.push(client);
    try {
      const c = config as any;
      if (!c.type || c.type === 'stdio') {
        await client.connect(new StdioClientTransport({ command: c.command, args: c.args, cwd,
          env: { ...Object.fromEntries(Object.entries(process.env).filter((x): x is [string,string] => typeof x[1] === 'string')), ...c.env } }));
      } else if (c.type === 'http') {
        await client.connect(new StreamableHTTPClientTransport(new URL(c.url), { requestInit: { headers: c.headers } }));
      } else if (c.type === 'sse') {
        await client.connect(new SSEClientTransport(new URL(c.url), { requestInit: { headers: c.headers } }));
      } else throw new Error(`Unsupported MCP transport: ${c.type}`);
      let cursor: string | undefined;
      do {
        const page = await client.listTools({ cursor });
        for (const def of page.tools) tools.push({ name: `mcp__${name}__${def.name}`,
          description: def.description ?? def.name, inputSchema: def.inputSchema,
          run: i => client.callTool({ name: def.name, arguments: i }) });
        cursor = page.nextCursor;
      } while (cursor);
      statuses.push({ name, status: 'connected' });
    } catch (e) { statuses.push({ name, status: 'failed', error: String(e) }); }
  }
  return { tools, statuses, close: async () => { await Promise.allSettled(clients.map(c => c.close())); } };
}
