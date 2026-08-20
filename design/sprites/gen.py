#!/usr/bin/env python3
"""Генератор пиксель-спрайтов для игрового UI AI Office (Figma-концепт).
1 арт-пиксель = SCALE экранных пикселей. Тайл = 16 арт-px = 48 px.
Темы: day (лофт/день) и night (ночь/неон). Запуск:
    python3 design/sprites/gen.py            → out/day/*.png и out/night/*.png
    python3 design/sprites/gen.py night      → только ночь
"""
from PIL import Image, ImageDraw
import os, random, sys

SCALE = 3
T = 16
ROOT = os.path.join(os.path.dirname(__file__), 'out')

# ---------- палитры ----------
PAL_DAY = dict(
    OUT_LINE='#2b2233',
    FLOOR=['#d6a86e', '#cf9f66', '#c99862', '#dcb078'], FLOOR_LINE='#a87a48',
    WALL='#efe4cf', WALL_SHADE='#e2d4ba', WAINSCOT='#d8c39d', WAINSCOT_LINE='#b89b6d',
    BASEBOARD='#8b6b45', BASEBOARD_L='#a5825a', CEIL='#3a2f3a', CEIL_L='#5a4a5a',
    DESK_TOP='#b57d4e', DESK_TOP_L='#c9905e', DESK_SIDE='#8f5d37', DESK_EDGE='#6b4326',
    CHAIR='#4c4562', CHAIR_L='#6b6485', CHAIR_D='#332e45',
    SEAT='#7a4f9c', SEAT_L='#a07ac4', SEAT_D='#553670',
    MON_FRAME='#3b3547', MON_SCREEN='#4fd1ff', MON_SCREEN_D='#2b8fc4', MON_STAND='#2a2536',
    KEYB='#e8e2d6', KEYB_D='#bdb5a6',
    GREEN='#4f9d4a', GREEN_L='#7cc46d', GREEN_D='#2f6b31', POT='#c2683e', POT_D='#8f4a2c',
    WHITE='#fbf8f2',
    KTILE=['#e9e2d3', '#d6cdbb'], KTILE_LINE='#c9bfa8',
    RUG=['#5b6fa8', '#4c5d90', '#3d4a75'],
    GRUG=['#b06a4e', '#96573f', '#6d3c2b'],
    SOFA='#4a8c86', SOFA_L='#6bb0a8', SOFA_D='#2f6260', SOFA_BASE='#2b4a4a',
    CASE='#dfe6ea', CASE_D='#b0bcc6',
    NIGHT=False,
)
PAL_NIGHT = dict(
    OUT_LINE='#14111f',
    FLOOR=['#4a4866', '#454360', '#3f3d58', '#514f6e'], FLOOR_LINE='#2a2840',
    WALL='#2b2d4a', WALL_SHADE='#303256', WAINSCOT='#23243c', WAINSCOT_LINE='#1a1b2e',
    BASEBOARD='#15162a', BASEBOARD_L='#2a2c46', CEIL='#0b0c18', CEIL_L='#1c1d30',
    DESK_TOP='#3d4d7a', DESK_TOP_L='#4c5f94', DESK_SIDE='#2c3a5e', DESK_EDGE='#1c2640',
    CHAIR='#2e2b45', CHAIR_L='#464264', CHAIR_D='#1c1a2e',
    SEAT='#4a3573', SEAT_L='#6a52a0', SEAT_D='#33234f',
    MON_FRAME='#262338', MON_SCREEN='#7fe9ff', MON_SCREEN_D='#3fb0e0', MON_STAND='#1a1826',
    KEYB='#9aa2bd', KEYB_D='#6f778f',
    GREEN='#2f6b31', GREEN_L='#4f9d4a', GREEN_D='#1f4a24', POT='#8f4a2c', POT_D='#5e2f1c',
    WHITE='#c9d0e2',
    KTILE=['#3a3d55', '#33364c'], KTILE_LINE='#282a3c',
    RUG=['#2f4a6e', '#263d5c', '#1d2f48'],
    GRUG=['#4a3560', '#3b2a4e', '#2a1d38'],
    SOFA='#2f5a63', SOFA_L='#3f7684', SOFA_D='#1f3d46', SOFA_BASE='#182e36',
    CASE='#2b2f4a', CASE_D='#1c1f33',
    NIGHT=True,
)
SKIN = ['#f5cfa6', '#e8b88a', '#c68d5f']
THEME = dict(PAL_DAY)
OUT = ROOT


def use_theme(name):
    global THEME, OUT
    THEME = dict(PAL_DAY if name == 'day' else PAL_NIGHT)
    globals().update(THEME)
    OUT = os.path.join(ROOT, name)
    os.makedirs(OUT, exist_ok=True)


def canvas(w, h):
    return Image.new('RGBA', (w, h), (0, 0, 0, 0))


def save(im, name):
    big = im.resize((im.width * SCALE, im.height * SCALE), Image.NEAREST)
    big.save(os.path.join(OUT, name + '.png'))
    print(os.path.basename(OUT), name, big.size)


def R(d, x0, y0, x1, y1, fill, outline=None):
    d.rectangle([x0, y0, x1, y1], fill=fill, outline=outline)


