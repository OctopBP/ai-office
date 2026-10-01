(function () {
  'use strict';

  const LEVELS = [
    { id: 1, title: 'Тихая гавань', desc: 'Спокойный уровень для разминки: вода, лодки и один маяк.' },
    { id: 2, title: 'Каменный лабиринт', desc: 'Узкие коридоры, закрытые двери и эхо, которое не врёт.' },
    { id: 3, title: 'Шаткие мосты', desc: 'Переправы над пропастью. Лёгкий шаг и холодная голова.' },
    { id: 4, title: 'Колокольня', desc: 'Лестницы вверх, звон вниз. Следите за временем.' },
    { id: 5, title: 'Последняя дверь', desc: 'Финал каталога: всё, что вы собрали, пригодится здесь.' }
  ];
  const LAYOUTS = { tall: { cols: 1 }, wide: { cols: 2 } };
  const SWIPE_MIN = 50;
  const HINTS_REFRESH_MS = 3000;

  const state = {
    index: 0,
    started: false,
    startedLevel: null,
    swipes: 0,
    layout: 'tall',
    cookieDismissed: false,
    animating: false,
    hints: { loaded: false, count: 0, level: null, error: null }
  };
  const hintsCache = {};
  const root = document.getElementById('app');

  window.__QA_STATE__ = function () {
    const level = LEVELS[state.index];
    return {
      level: { index: state.index, id: level.id, title: level.title, total: LEVELS.length },
      started: state.started,
      startedLevel: state.startedLevel,
      swipes: state.swipes,
      layout: state.layout,
      animating: state.animating,
      cookieDismissed: state.cookieDismissed,
      hints: { loaded: state.hints.loaded, count: state.hints.count, level: state.hints.level, error: state.hints.error }
    };
  };

  function mode() {
    return window.innerWidth > window.innerHeight ? 'wide' : 'tall';
  }

  function el(id) {
    return document.getElementById(id);
  }

  function render(cols) {
    root.style.setProperty('--cols', cols);
    root.innerHTML =
      '<section class="screen">' +
        '<header class="top"><h1>Каталог уровней</h1><p class="status" id="status" aria-live="polite"></p></header>' +
        '<div class="body">' +
          '<div class="deck" id="deck">' +
            '<article class="card" id="card"><p class="counter" id="counter"></p><h2 id="title"></h2><p id="desc"></p></article>' +
            '<div class="dots" id="dots"></div>' +
          '</div>' +
          '<aside class="hints-box"><h3>Подсказки</h3><ul class="hints" id="hints"></ul></aside>' +
        '</div>' +
        '<button type="button" class="start" id="start">Старт</button>' +
        (state.cookieDismissed ? '' :
          '<div class="cookie" id="cookie"><span>Мы используем cookie</span><button type="button" id="cookie-ok">Ок</button></div>') +
      '</section>';
    bind();
    update(false);
    setStatus();
    showHints();
  }

  function relayout() {
    root.textContent = '';
    const layout = LAYOUTS[mode()];
    state.layout = mode();
    render(layout.cols);
  }

  function setStatus() {
    el('status').textContent = state.started ? 'Запущен уровень «' + LEVELS[state.startedLevel - 1].title + '»' : '';
  }

  function update(animate) {
    const level = LEVELS[state.index];
    el('counter').textContent = 'Уровень ' + (state.index + 1) + ' из ' + LEVELS.length;
    el('title').textContent = level.title;
    el('desc').textContent = level.desc;
    el('dots').innerHTML = LEVELS.map(function (_, i) {
      return '<span class="' + (i === state.index ? 'on' : '') + '"></span>';
    }).join('');
    if (animate) {
      const card = el('card');
      card.classList.remove('enter');
      void card.offsetWidth;
      state.animating = true;
      card.addEventListener('animationend', function () { state.animating = false; }, { once: true });
      card.classList.add('enter');
    }
  }

  function go(step) {
    const next = state.index + step;
    if (next < 0 || next >= LEVELS.length) return;
    state.index = next;
    state.swipes += 1;
    update(true);
    showHints();
  }

  function renderHints(list) {
    el('hints').innerHTML = list.map(function (text) { return '<li>' + text + '</li>'; }).join('');
  }

  function fetchHints(id) {
    return fetch('hints/' + id + '.json')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (list) {
        hintsCache[id] = list;
        return list;
      });
  }

  function showHints() {
    const id = LEVELS[state.index].id;
    const cached = hintsCache[id];
    if (cached) {
      renderHints(cached);
      state.hints = { loaded: true, count: cached.length, level: id, error: null };
      return;
    }
    fetchHints(id)
      .then(function (list) {
        if (LEVELS[state.index].id !== id) return;
        renderHints(list);
        state.hints = { loaded: true, count: list.length, level: id, error: null };
      })
      .catch(function (err) {
        if (LEVELS[state.index].id !== id) return;
        el('hints').innerHTML = '<li class="note">Нет сети — подсказки появятся позже</li>';
        state.hints = { loaded: false, count: 0, level: id, error: String(err.message || err) };
      });
  }

  function bind() {
    const deck = el('deck');
    let x0 = 0;
    let y0 = 0;
    deck.addEventListener('touchstart', function (e) {
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
    }, { passive: true });
    deck.addEventListener('touchend', function (e) {
      const dx = e.changedTouches[0].clientX - x0;
      const dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
    }, { passive: true });

    el('start').addEventListener('click', function () {
      state.started = true;
      state.startedLevel = LEVELS[state.index].id;
      setStatus();
    });
    const ok = el('cookie-ok');
    if (ok) {
      ok.addEventListener('click', function () {
        state.cookieDismissed = true;
        el('cookie').remove();
      });
    }
  }

  window.addEventListener('resize', relayout);
  window.addEventListener('online', showHints);
  setInterval(showHints, HINTS_REFRESH_MS);
  LEVELS.forEach(function (level) { fetchHints(level.id).catch(function () {}); });
  render((LAYOUTS[mode()] || LAYOUTS.tall).cols);
  state.layout = mode();
})();
