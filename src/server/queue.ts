import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Очередь сообщений для streaming-input режима Agent SDK.
 * Позволяет держать сессию живой и «вбрасывать» в неё новые сообщения
 * (например, отчёт о завершённой задаче) без пересоздания сессии —
 * это сохраняет контекст и prompt-кеш.
 */
export class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = [];
  private resolver: ((v: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(text: string): void {
    if (this.closed) return;
    const msg = {
      type: 'user' as const,
      message: { role: 'user' as const, content: text },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage;

    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r({ value: msg, done: false });
    } else {
      this.pending.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const queued = this.pending.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => {
          this.resolver = resolve;
        });
      },
    };
  }
}