def P(d, x, y, c):
    d.point((x, y), fill=c)


def outline_alpha(im, color=None):
    color = color or OUT_LINE
    w, h = im.size
    src = im.load()
    out = im.copy()
    dst = out.load()
    col = Image.new('RGBA', (1, 1), color).getpixel((0, 0))
    for y in range(h):
        for x in range(w):
            if src[x, y][3] == 0:
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and src[nx, ny][3] != 0:
                        dst[x, y] = col
                        break
    return out


def tint(im, k=(0.50, 0.55, 0.82), add=(8, 12, 40)):
    """Ночной тонинг: приглушить и увести в синий (для неэмиссивных предметов)."""
    if not THEME.get('NIGHT'):
        return im
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a:
                px[x, y] = (min(255, int(r * k[0] + add[0])), min(255, int(g * k[1] + add[1])),
                            min(255, int(b * k[2] + add[2])), a)
    return im


def _hex(c):
    c = c.lstrip('#'); return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def _mix(c, k):
    r, g, b = _hex(c)
    if k > 0:
        r, g, b = [int(v + (255 - v) * k) for v in (r, g, b)]
    else:
        r, g, b = [int(v * (1 + k)) for v in (r, g, b)]
    return '#%02x%02x%02x' % (r, g, b)


def _light(c): return _mix(c, 0.22)
def _dark(c): return _mix(c, -0.25)


