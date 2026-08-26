#!/usr/bin/env python3
"""Набор пропсов по референсу (топ-даун пиксель-арт офис): тайлы пола, стены,
столы, стулья. Арт-тайл 24 px, SCALE 2 → 48 px на экране (как в стиле R).
Запуск: python3 design/sprites/gen_props.py → design/sprites/out/props/*.png
"""
from PIL import Image, ImageDraw
import json
import os
import random

SCALE = 2
T = 24                      # арт-тайл
WT = 12                     # толщина стены (пол-тайла)
OUT = os.path.join(os.path.dirname(__file__), 'out', 'props')
os.makedirs(OUT, exist_ok=True)

# ---------- палитра референса ----------
LINE = '#2f3541'
# пол
FLR = '#ecdfc4'; FLR_H = '#f4e9d3'; FLR_D = '#dbcbab'; FLR_SEAM = '#e0d2b5'
SUN = '#fbf3dd'; RUG = '#d6cbb2'; RUG_D = '#bdb094'
# стены
WALL = '#5c6675'; WALL_L = '#727d8d'; WALL_D = '#464f5d'; WALL_E = '#333a46'
TRIM = '#c9d0d8'; TRIM_D = '#a2aab5'; TRIM_L = '#e3e8ec'
GLASS = '#bcd8e6'; GLASS_L = '#dfeef5'; GLASS_D = '#93b6c8'
# дерево
OAK = '#d99f62'; OAK_L = '#e9ba81'; OAK_D = '#b57c46'; OAK_E = '#8a5930'
# металл / техника
MET = '#98a3b1'; MET_L = '#b8c1cc'; MET_D = '#6c7787'
SCR = '#2b3446'; SCR_L = '#3b4759'
# кресла
CH = '#525b6b'; CH_L = '#697383'; CH_D = '#3a414f'; CH_X = '#262b34'
RED = '#a8443d'; RED_L = '#c4615a'; RED_D = '#782a26'
WHITE = '#f4f1ea'; GREY = '#c9cdd4'; GREY_D = '#9aa2ad'
BLUE = '#5fb3e0'; CYAN = '#8fdcff'
SHADOW = (36, 40, 56, 74); SHADOW_SOFT = (36, 40, 56, 34)

CATALOG = {}


# ---------- утилиты ----------
def canvas(w, h):
    return Image.new('RGBA', (w, h), (0, 0, 0, 0))


def R(d, x0, y0, x1, y1, fill, outline=None):
    d.rectangle([x0, y0, x1, y1], fill=fill, outline=outline)


def E(d, x0, y0, x1, y1, fill, outline=None):
    d.ellipse([x0, y0, x1, y1], fill=fill, outline=outline)


def P(d, x, y, c):
    d.point((x, y), fill=c)


