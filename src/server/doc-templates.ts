/**
 * Шаблоны «Основы» для мастера нового офиса: какие документы типа
 * `foundation` заводятся под тип проекта и что в них лежит на старте.
 *
 * Это данные, а не логика: мастер (setup.ts) только определяет тип проекта и
 * создаёт по набору документы через createDoc. Заготовка — короткие
 * подзаголовки с подсказками, что туда писать; содержание пишут владелец и
 * команда. Язык набора — язык реализации офиса (`codeLanguage`).
 */
import type { Lang } from '../shared/i18n';

/** Тип проекта для набора «Основы». `general` — когда тип не определился. */
export type ProjectKind = 'game' | 'web' | 'general';

export const PROJECT_KINDS: readonly ProjectKind[] = ['game', 'web', 'general'];

export interface DocTemplate {
  title: string;
  /** Одна строка оглавления. */
  summary: string;
  /** Текст заготовки: подзаголовки с подсказками в курсиве. */
  body: string;
}

/** Собрать текст заготовки: заголовок документа и разделы с подсказками. */
function sections(title: string, parts: [string, string][]): string {
  return [`# ${title}`, '', ...parts.flatMap(([head, hint]) => [`## ${head}`, '', `_${hint}_`, ''])].join('\n');
}

function tpl(title: string, summary: string, parts: [string, string][]): DocTemplate {
  return { title, summary, body: sections(title, parts) };
}

const RU: Record<ProjectKind, DocTemplate[]> = {
  game: [
    tpl('Видение', 'Зачем эта игра, для кого и чем она отличается', [
      ['Суть в одной фразе', 'Что это за игра, если объяснять за десять секунд.'],
      ['Для кого', 'Игроки, на которых рассчитана игра, и во что они играют сейчас.'],
      ['Ключевые ощущения', 'Что игрок должен чувствовать: три-пять слов или фраз.'],
      ['Чем отличаемся', 'Что есть у нас и нет у похожих игр.'],
    ]),
    tpl('GDD', 'Дизайн-документ: игровой цикл, механики, прогрессия', [
      ['Основной игровой цикл', 'Что игрок делает раз за разом и зачем.'],
      ['Механики', 'Правила, управление, взаимодействия — по одной на пункт.'],
      ['Прогрессия', 'Как растёт игрок или мир: уровни, открытия, сложность.'],
      ['Платформы и объём', 'Где выходит игра и сколько в ней контента на старте.'],
    ]),
    tpl('Персонажи', 'Герои, противники и второстепенные персонажи', [
      ['Главный герой', 'Кто он, чего хочет, как выглядит и как играется.'],
      ['Противники', 'Кто мешает герою и как с ними сражаются или справляются.'],
      ['Второстепенные персонажи', 'Кто помогает, торгует, рассказывает историю.'],
    ]),
    tpl('Мир и сеттинг', 'Где и когда происходит игра, тон и визуальный стиль', [
      ['Сеттинг', 'Эпоха, место, жанр мира.'],
      ['История мира', 'Что произошло до начала игры и что важно знать игроку.'],
      ['Локации', 'Главные места, где проходит игра.'],
      ['Тон и визуальный стиль', 'Настроение и референсы: на что это должно быть похоже.'],
    ]),
  ],
  web: [
    tpl('Видение и аудитория', 'Зачем продукт, для кого и как поймём, что получилось', [
      ['Суть в одной фразе', 'Что делает продукт и какую проблему решает.'],
      ['Аудитория', 'Кто пользователи, в какой ситуации они приходят и что им нужно.'],
      ['Ценность', 'Почему выберут нас, а не то, чем пользуются сейчас.'],
      ['Метрики успеха', 'По каким числам поймём, что продукт работает.'],
    ]),
    tpl('UX-сценарии', 'Главные пути пользователя по продукту', [
      ['Ключевые сценарии', 'Что пользователь делает от входа до результата, по шагам.'],
      ['Первый визит', 'Что видит новый пользователь и куда его ведём.'],
      ['Структура и навигация', 'Основные страницы или экраны и как между ними переходить.'],
      ['Краевые случаи', 'Пустые состояния, ошибки, нет доступа, медленная сеть.'],
    ]),
    tpl('Дизайн-система', 'Цвета, шрифты, компоненты и принципы интерфейса', [
      ['Принципы', 'Каким должен ощущаться интерфейс: три-пять правил.'],
      ['Цвета и типографика', 'Палитра, шрифты, размеры.'],
      ['Компоненты', 'Кнопки, поля, карточки — что есть и как ими пользоваться.'],
      ['Адаптивность и доступность', 'Ширины экранов, контраст, работа с клавиатуры.'],
    ]),
    tpl('Контент и тексты', 'Голос продукта, словарь и основные тексты', [
      ['Голос и тон', 'Как продукт говорит с пользователем: на «ты» или на «вы», строго или дружески.'],
      ['Словарь', 'Термины продукта и как их писать единообразно.'],
      ['Ключевые тексты', 'Заголовки главной, призывы к действию, сообщения об ошибках.'],
      ['Языки', 'На каких языках продукт и кто отвечает за переводы.'],
    ]),
  ],
  general: [
    tpl('Видение', 'Зачем проект, для кого и каким он должен стать', [
      ['Суть в одной фразе', 'Что это за проект, если объяснять за десять секунд.'],
      ['Для кого', 'Кто будет пользоваться результатом и что им нужно.'],
      ['Каким должен стать', 'Как выглядит проект, когда он удался.'],
    ]),
    tpl('Цели и ограничения', 'Что считаем успехом и в каких рамках работаем', [
      ['Цели', 'Чего добиваемся и как это проверить.'],
      ['Не цели', 'Что сознательно не делаем.'],
      ['Ограничения', 'Сроки, бюджет, технологии, платформы, правовые рамки.'],
      ['Риски', 'Что может помешать и что с этим делать.'],
    ]),
  ],
};

