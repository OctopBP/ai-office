/**
 * Адреса приложения. Библиотеки роутинга нет: экранов два, и адрес здесь не
 * рисует экран сам, а только говорит стору, какой офис открыть.
 *
 *   /            — главный экран, вкладка «Офисы»
 *   /spending    — главный экран, вкладка «Расходы»
 *   /settings    — главный экран, вкладка «Настройки»
 *   /office/<id> — открытый офис
 *
 * Источник правды об открытом офисе — по-прежнему стор и сервер: офис на
 * сервере один текущий, и адрес может с ним разойтись (вход отказан, офис
 * переключили из другой вкладки). Поэтому связь двусторонняя: адрес → стор при
 * загрузке и на «назад/вперёд», стор → адрес, когда офис сменился не по ссылке
 * (`routeSync.ts`). Здесь — только разбор и запись адреса, без стора: стор
 * читает адрес при создании, и обратный импорт стал бы циклом.
 */
export type HomeTab = 'offices' | 'spending' | 'settings';
export type Route = { kind: 'home'; tab: HomeTab } | { kind: 'office'; officeId: string };

const TAB_PATH: Record<HomeTab, string> = { offices: '/', spending: '/spending', settings: '/settings' };

export function parseRoute(pathname: string): Route {
  const office = /^\/office\/([^/]+)\/?$/.exec(pathname);
  if (office) {
    try { return { kind: 'office', officeId: decodeURIComponent(office[1]) }; } catch { /* битый адрес — на главный */ }
  }
  const clean = pathname.replace(/\/+$/, '') || '/';
  const tab = (Object.keys(TAB_PATH) as HomeTab[]).find((k) => TAB_PATH[k] === clean);
  return { kind: 'home', tab: tab ?? 'offices' };
}

export function routePath(route: Route): string {
  return route.kind === 'office' ? `/office/${encodeURIComponent(route.officeId)}` : TAB_PATH[route.tab];
}

export const readRoute = (): Route => parseRoute(location.pathname);

/** Сменить адрес, если он другой. Тот же адрес второй записью в историю не ложится. */
export function go(route: Route, opts: { replace?: boolean } = {}): void {
  const path = routePath(route);
  if (location.pathname === path) return;
  if (opts.replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
}