def RR(d, x0, y0, x1, y1, fill, r=2):
    """Скруглённый прямоугольник «по-пиксельному»: срезаем углы."""
    r = max(0, min(r, (x1 - x0) // 2, (y1 - y0) // 2))
    if r == 0:
        R(d, x0, y0, x1, y1, fill)
        return
    R(d, x0 + r, y0, x1 - r, y1, fill)
    R(d, x0, y0 + r, x1, y1 - r, fill)
    if r > 1:
        R(d, x0 + 1, y0 + 1, x0 + r - 1, y0 + r - 1, fill)
        R(d, x1 - r + 1, y0 + 1, x1 - 1, y0 + r - 1, fill)
        R(d, x0 + 1, y1 - r + 1, x0 + r - 1, y1 - 1, fill)
        R(d, x1 - r + 1, y1 - r + 1, x1 - 1, y1 - 1, fill)


def _hex(c):
    c = c.lstrip('#')
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def _mix(c, k):
    r, g, b = _hex(c)
    if k > 0:
        r, g, b = [int(v + (255 - v) * k) for v in (r, g, b)]
    else:
        r, g, b = [int(v * (1 + k)) for v in (r, g, b)]
    return '#%02x%02x%02x' % (r, g, b)


def outline(im, color=LINE):
    """Тонкий контур вокруг непрозрачных пикселей (тени не считаются)."""
    w, h = im.size
    src = im.load()
    out = im.copy(); dst = out.load()
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


def with_shadow(im, dx=3, dy=4):
    """Запечённая тень вниз-вправо, как в референсе."""
    w, h = im.size
    out = canvas(w + dx + 1, h + dy + 1)
    src = im.load()
    sh = canvas(out.width, out.height); sp = sh.load()
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


def save(im, name, tiles=None):
    big = im.resize((im.width * SCALE, im.height * SCALE), Image.NEAREST)
    big.save(os.path.join(OUT, name + '.png'))
    CATALOG[name] = {'px': [big.width, big.height],
                     'tiles': tiles or [round(im.width / T, 2), round(im.height / T, 2)]}
    print('props', name, big.size)


def finish(im, name, shadow=True, dx=3, dy=4, line=True):
    if line:
        im = outline(im)
    if shadow:
        im = with_shadow(im, dx, dy)
    save(im, name)


# ============================ ПОЛ ============================
def floor_base(rnd, w=T, h=T, base=FLR):
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, base)
    for _ in range(w * h // 9):
        P(d, rnd.randrange(w), rnd.randrange(h), _mix(base, -0.03))
    for _ in range(w * h // 14):
        P(d, rnd.randrange(w), rnd.randrange(h), _mix(base, 0.05))
    return im, d


def floor_plain():
    im, d = floor_base(random.Random(3))
    save(im, 'floor')


def floor_seam():
    """Тайл с затиркой по правому и нижнему краю — собирается в сетку плит."""
    im, d = floor_base(random.Random(7))
    R(d, T - 1, 0, T - 1, T - 1, FLR_SEAM)
    R(d, 0, T - 1, T - 1, T - 1, FLR_SEAM)
    R(d, 0, 0, T - 2, 0, FLR_H)
    R(d, 0, 0, 0, T - 2, FLR_H)
    save(im, 'floor_seam')


def floor_sun():
    """Тайл в пятне света (равномерно светлее — стыкуется без швов)."""
    im, d = floor_base(random.Random(13), base=SUN)
    save(im, 'floor_sun')


def sun_beam():
    """Косой луч из окна — полупрозрачный оверлей поверх пола, 3×3 тайла."""
    w, h = T * 3, T * 3
    im = canvas(w, h)
    px = im.load()
    for y in range(h):
        for x in range(w):
            t = x - y * 0.55                      # наклон луча
            if 6 < t < w - 22:
                edge = min(t - 6, (w - 22) - t, 10) / 10
                a = int(92 * min(1.0, edge) * (1 - y / (h * 2.6)))
                if a > 0:
                    px[x, y] = (255, 246, 214, a)
    save(im, 'sun_beam')


def floor_shade():
    """Полутень у стены."""
    im, d = floor_base(random.Random(21), base=FLR)
    for y in range(6):
        a = 0.10 - y * 0.017
        R(d, 0, y, T - 1, y, _mix(FLR, -a))
    save(im, 'floor_shade')


def rug():
    """Ковёр переговорки/игровой: 3×2 тайла, кайма и лёгкий ворс."""
    w, h = T * 3, T * 2
    rnd = random.Random(31)
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, RUG)
    for _ in range(w * h // 7):
        P(d, rnd.randrange(w), rnd.randrange(h), _mix(RUG, rnd.choice([-0.05, 0.05])))
    R(d, 0, 0, w - 1, h - 1, None, outline=RUG_D)
    R(d, 3, 3, w - 4, h - 4, None, outline=RUG_D)
    R(d, 0, 0, w - 1, 0, _mix(RUG, 0.12))
    R(d, 0, h - 1, w - 1, h - 1, _mix(RUG, -0.12))
    save(im, 'rug')


def floor_preview():
    """Сборка 6×4 тайла: бесшовный пол + пятно света от окна."""
    cols, rows = 6, 4
    im = canvas(cols * T, rows * T)
    seam = Image.open(os.path.join(OUT, 'floor_seam.png')).resize((T, T), Image.NEAREST)
    sun = Image.open(os.path.join(OUT, 'floor_sun.png')).resize((T, T), Image.NEAREST)
    beam = Image.open(os.path.join(OUT, 'sun_beam.png'))
    beam = beam.resize((beam.width // SCALE, beam.height // SCALE), Image.NEAREST)
    for r in range(rows):
        for c in range(cols):
            im.alpha_composite(sun if (c >= 4 and r <= 1) else seam, (c * T, r * T))
    im.alpha_composite(beam, (T, 0))
    save(im, 'preview_floor')


# ============================ СТЕНЫ ============================
def _wall_body(d, x0, y0, x1, y1):
    R(d, x0, y0, x1, y1, WALL)
    R(d, x0, y0, x1, y0 + 1, WALL_L)          # верхняя фаска
    R(d, x0, y1 - 1, x1, y1, WALL_D)          # нижняя фаска
    R(d, x0, y0, x0, y1, _mix(WALL, 0.06))
    R(d, x1, y0, x1, y1, WALL_D)


def wall_h(name='wall_h', window=False):
    """Горизонтальная стена: модуль 24×12 + падающая тень на пол."""
    w, h = T, WT
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    _wall_body(d, 0, 0, w - 1, h - 1)
    if window:
        R(d, 2, 1, w - 3, h - 3, TRIM_D)                     # рама
        R(d, 3, 2, w - 4, h - 4, GLASS)
        R(d, 3, 2, w - 4, 3, GLASS_L)                        # блик стекла
        R(d, 3, h - 5, w - 4, h - 5, GLASS_D)
        R(d, w // 2 - 1, 2, w // 2, h - 4, TRIM)             # переплёт
        R(d, 2, h - 3, w - 3, h - 3, TRIM_L)                 # подоконник
    finish(im, name, shadow=True, dx=0, dy=3, line=False)


def wall_h_door():
    """Дверной проём: 2 тайла (48×12) — стена, косяки, порог."""
    w, h = T * 2, WT
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    _wall_body(d, 0, 0, w - 1, h - 1)
    op0, op1 = 15, w - 16                                    # проём 18 арт-px
    R(d, op0, 0, op1, h - 1, (0, 0, 0, 0))
    for jx in (op0 - 3, op1 + 1):                            # косяки
        R(d, jx, 0, jx + 2, h - 1, OAK_D)
        R(d, jx, 0, jx + 2, 1, OAK_L)
        R(d, jx, h - 2, jx + 2, h - 1, OAK_E)
    R(d, op0, h - 2, op1, h - 1, _mix(FLR, -0.12))           # порог
    R(d, op0, h - 3, op1, h - 3, _mix(FLR, -0.05))
    finish(im, 'wall_h_door', shadow=True, dx=0, dy=3, line=False)


def wall_v(name='wall_v'):
    """Вертикальная стена: модуль 12×24."""
    w, h = WT, T
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, WALL)
    R(d, 0, 0, 1, h - 1, WALL_L)
    R(d, w - 2, 0, w - 1, h - 1, WALL_D)
    R(d, 0, 0, w - 1, 0, _mix(WALL, 0.06))
    R(d, 0, h - 1, w - 1, h - 1, WALL_D)
    finish(im, name, shadow=True, dx=3, dy=0, line=False)


def wall_corner(name, right, bottom):
    """Угол 12×12: right/bottom — с каких сторон подходят стены."""
    w = h = WT
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, WALL)
    R(d, 0, 0, w - 1, 1, WALL_L)
    R(d, 0, 0, 1, h - 1, WALL_L)
    R(d, w - 2, 0, w - 1, h - 1, WALL_D)
    R(d, 0, h - 2, w - 1, h - 1, WALL_D)
    P(d, w - 1, h - 1, WALL_E)
    finish(im, name, shadow=True, dx=3 if right else 0, dy=3 if bottom else 0, line=False)


def wall_column():
    """Колонна/пилястра 12×12 — торец перегородки."""
    w = h = WT
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    R(d, 0, 0, w - 1, h - 1, WALL)
    R(d, 0, 0, w - 1, 1, WALL_L)
    R(d, 0, 0, 1, h - 1, WALL_L)
    R(d, w - 2, 0, w - 1, h - 1, WALL_D)
    R(d, 0, h - 2, w - 1, h - 1, WALL_D)
    R(d, 3, 3, w - 4, h - 4, _mix(WALL, 0.10))
    finish(im, 'wall_column', shadow=True, dx=3, dy=3, line=False)


def wall_preview():
    """Сборка: комнатка 6×4 тайла из модулей стен на полу."""
    cols, rows = 6, 4
    im = canvas(cols * T, rows * T)
    seam = Image.open(os.path.join(OUT, 'floor_seam.png')).resize((T, T), Image.NEAREST)
    for r in range(rows):
        for c in range(cols):
            im.alpha_composite(seam, (c * T, r * T))

    def ld(n):
        p = Image.open(os.path.join(OUT, n + '.png'))
        return p.resize((p.width // SCALE, p.height // SCALE), Image.NEAREST)

    wh, wwin, wdoor = ld('wall_h'), ld('wall_h_window'), ld('wall_h_door')
    wv, cor = ld('wall_v'), ld('wall_corner')
    W = cols * T; H = rows * T
    for c in range(cols):
        im.alpha_composite(wwin if c in (2, 3) else wh, (c * T, 0))
    for c in range(cols):
        if c in (3, 4):
            continue
        im.alpha_composite(wh, (c * T, H - WT))
    im.alpha_composite(wdoor, (3 * T, H - WT))
    for r in range(rows):
        im.alpha_composite(wv, (0, r * T))
        im.alpha_composite(wv, (W - WT, r * T))
    for pos in ((0, 0), (W - WT, 0), (0, H - WT), (W - WT, H - WT)):
        im.alpha_composite(cor, pos)
    save(im, 'preview_walls')


# ============================ СТОЛЫ ============================
def _desk_top(d, w, h, top=OAK, light=OAK_L, dark=OAK_D, edge=OAK_E, y0=0):
    R(d, 0, y0, w - 1, h - 1, top)
    R(d, 0, y0, w - 1, y0 + 1, light)            # блик у дальнего края
    R(d, 0, y0, 1, h - 1, light)
    R(d, 0, h - 3, w - 1, h - 2, dark)           # передняя кромка
    R(d, w - 3, y0, w - 2, h - 1, dark)
    R(d, 0, h - 1, w - 1, h - 1, edge)
    R(d, w - 1, y0, w - 1, h - 1, edge)
    for yy in (y0 + 9, y0 + 19):                 # стыки досок
        if yy < h - 3:
            R(d, 2, yy, w - 4, yy, _mix(top, -0.07))


def _monitor(d, cx, y):
    """Монитор у дальнего края: корпус + тёмный экран + ножка."""
    w = 18
    x0 = cx - w // 2
    R(d, x0, y, x0 + w - 1, y + 11, MET_D)
    R(d, x0, y, x0 + w - 1, y, MET_L)
    R(d, x0 + 1, y + 1, x0 + w - 2, y + 9, SCR)
    R(d, x0 + 2, y + 2, x0 + w - 3, y + 3, SCR_L)
    R(d, x0 + 3, y + 3, x0 + 9, y + 3, CYAN)
    R(d, x0 + 3, y + 5, x0 + w - 5, y + 5, BLUE)
    R(d, x0 + 3, y + 7, x0 + 8, y + 7, CYAN)
    R(d, cx - 2, y + 12, cx + 1, y + 13, MET)     # ножка
    R(d, cx - 4, y + 13, cx + 3, y + 13, MET_D)


def _keyboard(d, cx, y):
    R(d, cx - 9, y, cx + 8, y + 5, MET_L)
    R(d, cx - 9, y + 5, cx + 8, y + 5, MET_D)
    for kx in range(cx - 8, cx + 8, 2):
        P(d, kx, y + 2, GREY_D)
        P(d, kx, y + 4, GREY_D)
    R(d, cx + 12, y, cx + 15, y + 5, MET_L)       # мышь
    R(d, cx + 12, y, cx + 15, y, WHITE)
    R(d, cx + 12, y + 5, cx + 15, y + 5, MET_D)


def desk(name='desk', pc=True, docs=False, ghost=False):
    """Рабочий стол 48×32 арт-px (2×1.33 тайла), вид сверху."""
    w, h = 48, 32
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    if ghost:
        _desk_top(d, w, h, '#ded7cb', '#eae5db', '#c2bbad', '#a09889', y0=0)
        for x in range(2, w - 2, 4):              # пунктир «свободное место»
            R(d, x, 3, x + 1, 3, '#a09889')
            R(d, x, h - 5, x + 1, h - 5, '#a09889')
        for y in range(4, h - 5, 4):
            R(d, 2, y, 2, y + 1, '#a09889')
            R(d, w - 4, y, w - 4, y + 1, '#a09889')
        finish(im, name, shadow=False)
        return
    _desk_top(d, w, h)
    # тумба с ящиками слева
    R(d, 2, 6, 13, h - 4, _mix(OAK, -0.06))
    R(d, 2, 6, 13, 6, OAK_L)
    for i in range(2):
        y = 9 + i * 9
        R(d, 3, y, 12, y + 6, OAK_D)
        R(d, 4, y + 1, 11, y + 5, _mix(OAK, 0.05))
        R(d, 6, y + 3, 9, y + 3, OAK_E)
    if pc:
        _monitor(d, 30, 1)
        _keyboard(d, 27, 21)
    if docs:
        R(d, 17, 5, 26, 13, WHITE)                # бумаги
        R(d, 18, 7, 24, 7, GREY_D); R(d, 18, 9, 23, 9, GREY_D); R(d, 18, 11, 25, 11, GREY_D)
        E(d, 40, 4, 45, 9, RED_L)                 # кружка
        E(d, 41, 5, 44, 8, RED)
    finish(im, name)


def desk_small():
    """Компактный стол 32×26 — для узких мест."""
    w, h = 32, 26
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    _desk_top(d, w, h)
    _monitor(d, 16, 0)
    _keyboard(d, 12, 17)
    finish(im, 'desk_small')


def meeting_table():
    """Стол переговорки 84×44 (3.5×1.8 тайла)."""
    w, h = 84, 44
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    RR(d, 0, 0, w - 1, h - 1, OAK, r=3)
    R(d, 3, 0, w - 4, 1, OAK_L)
    R(d, 0, 3, 1, h - 4, OAK_L)
    R(d, 3, h - 2, w - 4, h - 1, OAK_D)
    R(d, w - 2, 3, w - 1, h - 4, OAK_D)
    R(d, 5, 5, w - 6, h - 6, None, outline=_mix(OAK, -0.10))   # кромка столешницы
    for yy in (14, 29):
        R(d, 6, yy, w - 7, yy, _mix(OAK, -0.06))
    # ноутбук, бумаги, кружки
    R(d, 33, 15, 52, 29, MET_D); R(d, 34, 16, 51, 26, SCR)
    R(d, 36, 18, 45, 18, CYAN); R(d, 36, 20, 49, 20, BLUE); R(d, 36, 22, 42, 22, CYAN)
    R(d, 35, 28, 50, 28, MET_L)
    R(d, 9, 9, 20, 18, WHITE); R(d, 10, 11, 18, 11, GREY_D); R(d, 10, 13, 16, 13, GREY_D)
    R(d, 62, 27, 74, 36, WHITE); R(d, 63, 29, 71, 29, GREY_D)
    E(d, 11, 30, 16, 35, RED_L); E(d, 12, 31, 15, 34, RED)
    E(d, 64, 9, 69, 14, MET_L); E(d, 65, 10, 68, 13, MET)
    finish(im, 'meeting_table', dx=4, dy=5)


# ============================ СТУЛЬЯ ============================
def _chair_raw(body=CH, light=CH_L, dark=CH_D):
    """Офисное кресло, вид сверху, сидящий смотрит вверх (спинка снизу).
    Порядок: ролики → спинка → подлокотники → сиденье, чтобы силуэт был цельным."""
    w, h = 24, 26
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    # крестовина: наружу выглядывают только ролики
    for wx, wy in ((1, 2), (20, 2), (1, 14), (20, 14), (10, 0)):
        R(d, wx, wy, wx + 2, wy + 2, CH_X)
        P(d, wx + 1, wy, _mix(CH_X, 0.25))
    # спинка (снизу, сиденье её перекрывает сверху)
    RR(d, 3, 14, 20, 24, dark, r=4)
    R(d, 5, 19, 18, 22, _mix(dark, 0.10))
    R(d, 6, 19, 17, 19, _mix(dark, 0.22))
    # подлокотники
    R(d, 1, 7, 3, 16, dark); R(d, 20, 7, 22, 16, dark)
    R(d, 1, 7, 3, 7, _mix(dark, 0.18)); R(d, 20, 7, 22, 7, _mix(dark, 0.18))
    # сиденье
    RR(d, 4, 3, 19, 18, body, r=4)
    RR(d, 5, 4, 18, 9, light, r=3)
    R(d, 5, 17, 18, 18, dark)
    R(d, 7, 11, 16, 12, _mix(body, -0.08))     # шов подушки
    R(d, 4, 18, 19, 18, _mix(dark, -0.25))     # граница «сиденье / спинка»
    return im


def chair(name, facing='up', body=CH, light=CH_L, dark=CH_D):
    """facing — куда смотрит сидящий: up / down / left / right."""
    im = _chair_raw(body, light, dark)
    if facing == 'down':
        im = im.transpose(Image.ROTATE_180)
    elif facing == 'left':
        im = im.transpose(Image.ROTATE_90)
    elif facing == 'right':
        im = im.transpose(Image.ROTATE_270)
    finish(im, name, dx=2, dy=3)


def armchair_red():
    """Бордовое кресло переговорки (мягкое, с валиками-подлокотниками)."""
    w, h = 24, 26
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    RR(d, 2, 4, 21, 22, RED, r=3)                    # сиденье
    RR(d, 3, 5, 20, 11, RED_L, r=2)
    R(d, 3, 20, 20, 22, RED_D)
    RR(d, 1, 17, 22, 24, RED_D, r=3)                 # спинка снизу
    R(d, 3, 18, 20, 21, RED)
    R(d, 4, 18, 19, 18, RED_L)
    R(d, 0, 6, 3, 19, RED_D); R(d, 20, 6, 23, 19, RED_D)   # подлокотники
    R(d, 0, 6, 3, 7, RED_L); R(d, 20, 6, 23, 7, RED_L)
    R(d, 2, 24, 5, 25, CH_X); R(d, 18, 24, 21, 25, CH_X)   # ножки
    finish(im, 'armchair_red', dx=2, dy=3)


def stool():
    """Табурет/пуф 16×16."""
    w = h = 16
    im = canvas(w, h)
    d = ImageDraw.Draw(im)
    E(d, 0, 1, w - 1, h - 1, CH_D)
    E(d, 0, 0, w - 1, h - 2, CH)
    E(d, 3, 2, w - 4, h - 7, CH_L)
    finish(im, 'stool', dx=2, dy=3)


def chair_preview():
    """Сборка: два стола со стульями на полу — проверка масштаба."""
    cols, rows = 6, 3
    im = canvas(cols * T, rows * T)
    seam = Image.open(os.path.join(OUT, 'floor_seam.png')).resize((T, T), Image.NEAREST)
    for r in range(rows):
        for c in range(cols):
            im.alpha_composite(seam, (c * T, r * T))

    def ld(n):
        p = Image.open(os.path.join(OUT, n + '.png'))
        return p.resize((p.width // SCALE, p.height // SCALE), Image.NEAREST)

    dk, dk2, ch_up = ld('desk_pc'), ld('desk_pc_docs'), ld('chair_up')
    for i, sprite in enumerate((dk, dk2)):
        x = 8 + i * 68
        im.alpha_composite(sprite, (x, 6))
        im.alpha_composite(ch_up, (x + 21, 40))
    save(im, 'preview_desks')


# ============================ ЛИСТ-КАТАЛОГ ============================
def main():
    floor_plain(); floor_seam(); floor_sun(); floor_shade(); rug(); sun_beam()
    floor_preview()

    wall_h('wall_h')
    wall_h('wall_h_window', window=True)
    wall_h_door()
    wall_v('wall_v')
    wall_corner('wall_corner', right=True, bottom=True)
    wall_column()
    wall_preview()

    desk('desk', pc=False)
    desk('desk_pc', pc=True)
    desk('desk_pc_docs', pc=True, docs=True)
    desk('desk_ghost', ghost=True)
    desk_small()
    meeting_table()

    chair('chair_up', 'up')
    chair('chair_down', 'down')
    chair('chair_left', 'left')
    chair('chair_right', 'right')
    chair('chair_exec', 'up', body='#3f4653', light='#525b6b', dark='#2b313c')
    armchair_red()
    stool()
    chair_preview()

    with open(os.path.join(OUT, 'catalog.json'), 'w', encoding='utf-8') as f:
        json.dump({'version': 1, 'tile': T, 'scale': SCALE, 'sprites': CATALOG}, f,
                  ensure_ascii=False, indent=2)
    print('всего спрайтов:', len(CATALOG))


if __name__ == '__main__':
    main()
