#!/usr/bin/env python3
"""Фон главного меню AI Office.

Приложение только открыли — офиса ещё нет, поэтому за меню не комната, а улица
перед офисом: вечернее небо, силуэты города, фонари и площадка перед входом.
Центр кадра оставлен пустым — там панель меню, персонажи стоят внизу.

    python3 design/sprites/gen_menu_bg.py   → out/menu_bg.png (1440x900)
"""
from PIL import Image, ImageDraw
import os
import random

SCALE = 3
W, H = 480, 300
OUT = os.path.join(os.path.dirname(__file__), 'out')

SKY = [
    (0.00, '#12102a'),
    (0.30, '#221a3d'),
    (0.55, '#3d2547'),
    (0.78, '#6b3550'),
    (0.92, '#a85a4f'),
    (1.00, '#d08a53'),
]
HORIZON = 156          # линия горизонта (низ дальних домов)
GROUND = '#241d33'     # площадка перед офисом
GROUND_L = '#2c2440'
CURB = '#3a2f4e'
LAMP = '#ffd98a'


def _rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def sky_color(y):
    t = y / HORIZON
    for i in range(len(SKY) - 1):
        p0, c0 = SKY[i]
        p1, c1 = SKY[i + 1]
        if p0 <= t <= p1:
            k = (t - p0) / (p1 - p0) if p1 > p0 else 0
            return _mix(_rgb(c0), _rgb(c1), k)
    return _rgb(SKY[-1][1])


def draw_sky(d, rnd):
    for y in range(HORIZON):
        c = sky_color(y)
        d.line([(0, y), (W, y)], fill=c)
    # лёгкий дизеринг на стыках полос, чтобы градиент читался «пиксельным»
    for y in range(6, HORIZON - 2, 2):
        c = _mix(sky_color(y), sky_color(y + 4), 0.5)
        for x in range(rnd.randint(0, 3), W, 4):
            if rnd.random() < 0.35:
                d.point((x, y), fill=c)


def draw_stars(d, rnd):
    for _ in range(90):
        x = rnd.randint(0, W - 1)
        y = rnd.randint(0, 96)
        if rnd.random() > 1.0 - y / 130.0:      # ближе к горизонту звёзд меньше
            continue
        c = rnd.choice(['#fff4d6', '#dfe4ff', '#ffe9b0', '#c8d0f0'])
        d.point((x, y), fill=c)
        if rnd.random() < 0.12:                  # крупная звезда-крестик
            d.point((x - 1, y), fill='#6a628a')
            d.point((x + 1, y), fill='#6a628a')
            d.point((x, y - 1), fill='#6a628a')
            d.point((x, y + 1), fill='#6a628a')


def draw_moon(d):
    cx, cy, r = 404, 38, 11
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill='#f7ecc6')
    d.ellipse([cx - r - 3, cy - r - 3, cx + r + 3, cy + r + 3], outline='#5a4a6e')
    for (ox, oy, rr) in ((-4, -3, 3), (3, 2, 4), (-2, 5, 2)):
        d.ellipse([cx + ox - rr, cy + oy - rr, cx + ox + rr, cy + oy + rr], fill='#e6d7ac')


def draw_skyline(d, rnd, y_base, y_min, y_max, body, win, win_chance, step=(14, 30)):
    """Ряд силуэтов домов с редкими светящимися окнами."""
    x = -6
    while x < W + 6:
        w = rnd.randint(*step)
        h = rnd.randint(y_min, y_max)
        top = y_base - h
        d.rectangle([x, top, x + w, y_base], fill=body)
        # надстройки на крыше
        if rnd.random() < 0.35:
            aw = rnd.randint(3, 6)
            ax = x + rnd.randint(2, max(2, w - aw - 2))
            d.rectangle([ax, top - rnd.randint(2, 5), ax + aw, top], fill=body)
        if rnd.random() < 0.22:                  # антенна
            ax = x + w // 2
            d.line([(ax, top), (ax, top - rnd.randint(4, 9))], fill=body)
        # окна сеткой 2x3 арт-пикселя
        for wy in range(top + 4, y_base - 3, 6):
            for wx in range(x + 3, x + w - 3, 5):
                if rnd.random() < win_chance:
                    c = win if rnd.random() < 0.75 else '#8fd0e8'
                    d.rectangle([wx, wy, wx + 1, wy + 2], fill=c)
        x += w + rnd.randint(1, 4)


