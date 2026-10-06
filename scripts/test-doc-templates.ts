/**
 * Проверки шаблонов «Основы» (src/server/doc-templates.ts): наборы под тип
 * проекта на обоих языках и определение типа по тексту плана.
 *
 * Запуск: npm run test:doctemplates
 */
import { LANGS } from '../src/shared/i18n';
import { detectProjectKind, foundationTemplates, PROJECT_KINDS } from '../src/server/doc-templates';

const results: string[] = [];
const check = (text: string, ok: boolean): void => { results.push(`${text}: ${ok}`); };
const titles = (kind: Parameters<typeof foundationTemplates>[0], lang: Parameters<typeof foundationTemplates>[1]) =>
  foundationTemplates(kind, lang).map((d) => d.title).join('|');

// 1. Наборы из задачи — на языке реализации.
check('ru: игра', titles('game', 'ru') === 'Видение|GDD|Персонажи|Мир и сеттинг');
check('ru: сайт', titles('web', 'ru') === 'Видение и аудитория|UX-сценарии|Дизайн-система|Контент и тексты');
check('ru: общий', titles('general', 'ru') === 'Видение|Цели и ограничения');
check('en: игра', titles('game', 'en') === 'Vision|GDD|Characters|World and setting');

// 2. Каждая заготовка: описание и подзаголовки с подсказками; языки — одной длины.
for (const lang of LANGS) {
  for (const kind of PROJECT_KINDS) {
    const docs = foundationTemplates(kind, lang);
    check(`${lang}/${kind}: у всех описание и подзаголовки с подсказками`, docs.length > 0 && docs.every((d) =>
      d.summary.trim() && d.body.startsWith(`# ${d.title}\n`) && (d.body.match(/^## .+\n\n_.+_$/gm) ?? []).length >= 2));
    check(`${lang}/${kind}: столько же документов, сколько в ru`, docs.length === foundationTemplates(kind, 'ru').length);
  }
}

// 3. Тип по тексту плана.
check('тип: игра по описанию', detectProjectKind(['Подземелья', 'Пиксельный рогалик, игровой цикл на 10 минут']) === 'game');
check('тип: game на английском', detectProjectKind(['Space shooter in Godot']) === 'game');
check('тип: сайт', detectProjectKind(['Лендинг для кофейни']) === 'web');
check('тип: веб-приложение', detectProjectKind(['Веб-приложение для учёта задач']) === 'web');
check('тип: SaaS по-английски', detectProjectKind(['A SaaS dashboard for invoices']) === 'web');
check('тип: пусто — общий', detectProjectKind(['', '']) === 'general');
check('тип: ничего не совпало — общий', detectProjectKind(['Витрина', '@office/backend', '@office/frontend', 'code']) === 'general');
check('тип: «программа» — не игра', detectProjectKind(['Программа лояльности']) === 'general');
check('тип: ничья — общий', detectProjectKind(['Сайт игры']) === 'general');

const failed = results.filter((r) => r.endsWith('false'));
console.log(results.join('\n'));
console.log(failed.length ? `\n❌ ${failed.length} проверок упало` : '\n✅ все проверки прошли');
process.exit(failed.length ? 1 : 0);
