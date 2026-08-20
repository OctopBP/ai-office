#!/usr/bin/env python3
"""Пиксель-спрайты кухонной зоны (T-20): модульная тумба (прямая секция и
угол), мойка в столешнице, кофемашина, длинный обеденный стол и мелкие
детали на стол. Холодильник и кулер для кухни уже есть в gen.py (fridge,
cooler) — здесь не дублируются.

Хелперы и палитру (canvas/save/R/P/outline_alpha/tint, SCALE=3, T=16,
THEME с DESK_TOP/DESK_SIDE и т.д.) берём из gen.py, чтобы новая мебель
совпадала по стилю и палитре с остальной комнатой.

    python3 design/sprites/gen_kitchen.py            → out/day/*.png и out/night/*.png
    python3 design/sprites/gen_kitchen.py night      → только ночь
"""
import os
import sys

from PIL import ImageDraw

sys.path.insert(0, os.path.dirname(__file__))
import gen  # noqa: E402  (после sys.path.insert)

# Цвета столешницы/тумбы — не часть THEME (как и в исходном counter() из
# gen.py): рисуем их фиксированными «дневными» тонами, а к ночи приводим
# общим tint(), как это уже делает gen.counter().
TOP = '#dfe6ea'
TOP_L = '#fbf8f2'
CAB = '#6b7fa3'
CAB_D = '#4e5f80'
HANDLE = '#f7d774'
BASIN = '#b7c4cf'
FAUCET = '#8f9aa5'
DROP = '#8fd3ff'
MACHINE = '#3b3547'
MACHINE_L = '#5a536e'
MACHINE_D = '#2a2740'
CUP = '#e8e2d6'
CUP_D = '#bdb5a6'
LIGHT = '#e94f6c'


def _cabinet_door(d, x0, y0, x1, y1, vertical=False):
    """Дверца тумбы: делительная линия по центру + жёлтая ручка."""
    if vertical:
        my = (y0 + y1) // 2
        gen.R(d, x0, my, x1, my, CAB_D)
        gen.R(d, x1 - 2, my - 3, x1 - 1, my - 2, HANDLE)
    else:
        mx = (x0 + x1) // 2
        gen.R(d, mx, y0, mx, y1, CAB_D)
        gen.R(d, mx - 3, y0 + 3, mx - 2, y0 + 4, HANDLE)


# ---------- 1. тумба: прямая секция ----------
def counter_straight():
    """Прямая секция тумбы, 2 тайла в ширину — ставится в ряд встык."""
    w, h = 32, 22
    im = gen.canvas(w, h)
    d = ImageDraw.Draw(im)
    gen.R(d, 0, 6, w - 1, 12, TOP)
    gen.R(d, 0, 6, w - 1, 6, TOP_L)
    gen.R(d, 0, 13, w - 1, h - 1, CAB)
    gen.R(d, 0, 13, w - 1, 13, gen._light(CAB))
    _cabinet_door(d, 0, 13, w - 1, h - 1)
    im = gen.tint(im)
    im = gen.outline_alpha(im)
    gen.save(im, 'counter_straight')


# ---------- 2. тумба: угловая секция ----------
def counter_corner():
    """Угловая секция 2x2 тайла: столешница в левом верхнем углу,
    фасады тумбы L-образно по нижнему и правому краю — поворот ряда на 90°."""
    w, h = 32, 32
    im = gen.canvas(w, h)
    d = ImageDraw.Draw(im)
    band = 9
    gen.R(d, 0, 6, w - 1 - band, h - 1 - band, TOP)
    gen.R(d, 0, 6, w - 1 - band, 6, TOP_L)
    gen.R(d, 0, 6, 0, h - 1 - band, TOP_L)
    # южный фасад (по всей ширине)
    gen.R(d, 0, h - band, w - 1, h - 1, CAB)
    gen.R(d, 0, h - band, w - 1, h - band, gen._light(CAB))
    _cabinet_door(d, 0, h - band, w - 1 - band, h - 1)
    # восточный фасад (над южным, до верхней столешницы)
    gen.R(d, w - band, 6, w - 1, h - 1 - band, CAB)
    gen.R(d, w - band, 6, w - 1, 6, gen._light(CAB))
    _cabinet_door(d, w - band, 6, w - 1, h - 1 - band, vertical=True)
    im = gen.tint(im)
    im = gen.outline_alpha(im)
    gen.save(im, 'counter_corner')


