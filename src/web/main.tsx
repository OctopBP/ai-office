import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useStore } from './store';
// Шрифты локально, а не с Google Fonts: офис работает без сети.
import '@fontsource-variable/inter';
import '@fontsource-variable/sora';
import './styles/index.css';

/**
 * Стенд подгонки — отдельный экран, а не часть офиса: `?fit=1`.
 *
 * Грузится лениво и только в разработке. Ленью здесь решается не скорость
 * старта, а то, что офис не тащит инструмент разработчика: в сборке стенд
 * лежит отдельным куском, который никто никогда не запрашивает — условие
 * `import.meta.env.DEV` в проде ложно, и до `import()` дело не доходит.
 */
const FitBench = lazy(() => import('./office3d/FitBench').then((m) => ({ default: m.FitBench })));
/** Стенд кита — те же правила: `?kit=1`, лениво, только в разработке. */
const KitBench = lazy(() => import('./KitBench').then((m) => ({ default: m.KitBench })));
/** Стенд скинов — `?skins=1`: все скины персонажа в любой позе, добавление и замена. */
const SkinBench = lazy(() => import('./office3d/SkinBench').then((m) => ({ default: m.SkinBench })));
const params = new URLSearchParams(location.search);
const bench = import.meta.env.DEV && params.has('fit');
const kit = import.meta.env.DEV && params.has('kit');
const skins = import.meta.env.DEV && params.has('skins');

/**
 * Приложение целиком перемонтируется на смене языка офиса.
 *
 * Подписи собирает `t()` из модуля словаря, а не хук: они нужны и стору, и
 * сцене, куда хук не прокинуть. Значит, React сам по себе о смене языка не
 * узнаёт — и половина экрана осталась бы на прежнем. Ключ решает это одним
 * приёмом; язык меняют раз в жизни офиса, и цена перемонтирования тут
 * ничего не значит.
 */
function Root() {
  const lang = useStore((s) => s.lang);
  return <App key={lang} />;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {bench
      ? <Suspense fallback={null}><FitBench /></Suspense>
      : kit
        ? <Suspense fallback={null}><KitBench /></Suspense>
        : skins
          ? <Suspense fallback={null}><SkinBench /></Suspense>
          : <Root />}
  </React.StrictMode>,
);
