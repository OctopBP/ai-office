#!/usr/bin/env python3
"""Стиль R — «топ-даун по референсу»: вид сверху (лёгкий 3/4), пиксель = 2 экранных px,
тайл = 24 арт-px = 48 px, мягкие отбрасываемые тени, тонкий тёмный контур, приглушённая
палитра (крем · сланцево-синий · дуб · бордо). Запуск: python3 design/sprites/gen_ref.py
→ design/sprites/out/ref/*.png
"""
from PIL import Image, ImageDraw
import os, random

SCALE = 2
T = 24
OUT = os.path.join(os.path.dirname(__file__), 'out', 'ref')
os.makedirs(OUT, exist_ok=True)

# ---------- палитра референса ----------
LINE = '#3a3f4e'          # контур
FLOOR = '#e9e1d2'; FLOOR_N = ['#e4dccb', '#ede6d8', '#e0d7c5']
WALL = '#5f6b7b'; WALL_L = '#6f7b8c'; WALL_D = '#4e5868'
FRAME = '#cfd5dc'; FRAME_D = '#aab2bc'; FRAME_L = '#e6eaee'   # периметр/рамы
SKY = '#cfe3ef'; SKY_L = '#e6f2f8'
OAK = '#d8ae78'; OAK_L = '#e8c692'; OAK_D = '#b98d58'; OAK_E = '#8f6a3f'
SLATE = '#6b7688'; SLATE_L = '#8c97aa'; SLATE_D = '#4e5768'; SLATE_X = '#3d4452'
RED = '#b0463f'; RED_L = '#cf6258'; RED_D = '#7e2f2a'
GREEN = '#3f7d4a'; GREEN_L = '#5aa05f'; GREEN_D = '#2c5a35'
POT = '#b8714e'; POT_D = '#8a5238'; POT_G = '#6b7688'
SCREEN = '#1e2633'; SCREEN_L = '#2b3648'
WHITE = '#f4f1ea'; GREY = '#c9cdd4'; GREY_D = '#9aa2ad'
SKIN = ['#f1cfa8', '#e2b385', '#b98560']
SHADOW = (34, 38, 56, 78); SHADOW_SOFT = (34, 38, 56, 36)


def canvas(w, h):
    return Image.new('RGBA', (w, h), (0, 0, 0, 0))


def save(im, name):
    big = im.resize((im.width * SCALE, im.height * SCALE), Image.NEAREST)
    big.save(os.path.join(OUT, name + '.png'))
    print('ref', name, big.size)


def R(d, x0, y0, x1, y1, fill, outline=None):
    d.rectangle([x0, y0, x1, y1], fill=fill, outline=outline)


def E(d, x0, y0, x1, y1, fill, outline=None):
    d.ellipse([x0, y0, x1, y1], fill=fill, outline=outline)


def P(d, x, y, c):
    d.point((x, y), fill=c)


def _hex(c):
    c = c.lstrip('#'); return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def _mix(c, k):
    r, g, b = _hex(c)
    if k > 0:
        r, g, b = [int(v + (255 - v) * k) for v in (r, g, b)]
    else:
        r, g, b = [int(v * (1 + k)) for v in (r, g, b)]
    return '#%02x%02x%02x' % (r, g, b)


def outline(im, color=LINE):
    """1-px контур вокруг непрозрачных областей (тень не считается — у неё alpha < 200)."""
    w, h = im.size
    src = im.load(); out = im.copy(); dst = out.load()
    col = _hex(color) + (255,)
    for y in range(h):
        for x in range(w):
            if src[x, y][3] < 200:
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and src[nx, ny][3] >= 200:
                        dst[x, y] = col
                        break
    return out


def with_shadow(im, dx=3, dy=4, soft=1):
    """Отбрасываемая тень вниз-вправо (как в референсе): силуэт объекта со сдвигом."""
    w, h = im.size
    out = canvas(w + dx + soft, h + dy + soft)
    src = im.load()
    sh = canvas(w + dx + soft, h + dy + soft); sp = sh.load()
    for y in range(h):
        for x in range(w):
            if src[x, y][3] >= 200:
                sp[x + dx, y + dy] = SHADOW
                for ex, ey in ((1, 0), (0, 1), (1, 1)):
                    xx, yy = x + dx + ex, y + dy + ey
                    if xx < sh.width and yy < sh.height and sp[xx, yy][3] == 0:
                        sp[xx, yy] = SHADOW_SOFT
    out.alpha_composite(sh)
    out.alpha_composite(im, (0, 0))
    return out


