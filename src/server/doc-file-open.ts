/**
 * Только локальное открытие: HTTP-слой обязан заранее проверить локальность и доступ.
 * кореньОригиналов — серверный join(офис.docsDir(), 'originals'), а не путь клиента.
 * Копия с расширением нужна ассоциации ОС: в хранилище файл называется original.
 * Успешно открытые копии живут до выхода сервера (приложение читает их асинхронно).
 * Как и хранилище, модуль предполагает отсутствие конкурентной подмены каталогов.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { ХранилищеОригиналов } from './doc-files';
import { findFigcraftApp, openCommand, spawnLauncher, type AppLookup, type Launcher } from './figcraft';

export type РезультатОткрытияОригинала =
  | { ok: true }
  | { ok: false; status: 403 | 404 | 415 | 500 | 502; code:
      'not_found' | 'forbidden_path' | 'forbidden_format' | 'storage_error' | 'launch_failed'; error: string };

export interface ПараметрыОткрытияОригинала {
  /** Корень библиотеки originals именно текущего офиса, определяется сервером. */
  кореньОригиналов: string;
  docId: string;
  fileId: string;
}

export interface СредаОткрытияОригинала {
  запуск?: Launcher;
  платформа?: NodeJS.Platform;
  figcraft?: AppLookup;
}

const ФОРМАТЫ = new Set([
  '.pdf', '.txt', '.md', '.csv', '.json', '.rtf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff',
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.figcraft',
]);
const копии = new Set<string>();
process.once('exit', () => {
  for (const папка of копии) {
    try { rmSync(папка, { recursive: true, force: true }); } catch { /* уборка при выходе */ }
  }
});

function внутри(корень: string, путь: string): boolean {
  const остаток = relative(корень, путь);
  return остаток !== '' && остаток !== '..' && !остаток.startsWith('..' + sep) && !isAbsolute(остаток);
}

function ошибка(
  status: 403 | 404 | 415 | 500 | 502,
  code: Exclude<РезультатОткрытияОригинала, { ok: true }>['code'],
  error: string,
): РезультатОткрытияОригинала {
  return { ok: false, status, code, error };
}

/** Для ассоциации ОС ждём код завершения посредника, чтобы заметить отказ приложения. */
const запускАссоциации: Launcher = (команда, аргументы) => new Promise(готово => {
  const процесс = spawn(команда, аргументы, { shell: false, stdio: 'ignore', windowsHide: true });
  процесс.once('error', () => готово({ ok: false, message: 'Не удалось запустить приложение' }));
  процесс.once('close', код => готово(код === 0
    ? { ok: true } : { ok: false, message: 'Приложение отказалось открыть документ' }));
});

export async function открытьОригиналДокумента(
  вход: ПараметрыОткрытияОригинала, среда: СредаОткрытияОригинала = {},
): Promise<РезультатОткрытияОригинала> {
  let папка: string | undefined;
  try {
    const хранилище = new ХранилищеОригиналов(вход.кореньОригиналов);
    const запись = хранилище.метаданные(вход.fileId);
    if (!запись || запись.docId !== вход.docId) {
      return ошибка(404, 'not_found', 'Оригинал документа не найден');
    }
    const корень = realpathSync(хранилище.корень);
    const оригинал = realpathSync(join(хранилище.корень, запись.id, 'original'));
    if (!внутри(корень, оригинал)) return ошибка(403, 'forbidden_path', 'Оригинал вне библиотеки офиса');
    const расширение = extname(запись.имя).toLowerCase();
    if (!ФОРМАТЫ.has(расширение)) return ошибка(415, 'forbidden_format', 'Формат запрещён для локального открытия');
    const байты = хранилище.прочитать(запись.id);
    if (!байты) return ошибка(404, 'not_found', 'Оригинал документа не найден');

    // Никогда не передаём ОС исходный executable, даже с расширением документа.
    const сигнатура = байты.subarray(0, 4).toString('hex');
    if (байты.subarray(0, 2).toString() === '#!' || сигнатура.startsWith('4d5a')
      || ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(сигнатура)) {
      return ошибка(415, 'forbidden_format', 'Исполняемый файл запрещён для локального открытия');
    }

    let команда: string;
    let аргументы: string[];
    let запуск = среда.запуск ?? запускАссоциации;
    const платформа = среда.платформа ?? process.platform;
    // Windows не имеет безопасного посредника ассоциаций без cmd/start.
    if (расширение === '.figcraft') {
      const приложение = findFigcraftApp(среда.figcraft);
      if (!приложение) return ошибка(502, 'launch_failed', 'Приложение FigCraft не найдено');
      папка = mkdtempSync(join(корень, '.open-'));
      const путь = join(папка, запись.имя);
      writeFileSync(путь, байты, { flag: 'wx', mode: 0o600 });
      ({ cmd: команда, args: аргументы } = openCommand(приложение, путь));
      запуск = среда.запуск ?? spawnLauncher;
    } else {
      if (платформа !== 'darwin' && платформа !== 'linux') {
        return ошибка(502, 'launch_failed', 'Локальное открытие на этой ОС не поддерживается');
      }
      папка = mkdtempSync(join(корень, '.open-'));
      const путь = join(папка, запись.имя);
      writeFileSync(путь, байты, { flag: 'wx', mode: 0o600 });
      команда = платформа === 'darwin' ? 'open' : 'xdg-open';
      аргументы = [путь];
    }
    let результат;
    try { результат = await запуск(команда, аргументы); }
    catch { return ошибка(502, 'launch_failed', 'Не удалось запустить приложение документа'); }
    if (!результат.ok) return ошибка(502, 'launch_failed', 'Приложение не смогло открыть документ');
    копии.add(папка);
    папка = undefined;
    return { ok: true };
  } catch (сбой) {
    const код = (сбой as NodeJS.ErrnoException)?.code;
    if (код === 'ENOENT') return ошибка(404, 'not_found', 'Оригинал документа не найден');
    if (код === 'ELOOP' || (сбой instanceof Error && /ссыл|каталог|обычный файл/.test(сбой.message))) {
      return ошибка(403, 'forbidden_path', 'Недопустимый путь оригинала');
    }
    return ошибка(500, 'storage_error', 'Не удалось подготовить оригинал документа');
  } finally {
    if (папка) {
      try { rmSync(папка, { recursive: true, force: true }); } catch { /* исходная ошибка важнее уборки */ }
    }
  }
}