# ---------- пол ----------
def floor(cols=24, rows=15, seed=7):
    rnd = random.Random(seed)
    im = canvas(cols * T, rows * T)
    d = ImageDraw.Draw(im)
    W, H = cols * T, rows * T
    PH = 8
    for r in range(H // PH):
        y = r * PH
        x = -rnd.randrange(8, 40)
        while x < W:
            ln = rnd.randrange(28, 56)
            base = FLOOR[rnd.randrange(len(FLOOR))]
            R(d, x, y, x + ln - 1, y + PH - 1, base)
            R(d, x, y, x + ln - 1, y, _mix(base, 0.10))
            R(d, x, y + PH - 1, x + ln - 1, y + PH - 1, FLOOR_LINE)
            R(d, x + ln - 1, y, x + ln - 1, y + PH - 1, FLOOR_LINE)
            for _ in range(ln // 10):
                gx, gy = x + rnd.randrange(1, max(2, ln - 1)), y + rnd.randrange(1, PH - 1)
                if 0 <= gx < W:
                    P(d, gx, gy, _mix(base, -0.08))
            x += ln
    save(im, 'floor')


# ---------- стена ----------
def wall(cols=24, h=32):
    im = canvas(cols * T, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, im.width - 1, h - 1, WALL)
    R(d, 0, 0, im.width - 1, 2, CEIL)
    R(d, 0, 3, im.width - 1, 3, CEIL_L)
    for x in range(4, im.width, 8):
        for y in range(8, h - 12, 8):
            P(d, x + (y // 8 % 2) * 4, y, WALL_SHADE)
    R(d, 0, h - 11, im.width - 1, h - 4, WAINSCOT)
    R(d, 0, h - 11, im.width - 1, h - 11, WAINSCOT_LINE)
    for x in range(0, im.width, 8):
        R(d, x, h - 10, x, h - 5, WAINSCOT_LINE)
    R(d, 0, h - 3, im.width - 1, h - 1, BASEBOARD)
    R(d, 0, h - 3, im.width - 1, h - 3, BASEBOARD_L)
    save(im, 'wall')


# ---------- стол ----------
def desk(name='desk', pm=False, ghost=False):
    w, h = 32, 22
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    if ghost:
        top, topl, side, edge = ('#bfb6a8', '#d0c8bb', '#9c9386', '#7d756a') if not NIGHT else ('#4a4a60', '#585870', '#3a3a4e', '#2c2c3c')
    else:
        top, topl, side, edge = DESK_TOP, DESK_TOP_L, DESK_SIDE, DESK_EDGE
    R(d, 1, 6, w - 2, 15, top)
    R(d, 1, 6, w - 2, 7, topl)
    R(d, 1, 16, w - 2, 19, side)
    R(d, 1, 19, w - 2, 19, edge)
    R(d, 2, 20, 3, 21, edge)
    R(d, w - 4, 20, w - 3, 21, edge)
    if not ghost:
        mx = 11
        R(d, mx, 0, mx + 9, 8, MON_FRAME)          # корпус монитора
        R(d, mx + 4, 9, mx + 5, 9, MON_STAND)
        R(d, mx + 2, 10, mx + 7, 10, MON_STAND)
        R(d, mx - 1, 12, mx + 10, 14, KEYB)          # клавиатура
        R(d, mx - 1, 14, mx + 10, 14, KEYB_D)
        for kx in range(mx, mx + 10, 2):
            P(d, kx, 13, KEYB_D)
        R(d, 26, 11, 28, 14, '#e94f6c'); R(d, 29, 12, 29, 13, '#e94f6c'); R(d, 26, 11, 28, 11, '#ffd0d8')  # кружка
        if pm:
            R(d, 3, 9, 8, 14, WHITE); R(d, 4, 10, 7, 10, '#9aa4b8'); R(d, 4, 12, 6, 12, '#9aa4b8')
            R(d, 3, 2, 6, 5, GREEN); P(d, 2, 3, GREEN_L); P(d, 7, 4, GREEN_L); P(d, 4, 1, GREEN_L)
            R(d, 3, 6, 6, 8, POT); R(d, 3, 8, 6, 8, POT_D)
        elif not NIGHT:
            R(d, 3, 10, 8, 14, '#f7d774'); R(d, 4, 11, 7, 11, '#c9a63d')   # блокнот
        # эмиссивное — экран (и лампа ночью) рисуем без тонинга
        R(d, mx + 1, 1, mx + 8, 6, MON_SCREEN)
        R(d, mx + 1, 5, mx + 8, 6, MON_SCREEN_D)
        R(d, mx + 2, 2, mx + 5, 2, '#ffffff')
        R(d, mx + 2, 4, mx + 6, 4, '#bff0ff')
        if NIGHT and not pm:
            # настольная лампа слева: основание, стойка, абажур, свет
            R(d, 3, 13, 7, 14, '#2a2740'); R(d, 5, 8, 5, 12, '#3b3856')
            R(d, 2, 4, 8, 7, '#e0a83a'); R(d, 3, 3, 7, 3, '#f7d774')
            R(d, 3, 8, 7, 8, '#fff2b0'); R(d, 2, 9, 8, 9, '#fbe38a'); R(d, 3, 10, 7, 11, '#f0cf6a')
        if NIGHT and pm:
            R(d, 3, 2, 6, 2, GREEN_L)
    im = outline_alpha(im, None if not ghost else ('#8a8278' if not NIGHT else '#3a3a4e'))
    save(im, name)


# ---------- стул ----------
def chair():
    w, h = 14, 13
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 2, 1, w - 3, 6, SEAT); R(d, 3, 0, w - 4, 0, SEAT)
    R(d, 3, 1, w - 4, 1, SEAT_L); R(d, 2, 2, 2, 5, SEAT_L)
    R(d, 4, 3, w - 5, 4, SEAT_D)
    R(d, 0, 5, 1, 9, CHAIR); R(d, w - 2, 5, w - 1, 9, CHAIR)
    P(d, 0, 5, CHAIR_L); P(d, w - 2, 5, CHAIR_L)
    R(d, 2, 7, w - 3, 10, SEAT); R(d, 3, 7, w - 4, 7, SEAT_L)
    R(d, 2, 10, w - 3, 10, SEAT_D)
    R(d, 6, 11, 7, 11, CHAIR_D); R(d, 4, 12, 9, 12, CHAIR_D)
    im = outline_alpha(im)
    save(im, 'chair')


# ---------- персонаж (общий для тем) ----------
def agent(name, shirt, hair, skin=SKIN[0], glasses=False, tie=False, headset=False, hood=False):
    w, h = 16, 24
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 4, 19, 6, 22, '#3d3a52'); R(d, 9, 19, 11, 22, '#3d3a52')
    R(d, 3, 22, 6, 23, '#2b2233'); R(d, 9, 22, 12, 23, '#2b2233')
    R(d, 3, 12, 12, 18, shirt)
    R(d, 3, 12, 4, 18, _light(shirt)); R(d, 11, 12, 12, 18, _dark(shirt))
    R(d, 1, 13, 2, 18, shirt); R(d, 13, 13, 14, 18, shirt)
    R(d, 1, 18, 2, 19, skin); R(d, 13, 18, 14, 19, skin)
    R(d, 6, 11, 9, 11, _dark(skin))
    R(d, 3, 2, 12, 10, skin); R(d, 12, 4, 12, 10, _dark(skin))
    R(d, 5, 6, 5, 7, '#2b2233'); R(d, 9, 6, 9, 7, '#2b2233')
    P(d, 5, 6, '#4a4a6a'); P(d, 9, 6, '#4a4a6a')
    R(d, 7, 9, 8, 9, _dark(skin))
    P(d, 4, 8, '#f0a3a0'); P(d, 11, 8, '#f0a3a0')
    R(d, 3, 1, 12, 3, hair); R(d, 3, 4, 3, 6, hair); R(d, 12, 4, 12, 5, hair); R(d, 4, 0, 11, 0, hair)
    if hood:
        R(d, 2, 1, 13, 4, shirt); R(d, 2, 5, 2, 8, shirt); R(d, 13, 5, 13, 8, shirt)
        R(d, 4, 0, 11, 0, shirt); R(d, 3, 2, 12, 2, _light(shirt))
    if glasses:
        R(d, 4, 6, 6, 7, '#2b2233'); R(d, 8, 6, 10, 7, '#2b2233')
        P(d, 5, 6, '#bfe6ff'); P(d, 9, 6, '#bfe6ff'); P(d, 7, 6, '#2b2233')
    if headset:
        R(d, 2, 3, 2, 8, '#2b2233'); R(d, 13, 3, 13, 8, '#2b2233')
        R(d, 3, 0, 12, 0, '#2b2233'); R(d, 12, 8, 13, 9, '#2b2233')
    if tie:
        R(d, 7, 12, 8, 16, '#e94f6c'); R(d, 7, 12, 8, 12, '#ffd0d8')
    im = outline_alpha(im, '#2b2233')
    save(im, name)


# ---------- доска задач ----------
def board():
    w, h = 52, 30
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, '#8b5a34'); R(d, 1, 1, w - 2, 1, '#b57d4e')
    R(d, 2, 2, w - 3, h - 3, '#c9975a')
    for y in range(3, h - 3, 3):
        for x in range(3 + (y % 2), w - 3, 3):
            P(d, x, y, '#b98650')
    im = tint(im, (0.6, 0.6, 0.8), (6, 8, 30))
    d = ImageDraw.Draw(im)
    for i, c in enumerate(['#5b7fd6', '#e0a83a', '#4fae5c']):
        x = 4 + i * 16
        R(d, x, 4, x + 13, 5, c)
    for x, y, c in [(4, 8, '#f7d774'), (4, 15, '#f7d774'), (4, 22, '#bfe6ff'), (20, 8, '#f9a8b8'), (20, 15, '#f7d774'),
                    (36, 8, '#bff0b8'), (36, 15, '#bff0b8'), (36, 22, '#bff0b8')]:
        R(d, x, y, x + 12, y + 5, c); R(d, x + 1, y + 2, x + 9, y + 2, _dark(c)); R(d, x + 1, y + 4, x + 6, y + 4, _dark(c))
        P(d, x + 6, y, '#e94f6c')
    im = outline_alpha(im)
    save(im, 'board')


# ---------- экран лога ----------
def logscreen():
    w, h = 44, 26
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 3, MON_FRAME); R(d, 1, 1, w - 2, 1, _light(MON_FRAME))
    R(d, 2, 2, w - 3, h - 5, '#0f1a1e')
    for y in range(3, h - 5, 2):
        R(d, 3, y, w - 4, y, '#132329')
    R(d, 3, h - 6, 5, h - 6, '#4fe38b')
    R(d, w // 2 - 2, h - 2, w // 2 + 1, h - 1, MON_STAND)
    im = outline_alpha(im)
    save(im, 'logscreen')


# ---------- окно ----------
def window():
    w, h = 34, 24
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    if not NIGHT:
        R(d, 0, 0, w - 1, h - 1, WHITE)
        R(d, 2, 2, w - 3, h - 3, '#8fd3ff'); R(d, 2, 2, w - 3, 8, '#a9dfff')
        R(d, 6, 5, 12, 6, WHITE); R(d, 8, 4, 10, 4, WHITE); R(d, 20, 9, 27, 10, WHITE); R(d, 22, 8, 25, 8, WHITE)
        frame = WHITE
    else:
        R(d, 0, 0, w - 1, h - 1, '#8f97b3')
        R(d, 2, 2, w - 3, h - 3, '#0e1636'); R(d, 2, 2, w - 3, 9, '#0a1028')
        for sx, sy in [(5, 4), (9, 7), (14, 3), (19, 6), (24, 4), (29, 8), (12, 12), (27, 13)]:
            P(d, sx, sy, '#dfe8ff')
        R(d, 22, 4, 26, 8, '#fff2b0'); R(d, 23, 3, 25, 3, '#fff2b0'); R(d, 23, 9, 25, 9, '#fff2b0')  # луна
        R(d, 24, 5, 26, 7, '#0e1636'); R(d, 25, 4, 26, 4, '#0e1636')  # серп
        # силуэт города с окнами
        for bx, bh in [(3, 6), (8, 9), (13, 5), (18, 8), (23, 4), (28, 7)]:
            R(d, bx, h - 3 - bh, bx + 3, h - 3, '#151b3a')
            for wy in range(h - 2 - bh, h - 3, 2):
                P(d, bx + 1, wy, '#f7d774')
        frame = '#8f97b3'
    R(d, w // 2 - 1, 2, w // 2, h - 3, frame)
    R(d, 2, h // 2 - 1, w - 3, h // 2, frame)
    R(d, 0, h - 2, w - 1, h - 1, WAINSCOT)
    im = outline_alpha(im)
    save(im, 'window')


def clock():
    w = 12
    im = canvas(w, w)
    d = ImageDraw.Draw(im)
    d.ellipse([0, 0, w - 1, w - 1], fill=WHITE, outline='#8b5a34')
    R(d, 5, 2, 5, 5, OUT_LINE); R(d, 6, 5, 8, 5, OUT_LINE)
    P(d, 5, 5, '#e94f6c')
    im = outline_alpha(im)
    save(im, 'clock')


def door():
    w, h = 12, 30
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, '#8b5a34'); R(d, 2, 2, w - 3, h - 3, '#b57d4e'); R(d, 3, 3, w - 4, 3, '#c9905e')
    R(d, 3, 6, w - 4, 12, '#a06a3f'); R(d, 3, 16, w - 4, 24, '#a06a3f')
    im = tint(im)
    d = ImageDraw.Draw(im)
    R(d, w - 4, h // 2, w - 3, h // 2 + 1, '#f7d774')
    im = outline_alpha(im)
    save(im, 'door')


def doormat():
    w, h = 16, 8
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, '#7c5b3f')
    for x in range(1, w - 1, 2):
        R(d, x, 1, x, h - 2, '#8f6a48')
    im = tint(im)
    im = outline_alpha(im, '#4a3524' if not NIGHT else OUT_LINE)
    save(im, 'doormat')


def plant(name, big=False):
    w, h = (16, 26) if big else (12, 18)
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    cx = w // 2
    R(d, cx - 4, h - 7, cx + 3, h - 1, POT); R(d, cx - 4, h - 7, cx + 3, h - 6, _light(POT)); R(d, cx - 4, h - 2, cx + 3, h - 1, POT_D)
    leaves = [(cx - 1, h - 14, cx, h - 8), (cx - 5, h - 12, cx - 3, h - 9), (cx + 2, h - 13, cx + 4, h - 9), (cx - 3, h - 17, cx + 2, h - 13)]
    if big:
        leaves += [(cx - 6, h - 20, cx - 2, h - 15), (cx + 2, h - 22, cx + 6, h - 16), (cx - 2, h - 25, cx + 2, h - 19)]
    for i, (x0, y0, x1, y1) in enumerate(leaves):
        R(d, x0, y0, x1, y1, GREEN if i % 2 == 0 else GREEN_D); P(d, x0, y0, GREEN_L)
    im = outline_alpha(im)
    save(im, name)


def cooler():
    w, h = 10, 24
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 2, 0, w - 3, 8, '#8fd3ff'); R(d, 3, 1, 3, 6, '#dff4ff')
    R(d, 1, 9, w - 2, h - 1, '#fbf8f2'); R(d, 1, 9, w - 2, 10, '#c9d3dc'); R(d, 2, h - 3, w - 3, h - 1, '#c9d3dc')
    im = tint(im)
    d = ImageDraw.Draw(im)
    R(d, 3, 13, 4, 14, '#4fa8ff'); R(d, w - 5, 13, w - 4, 14, '#e94f6c')
    im = outline_alpha(im)
    save(im, 'cooler')


def counter():
    w, h = 40, 22
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 6, w - 1, 12, '#dfe6ea'); R(d, 0, 6, w - 1, 6, '#fbf8f2')
    R(d, 0, 13, w - 1, h - 1, '#6b7fa3')
    for x in (13, 26):
        R(d, x, 13, x, h - 1, '#4e5f80')
    for x in (6, 19, 32):
        R(d, x, 16, x + 1, 17, '#f7d774')
    R(d, 3, 0, 11, 6, '#3b3547'); R(d, 4, 1, 10, 1, '#5a536e')
    R(d, 16, 8, 24, 11, '#b7c4cf'); R(d, 19, 5, 20, 8, '#8f9aa5')
    R(d, 30, 8, 36, 11, '#f7d774'); P(d, 31, 8, '#e94f6c'); P(d, 34, 9, '#e94f6c'); P(d, 33, 8, '#4f9d4a')
    im = tint(im)
    d = ImageDraw.Draw(im)
    R(d, 6, 4, 8, 5, '#e94f6c')   # индикатор кофемашины
    im = outline_alpha(im)
    save(im, 'counter')


