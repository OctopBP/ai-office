/**
 * Схема списка внешностей (`design/models/characters/skins/looks.json`).
 *
 * Отдельно от самого списка (`looks.ts`), потому что разбор нужен и там, где
 * файла ещё нет или он только что переписан: dev-плагину vite, который
 * проверяет запись со стенда до того, как положить её на диск, и самому
 * стенду, который читает файл с диска живьём, а не через импорт. Импортируй
 * этот модуль конфиг vite — вместе с ним подтянулся бы и `looks.json`, а
 * любая правка зависимости конфига перезапускает дев-сервер целиком.
 */
import type { Lang } from './i18n';

export interface Look {
  /** Имя скина в `design/models/characters/skins` — оно же значение `RoleEditable.sprite`. */
  id: string;
  /** Спрайт плоского офиса из каталога (`agent_p1`…`agent_p10`). */
  sprite: string;
  /** Подпись по языкам; пустая — показывается `id`. */
  title: Partial<Record<Lang, string>>;
}

/** Имя скина попадает в путь к файлу, поэтому — только буквы, цифры, `_` и `-`. */
export const LOOK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Человечки плоского офиса, между которыми выбирают спрайт внешности. */
export const SPRITE_ID = /^agent_p\d+$/;

/**
 * Разобрать `looks.json`. Ошибка — исключением с адресом поля: файл правит
 * и стенд, и человек, а испорченный список ронял бы форму роли молча.
 */
export function parseLooks(data: unknown): Look[] {
  const list = (data as { looks?: unknown } | null)?.looks;
  if (!Array.isArray(list)) throw new Error('looks.json: ожидается { "looks": [...] }');
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const at = `looks[${i}]`;
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.id !== 'string' || !LOOK_ID.test(r.id)) throw new Error(`${at}.id: недопустимое имя «${String(r.id)}»`);
    if (seen.has(r.id)) throw new Error(`${at}.id: «${r.id}» встречается дважды`);
    seen.add(r.id);
    if (typeof r.sprite !== 'string' || !SPRITE_ID.test(r.sprite)) throw new Error(`${at}.sprite: ожидается agent_pN, а не «${String(r.sprite)}»`);
    const t = r.title ?? {};
    if (typeof t !== 'object' || Array.isArray(t)) throw new Error(`${at}.title: ожидается { ru, en }`);
    const title: Partial<Record<Lang, string>> = {};
    for (const lang of ['ru', 'en'] as const) {
      const v = (t as Record<string, unknown>)[lang];
      if (v === undefined) continue;
      if (typeof v !== 'string') throw new Error(`${at}.title.${lang}: ожидается строка`);
      if (v.trim()) title[lang] = v.trim();
    }
    return { id: r.id, sprite: r.sprite, title };
  });
}

/** Подпись внешности на языке интерфейса; нет перевода — другой язык, нет и его — имя файла. */
export function lookTitle(look: Look, lang: Lang): string {
  return look.title[lang] ?? look.title.en ?? look.title.ru ?? look.id;
}
