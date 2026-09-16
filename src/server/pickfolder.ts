/**
 * Нативный диалог выбора папки. Браузер абсолютный путь не отдаёт, а сервер
 * работает на той же машине, что и человек, — значит, диалог открывает он:
 * на macOS панель AppKit из `osascript -l JavaScript`, на Linux zenity или
 * kdialog, на Windows PowerShell. Итог — путь либо «отменили».
 *
 * Диалог один на процесс: второй одновременно открытый — это два окна на
 * экране, и неясно, к какому полю относится ответ.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Lang } from '../shared/i18n';
import { t } from './i18n';

export type PickResult = { dir: string } | { cancelled: true } | { error: string };

let busy = false;

/** Есть ли на этой системе, чем показать диалог. Витрина мастера прячет кнопку, если нет. */
export function folderPickerAvailable(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return process.platform === 'linux' && Boolean(findOnPath('zenity') || findOnPath('kdialog'));
}

function findOnPath(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const file = `${dir}/${bin}`;
    if (dir && existsSync(file)) return file;
  }
  return null;
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

function run(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/**
 * Показать диалог и дождаться ответа. `start` — где открыть; если папки нет,
 * открываем домашнюю. Ответ без завершающего слэша: путь ложится в поле формы,
 * а там принято без него.
 */
export async function pickFolder(start: string | undefined, lang: Lang): Promise<PickResult> {
  if (busy) return { error: t(lang, 'pick.busy') };
  if (!folderPickerAvailable()) return { error: t(lang, 'pick.unsupported') };
  busy = true;
  try {
    const from = start && isDir(start) ? start : homedir();
    const prompt = t(lang, 'pick.prompt');
    let got: { ok: boolean; stdout: string; stderr: string };
    let cancelled: (r: typeof got) => boolean;
    if (process.platform === 'darwin') {
      // Панель открывает сам процесс osascript через AppKit, а не System
      // Events: Apple-события другому приложению требуют разрешения
      // «Автоматизация» для процесса сервера, и без него было бы
      // «Not authorized to send Apple events» (-1743). Свою панель процесс
      // показывает без разрешений; activateIgnoringOtherApps выводит её
      // поверх окон. Пустой ответ — отмена.
      const script = [
        "ObjC.import('Cocoa');",
        'const app = $.NSApplication.sharedApplication;',
        'app.setActivationPolicy($.NSApplicationActivationPolicyRegular);',
        'const panel = $.NSOpenPanel.openPanel;',
        'panel.canChooseDirectories = true;',
        'panel.canChooseFiles = false;',
        'panel.canCreateDirectories = true;',
        'panel.allowsMultipleSelection = false;',
        `panel.message = ${JSON.stringify(prompt)};`,
        `panel.directoryURL = $.NSURL.fileURLWithPath(${JSON.stringify(from)});`,
        'app.activateIgnoringOtherApps(true);',
        'const ok = panel.runModal === $.NSModalResponseOK;',
        "ok ? ObjC.unwrap(panel.URLs.objectAtIndex(0).path) : '';",
      ].join('\n');
      got = await run('osascript', ['-l', 'JavaScript', '-e', script]);
      cancelled = () => false;
    } else if (process.platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        `$d.Description = '${prompt.replace(/'/g, "''")}'`,
        `$d.SelectedPath = '${from.replace(/'/g, "''")}'`,
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath } else { exit 1 }',
      ].join('; ');
      got = await run('powershell', ['-NoProfile', '-Command', script]);
      cancelled = (r) => !r.ok && !r.stderr.trim();
    } else if (findOnPath('zenity')) {
      got = await run('zenity', ['--file-selection', '--directory', `--title=${prompt}`, `--filename=${from}/`]);
      cancelled = (r) => !r.ok && !r.stderr.trim();
    } else {
      got = await run('kdialog', ['--getexistingdirectory', from, '--title', prompt]);
      cancelled = (r) => !r.ok && !r.stderr.trim();
    }
    if (got.ok) {
      const dir = got.stdout.trim().replace(/\/+$/, '');
      return dir ? { dir } : { cancelled: true };
    }
    if (cancelled(got)) return { cancelled: true };
    return { error: t(lang, 'pick.failed', { error: got.stderr.trim() || cmdName() }) };
  } finally {
    busy = false;
  }
}

const cmdName = (): string => (process.platform === 'darwin' ? 'osascript' : process.platform === 'win32' ? 'powershell' : 'zenity');