def fridge():
    w, h = 14, 30
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, '#eef1f4'); R(d, 0, 10, w - 1, 10, '#b7c4cf')
    R(d, w - 4, 4, w - 3, 8, '#8f9aa5'); R(d, w - 4, 13, w - 3, 22, '#8f9aa5')
    R(d, 3, 3, 6, 5, '#f7d774'); R(d, 4, 14, 8, 17, '#8fd3ff')
    im = tint(im)
    im = outline_alpha(im)
    save(im, 'fridge')


def kitchen_tiles(cols=5, rows=4):
    im = canvas(cols * T, rows * T)
    d = ImageDraw.Draw(im)
    for r in range(rows * 2):
        for c in range(cols * 2):
            x, y = c * 8, r * 8
            R(d, x, y, x + 7, y + 7, KTILE[(r + c) % 2])
            R(d, x, y + 7, x + 7, y + 7, KTILE_LINE); R(d, x + 7, y, x + 7, y + 7, KTILE_LINE)
    save(im, 'kitchen_tiles')


def rug(cols=7, rows=4):
    c1, c2, edge = RUG
    im = canvas(cols * T, rows * T)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, im.width - 1, im.height - 1, c1); R(d, 2, 2, im.width - 3, im.height - 3, c2); R(d, 4, 4, im.width - 5, im.height - 5, c1)
    for x in range(6, im.width - 6, 4):
        for y in range(6, im.height - 6, 4):
            P(d, x + (y // 4 % 2) * 2, y, c2)
    R(d, 0, 0, im.width - 1, im.height - 1, None, outline=edge)
    save(im, 'rug')


def round_table():
    w, h = 30, 22
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    d.ellipse([0, 4, w - 1, h - 1], fill=DESK_SIDE); d.ellipse([0, 0, w - 1, h - 5], fill=DESK_TOP); d.ellipse([3, 2, w - 4, h - 9], fill=DESK_TOP_L)
    R(d, 12, 6, 18, 10, MON_FRAME); R(d, 13, 7, 17, 9, MON_SCREEN)
    im = outline_alpha(im)
    save(im, 'round_table')


def bookshelf():
    w, h = 26, 30
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, '#8b5a34'); R(d, 2, 2, w - 3, h - 3, '#5e3d24')
    books = ['#e94f6c', '#4fa8ff', '#f7d774', '#4fae5c', '#a06cd5', '#f28c3a', '#bfe6ff', '#fbf8f2']
    for shelf in range(3):
        y = 4 + shelf * 9
        R(d, 2, y + 7, w - 3, y + 8, '#a06a3f')
        x = 3; i = shelf
        while x < w - 5:
            bw = 2 + (i % 2)
            R(d, x, y + (i % 3 == 0), x + bw - 1, y + 6, books[i % len(books)])
            x += bw + 1; i += 1
    im = tint(im, (0.62, 0.62, 0.85), (6, 8, 30))
    im = outline_alpha(im)
    save(im, 'bookshelf')


def poster():
    w, h = 14, 18
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, '#fbf8f2'); R(d, 2, 2, w - 3, 10, '#4c5d90')
    R(d, 4, 4, 9, 4, '#f7d774'); R(d, 4, 6, 7, 6, '#f7d774'); R(d, 4, 8, 10, 8, '#f7d774')
    R(d, 3, 12, w - 4, 12, '#8f9aa5'); R(d, 3, 14, w - 6, 14, '#8f9aa5')
    im = tint(im)
    im = outline_alpha(im)
    save(im, 'poster')