def finish(im, name, shadow=True, dx=3, dy=4):
    im = outline(im)
    if shadow:
        im = with_shadow(im, dx, dy)
    save(im, name)


# ---------- пол: ровный крем с лёгким шумом ----------
def floor(cols=24, rows=15, seed=11):
    rnd = random.Random(seed)
    im = canvas(cols * T, rows * T)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, im.width - 1, im.height - 1, FLOOR)
    for _ in range(cols * rows * 6):
        P(d, rnd.randrange(im.width), rnd.randrange(im.height), FLOOR_N[rnd.randrange(3)])
    # едва заметная сетка плит 2×2 тайла
    for x in range(0, im.width, T * 2):
        R(d, x, 0, x, im.height - 1, '#e2d9c8')
    for y in range(0, im.height, T * 2):
        R(d, 0, y, im.width - 1, y, '#e2d9c8')
    save(im, 'floor')


# ---------- стена с окнами (верхняя полоса, 2 тайла) ----------
def wall(cols=24, h=48):
    im = canvas(cols * T, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, im.width - 1, h - 1, WALL)
    R(d, 0, 0, im.width - 1, 1, WALL_D)
    R(d, 0, h - 3, im.width - 1, h - 1, WALL_D)        # плинтус/тень к полу
    R(d, 0, h - 4, im.width - 1, h - 4, WALL_L)
    # 4 окна
    for wx in (28, 168, 352, 470):
        ww, wh, wy = 84, 26, 6
        R(d, wx - 2, wy - 2, wx + ww + 1, wy + wh + 3, FRAME)       # рама
        R(d, wx - 2, wy + wh + 2, wx + ww + 1, wy + wh + 3, FRAME_D)  # подоконник
        R(d, wx, wy, wx + ww - 1, wy + wh - 1, SKY)
        R(d, wx, wy, wx + ww - 1, wy + 6, SKY_L)
        R(d, wx + ww // 2 - 1, wy, wx + ww // 2, wy + wh - 1, FRAME)   # переплёт
        for cx in (wx + 10, wx + 50):                                   # облака
            R(d, cx, wy + 9, cx + 14, wy + 11, SKY_L); R(d, cx + 4, wy + 8, cx + 10, wy + 8, SKY_L)
    save(im, 'wall')


# ---------- рабочий стол (вид сверху, монитор у дальнего края) ----------
def desk(name='desk', pm=False, ghost=False):
    w, h = 46, 28
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    top, l, dk, e = (OAK, OAK_L, OAK_D, OAK_E) if not ghost else ('#d9d3c8', '#e4dfd6', '#bfb8ab', '#9d968a')
    R(d, 0, 4, w - 1, h - 1, top)
    R(d, 0, 4, w - 1, 5, l); R(d, 0, 4, 1, h - 1, l)              # блик верх/лево
    R(d, 0, h - 2, w - 1, h - 1, dk); R(d, w - 2, 4, w - 1, h - 1, dk)  # тень низ/право
    R(d, 2, h - 1, w - 3, h - 1, e)
    if not ghost:
        # монитор: тёмная панель у верхнего края + подставка
        R(d, 15, 0, 30, 9, SLATE_X); R(d, 16, 1, 29, 7, SCREEN)
        R(d, 17, 2, 22, 2, '#6fd3ff'); R(d, 17, 4, 26, 4, '#3fa0d8'); R(d, 17, 6, 20, 6, '#6fd3ff')
        R(d, 21, 10, 24, 11, SLATE_D)
        # клавиатура и мышь
        R(d, 14, 15, 31, 19, GREY); R(d, 14, 19, 31, 19, GREY_D)
        for kx in range(15, 31, 2):
            P(d, kx, 17, GREY_D)
        R(d, 34, 15, 37, 19, GREY); R(d, 34, 15, 37, 15, WHITE)
        # кружка
        E(d, 39, 8, 43, 12, RED_L); P(d, 41, 10, RED)
        if pm:
            R(d, 4, 8, 11, 14, WHITE); R(d, 5, 10, 10, 10, GREY_D); R(d, 5, 12, 8, 12, GREY_D)  # бумаги
            E(d, 3, 17, 10, 24, GREEN); E(d, 5, 19, 8, 22, GREEN_L)                            # растение
        else:
            R(d, 4, 17, 10, 24, '#f2d98a'); R(d, 5, 19, 9, 19, '#c9a63d'); R(d, 5, 21, 8, 21, '#c9a63d')  # блокнот
    finish(im, name, shadow=not ghost)


# ---------- офисное кресло (вид сверху-3/4) ----------
def chair(name='chair', body=SLATE, light=SLATE_L, dark=SLATE_D, arm=True):
    w, h = 22, 26
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    # крестовина
    R(d, 10, 20, 11, 25, SLATE_X); R(d, 4, 24, 17, 25, SLATE_X); R(d, 6, 22, 15, 23, SLATE_X)
    # спинка (скруглённый верх)
    R(d, 4, 0, 17, 8, dark); R(d, 5, 0, 16, 0, dark); R(d, 3, 1, 18, 8, dark)
    R(d, 5, 1, 16, 6, body); R(d, 6, 1, 15, 1, light); R(d, 5, 2, 5, 5, light)
    # сиденье
    R(d, 3, 8, 18, 19, body); R(d, 4, 8, 17, 8, light); R(d, 3, 9, 3, 17, light)
    R(d, 3, 19, 18, 19, dark); R(d, 18, 9, 18, 19, dark)
    R(d, 7, 12, 14, 15, light)   # подушка-блик
    if arm:
        R(d, 0, 7, 2, 18, dark); R(d, 19, 7, 21, 18, dark)
        R(d, 0, 7, 2, 8, body); R(d, 19, 7, 21, 8, body)
    finish(im, name)


def armchair():
    """Бордовое кресло из референса: широкое, с подлокотниками-валиками."""
    w, h = 26, 26
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 3, 0, 22, 9, RED_D); R(d, 4, 0, 21, 0, RED_D)
    R(d, 4, 1, 21, 7, RED); R(d, 5, 1, 20, 1, RED_L); R(d, 4, 2, 4, 6, RED_L)
    R(d, 3, 9, 22, 21, RED); R(d, 4, 9, 21, 9, RED_L); R(d, 3, 21, 22, 21, RED_D)
    R(d, 7, 12, 18, 17, RED_L)
    R(d, 0, 6, 3, 22, RED_D); R(d, 22, 6, 25, 22, RED_D); R(d, 0, 6, 3, 7, RED_L); R(d, 22, 6, 25, 7, RED_L)
    R(d, 1, 22, 4, 24, SLATE_X); R(d, 21, 22, 24, 24, SLATE_X)   # ножки
    finish(im, 'armchair')


