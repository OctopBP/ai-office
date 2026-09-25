/**
 * Сборка установщиков. Запускается из этой папки: `npm run dist`,
 * а ресурсы к этому моменту уже лежат в resources/ (npm run build:desktop).
 *
 * Конфиг — код, а не yml, ровно из-за подписи macOS: как подписывать, зависит
 * от того, есть ли сертификат в окружении, и третьего способа это выразить нет.
 *
 * Имя файла — не `electron-builder.js` намеренно. На Windows `cmd` ищет
 * команду сначала в текущей папке, а `.JS` входит в PATHEXT: `electron-builder`
 * из npm-скрипта запускал этот конфиг через Windows Script Host, тот молча
 * выходил с нулём, и установщик не собирался без единой ошибки в логе.
 * Ошибиться тут дорого — разница между «система спросит разработчика» и
 * «приложение повреждено, переместите в корзину» целиком в этих строчках.
 */

/** Сертификат Developer ID: из секрета сборки (CSC_LINK) или из связки ключей (CSC_NAME). */
const signed = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

/**
 * Данные для нотаризации. Apple принимает два способа, и оба здесь равноправны:
 * ключ App Store Connect (APPLE_API_*) или Apple ID с паролем приложения.
 * Нотаризация без подписи бессмысленна, поэтому одна без другой не включается.
 */
const notarize = signed && Boolean(
  (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)
  || (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID),
);

if (process.platform === 'darwin') {
  console.log(signed
    ? `подпись macOS: сертификат Developer ID, нотаризация ${notarize ? 'включена' : 'выключена (нет данных Apple ID или ключа)'}`
    : 'подпись macOS: «для себя» (ad-hoc) — сертификата в окружении нет');
}

module.exports = {
  appId: 'dev.aioffice.app',
  productName: 'AI Office',
  copyright: 'Apache-2.0',

  directories: { buildResources: 'build', output: 'out' },

  // В app.asar едет только оболочка. Ресурсы — отдельно: сервер читает их с
  // диска обычным fs, а внутри асара их пришлось бы распаковывать.
  files: [
    'main.js', 'paths.js', 'server.js', 'engine.js', 'preload.js', 'boot.html',
    'build/icon.png', 'package.json',
  ],

  extraResources: [
    { from: 'resources', to: '.' },
    // Agent SDK перечислен отдельно: общий набор ресурсов electron-builder
    // копирует своим фильтром, а тот выбрасывает node_modules — и SDK молча
    // не доезжал в собранное приложение.
    { from: 'resources/node_modules', to: 'node_modules' },
  ],

  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.icns',
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',

    // Без сертификата — подпись «для себя». Это не формальность: Electron
    // приезжает подписанным ad-hoc, сборщик кладёт внутрь ресурсы офиса, и
    // печать перестаёт сходиться. Не переподписать — значит выпустить
    // приложение, которое macOS объявит повреждённым у всех, кто его скачал.
    // С сертификатом поле не задаётся вовсе: electron-builder сам находит
    // Developer ID в связке ключей или во временной, куда положил CSC_LINK.
    ...(signed ? {} : { identity: '-' }),

    // Защищённая среда исполнения — требование нотаризации. Без сертификата
    // она ничего не даёт, а ad-hoc подписи мешает.
    hardenedRuntime: signed,
    notarize,
  },

  win: {
    icon: 'build/icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }],
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    // Офис держит состояние в папке данных пользователя — её удаление при
    // деинсталляции стёрло бы доски и журналы, а они не часть программы.
    deleteAppDataOnUninstall: false,
  },

  publish: { provider: 'github', owner: 'OctopBP', repo: 'ai-office' },
};
