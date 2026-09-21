import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { message: string } };
/** One stdio connection per office session; no shared mutable current-thread state. */
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private stderr = '';
  onMessage: (message: RpcMessage) => void = () => {};
  onError: (error: Error) => void = () => {};

  constructor(binary: string, cwd: string, env: NodeJS.ProcessEnv = process.env) {
    this.child = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd, env, stdio: 'pipe' });
    this.child.stderr.on('data', b => { this.stderr = (this.stderr + String(b)).slice(-4000); });
    this.child.on('error', e => this.fail(e));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex app-server exited (${code ?? signal}). ${this.stderr}`)));
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      try {
        const msg = JSON.parse(line) as RpcMessage;
        if (!msg.method && typeof msg.id === 'number') {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id); clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
        } else this.onMessage(msg);
      } catch (e) { this.fail(new Error(`Invalid Codex protocol: ${String(e)}`)); }
    });
  }

  request(method: string, params?: unknown, timeout = 60_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex connection is closed'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }
  send(message: object): void {
    if (!this.closed) this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.onError(error); this.close(error);
  }
  close(error = new Error('Codex session closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.child.stdin.end(); this.child.kill('SIGTERM');
    const kill = setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL'); }, 2000);
    kill.unref();
  }
}