const EN: Record<ProjectKind, DocTemplate[]> = {
  game: [
    tpl('Vision', 'Why this game, who it is for and what sets it apart', [
      ['One-line pitch', 'What the game is, explained in ten seconds.'],
      ['Audience', 'The players the game is for and what they play today.'],
      ['Core feelings', 'What the player should feel: three to five words or phrases.'],
      ['What sets us apart', 'What we have that similar games do not.'],
    ]),
    tpl('GDD', 'Game design document: core loop, mechanics, progression', [
      ['Core loop', 'What the player does again and again, and why.'],
      ['Mechanics', 'Rules, controls, interactions — one per item.'],
      ['Progression', 'How the player or the world grows: levels, unlocks, difficulty.'],
      ['Platforms and scope', 'Where the game ships and how much content it has at launch.'],
    ]),
    tpl('Characters', 'Heroes, enemies and supporting characters', [
      ['Protagonist', 'Who they are, what they want, how they look and play.'],
      ['Enemies', 'Who stands in the way and how the player deals with them.'],
      ['Supporting characters', 'Who helps, trades, tells the story.'],
    ]),
    tpl('World and setting', 'Where and when the game happens, tone and visual style', [
      ['Setting', 'Era, place, genre of the world.'],
      ['World history', 'What happened before the game starts and what the player should know.'],
      ['Locations', 'The main places the game takes place in.'],
      ['Tone and visual style', 'Mood and references: what it should look like.'],
    ]),
  ],
  web: [
    tpl('Vision and audience', 'Why the product exists, who it is for and how we know it works', [
      ['One-line pitch', 'What the product does and which problem it solves.'],
      ['Audience', 'Who the users are, in what situation they come and what they need.'],
      ['Value', 'Why they will choose us over what they use today.'],
      ['Success metrics', 'Which numbers tell us the product works.'],
    ]),
    tpl('UX scenarios', 'The main user paths through the product', [
      ['Key scenarios', 'What the user does from arrival to result, step by step.'],
      ['First visit', 'What a new user sees and where we lead them.'],
      ['Structure and navigation', 'Main pages or screens and how to move between them.'],
      ['Edge cases', 'Empty states, errors, no access, slow network.'],
    ]),
    tpl('Design system', 'Colours, type, components and interface principles', [
      ['Principles', 'How the interface should feel: three to five rules.'],
      ['Colour and typography', 'Palette, fonts, sizes.'],
      ['Components', 'Buttons, fields, cards — what exists and how to use it.'],
      ['Responsiveness and accessibility', 'Screen widths, contrast, keyboard use.'],
    ]),
    tpl('Content and copy', 'Product voice, glossary and key texts', [
      ['Voice and tone', 'How the product talks to the user: formal or friendly.'],
      ['Glossary', 'Product terms and how to spell them consistently.'],
      ['Key texts', 'Home page headlines, calls to action, error messages.'],
      ['Languages', 'Which languages the product ships in and who owns translations.'],
    ]),
  ],
  general: [
    tpl('Vision', 'Why the project exists, who it is for and what it should become', [
      ['One-line pitch', 'What the project is, explained in ten seconds.'],
      ['Audience', 'Who will use the result and what they need.'],
      ['What success looks like', 'How the project looks once it has worked out.'],
    ]),
    tpl('Goals and constraints', 'What counts as success and the limits we work within', [
      ['Goals', 'What we are after and how to check it.'],
      ['Non-goals', 'What we deliberately do not do.'],
      ['Constraints', 'Deadlines, budget, technology, platforms, legal limits.'],
      ['Risks', 'What may get in the way and what to do about it.'],
    ]),
  ],
};