# ---------- персонаж (сверху-3/4: волосы, лицо, плечи) ----------
def agent(name, shirt, hair, skin=SKIN[0], glasses=False, tie=False, hood=False, standing=False):
    w, h = (22, 32) if standing else (22, 22)
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    # плечи/туловище
    R(d, 1, 12, 20, 21, shirt); R(d, 2, 12, 19, 12, _mix(shirt, 0.25)); R(d, 1, 13, 1, 20, _mix(shirt, 0.25))
    R(d, 19, 13, 20, 21, _mix(shirt, -0.3)); R(d, 1, 21, 20, 21, _mix(shirt, -0.3))
    if standing:
        R(d, 4, 22, 17, 27, _mix(shirt, -0.15)); R(d, 5, 28, 9, 31, '#3d4452'); R(d, 12, 28, 16, 31, '#3d4452')
    if tie:
        R(d, 10, 14, 11, 20, RED); R(d, 10, 14, 11, 14, RED_L)
    # голова (овал), лицо в нижней половине
    E(d, 4, 1, 17, 15, skin)
    R(d, 5, 2, 16, 8, hair); E(d, 4, 0, 17, 9, hair); R(d, 4, 4, 4, 11, hair); R(d, 17, 4, 17, 10, hair)
    P(d, 7, 2, _mix(hair, 0.25)); P(d, 8, 1, _mix(hair, 0.25)); P(d, 9, 1, _mix(hair, 0.25))
    if hood:
        E(d, 3, 0, 18, 10, shirt); R(d, 3, 4, 3, 12, shirt); R(d, 18, 4, 18, 12, shirt); R(d, 5, 2, 16, 7, hair)
    R(d, 7, 10, 8, 11, LINE); R(d, 13, 10, 14, 11, LINE)      # глаза
    P(d, 6, 12, '#f0a3a0'); P(d, 15, 12, '#f0a3a0')           # щёки
    R(d, 10, 13, 11, 13, _mix(skin, -0.3))                    # рот
    if glasses:
        R(d, 6, 10, 9, 11, LINE); R(d, 12, 10, 15, 11, LINE); R(d, 10, 10, 11, 10, LINE)
        P(d, 7, 10, '#bfe6ff'); P(d, 13, 10, '#bfe6ff')
    finish(im, name, dx=2, dy=3)


