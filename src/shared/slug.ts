/**
 * Имя папки из названия: латиница в нижнем регистре, дефисы вместо всего
 * остального, кириллица транслитерируется. Общее для мастера нового офиса
 * (веб предлагает имя папки, сервер выбирает корень офису без проекта) —
 * иначе подсказка в форме и реальная папка разошлись бы.
 */
const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export const SLUG_FALLBACK = 'project';

export function slugify(name: string, fallback = SLUG_FALLBACK): string {
  const latin = Array.from(name.toLowerCase()).map((ch) => CYR[ch] ?? ch).join('');
  const slug = latin.normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
  return slug || fallback;
}