def neon_sign():
    """Неоновая вывеска «AI» с розовым свечением (для ночной темы; днём — выключена)."""
    w, h = 26, 16
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, '#1a1826')
    on = NIGHT
    glow, tube = ('#7a1f4a', '#ff5ca8') if on else ('#3a2f3a', '#6b4a5c')
    # A
    for (x0, y0, x1, y1) in [(4, 3, 4, 12), (10, 3, 10, 12), (5, 2, 9, 2), (5, 7, 9, 7)]:
        R(d, x0 - 1, y0 - 1, x1 + 1, y1 + 1, glow) if on else None
    for (x0, y0, x1, y1) in [(4, 3, 4, 12), (10, 3, 10, 12), (5, 2, 9, 2), (5, 7, 9, 7)]:
        R(d, x0, y0, x1, y1, tube)
    # I
    R(d, 15, 1, 21, 13, glow) if on else None
    R(d, 16, 2, 20, 2, tube); R(d, 18, 3, 18, 11, tube); R(d, 16, 12, 20, 12, tube)
    im = outline_alpha(im)
    save(im, 'neon_sign')


def server_rack():
    w, h = 14, 30
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, '#262338'); R(d, 1, 1, w - 2, 1, '#3b3547')
    for u in range(5):
        y = 3 + u * 5
        R(d, 2, y, w - 3, y + 3, '#1a1826'); R(d, 2, y, w - 3, y, '#33304a')
        R(d, 3, y + 1, 4, y + 2, '#4fe38b' if u % 2 == 0 else '#4fa8ff')
        P(d, 6, y + 1, '#f7d774' if u == 2 else '#2f2c44'); P(d, 8, y + 2, '#e94f6c' if u == 3 else '#2f2c44')
        R(d, 9, y + 1, w - 4, y + 2, '#3a3750')
    R(d, 2, h - 2, w - 3, h - 1, '#1a1826')
    im = outline_alpha(im)
    save(im, 'server_rack')


