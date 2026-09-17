import { go, readRoute } from './router';
import { useStore } from './store';

/** Применить адрес к стору: открыть офис из ссылки или выйти на главный экран. */
function applyRoute(): void {
  const route = readRoute();
  const s = useStore.getState();
  if (route.kind === 'office') {
    s.enterOffice(route.officeId);
    return;
  }
  // Сначала выход, потом вкладка: иначе подписчик увидел бы вкладку главного
  // экрана при ещё открытом офисе.
  if (s.screen === 'office') s.leaveOffice();
  s.setHomeTab(route.tab);
}

const APP_TITLE = 'AI Office';

// На уровне модуля, а не замыкания: приложение перемонтируется при смене
// языка (`main.tsx`), и адрес, применённый второй раз, дёрнул бы вход повторно.
let applied = false;

/**
 * Связать адрес со стором. Вызывается один раз при старте приложения.
 *
 * До первого снимка адрес не трогаем: список офисов ещё неизвестен, и
 * `/office/o-3` нельзя ни открыть, ни признать несуществующим.
 */
export function startRouting(): () => void {
  // Что адрес видел в прошлый раз. Поправляем его только на перемене экрана
  // или офиса: стор меняется и по сотне других поводов, и в середине перехода
  // («назад» уже сменил адрес, а стор ещё нет) адрес трогать нельзя.
  let seen = '';

  const sync = (force = false) => {
    if (!applied) {
      if (!useStore.getState().booted) return;
      applied = true;
      force = true;
      applyRoute();
    }
    // Состояние читаем после применения адреса: вход мог уже сменить экран.
    const s = useStore.getState();
    const current = s.offices.find((o) => o.current);
    const key = `${s.screen}|${current?.id ?? ''}|${s.pending ?? ''}`;
    if (key === seen && !force) return;
    seen = key;
    // Пока ждём сервер, адрес уже указывает, куда идём, — не перебиваем его.
    if (s.pending) return;
    const route = readRoute();
    if (s.screen === 'office' && current) {
      // Офис создан из меню — это переход, ему место в истории. Офис
      // сменился под открытым (из другой вкладки, из рейла через модалку) —
      // тот же экран, адрес просто поправляется.
      go({ kind: 'office', officeId: current.id }, { replace: route.kind === 'office' });
      document.title = `${current.name} · ${APP_TITLE}`;
    } else {
      // Вход не удался или такого офиса нет — остаёмся в меню, и адрес
      // перестаёт обещать офис.
      if (route.kind === 'office') go({ kind: 'home', tab: s.homeTab }, { replace: true });
      document.title = APP_TITLE;
    }
  };

  const unsubscribe = useStore.subscribe(() => sync());
  const onPopState = () => { applyRoute(); sync(true); };
  window.addEventListener('popstate', onPopState);
  sync();
  return () => { unsubscribe(); window.removeEventListener('popstate', onPopState); };
}