# ---------- 3. мойка в столешнице ----------
def sink_counter():
    """Секция тумбы с врезной мойкой — тех же размеров, что и counter_straight,
    можно поставить в любое место ряда."""
    w, h = 32, 22
    im = gen.canvas(w, h)
    d = ImageDraw.Draw(im)
    gen.R(d, 0, 6, w - 1, 12, TOP)
    gen.R(d, 0, 6, w - 1, 6, TOP_L)
    gen.R(d, 0, 13, w - 1, h - 1, CAB)
    gen.R(d, 0, 13, w - 1, 13, gen._light(CAB))
    _cabinet_door(d, 0, 13, 12, h - 1)
    _cabinet_door(d, 19, 13, w - 1, h - 1)
    # чаша мойки врезана в столешницу
    gen.R(d, 12, 7, 20, 11, BASIN)
    gen.R(d, 13, 8, 19, 10, gen._dark(BASIN))
    # смеситель поднимается над столешницей
    gen.R(d, 15, 2, 16, 6, FAUCET)
    gen.R(d, 14, 1, 17, 2, FAUCET)
    im = gen.tint(im)
    d = ImageDraw.Draw(im)
    gen.P(d, 16, 7, DROP)
    im = gen.outline_alpha(im)
    gen.save(im, 'sink_counter')


# ---------- 4. кофемашина ----------
def coffee_machine():
    """Отдельностоящая кофемашина — ставится поверх секции тумбы (как монитор на стол)."""
    w, h = 12, 18
    im = gen.canvas(w, h)
    d = ImageDraw.Draw(im)
    gen.R(d, 1, 1, 10, 12, MACHINE)
    gen.R(d, 2, 2, 9, 2, MACHINE_L)
    gen.R(d, 1, 0, 10, 0, MACHINE_L)
    gen.R(d, 4, 12, 7, 13, MACHINE_D)          # носик
    gen.R(d, 4, 14, 7, 17, CUP)                 # чашка
    gen.R(d, 4, 17, 7, 17, CUP_D)
    im = gen.tint(im)
    d = ImageDraw.Draw(im)
    gen.R(d, 3, 5, 4, 5, LIGHT)                 # индикатор — не тонируется
    im = gen.outline_alpha(im)
    gen.save(im, 'coffee_machine')


# ---------- 5. длинный обеденный стол ----------
def dining_table():
    """Длинный стол на 6 тайлов — под большую компанию сидящих агентов."""
    w, h = 96, 22
    im = gen.canvas(w, h)
    d = ImageDraw.Draw(im)
    top, topl, side, edge = gen.DESK_TOP, gen.DESK_TOP_L, gen.DESK_SIDE, gen.DESK_EDGE
    gen.R(d, 1, 5, w - 2, 15, top)
    gen.R(d, 1, 5, w - 2, 6, topl)
    for lx in range(17, w - 2, 16):
        gen.R(d, lx, 6, lx, 15, gen._mix(top, -0.08))
    gen.R(d, 1, 16, w - 2, 19, side)
    gen.R(d, 1, 19, w - 2, 19, edge)
    for lx in (6, w // 3 - 2, 2 * w // 3 + 2, w - 10):
        gen.R(d, lx, 20, lx + 1, 21, edge)
    im = gen.tint(im, (0.55, 0.55, 0.85), (8, 10, 34))
    im = gen.outline_alpha(im)
    gen.save(im, 'dining_table')


# ---------- 6. мелочи на стол ----------
def kitchen_mugs():
    """Пара кружек — декор поверх стола/тумбы."""
    w, h = 12, 8
    im = gen.canvas(w, h)
    d = ImageDraw.Draw(im)
    gen.R(d, 1, 1, 4, 5, LIGHT); gen.R(d, 1, 1, 4, 1, '#ffd0d8'); gen.P(d, 5, 3, LIGHT)
    gen.R(d, 7, 2, 10, 6, '#4fa8ff'); gen.R(d, 7, 2, 10, 2, '#bfe6ff'); gen.P(d, 11, 4, '#4fa8ff')
    im = gen.tint(im)
    im = gen.outline_alpha(im)
    gen.save(im, 'kitchen_mugs')


def kitchen_snack():
    """Тарелка с едой — декор поверх стола."""
    w, h = 14, 8
    im = gen.canvas(w, h)
    d = ImageDraw.Draw(im)
    d.ellipse([0, 2, 13, 7], fill=gen.WHITE)
    d.ellipse([2, 3, 11, 6], fill=gen._mix(gen.WHITE, -0.08))
    gen.R(d, 4, 2, 9, 3, '#e0a83a'); gen.R(d, 4, 2, 9, 2, HANDLE)
    gen.P(d, 5, 3, gen.GREEN); gen.P(d, 8, 3, gen.GREEN)
    im = gen.tint(im)
    im = gen.outline_alpha(im)
    gen.save(im, 'kitchen_snack')


def build(theme):
    gen.use_theme(theme)
    globals().update(gen.THEME)          # DESK_TOP, DESK_SIDE, WHITE, GREEN, NIGHT и т.д.
    counter_straight()
    counter_corner()
    sink_counter()
    coffee_machine()
    dining_table()
    kitchen_mugs()
    kitchen_snack()


if __name__ == '__main__':
    themes = sys.argv[1:] or ['day', 'night']
    for t in themes:
        build(t)