def draw_ground(d, rnd):
    d.rectangle([0, HORIZON, W, H], fill=GROUND)
    d.rectangle([0, HORIZON, W, HORIZON + 2], fill=CURB)          # бордюр у домов
    # плитка площадки
    for y in range(HORIZON + 10, H, 12):
        d.line([(0, y), (W, y)], fill=GROUND_L)
    for y in range(HORIZON + 10, H, 12):
        off = 0 if ((y - HORIZON) // 12) % 2 == 0 else 12
        for x in range(off, W, 24):
            d.line([(x, y), (x, min(H, y + 12))], fill=GROUND_L)
    # мягкое затемнение к нижнему краю
    for y in range(H - 40, H):
        k = (y - (H - 40)) / 40 * 0.45
        c = _mix(_rgb(GROUND), (12, 9, 20), k)
        d.line([(0, y), (W, y)], fill=c)


def light_pool(im, cx, cy, rx, ry, strength=0.5, color=(255, 214, 138)):
    """Тёплое пятно света от фонаря — с дизерингом, без мыла."""
    px = im.load()
    for y in range(max(0, cy - ry), min(H, cy + ry)):
        for x in range(max(0, cx - rx), min(W, cx + rx)):
            dx = (x - cx) / rx
            dy = (y - cy) / ry
            dist = dx * dx + dy * dy
            if dist >= 1:
                continue
            k = (1 - dist) ** 1.6 * strength
            if k < 0.04:
                continue
            if k < 0.16 and ((x + y) % 2):        # дизеринг по краю пятна
                continue
            px[x, y] = _mix(px[x, y], color, min(k, 0.85))


def draw_lamp(im, d, x, base_y, h=64):
    top = base_y - h
    light_pool(im, x, top + 6, 14, 12, 0.42)                         # ореол плафона
    d = ImageDraw.Draw(im)
    d.rectangle([x - 1, top + 5, x + 1, base_y], fill='#171326')     # столб
    d.rectangle([x - 4, base_y - 2, x + 4, base_y + 1], fill='#171326')
    d.rectangle([x - 5, top + 1, x + 5, top + 6], fill='#241d38')    # плафон
    d.rectangle([x - 3, top + 3, x + 3, top + 6], fill=LAMP)
    d.rectangle([x - 1, top - 1, x + 1, top + 1], fill='#241d38')    # крепление
    light_pool(im, x, base_y + 4, 34, 11, 0.26)                      # пятно на плитке


def draw_planter(d, x, y, big=False):
    w = 12 if big else 9
    h = 8 if big else 6
    d.rectangle([x, y, x + w, y + h], fill='#4a3550')
    d.rectangle([x, y, x + w, y + 1], fill='#5e4566')
    ch = 14 if big else 10
    d.rectangle([x + w // 2 - 1, y - ch, x + w // 2, y], fill='#2c4a35')
    for (ox, oy, rr) in ((-4, -3, 4), (4, -4, 4), (0, -9, 5), (-3, -8, 3), (3, -7, 3)):
        cx, cy = x + w // 2 + ox, y - ch + oy + 4
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill='#35704a')
    for (ox, oy) in ((-3, -10), (2, -12), (5, -6), (-6, -5)):
        d.point((x + w // 2 + ox, y - ch + oy + 4), fill='#4f9d4a')


def draw_bench(d, x, y):
    d.rectangle([x, y, x + 26, y + 3], fill='#4a3550')          # сиденье
    d.rectangle([x, y, x + 26, y + 1], fill='#5e4566')
    d.rectangle([x, y - 7, x + 26, y - 5], fill='#4a3550')      # спинка
    for ox in (2, 22):
        d.rectangle([x + ox, y - 7, x + ox + 1, y + 8], fill='#2c2140')
        d.rectangle([x + ox - 1, y + 7, x + ox + 3, y + 8], fill='#2c2140')


def draw_bin(d, x, y):
    d.rectangle([x, y - 9, x + 7, y], fill='#3a2f4e')
    d.rectangle([x, y - 9, x + 7, y - 8], fill='#544066')
    d.rectangle([x + 2, y - 7, x + 3, y - 2], fill='#2c2140')


def build():
    rnd = random.Random(20260819)
    im = Image.new('RGB', (W, H), '#12102a')
    d = ImageDraw.Draw(im)

    draw_sky(d, rnd)
    draw_stars(d, rnd)
    draw_moon(d)

    # три плана города: чем дальше, тем светлее и туманнее
    draw_skyline(d, rnd, HORIZON - 10, 26, 62, '#241c3d', '#e8b45c', 0.16, (16, 34))
    draw_skyline(d, rnd, HORIZON - 4, 20, 48, '#1b1530', '#f2c96a', 0.22, (14, 28))
    draw_skyline(d, rnd, HORIZON + 1, 14, 34, '#141024', '#ffd486', 0.26, (12, 24))

    draw_ground(d, rnd)

    draw_lamp(im, d, 58, HORIZON + 34)
    draw_lamp(im, d, 422, HORIZON + 34)

    d = ImageDraw.Draw(im)
    draw_planter(d, 92, HORIZON + 40, big=True)
    draw_planter(d, 376, HORIZON + 42)
    draw_bench(d, 122, HORIZON + 36)
    draw_bin(d, 350, HORIZON + 38)

    # виньетка по краям, чтобы центр с меню читался спокойнее
    px = im.load()
    for y in range(H):
        for x in range(W):
            dx = abs(x - W / 2) / (W / 2)
            dy = abs(y - H / 2) / (H / 2)
            k = max(0.0, (dx * dx + dy * dy) * 0.5 - 0.22)
            if k > 0.02:
                px[x, y] = _mix(px[x, y], (10, 8, 20), min(k, 0.5))

    os.makedirs(OUT, exist_ok=True)
    big = im.resize((W * SCALE, H * SCALE), Image.NEAREST)
    path = os.path.join(OUT, 'menu_bg.png')
    big.save(path)
    print('saved', path, big.size)


if __name__ == '__main__':
    build()
