/**
 * Ключи провайдеров — только в системной связке ключей (spec провайдеров §5.7).
 *
 * macOS — Keychain через `security`, Windows — хранилище учётных данных через
 * CredRead/CredWrite из PowerShell, Linux — Secret Service через `secret-tool`.
 * Нативный модуль (`@napi-rs/keyring`) не берём: OFFICE.md избегает риска
 * сборки, а системные программы есть везде, где есть сама связка. Ключ уходит
 * программе через stdin, а не аргументом: аргументы видны в списке процессов.
 *
 * В `state.json`, журнал, логи и сообщения веба ключ не попадает. Веб видит
 * только последние четыре знака. Движку ключ отдаётся окружением его процесса
 * (`setEngineSecrets` в childenv.ts), командам агента — никогда.
 *
 * `OFFICE_KEYCHAIN=memory` — связка в памяти процесса: для проверок, чтобы
 * они не трогали настоящий Keychain владельца.
 */
import { execFile } from 'node:child_process';
import { PROVIDER_IDS, type ProviderId } from '../../shared/providers';
import { setEngineSecrets } from '../childenv';
import { LoginError } from './types';

/** Под каким именем ключ провайдера живёт в окружении движка. */
export const KEY_VAR: Record<ProviderId, string> = {
  'claude-code': 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  // У Gemini и Qwen свои имена: ключ уходит только на сервер своего провайдера,
  // а не на чужой, который прочёл бы общую переменную.
  google: 'GEMINI_API_KEY',
  alibaba: 'DASHSCOPE_API_KEY',
  ollama: 'OLLAMA_API_KEY',
  // Своему адресу общеизвестной переменной нет — своё имя, чтобы ключ
  // владельца от OpenAI не уехал на чужой сервер.
  custom: 'OFFICE_CUSTOM_API_KEY',
};

const SERVICE = 'AI Office';
const account = (provider: ProviderId): string => `provider:${provider}`;

export interface KeyStore {
  /** Есть ли связка на этой машине вообще. */
  available(): Promise<boolean>;
  get(provider: ProviderId): Promise<string | null>;
  set(provider: ProviderId, secret: string): Promise<void>;
  delete(provider: ProviderId): Promise<void>;
}

interface Run { code: number; stdout: string; stderr: string }

function run(cmd: string, args: string[], input?: string): Promise<Run> {
  return new Promise((done) => {
    const child = execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.end(input ?? '');
  });
}

const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');

/** macOS: `security -i` читает команды со stdin, ключ передаётся шестнадцатерично (`-X`). */
const macStore: KeyStore = {
  async available() {
    return (await run('security', ['list-keychains'])).code === 0;
  },
  async get(provider) {
    const out = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account(provider), '-w']);
    // 44 — «нет такой записи»: это не поломка, а отсутствие ключа.
    if (out.code === 44) return null;
    if (out.code !== 0) throw new Error(out.stderr.trim() || `security: код ${out.code}`);
    return out.stdout.replace(/\r?\n$/, '') || null;
  },
  async set(provider, secret) {
    const line = `add-generic-password -U -s "${SERVICE}" -a "${account(provider)}" -X ${hex(secret)}\n`;
    const out = await run('security', ['-i'], line);
    if (out.code !== 0 || /error/i.test(out.stderr)) throw new Error(out.stderr.trim() || `security: код ${out.code}`);
  },
  async delete(provider) {
    const out = await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account(provider)]);
    if (out.code !== 0 && out.code !== 44) throw new Error(out.stderr.trim() || `security: код ${out.code}`);
  },
};

/**
 * Windows: Credential Manager через advapi32. Готового командлета для чтения
 * общих учётных данных в PowerShell нет, поэтому — P/Invoke. Сценарий и ключ
 * едут на stdin, имя записи — `AI Office/provider:<id>`.
 */
const WIN_PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OfficeCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) {
      if (Marshal.GetLastWin32Error() == 1168) return null;
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      var bytes = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
      return Encoding.UTF8.GetString(bytes);
    } finally { CredFree(p); }
  }
  public static void Write(string target, string secret) {
    var bytes = Encoding.UTF8.GetBytes(secret);
    var c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.Persist = 2; c.UserName = "AI Office";
    c.CredentialBlobSize = bytes.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length);
      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static void Delete(string target) {
    if (!CredDeleteW(target, 1, 0) && Marshal.GetLastWin32Error() != 1168)
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
`;

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const psString = (s: string): string =>
  `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s)}'))`;

async function powershell(body: string): Promise<Run> {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    `${WIN_PRELUDE}\n${body}\n`);
}

const winTarget = (provider: ProviderId): string => `${SERVICE}/${account(provider)}`;