# ---------- большой стол переговорки ----------
def meeting_table():
    w, h = 80, 44
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, OAK); R(d, 0, 0, w - 1, 1, OAK_L); R(d, 0, 0, 1, h - 1, OAK_L)
    R(d, 0, h - 2, w - 1, h - 1, OAK_D); R(d, w - 2, 0, w - 1, h - 1, OAK_D)
    R(d, 4, 4, w - 5, h - 5, None, outline=OAK_D)     # кромка
    # ноутбук, бумаги, кружки
    R(d, 30, 14, 49, 27, SLATE_X); R(d, 31, 15, 48, 25, SCREEN); R(d, 33, 17, 42, 17, '#6fd3ff'); R(d, 33, 19, 46, 19, '#3fa0d8')
    R(d, 8, 8, 18, 15, WHITE); R(d, 9, 10, 16, 10, GREY_D); R(d, 9, 12, 14, 12, GREY_D)
    R(d, 60, 28, 70, 35, WHITE); R(d, 61, 30, 68, 30, GREY_D)
    E(d, 10, 30, 15, 35, RED_L); E(d, 62, 8, 67, 13, SLATE_L)
    finish(im, 'meeting_table', dx=4, dy=5)


# ---------- комод / тумба ----------
def cabinet():
    w, h = 44, 24
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, OAK); R(d, 0, 0, w - 1, 1, OAK_L); R(d, 0, h - 2, w - 1, h - 1, OAK_D)
    for r in range(2):
        for c in range(3):
            x, y = 3 + c * 14, 4 + r * 10
            R(d, x, y, x + 11, y + 7, OAK_D); R(d, x + 1, y + 1, x + 10, y + 6, OAK)
            R(d, x + 4, y + 3, x + 7, y + 4, OAK_E)
    finish(im, 'cabinet')


def side_table():
    w, h = 22, 22
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, OAK); R(d, 0, 0, w - 1, 1, OAK_L); R(d, 0, h - 2, w - 1, h - 1, OAK_D)
    R(d, 2, 2, w - 3, h - 3, None, outline=OAK_D)
    finish(im, 'side_table')


# ---------- растения ----------
def plant(name, big=True, grey_pot=False):
    w, h = (32, 36) if big else (20, 24)
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    cx, cy = w // 2, h // 2 + 1
    pot, potd = (POT_G, SLATE_D) if grey_pot else (POT, POT_D)
    pr = 9 if big else 6                                     # горшок — круг под листьями
    E(d, cx - pr, cy - pr + 2, cx + pr, cy + pr + 2, potd)
    E(d, cx - pr, cy - pr, cx + pr, cy + pr, pot)
    E(d, cx - pr + 2, cy - pr + 2, cx + pr - 2, cy + pr - 2, _mix(pot, -0.15))
    # листья-лучи из центра поверх горшка
    rays = [(-1, -1, 14), (1, -1, 14), (-1, 0, 15), (1, 0, 15), (0, -1, 15), (-1, 1, 12), (1, 1, 12), (0, 1, 11)] if big else \
           [(-1, -1, 8), (1, -1, 8), (-1, 0, 9), (1, 0, 9), (0, -1, 9), (0, 1, 7), (-1, 1, 6), (1, 1, 6)]
    for i, (ddx, ddy, ln) in enumerate(rays):
        col = GREEN if i % 2 == 0 else GREEN_D
        for t in range(ln):
            x = cx + int(ddx * t * 0.75); y = cy + int(ddy * t * 0.75)
            wdt = 2 if t < ln * 0.6 else 1
            R(d, x - wdt, y - wdt, x + wdt, y + wdt, col)
        P(d, cx + int(ddx * ln * 0.75), cy + int(ddy * ln * 0.75), GREEN_L)
    E(d, cx - 3, cy - 3, cx + 3, cy + 3, GREEN_L)
    finish(im, name, dx=2, dy=3)