# ---------- игровая зона ----------
def game_rug(cols=10, rows=4):
    """Ковёр игровой зоны — тёплый, в «пиксельную ёлочку», чтобы не путался с ковром переговорки."""
    c1, c2, edge = GRUG
    im = canvas(cols * T, rows * T)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, im.width - 1, im.height - 1, c1)
    R(d, 2, 2, im.width - 3, im.height - 3, c2)
    R(d, 4, 4, im.width - 5, im.height - 5, c1)
    for y in range(6, im.height - 6, 6):
        for x in range(6, im.width - 6, 12):
            off = (y // 6 % 2) * 6
            for i in range(4):
                P(d, x + off + i, y + i % 2, c2)
                P(d, x + off + i, y + 3 - i % 2, edge)
    R(d, 0, 0, im.width - 1, im.height - 1, None, outline=edge)
    R(d, 3, 3, im.width - 4, im.height - 4, None, outline=edge)
    save(im, 'game_rug')


def tv():
    """Телевизор на тумбе: экран эмиссивный (не тонируется ночью)."""
    w, h = 32, 30
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    # тумба
    R(d, 1, 21, w - 2, 24, DESK_TOP); R(d, 1, 21, w - 2, 21, DESK_TOP_L)
    R(d, 1, 25, w - 2, 28, DESK_SIDE); R(d, 1, 28, w - 2, 28, DESK_EDGE)
    R(d, 16, 25, 16, 28, DESK_EDGE)
    P(d, 8, 26, DESK_EDGE); P(d, 24, 26, DESK_EDGE)
    R(d, 2, 29, 4, 29, DESK_EDGE); R(d, w - 5, 29, w - 3, 29, DESK_EDGE)
    # корпус
    R(d, 3, 0, w - 4, 20, MON_FRAME); R(d, 4, 1, w - 5, 1, _light(MON_FRAME))
    R(d, 13, 21, 18, 21, MON_STAND)
    im = tint(im)
    d = ImageDraw.Draw(im)
    # экран: пиксельный платформер
    sx, sy = 5, 3
    R(d, sx, sy, sx + 21, sy + 12, '#1b2a55')
    R(d, sx, sy, sx + 21, sy + 3, '#2b3f78')
    for px, py in ((3, 1), (9, 2), (16, 1), (19, 3)):
        P(d, sx + px, sy + py, '#8fb6ff')
    R(d, sx, sy + 10, sx + 21, sy + 12, '#4fae5c'); R(d, sx, sy + 10, sx + 21, sy + 10, '#7cc46d')
    R(d, sx + 3, sy + 7, sx + 6, sy + 8, '#b57d4e'); R(d, sx + 3, sy + 7, sx + 6, sy + 7, '#cf9f66')
    R(d, sx + 12, sy + 5, sx + 15, sy + 6, '#b57d4e'); R(d, sx + 12, sy + 5, sx + 15, sy + 5, '#cf9f66')
    R(d, sx + 4, sy + 8, sx + 5, sy + 9, '#f7d774')       # монетка
    R(d, sx + 8, sy + 8, sx + 10, sy + 9, '#e94f6c')      # герой
    R(d, sx + 8, sy + 7, sx + 10, sy + 7, '#f5cfa6')
    P(d, sx + 9, sy + 6, '#e94f6c')
    R(d, sx + 17, sy + 8, sx + 19, sy + 9, '#a06cd5')     # моб
    P(d, sx + 17, sy + 7, '#a06cd5'); P(d, sx + 19, sy + 7, '#a06cd5')
    R(d, sx + 1, sy + 1, sx + 3, sy + 1, '#fff2b0')       # HUD игры
    # динамик и индикатор
    for x in range(6, 14, 2):
        P(d, x, 18, _light(MON_FRAME))
    R(d, w - 8, 17, w - 5, 18, '#4fe38b')
    im = outline_alpha(im)
    save(im, 'tv')


def console():
    """Приставка с двумя геймпадами — лежит на ковре перед диваном."""
    w, h = 22, 12
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 6, 2, 15, 7, CASE); R(d, 6, 2, 15, 2, _light(CASE)); R(d, 6, 6, 15, 7, CASE_D)
    R(d, 7, 4, 12, 4, CASE_D)
    # провода
    R(d, 4, 5, 5, 5, MON_STAND); R(d, 16, 5, 17, 5, MON_STAND)
    # геймпады
    for gx in (0, 16):
        R(d, gx + 1, 6, gx + 4, 9, MON_FRAME); R(d, gx, 7, gx + 5, 8, MON_FRAME)
        R(d, gx + 1, 6, gx + 4, 6, _light(MON_FRAME))
    im = tint(im)
    d = ImageDraw.Draw(im)
    R(d, 7, 3, 11, 3, '#4fa8ff'); P(d, 14, 3, '#4fe38b')   # подсветка приставки
    P(d, 1, 7, '#e94f6c'); P(d, 3, 8, '#4fa8ff')
    P(d, 17, 7, '#e94f6c'); P(d, 19, 8, '#4fa8ff')
    im = outline_alpha(im)
    save(im, 'console')