const winStore: KeyStore = {
  async available() {
    return (await powershell('[OfficeCred]::Read("AI Office/probe") | Out-Null')).code === 0;
  },
  async get(provider) {
    const out = await powershell(
      `$v = [OfficeCred]::Read(${psString(winTarget(provider))}); if ($v -ne $null) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v))) }`);
    if (out.code !== 0) throw new Error(out.stderr.trim() || `powershell: код ${out.code}`);
    const text = out.stdout.trim();
    return text ? Buffer.from(text, 'base64').toString('utf8') : null;
  },
  async set(provider, secret) {
    const out = await powershell(`[OfficeCred]::Write(${psString(winTarget(provider))}, ${psString(secret)})`);
    if (out.code !== 0) throw new Error(out.stderr.trim() || `powershell: код ${out.code}`);
  },
  async delete(provider) {
    const out = await powershell(`[OfficeCred]::Delete(${psString(winTarget(provider))})`);
    if (out.code !== 0) throw new Error(out.stderr.trim() || `powershell: код ${out.code}`);
  },
};

/** Linux: Secret Service (GNOME Keyring, KWallet) через `secret-tool`. */
const linuxStore: KeyStore = {
  async available() {
    // `search` без совпадений тоже даёт код 1, поэтому смотрим на то, запустилась ли программа.
    const out = await run('secret-tool', ['search', 'service', SERVICE]);
    return out.code === 0 || out.code === 1;
  },
  async get(provider) {
    const out = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account(provider)]);
    if (out.code !== 0) return null;
    return out.stdout.replace(/\r?\n$/, '') || null;
  },
  async set(provider, secret) {
    const out = await run('secret-tool',
      ['store', `--label=${SERVICE} ${provider}`, 'service', SERVICE, 'account', account(provider)], secret);
    if (out.code !== 0) throw new Error(out.stderr.trim() || `secret-tool: код ${out.code}`);
  },
  async delete(provider) {
    await run('secret-tool', ['clear', 'service', SERVICE, 'account', account(provider)]);
  },
};

function memoryStore(): KeyStore {
  const map = new Map<ProviderId, string>();
  return {
    async available() { return true; },
    async get(provider) { return map.get(provider) ?? null; },
    async set(provider, secret) { map.set(provider, secret); },
    async delete(provider) { map.delete(provider); },
  };
}

function systemStore(): KeyStore {
  if (process.env.OFFICE_KEYCHAIN === 'memory') return memoryStore();
  if (process.platform === 'darwin') return macStore;
  if (process.platform === 'win32') return winStore;
  return linuxStore;
}

const store = systemStore();

/**
 * Ключи из связки, прочитанные при старте. Запуск сессии синхронный, и ходить
 * в Keychain на каждую — лишние процессы и лишние окна подтверждения.
 */
const cache = new Map<ProviderId, string>();
let loaded: Promise<void> | null = null;
let keychainOk = false;

function publish(): void {
  const secrets: Record<string, string> = {};
  for (const [provider, key] of cache) secrets[KEY_VAR[provider]] = key;
  setEngineSecrets(secrets);
}

/** Прочитать ключи из связки. Повторный вызов отдаёт то же обещание. */
export function loadKeys(): Promise<void> {
  loaded ??= (async () => {
    keychainOk = await store.available().catch(() => false);
    if (!keychainOk) return;
    for (const provider of PROVIDER_IDS) {
      try {
        const key = await store.get(provider);
        if (key) cache.set(provider, key);
      } catch (err) {
        // Отказ связки по одному провайдеру не повод терять остальные.
        console.warn(`[keys] ${provider}: связка ключей не отдала ключ — ${(err as Error).message}`);
      }
    }
    publish();
  })();
  return loaded;
}

export async function keychainAvailable(): Promise<boolean> {
  await loadKeys();
  return keychainOk;
}

/** Ключ провайдера: из связки, а если там нет — из переменной окружения сервера. */
export function providerKey(provider: ProviderId): { key: string; source: 'keychain' | 'env' } | null {
  const stored = cache.get(provider);
  if (stored) return { key: stored, source: 'keychain' };
  const env = process.env[KEY_VAR[provider]]
    || (provider === 'claude-code' ? process.env.ANTHROPIC_AUTH_TOKEN : undefined);
  return env ? { key: env, source: 'env' } : null;
}

/** Положить ключ в связку и сразу отдать его движкам. */
export async function saveKey(provider: ProviderId, secret: string): Promise<void> {
  await loadKeys();
  if (!keychainOk) throw new Error('keychain unavailable');
  await store.set(provider, secret);
  cache.set(provider, secret);
  publish();
}

export async function deleteKey(provider: ProviderId): Promise<void> {
  await loadKeys();
  if (keychainOk) await store.delete(provider);
  cache.delete(provider);
  publish();
}

/**
 * Проверить ключ запросом списка моделей — метаданные, платный ход не
 * делается. 401/403 — ключ не принят; нет ответа — сеть; прочее — текстом.
 */
export async function verifyKey(url: string, headers: Record<string, string>): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new LoginError('network', (err as Error).message);
  }
  if (res.status === 401 || res.status === 403) throw new LoginError('rejected', `HTTP ${res.status}`);
  if (!res.ok) throw new LoginError('network', `HTTP ${res.status}`);
}