# ---------- настенное ----------
def picture(name='picture', w=22, h=16, motif='landscape'):
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, OAK_E); R(d, 2, 2, w - 3, h - 3, '#dbe7ef')
    if motif == 'landscape':
        R(d, 2, h // 2, w - 3, h - 3, '#6fa36b'); R(d, 6, 5, 12, 8, WHITE); E(d, w - 8, 3, w - 5, 6, '#f2d98a')
    else:
        R(d, 3, 3, w - 4, h - 4, SLATE_L); R(d, 6, 6, w - 7, h - 7, RED_L)
    finish(im, name, dx=1, dy=2)


def wall_monitor():
    """Настенный монитор (в референсе — с диаграммой). У нас — экран лога."""
    w, h = 62, 36
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 4, SLATE_X); R(d, 2, 2, w - 3, h - 6, SCREEN)
    R(d, 3, 3, w - 4, 3, SCREEN_L)
    R(d, 27, h - 3, 34, h - 1, SLATE_D)
    finish(im, 'wall_monitor', dx=1, dy=2)


def corkboard():
    w, h = 54, 34
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, OAK_E); R(d, 2, 2, w - 3, h - 3, '#c9a36c')
    for y in range(4, h - 3, 3):
        for x in range(4 + (y % 2), w - 3, 3):
            P(d, x, y, '#b8905a')
    for i, c in enumerate(['#5b7fd6', '#e0a83a', '#4fae5c']):
        R(d, 5 + i * 16, 4, 5 + i * 16 + 13, 5, c)
    for x, y, c in [(5, 8, '#f2d98a'), (5, 16, '#f2d98a'), (5, 24, '#bfe6ff'), (21, 8, '#f2a6a6'), (21, 16, '#f2d98a'),
                    (37, 8, '#bff0b8'), (37, 16, '#bff0b8'), (37, 24, '#bff0b8')]:
        R(d, x, y, x + 12, y + 6, c); R(d, x + 1, y + 2, x + 9, y + 2, _mix(c, -0.35)); R(d, x + 1, y + 4, x + 6, y + 4, _mix(c, -0.35))
        P(d, x + 6, y, RED)
    finish(im, 'corkboard', dx=1, dy=2)


def clock():
    w = 14
    im = canvas(w, w)
    d = ImageDraw.Draw(im)
    E(d, 0, 0, w - 1, w - 1, WHITE, outline=OAK_E)
    R(d, 6, 2, 6, 6, LINE); R(d, 7, 6, 10, 6, LINE); P(d, 6, 6, RED)
    finish(im, 'clock', dx=1, dy=2)


# ---------- кухня ----------
def counter():
    w, h = 48, 22
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, WHITE); R(d, 0, h - 2, w - 1, h - 1, GREY_D)
    R(d, 0, 0, w - 1, 1, '#ffffff')
    R(d, 6, 4, 16, 12, SLATE_X); R(d, 7, 5, 15, 6, SLATE_D); R(d, 10, 9, 12, 10, RED_L)   # кофемашина
    E(d, 22, 5, 34, 15, GREY); E(d, 24, 7, 32, 13, GREY_D); R(d, 27, 2, 29, 6, GREY_D)     # раковина
    E(d, 38, 6, 45, 13, '#f2d98a'); P(d, 40, 8, RED); P(d, 43, 10, GREEN)                  # фрукты
    finish(im, 'counter')


def fridge():
    w, h = 20, 30
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, WHITE); R(d, 0, 10, w - 1, 10, GREY_D); R(d, 0, 0, w - 1, 0, '#ffffff')
    R(d, w - 4, 3, w - 3, 8, GREY_D); R(d, w - 4, 13, w - 3, 24, GREY_D)
    R(d, 3, 3, 6, 5, '#f2d98a'); R(d, 4, 14, 8, 17, SKY)
    finish(im, 'fridge')


