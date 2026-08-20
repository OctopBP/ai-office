#!/usr/bin/env python3
"""Пиксель-ассеты для экрана меню офисов (T-10): значок офиса для строки
списка, рамка/панель меню, кнопка (обычная/наведение/нажатие/задизейблено),
кадры спиннера загрузки.

Палитру и хелперы (canvas/save/R/P/outline_alpha, SCALE=3, T=16) берём из
gen.py, чтобы значок здания совпадал по стилю с комнатой. Цвета самого UI-хрома
(панель/кнопка/спиннер) заданы отдельно в UI_DAY/UI_NIGHT — это те же значения,
что в src/web/styles.css (:root и [data-theme='night']), чтобы пиксельная рамка
не спорила по цвету с CSS-версией той же панели.

    python3 design/sprites/gen_menu_ui.py            → out/day/*.png и out/night/*.png
    python3 design/sprites/gen_menu_ui.py night      → только ночь
"""
import os
import sys

from PIL import ImageDraw

sys.path.insert(0, os.path.dirname(__file__))
import gen  # noqa: E402  (после sys.path.insert)

# Цвета UI-хрома — зеркало :root / [data-theme='night'] из src/web/styles.css.
UI_DAY = dict(
    BG='#fbf8f2', BG2='#f1ece0', LINE='#2b2233', LINE_SOFT='#cdc2ad',
    ACCENT='#f0b429', ACCENT_INK='#2b2233', MUTED='#7a6f63',
)
UI_NIGHT = dict(
    BG='#221d33', BG2='#2b2440', LINE='#0f0c18', LINE_SOFT='#443a63',
    ACCENT='#f0b429', ACCENT_INK='#2b2233', MUTED='#9a90bb',
)


def _fade(im, target, amt):
    """Смешать непрозрачные пиксели к цвету target — для состояния «задизейблено»."""
    tr, tg, tb = gen._hex(target)
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a:
                px[x, y] = (round(r + (tr - r) * amt), round(g + (tg - g) * amt),
                            round(b + (tb - b) * amt), a)
    return im


def _blend(c1, c2, t):
    r1, g1, b1 = gen._hex(c1)
    r2, g2, b2 = gen._hex(c2)
    return '#%02x%02x%02x' % (round(r1 + (r2 - r1) * t), round(g1 + (g2 - g1) * t), round(b1 + (b2 - b1) * t))


# ---------- 1. значок офиса для строки списка ----------
def menu_icon_office():
    """Домик-офис 16x16: заменяет эмодзи-заглушку 🏢 в строке списка офисов."""
    w, h = 16, 16
    im = gen.canvas(w, h)
    d = ImageDraw.Draw(im)
    # крыша
    gen.R(d, 2, 1, 13, 2, BASEBOARD)
    gen.R(d, 3, 0, 12, 0, BASEBOARD_L)
    gen.R(d, 2, 3, 13, 3, BASEBOARD_L)
    # корпус
    gen.R(d, 2, 4, 13, 13, WALL)
    gen.R(d, 2, 4, 3, 13, gen._light(WALL))
    gen.R(d, 11, 4, 13, 13, WALL_SHADE)
    # окна — тёплый свет ночью, стекло неба днём (как у window())
    glass = '#a9dfff' if not NIGHT else '#f7d774'
    for wx in (4, 9):
        gen.R(d, wx, 6, wx + 2, 8, glass)
        gen.R(d, wx, 6, wx + 2, 6, WHITE if not NIGHT else gen._light(glass))
    # дверь
    gen.R(d, 6, 9, 9, 13, DESK_SIDE)
    gen.R(d, 6, 9, 9, 9, DESK_TOP_L)
    gen.P(d, 8, 11, WHITE if not NIGHT else '#f7d774')
    # цоколь
    gen.R(d, 1, 13, 14, 14, BASEBOARD)
    im = gen.outline_alpha(im, OUT_LINE)
    gen.save(im, 'menu_icon_office')


