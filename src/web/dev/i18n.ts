// Словари только для dev-only стенда; продукт использует свои ru/en.
export const словари = {
  ru: {
    title: 'Проверить расход рейла',
    help: 'Изолированные тестовые данные. Наведите указатель или нажмите Tab для подсказки; Escape закрывает её. Сеть офиса не используется.',
    scenario: 'Выбрать сценарий', language: 'Выбрать язык', theme: 'Выбрать тему',
    day: 'Светлая', night: 'Тёмная',
    full: 'Полные данные · 5h / 1w', unknown: 'Неизвестная цена и лимиты',
    partial: 'Частичная цена и история', expired: 'Истёкшее время сброса',
    noReset: 'Неизвестное время сброса', long: 'Длинные суммы',
    stale: 'Устаревшие данные', empty: 'Нет данных', loading: 'Переход · ожидание данных',
    edges: 'Границы · 0% / 100%', retry: 'Начать сценарий заново',
    ready: 'Стенд загружен · только fixtures',
  },
  en: {
    title: 'Check rail spending',
    help: 'Isolated fixtures. Hover or press Tab for a tooltip; Escape closes it. No office network is used.',
    scenario: 'Choose scenario', language: 'Choose language', theme: 'Choose theme',
    day: 'Light', night: 'Dark',
    full: 'Full data · 5h / 1w', unknown: 'Unknown cost and limits',
    partial: 'Partial cost and history', expired: 'Expired reset',
    noReset: 'Unknown reset time', long: 'Long amounts',
    stale: 'Stale data', empty: 'No data', loading: 'Transition · waiting for data',
    edges: 'Boundaries · 0% / 100%', retry: 'Restart scenario',
    ready: 'Preview loaded · fixtures only',
  },
};
