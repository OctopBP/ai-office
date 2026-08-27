import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/**
 * Стенд подгонки — отдельный экран, а не часть офиса: `?fit=1`.
 *
 * Грузится лениво и только в разработке. Ленью здесь решается не скорость
 * старта, а то, что офис не тащит инструмент разработчика: в сборке стенд
 * лежит отдельным куском, который никто никогда не запрашивает — условие
 * `import.meta.env.DEV` в проде ложно, и до `import()` дело не доходит.
 */
const FitBench = lazy(() => import('./office3d/FitBench').then((m) => ({ default: m.FitBench })));
const bench = import.meta.env.DEV && new URLSearchParams(location.search).has('fit');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {bench
      ? <Suspense fallback={null}><FitBench /></Suspense>
      : <App />}
  </React.StrictMode>,
);
