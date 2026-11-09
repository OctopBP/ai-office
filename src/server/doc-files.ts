/**
 * Локальное хранилище: new ХранилищеОригиналов(корень), где корень — отдельный
 * каталог библиотеки рядом с файлом состояния, уникальный для каждого офиса.
 * сохранить({ docId, имя, mime, байты }) возвращает метаданные; метаданные(id),
 * прочитать(id), удалить(id) возвращают null/false для отсутствующего или неверного id.
 * Ошибки диска, повреждение и симлинки вызывают исключение. HTTP и состояние не нужны.
 * Все операции синхронны; каталог принадлежит серверу, внешняя конкурентная подмена
 * каталогов во время системного вызова не поддерживается.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

export const ПРЕДЕЛ_ОРИГИНАЛА = 20 * 1024 * 1024;

export interface МетаданныеОригинала {
  id: string;
  docId: string;
  имя: string;
  mime: string;
  размер: number;
}

export interface НовыйОригинал {
  docId: string;
  имя: string;
  mime?: string;
  байты: Buffer;
}

const ШАБЛОН_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const допустимыйId = (id: unknown): id is string => typeof id === 'string' && ШАБЛОН_ID.test(id);

function нетФайла(ошибка: unknown): boolean {
  return (ошибка as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function безопасноеИмя(исходное: string): string {
  const сегмент = исходное.replace(/\\/g, '/').split('/').pop() ?? '';
  let имя = сегмент.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .trim().replace(/[. ]+$/, '');
  if (!имя || /^\.+$/.test(имя)) имя = 'файл';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(имя)) имя = '_' + имя;
  // Ограничение в байтах подходит и для файловых систем с пределом имени 255 байт.
  while (Buffer.byteLength(имя) > 200) имя = [...имя].slice(0, -1).join('');
  имя = имя.replace(/[. ]+$/, '') || 'файл';
  return имя;
}

function безопасныйMime(mime: string | undefined): string {
  const тип = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+_-]*\/[a-z0-9][a-z0-9.+_-]*$/.test(тип) && тип.length <= 200
    ? тип : 'application/octet-stream';
}

/** Проверяются все компоненты, включая корень и его родителей, без перехода по ссылкам. */
function каталог(путь: string, создать: boolean): boolean {
  const родитель = dirname(путь);
  if (родитель !== путь && !каталог(родитель, создать)) return false;
  try {
    const сведения = lstatSync(путь);
    if (сведения.isSymbolicLink() || !сведения.isDirectory()) {
      throw new Error('Хранилище оригиналов: недопустимый каталог или символическая ссылка');
    }
  } catch (ошибка) {
    if (!нетФайла(ошибка)) throw ошибка;
    if (!создать) return false;
    try { mkdirSync(путь, { mode: 0o700 }); }
    catch (сбой) {
      if ((сбой as NodeJS.ErrnoException).code !== 'EEXIST') throw сбой;
    }
    return каталог(путь, false);
  }
  return true;
}

function проверитьФайл(путь: string): void {
  const сведения = lstatSync(путь);
  if (!сведения.isFile() || сведения.isSymbolicLink() || сведения.nlink !== 1) {
    throw new Error('Хранилище оригиналов: требуется обычный файл без ссылок');
  }
}

function читатьФайл(путь: string): Buffer {
  проверитьФайл(путь);
  const дескриптор = openSync(путь, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const сведения = fstatSync(дескриптор);
    if (!сведения.isFile() || сведения.nlink !== 1 || сведения.size > ПРЕДЕЛ_ОРИГИНАЛА) {
      throw new Error('Хранилище оригиналов: недопустимый файл');
    }
    return readFileSync(дескриптор);
  } finally { closeSync(дескриптор); }
}

export class ХранилищеОригиналов {
  readonly корень: string;

  constructor(корень: string) {
    if (!корень.trim()) throw new Error('Нужен отдельный корень библиотеки офиса');
    this.корень = resolve(корень);
    if (this.корень === parse(this.корень).root) throw new Error('Корень диска не может быть библиотекой');
  }

  сохранить(вход: НовыйОригинал): МетаданныеОригинала {
    if (!Buffer.isBuffer(вход.байты)) throw new Error('Оригинал должен быть Buffer');
    if (вход.байты.length > ПРЕДЕЛ_ОРИГИНАЛА) throw new Error('Файл превышает лимит 20 МиБ');
    if (typeof вход.docId !== 'string' || !вход.docId.trim() || вход.docId.length > 256) {
      throw new Error('Нужен docId длиной от 1 до 256 символов');
    }
    const данные: МетаданныеОригинала = {
      id: randomUUID(), docId: вход.docId, имя: безопасноеИмя(вход.имя),
      mime: безопасныйMime(вход.mime), размер: вход.байты.length,
    };
    каталог(this.корень, true);
    const временный = join(this.корень, '.запись-' + данные.id);
    mkdirSync(временный, { mode: 0o700 });
    try {
      writeFileSync(join(временный, 'original'), вход.байты, { flag: 'wx', mode: 0o600 });
      writeFileSync(join(временный, 'meta.json'), JSON.stringify(данные), { flag: 'wx', mode: 0o600 });
      // Запись видна читателю только после успешной записи обоих файлов.
      renameSync(временный, join(this.корень, данные.id));
      return данные;
    } catch (ошибка) {
      for (const имя of ['meta.json', 'original']) {
        try { unlinkSync(join(временный, имя)); } catch { /* исходная ошибка важнее уборки */ }
      }
      try { rmdirSync(временный); } catch { /* незавершённая запись не видна читателю */ }
      throw ошибка;
    }
  }

  метаданные(id: string): МетаданныеОригинала | null {
    if (!допустимыйId(id) || !каталог(this.корень, false)) return null;
    const папка = join(this.корень, id);
    if (!каталог(папка, false)) return null;
    try {
      const данные: unknown = JSON.parse(читатьФайл(join(папка, 'meta.json')).toString('utf8'));
      const запись = данные as МетаданныеОригинала | null;
      if (!запись || запись.id !== id || typeof запись.docId !== 'string'
        || !запись.docId.trim() || запись.docId.length > 256
        || typeof запись.имя !== 'string' || безопасноеИмя(запись.имя) !== запись.имя
        || typeof запись.mime !== 'string' || безопасныйMime(запись.mime) !== запись.mime
        || !Number.isInteger(запись.размер) || запись.размер < 0 || запись.размер > ПРЕДЕЛ_ОРИГИНАЛА) {
        throw new Error('Повреждены метаданные оригинала');
      }
      const оригинал = join(папка, 'original');
      проверитьФайл(оригинал);
      if (lstatSync(оригинал).size !== запись.размер) throw new Error('Размер оригинала не совпадает с метаданными');
      return { id: запись.id, docId: запись.docId, имя: запись.имя, mime: запись.mime, размер: запись.размер };
    } catch (ошибка) {
      if (нетФайла(ошибка)) return null;
      throw ошибка;
    }
  }

  прочитать(id: string): Buffer | null {
    const данные = this.метаданные(id);
    if (!данные) return null;
    const байты = читатьФайл(join(this.корень, id, 'original'));
    if (байты.length !== данные.размер) throw new Error('Размер оригинала не совпадает с метаданными');
    return байты;
  }

  удалить(id: string): boolean {
    if (!this.метаданные(id)) return false;
    const папка = join(this.корень, id);
    // Без рекурсивного удаления: посторонние файлы и каталоги не затрагиваются.
    unlinkSync(join(папка, 'meta.json'));
    unlinkSync(join(папка, 'original'));
    rmdirSync(папка);
    return true;
  }
}