export const FOUNDATION_TEMPLATES: Record<Lang, Record<ProjectKind, DocTemplate[]>> = { ru: RU, en: EN };

/** Набор заготовок «Основы» под тип проекта на языке реализации офиса. */
export function foundationTemplates(kind: ProjectKind, lang: Lang): DocTemplate[] {
  return (FOUNDATION_TEMPLATES[lang] ?? FOUNDATION_TEMPLATES.en)[kind];
}

/**
 * Признаки типа проекта — начала слов в названии, описании и пакетах плана.
 * Сравниваем начало слова, а не подстроку: «игр» ловит «игра» и «игровой»,
 * но «программа» не ловит.
 */
const KIND_STEMS: Record<Exclude<ProjectKind, 'general'>, string[]> = {
  game: [
    'игр', 'геймдизайн', 'геймплей', 'платформер', 'шутер', 'рогалик', 'квест', 'головоломк', 'гдд',
    'game', 'gameplay', 'gdd', 'rpg', 'mmo', 'platformer', 'shooter', 'roguelike', 'puzzle',
    'unity', 'unreal', 'godot', 'phaser',
  ],
  web: [
    'сайт', 'веб', 'лендинг', 'интернет-магазин', 'магазин', 'портал', 'блог', 'saas', 'дашборд', 'кабинет',
    'site', 'website', 'web', 'webapp', 'landing', 'shop', 'e-commerce', 'ecommerce',
    'blog', 'dashboard', 'portal', 'react', 'vue', 'nextjs', 'svelte', 'angular',
  ],
};

/**
 * Тип проекта по тексту, который мастер уже знает о проекте: название,
 * описание, имена и метки пакетов. Побеждает тип с большим числом совпавших
 * слов; ничья или ни одного совпадения — `general`.
 */
export function detectProjectKind(texts: readonly string[]): ProjectKind {
  const words = texts.join(' ').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
  const score = (stems: string[]) => words.filter((w) => stems.some((s) => w.startsWith(s))).length;
  const game = score(KIND_STEMS.game);
  const web = score(KIND_STEMS.web);
  if (game > web) return 'game';
  if (web > game) return 'web';
  return 'general';
}