def cooler():
    w, h = 12, 24
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 2, 0, 9, 8, SKY); R(d, 3, 1, 3, 6, SKY_L)
    R(d, 1, 9, 10, 23, WHITE); R(d, 1, 9, 10, 10, GREY); R(d, 3, 13, 4, 14, '#4fa8ff'); R(d, 7, 13, 8, 14, RED)
    finish(im, 'cooler')


def kitchen_tiles(cols=5, rows=4):
    im = canvas(cols * T, rows * T)
    d = ImageDraw.Draw(im)
    for r in range(rows * 2):
        for c in range(cols * 2):
            x, y = c * 12, r * 12
            R(d, x, y, x + 11, y + 11, '#dfe3e6' if (r + c) % 2 == 0 else '#ccd2d8')
            R(d, x, y + 11, x + 11, y + 11, '#bcc3ca'); R(d, x + 11, y, x + 11, y + 11, '#bcc3ca')
    save(im, 'kitchen_tiles')


def rug(cols=8, rows=5):
    im = canvas(cols * T, rows * T)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, im.width - 1, im.height - 1, '#b9c2cf'); R(d, 3, 3, im.width - 4, im.height - 4, '#c8d0da')
    R(d, 6, 6, im.width - 7, im.height - 7, None, outline='#aeb8c6')
    for x in range(10, im.width - 10, 6):
        for y in range(10, im.height - 10, 6):
            P(d, x + (y // 6 % 2) * 3, y, '#b9c2cf')
    save(im, 'rug')


def door():
    """Дверь в левой стене: проём + створка, приоткрытая внутрь."""
    w, h = 26, 40
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 2, 3, 37, FRAME_D)          # проём (светлая стена)
    # створка под углом: ступенчатая
    for i in range(14):
        x0 = 4 + i; y0 = 4 + i * 2
        R(d, x0, y0, x0 + 4, y0 + 14 if y0 + 14 < h else h - 1, OAK)
        R(d, x0, y0, x0, y0 + 14 if y0 + 14 < h else h - 1, OAK_L)
    P(d, 16, 28, '#f2d98a')
    finish(im, 'door', dx=2, dy=3)


def doormat():
    w, h = 22, 12
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, '#8a7a64')
    for x in range(1, w - 1, 2):
        R(d, x, 1, x, h - 2, '#9c8b72')
    save(outline(im, '#5e5142'), 'doormat')


def shadow_blob():
    im = canvas(16, 6)
    ImageDraw.Draw(im).ellipse([0, 0, 15, 5], fill=SHADOW)
    save(im, 'shadow')


def coin():
    w = 12
    im = canvas(w, w)
    d = ImageDraw.Draw(im)
    E(d, 0, 0, w - 1, w - 1, '#f2d98a'); E(d, 2, 2, w - 3, w - 3, '#dcb94f'); R(d, 5, 3, 6, 8, '#f2d98a')
    save(outline(im, '#8a6a12'), 'coin')


if __name__ == '__main__':
    floor(); wall()
    desk('desk'); desk('desk_pm', pm=True); desk('desk_ghost', ghost=True)
    chair(); armchair()
    agent('agent_pm', '#e0a83a', '#4a2f1e', SKIN[0], glasses=True, tie=True)
    agent('agent_backend1', '#3b82f6', '#1f1b24', SKIN[1])
    agent('agent_backend2', '#3b82f6', '#d99a3a', SKIN[0], hood=True)
    agent('agent_frontend1', '#d4546f', '#c0392b', SKIN[0])
    agent('agent_frontend1_standing', '#d4546f', '#c0392b', SKIN[0], standing=True)
    agent('agent_backend2_standing', '#3b82f6', '#d99a3a', SKIN[0], hood=True, standing=True)
    agent('agent_uiux', '#a06cd5', '#1f1b24', SKIN[2], glasses=True)
    meeting_table(); cabinet(); side_table()
    plant('plant_big'); plant('plant_big_grey', grey_pot=True); plant('plant_small', big=False)
    picture('picture'); picture('picture2', motif='abstract'); wall_monitor(); corkboard(); clock()
    counter(); fridge(); cooler(); kitchen_tiles(); rug(); door(); doormat(); shadow_blob(); coin()