def arcade():
    """Аркадный автомат: маркиза и экран светятся (ночью — заметно)."""
    w, h = 16, 32
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 1, 4, w - 2, 30, CHAIR); R(d, 1, 4, 2, 30, CHAIR_L); R(d, w - 3, 4, w - 2, 30, CHAIR_D)
    R(d, 2, 5, w - 3, 15, CHAIR_D)
    R(d, 2, 16, w - 3, 19, CHAIR_L)                       # панель управления
    R(d, 1, 28, w - 2, 31, CHAIR_D)
    R(d, 4, 22, 11, 23, CHAIR_D)                          # монетоприёмник
    im = tint(im, (0.62, 0.62, 0.9), (6, 8, 30))
    d = ImageDraw.Draw(im)
    # маркиза
    glow = '#ff5ca8' if NIGHT else '#e0507a'
    R(d, 0, 0, w - 1, 3, glow); R(d, 1, 1, w - 2, 1, '#ffd0e4')
    for x in (3, 5, 7, 9, 11):
        P(d, x, 2, '#ffffff')
    # экран
    R(d, 3, 6, w - 4, 14, '#0f1a1e')
    R(d, 4, 12, w - 5, 13, '#4fe38b')
    R(d, 6, 8, 8, 9, '#f7d774'); P(d, 10, 7, '#e94f6c'); P(d, 5, 10, '#4fa8ff')
    R(d, 4, 7, 4, 7, '#bff0ff')
    # джойстик и кнопки
    R(d, 4, 17, 4, 18, '#2b2233'); P(d, 4, 16, '#e94f6c')
    P(d, 8, 17, '#f7d774'); P(d, 10, 17, '#4fa8ff'); P(d, 9, 18, '#4fe38b')
    R(d, 5, 22, 9, 22, '#f7d774')
    im = outline_alpha(im)
    save(im, 'arcade')