# ---------- 2. рамка/панель меню ----------
def menu_panel(ui):
    """Гранёная панель 48x16 арт-px под 9-slice: border-image-slice 24 (=8*SCALE) со всех сторон."""
    w, h = 48, 36
    im = gen.canvas(w, h)
    d = ImageDraw.Draw(im)
    gen.R(d, 0, 0, w - 1, h - 1, ui['BG'])
    gen.R(d, 1, 1, w - 2, 1, gen._light(ui['BG']))                 # блик сверху
    gen.R(d, 1, 1, 1, h - 2, gen._light(ui['BG']))                 # блик слева
    gen.R(d, w - 2, 1, w - 2, h - 2, ui['LINE_SOFT'])              # тень справа
    gen.R(d, 1, h - 4, w - 2, h - 2, ui['LINE_SOFT'])              # тень снизу — плотнее (как border-bottom-width:3 в CSS)
    # срез углов на 2px — гранёная рамка вместо скругления
    for (cx, cy, sx, sy) in ((0, 0, 1, 1), (w - 1, 0, -1, 1), (0, h - 1, 1, -1), (w - 1, h - 1, -1, -1)):
        for i in range(2):
            gen.P(d, cx + sx * i, cy, (0, 0, 0, 0))
            gen.P(d, cx, cy + sy * i, (0, 0, 0, 0))
    im = gen.outline_alpha(im, ui['LINE'])
    gen.save(im, 'menu_panel')


# ---------- 3. кнопка: 4 состояния ----------
def menu_button(ui, state):
    """Кнопка 32x16 арт-px под 9-slice: border-image-slice 18 (=6*SCALE) со всех сторон."""
    w, h = 32, 16
    im = gen.canvas(w, h)
    d = ImageDraw.Draw(im)

    fill = {'normal': ui['BG2'], 'hover': ui['BG'], 'active': ui['BG2'], 'disabled': ui['BG2']}[state]
    press = state == 'active'                       # кнопка «утоплена», как button:active в CSS
    shadow_h = 1 if press else 3                     # тень снизу тоньше — имитирует translateY(1px)
    top = 1 if press else 0

    gen.R(d, 0, top, w - 1, h - 1, fill)
    gen.R(d, 1, top + 1, w - 2, top + 1, gen._light(fill) if not press else fill)
    gen.R(d, 1, h - 1 - shadow_h, w - 2, h - 2, ui['LINE_SOFT'])
    if state == 'hover':
        gen.R(d, 0, top, w - 1, top, ui['ACCENT'])    # тонкая тёплая полоска сверху — акцент наведения
    for (cx, cy, sx, sy) in ((0, top, 1, 1), (w - 1, top, -1, 1), (0, h - 1, 1, -1), (w - 1, h - 1, -1, -1)):
        for i in range(2):
            gen.P(d, cx + sx * i, cy, (0, 0, 0, 0))
            gen.P(d, cx, cy + sy * i, (0, 0, 0, 0))

    line = ui['LINE']
    if state == 'disabled':
        im = _fade(im, ui['MUTED'], 0.55)
        line = ui['MUTED']
    im = gen.outline_alpha(im, line)
    gen.save(im, f'menu_button{"" if state == "normal" else "_" + state}')


# ---------- 4. спиннер загрузки (8 кадров) ----------
DIRS = [(0, -4), (3, -3), (4, 0), (3, 3), (0, 4), (-3, 3), (-4, 0), (-3, -3)]


def menu_spinner(ui, frame):
    w = h = 12
    im = gen.canvas(w, h)
    d = ImageDraw.Draw(im)
    cx, cy = 6, 6
    for k in range(3):                                # хвост из 3 точек, дальше — прозрачно
        dx, dy = DIRS[(frame - k) % 8]
        x, y = cx + dx, cy + dy
        if k == 0:
            gen.R(d, x - 1, y - 1, x, y, ui['ACCENT'])
        elif k == 1:
            gen.P(d, x, y, _blend(ui['ACCENT'], ui['LINE_SOFT'], 0.5))
        else:
            gen.P(d, x, y, _blend(ui['ACCENT'], ui['LINE_SOFT'], 0.85))
    im = gen.outline_alpha(im, ui['LINE'])
    gen.save(im, f'menu_spinner_{frame}')


def build(theme):
    gen.use_theme(theme)
    globals().update(gen.THEME)          # WALL, BASEBOARD, DESK_TOP, OUT_LINE, NIGHT и т.д. — как в gen.py
    ui = UI_DAY if theme == 'day' else UI_NIGHT
    menu_icon_office()
    menu_panel(ui)
    for state in ('normal', 'hover', 'active', 'disabled'):
        menu_button(ui, state)
    for i in range(8):
        menu_spinner(ui, i)


if __name__ == '__main__':
    themes = sys.argv[1:] or ['day', 'night']
    for t in themes:
        build(t)