def _sofa_body(d, w, h):
    back, back_l, back_d = SOFA, SOFA_L, SOFA_D
    R(d, 4, 2, w - 5, 14, back); R(d, 5, 2, w - 6, 3, back_l)
    R(d, 4, 13, w - 5, 14, back_d)
    for x in (w // 3, 2 * w // 3):                        # швы спинки
        R(d, x, 4, x, 12, back_d)
    R(d, 0, 8, 6, 22, back); R(d, w - 7, 8, w - 1, 22, back)   # подлокотники
    R(d, 0, 8, 6, 9, back_l); R(d, w - 7, 8, w - 1, 9, back_l)
    R(d, 6, 15, w - 7, 21, back_l)                        # сиденье
    R(d, 6, 15, w - 7, 15, back)
    for x in (w // 3, 2 * w // 3):
        R(d, x, 16, x, 20, back)
    R(d, 4, 21, w - 5, 25, SOFA_BASE); R(d, 4, 21, w - 5, 21, back_d)  # передняя панель
    R(d, 5, 26, 8, 27, CHAIR_D); R(d, w - 9, 26, w - 6, 27, CHAIR_D)  # ножки
    R(d, 0, 21, 6, 23, back_d); R(d, w - 7, 21, w - 1, 23, back_d)


def sofa():
    """Диван: рисуем целиком, затем нижнюю часть сохраняем отдельно как sofa_front —
    её кладём поверх агентов, чтобы ноги «уходили» за сиденье (как столы поверх агентов)."""
    w, h, cut = 52, 28, 15
    im = canvas(w, h)
    _sofa_body(ImageDraw.Draw(im), w, h)
    im = tint(im, (0.58, 0.58, 0.86), (8, 10, 34))
    im = outline_alpha(im)
    save(im, 'sofa')
    save(im.crop((0, cut, w, h)), 'sofa_front')


def beanbag():
    w, h = 16, 11
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    d.ellipse([0, 2, w - 1, h - 1], fill=GREEN_D)
    d.ellipse([1, 0, w - 2, h - 4], fill=GREEN)
    d.ellipse([3, 1, w - 6, h - 7], fill=GREEN_L)
    P(d, 5, 6, GREEN_D); P(d, 10, 7, GREEN_D)
    im = tint(im)
    im = outline_alpha(im)
    save(im, 'beanbag')


def gamepad():
    """Геймпад в руках сидящего агента (кладём поверх сиденья дивана)."""
    w, h = 10, 6
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 1, 1, w - 2, 4, MON_FRAME); R(d, 0, 2, w - 1, 3, MON_FRAME)
    R(d, 1, 1, w - 2, 1, _light(MON_FRAME))
    im = tint(im)
    d = ImageDraw.Draw(im)
    P(d, 2, 2, '#e8e2d6'); P(d, 1, 3, '#e8e2d6'); P(d, 3, 3, '#e8e2d6'); P(d, 2, 4, '#e8e2d6')
    P(d, 7, 2, '#e94f6c'); P(d, 8, 3, '#4fa8ff')
    P(d, 5, 2, '#4fe38b')
    im = outline_alpha(im)
    save(im, 'gamepad')


def shadow():
    im = canvas(14, 5)
    ImageDraw.Draw(im).ellipse([0, 0, 13, 4], fill=(20, 17, 31, 110))
    save(im, 'shadow')


def coin():
    w = 10
    im = canvas(w, w)
    d = ImageDraw.Draw(im)
    d.ellipse([0, 0, w - 1, w - 1], fill='#f7d774'); d.ellipse([2, 2, w - 3, w - 3], fill='#e0b53a'); R(d, 4, 3, 5, 6, '#f7d774')
    im = outline_alpha(im, '#8a6a12')
    save(im, 'coin')


def build(theme):
    use_theme(theme)
    floor(); wall()
    desk('desk'); desk('desk_pm', pm=True); desk('desk_ghost', ghost=True)
    chair()
    agent('agent_pm', '#f2a33a', '#4a2f1e', SKIN[0], glasses=True, tie=True)
    agent('agent_backend1', '#3b82f6', '#1f1b24', SKIN[1], headset=True)
    agent('agent_backend2', '#3b82f6', '#d99a3a', SKIN[0], hood=True)
    agent('agent_frontend1', '#e0507a', '#c0392b', SKIN[0])
    agent('agent_uiux', '#a06cd5', '#1f1b24', SKIN[2], glasses=True)
    board(); logscreen(); window(); clock(); door(); doormat()
    plant('plant_small'); plant('plant_big', big=True)
    cooler(); counter(); fridge(); kitchen_tiles(cols=8, rows=6); rug(); round_table(); bookshelf(); poster()
    neon_sign(); server_rack(); shadow(); coin()
    game_rug(); tv(); console(); arcade(); sofa(); beanbag(); gamepad()


if __name__ == '__main__':
    themes = sys.argv[1:] or ['day', 'night']
    for t in themes:
        build(t)
