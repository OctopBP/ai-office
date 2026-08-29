"""
Разбор раскладки офиса — та же арифметика, что в `src/web/office3d`, на Python.

Модуль нужен ровно один раз: чтобы **перенести** нынешнюю комнату из тайловой
раскладки в Blender. Дальше комнату ведёт человек в сцене, а этот код умирает
вместе с раскладками. Поэтому он повторяет TypeScript построчно, а не пытается
быть лучше: расхождение здесь означало бы, что перенос уже неверен.

Ссылки на первоисточники, с которых списано:
  scene3, wallCells, runBox  ← src/web/office3d/geometry.ts
  floorRect, place3          ← src/web/office3d/props.ts
  restSeats, sideSeats       ← src/shared/layout.ts

Про bpy тут не знает ничего: обычный Python, запускается и снаружи Blender.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

# ── Постоянные сцены. Списаны с geometry.ts и props.ts. ──────────────────────

WALL_H = 2.6
WALL_THICK = 0.4
WINDOW_SILL = 0.9
WINDOW_HEAD = 1.9
FLOOR_THICK = 0.12

#: Продолжение коробки за центр крайней клетки участка (geometry.ts, JOIN/OPENING/CAP):
#: стыковка с соседней стеной, граница проёма внутри отрезка, свободный конец.
JOIN = 1
OPENING = 0.5
CAP = WALL_THICK / 2

#: Тайлов в одной единице модели Kenney (props.ts, MODEL_SCALE).
MODEL_SCALE = 2 / 0.75

#: Метров в тайле. Нужно только чтобы выставить единицы сцены в Blender:
#: считаем везде в тайлах, а человеку показываем метры.
TILE_M = 0.75

#: Насколько собеседники расходятся от точки разговора (interests.ts, TALK_GAP).
TALK_GAP = 0.75

#: Зазор между краем предмета и стоящим у него (layout.ts, SEAT_GAP).
SEAT_GAP = 0.5


# ── Данные ───────────────────────────────────────────────────────────────────

@dataclass
class Box:
    """Коробка: центр в плане, габариты, отметка низа. Всё в тайлах."""
    cx: float
    cy: float
    w: float
    d: float
    h: float
    base: float
    glass: bool = False


@dataclass
class Placed:
    """Предмет, готовый к постановке в сцену."""
    key: str
    sprite: str
    ax: float
    ay: float
    cx: float
    cy: float
    w: float
    d: float
    h: float
    base: float
    rot: float          # радианы, как в Placed3.rot
    models: list = field(default_factory=list)
    wall: float | None = None
    shape: str = 'box'
    tone: str = 'metal'


# ── Пресеты предметов ────────────────────────────────────────────────────────
#
# Раньше здесь лежала копия таблицы `PROPS` из `props.ts` — шестое по счёту
# место, где был описан один и тот же диван, и после переноса в пресеты
# (docs/design/office-presets/spec.md) единственное уцелевшее. Копия, за
# которой больше нечему следить, расходится молча: клиент читает пресет, а
# сцена в Blender собиралась бы по числам годичной давности.
#
# Теперь читаем те же файлы, что и клиент. Полей нужно немного — высота, след,
# из чего собран, висит ли на стене, — и все они в пресете есть.

PRESETS: dict[str, dict] = {}


def load_presets(root: Path) -> None:
    """Прочитать `design/presets/*/preset.json`. Зовётся из `load()`."""
    PRESETS.clear()
    for path in sorted((root / 'design' / 'presets').glob('*/preset.json')):
        PRESETS[path.parent.name] = json.loads(path.read_text('utf-8'))


# Предмет, которого в пресетах нет: коробка размером с клетку. Как и на
# клиенте — кубик не на своём месте виднее, чем дырка в комнате.
FALLBACK: dict = {
    'id': 'unknown', 'size': [1, 1], 'footprint': [0, 0, 1, 1],
    'h': 1.0, 'fallback': 'box', 'components': [],
}


def component(preset: dict, kind: str) -> dict | None:
    """Первый компонент этого сорта. Кратность проверяет схема на стороне TS."""
    for c in preset.get('components', []):
        if c.get('type') == kind:
            return c
    return None


FLOORS = {
    'parquet': (0.851, 0.694, 0.514),
    'carpet': (0.604, 0.659, 0.733),
    'tile': (0.875, 0.894, 0.918),
}
WALL_COLOR = (0.941, 0.949, 0.961)
GLASS_COLOR = (0.737, 0.847, 0.910)


def def_of(sprite: str) -> dict:
    return PRESETS.get(sprite, FALLBACK)


# ── Чтение файлов ────────────────────────────────────────────────────────────

def load(root: Path, preset: str) -> tuple[dict, dict]:
    load_presets(root)
    layout = json.loads((root / 'design' / 'layouts' / f'{preset}.json').read_text('utf-8'))
    catalog = json.loads((root / 'design' / 'sprites' / 'out' / 'catalog.json').read_text('utf-8'))
    return layout, catalog


# ── Стены и полы (порт geometry.ts) ──────────────────────────────────────────

def _wall_cells(wall: dict):
    ax, ay = wall['a']
    bx, by = wall['b']
    horizontal = ay == by
    raw = (bx - ax) if horizontal else (by - ay)
    step = -1 if raw < 0 else 1
    n = abs(raw)

    kinds = ['solid'] * n
    for offset, span in wall.get('doors', []):
        for i in range(max(offset, 0), min(offset + span, n)):
            kinds[i] = 'gap'
    for offset in wall.get('windows', []):
        if 0 <= offset < n and kinds[offset] != 'gap':
            kinds[offset] = 'window'

    def cell_at(i):
        return (ax + i * step, ay) if horizontal else (ax, ay + i * step)

    return kinds, cell_at, horizontal, step, n


def _run_box(cells, horizontal, base, h, ext_lo, ext_hi) -> Box:
    x0 = min(c[0] for c in cells)
    y0 = min(c[1] for c in cells)
    start = x0 if horizontal else y0
    lo = start + 0.5 - ext_lo
    hi = start + len(cells) - 0.5 + ext_hi
    along = hi - lo
    mid = (lo + hi) / 2
    if horizontal:
        return Box(mid, y0 + 0.5, along, WALL_THICK, h, base)
    return Box(x0 + 0.5, mid, WALL_THICK, along, h, base)


def _wall_body_cells(layout: dict) -> set:
    """Клетки всех стен, где есть тело стены; проёмы не в счёт."""
    body = set()
    for wall in layout.get('walls', []):
        kinds, cell_at, _horizontal, _step, n = _wall_cells(wall)
        for i in range(n):
            if kinds[i] != 'gap':
                body.add(cell_at(i))
    return body


def floors_of(layout: dict) -> list[tuple[str, str, Box]]:
    out = []
    for room in layout.get('rooms', []):
        x0, y0, x1, y1 = room['rect']
        out.append((room['id'], room.get('floor', 'carpet'), Box(
            (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, FLOOR_THICK, -FLOOR_THICK)))
    return out


def walls_of(layout: dict) -> list[list[Box]]:
    """Стены отрезками: список коробок на каждый отрезок раскладки."""
    body = _wall_body_cells(layout)
    result = []
    for wall in layout.get('walls', []):
        kinds, cell_at, horizontal, step, n = _wall_cells(wall)

        def ext(outside, cell_at=cell_at, n=n):
            if 0 <= outside < n:
                return OPENING
            return JOIN if cell_at(outside) in body else CAP

        boxes: list[Box] = []
        i = 0
        while i < n:
            kind = kinds[i]
            j = i
            while j < n and kinds[j] == kind:
                j += 1
            if kind != 'gap':
                cells = [cell_at(k) for k in range(i, j)]
                ext_first, ext_last = ext(i - 1), ext(j)
                ext_lo = ext_first if step > 0 else ext_last
                ext_hi = ext_last if step > 0 else ext_first
                if kind == 'solid':
                    boxes.append(_run_box(cells, horizontal, 0, WALL_H, ext_lo, ext_hi))
                else:
                    boxes.append(_run_box(cells, horizontal, 0, WINDOW_SILL, ext_lo, ext_hi))
                    boxes.append(_run_box(
                        cells, horizontal, WINDOW_HEAD, WALL_H - WINDOW_HEAD, ext_lo, ext_hi))
                    glass = _run_box(
                        cells, horizontal, WINDOW_SILL, WINDOW_HEAD - WINDOW_SILL,
                        ext_lo, ext_hi)
                    if horizontal:
                        glass.d = WALL_THICK * 0.25
                    else:
                        glass.w = WALL_THICK * 0.25
                    glass.glass = True
                    boxes.append(glass)
            i = j
        if boxes:
            result.append(boxes)
    return result


# ── Расстановка предметов (порт props.ts) ────────────────────────────────────

def floor_rect(catalog: dict, prop: dict) -> tuple[float, float, float, float]:
    d = def_of(prop['sprite'])
    s = prop.get('scale', 1)
    ax, ay = prop['at']
    # Трёх веток больше нет: след записан в пресете, один и тот же для
    # отрисовки и для проходимости (спека §3).
    fx, fy, fw, fh = d['footprint']
    return ax + fx * s, ay + fy * s, fw * s, fh * s


def nailed_props(layout: dict) -> list[dict]:
    """Нажимаемое — дверь и хотспоты — как обычные предметы раскладки.

    Так делает и клиент (`Office3D.tsx`): доска, экран лога и дверь едут в
    `place3` вместе с мебелью, потому что прижать панель к стене и развернуть
    её в комнату — та же арифметика, что у постера и часов. Отдельного
    размещения для них нет ни там, ни здесь.
    """
    extra: list[dict] = []
    for zone in layout.get('zones', []):
        if zone.get('kind') == 'entrance' and zone.get('sprite') and zone.get('at'):
            extra.append({'sprite': zone['sprite'], 'at': zone['at'], 'id': 'spot-door'})
    for spot in layout.get('hotspots', []):
        if spot.get('sprite') and spot.get('at') and spot.get('panel'):
            extra.append({'sprite': spot['sprite'], 'at': spot['at'],
                          'id': f'spot-{spot["panel"]}'})
    return extra


def place(layout: dict, catalog: dict, extra: list[dict] | None = None) -> list[Placed]:
    cols, rows = layout['size']
    items: list[Placed] = []
    for i, prop in enumerate(list(layout.get('props', [])) + list(extra or [])):
        d = def_of(prop['sprite'])
        x, y, w, depth = floor_rect(catalog, prop)
        mount = component(d, 'wall_mounted')
        wall = mount['at'] if mount else None
        items.append(Placed(
            key=prop.get('id') or f'{prop["sprite"]}.{i}',
            sprite=prop['sprite'],
            ax=prop['at'][0], ay=prop['at'][1],
            cx=x + w / 2, cy=y + depth / 2,
            w=w,
            # У настенного глубина — толщина панели, а не след.
            d=(mount.get('thickness', 0.12) if mount else depth),
            h=d['h'],
            base=(wall if wall is not None else 0),
            rot=math.radians(prop['rot']) if 'rot' in prop else 0.0,
            models=d.get('parts', []),
            wall=wall,
            shape=d['fallback'],
            tone=d.get('tone', 'metal'),
        ))

    # Что на чём стоит.
    for item in items:
        if item.wall is not None or item.shape == 'slab':
            continue
        lift = 0.0
        for host in items:
            if host is item or host.wall is not None or host.shape == 'slab':
                continue
            inside = (
                item.cx - item.w / 2 >= host.cx - host.w / 2 - 1e-6 and
                item.cx + item.w / 2 <= host.cx + host.w / 2 + 1e-6 and
                item.cy - item.d / 2 >= host.cy - host.d / 2 - 1e-6 and
                item.cy + item.d / 2 <= host.cy + host.d / 2 + 1e-6)
            if inside:
                lift = max(lift, host.base + host.h)
        item.base = lift

    # Настенное прижимается к стене и разворачивается в комнату.
    walls = layout.get('walls', [])
    for item in items:
        if item.wall is None:
            continue
        best = None
        for wall in walls:
            ax, ay = wall['a']
            bx, by = wall['b']
            horizontal = ay == by
            along = item.cx if horizontal else item.cy
            lo = min(ax if horizontal else ay, bx if horizontal else by)
            hi = max(ax if horizontal else ay, bx if horizontal else by)
            if along < lo - 1 or along > hi + 1:
                continue
            at = ay if horizontal else ax
            dist = abs((item.cy if horizontal else item.cx) - at)
            if best is None or dist < best[2]:
                best = (horizontal, at, dist)

        horizontal = best[0] if best else True
        inner = (item.cy < rows / 2) if horizontal else (item.cx < cols / 2)
        side = 1 if inner else -1

        if best:
            face = best[1] + 0.5 + side * (WALL_THICK / 2 + item.d / 2)
            if horizontal:
                item.cy = face
            else:
                item.cx = face
        if item.rot == 0:
            if horizontal:
                item.rot = 0.0 if side > 0 else math.pi
            else:
                item.rot = math.pi / 2 if side > 0 else -math.pi / 2

    return items


# ── Маркеры: что становится пустышкой в сцене ────────────────────────────────

@dataclass
class Marker:
    """Пустышка будущей сцены: имя, точка в плане, взгляд, доп. свойства.

    `yaw` — радианы, 0 значит «лицом вниз по плану» (в сцене это +Z, юг).
    Ровно та же величина, что `Interest.yaw` в interests.ts.
    """
    name: str
    x: float
    y: float
    yaw: float = 0.0
    z: float = 0.0
    extras: dict = field(default_factory=dict)
    #: Полугабариты, если маркер описывает область, а не точку.
    extent: tuple[float, float, float] | None = None


def _prop_by_id(layout: dict, prop_id: str | None):
    for prop in layout.get('props', []):
        if prop_id and prop.get('id') == prop_id:
            return prop
    return None


def markers_of(layout: dict, catalog: dict) -> list[Marker]:
    """Все маркеры нынешней раскладки — то, что должно уехать в пустышки.

    Названия здесь — предложение из записки о передаче дел, с двумя правками:
    `walkable` получил приставку (`nav.walkable`), а зона переговорной осталась
    областью, а не набором мест: число участников встречи заранее неизвестно,
    и раскладывать их по кругу всё равно придётся коду.
    """
    sprites = catalog['sprites']
    out: list[Marker] = []

    # Рабочие места: слот `work` у столов. Порядок — по строкам сверху вниз,
    # чтобы номер стола не зависел от порядка предметов в файле.
    desks = []
    for prop in layout.get('props', []):
        sprite = sprites.get(prop['sprite'])
        slot = next((s for s in (sprite or {}).get('slots', [])
                     if s.get('kind') == 'work'), None)
        if not slot:
            continue
        s = prop.get('scale', 1)
        desks.append((prop, slot, prop['at'][0] + slot['x'] * s,
                      prop['at'][1] + slot['y'] * s))
    desks.sort(key=lambda d: (round(d[3], 3), round(d[2], 3)))
    for prop, slot, x, y in desks:
        extras = {'sprite': prop['sprite']}
        if prop['sprite'] == 'desk_pm':
            extras['role'] = 'pm'
        # Табличка задачи стоит на столешнице — слот `plate` того же предмета.
        plate = next((s for s in sprites[prop['sprite']].get('slots', [])
                      if s.get('kind') == 'plate'), None)
        if plate:
            s = prop.get('scale', 1)
            extras['plateX'] = round(prop['at'][0] + plate['x'] * s - x, 3)
            extras['plateY'] = round(prop['at'][1] + plate['y'] * s - y, 3)
        # Сидящий за столом смотрит на стол: слот `work` объявлен над якорем
        # предмета (y отрицательный), значит взгляд — вниз по плану, yaw = 0.
        out.append(Marker('seat.work', x, y, 0.0, extras=extras))

    # Места отдыха: слоты `seat` у предметов. `use` решает, что это за место.
    for prop in layout.get('props', []):
        sprite = sprites.get(prop['sprite'])
        if not sprite:
            continue
        s = prop.get('scale', 1)
        for slot in sprite.get('slots', []):
            if slot.get('kind') != 'seat' or 'x' not in slot:
                continue
            use = slot.get('use', 'sit')
            x = prop['at'][0] + slot['x'] * s
            y = prop['at'][1] + slot['y'] * s
            out.append(Marker(f'seat.{use}', x, y, 0.0,
                              extras={'sprite': prop['sprite']}))

    for zone in layout.get('zones', []):
        kind = zone.get('kind')

        if kind == 'talk' and zone.get('at'):
            # Точка разговора: двое встают по обе стороны и смотрят друг на
            # друга. Ось разговора — это направление «вправо» у пустышки,
            # то есть её собственный +X.
            x, y = zone['at']
            along_x = zone.get('axis', 'x') == 'x'
            out.append(Marker('spot.talk', x, y,
                              0.0 if along_x else math.pi / 2,
                              extras={'gap': TALK_GAP}))

        elif kind == 'idle':
            room = next((r for r in layout.get('rooms', [])
                         if r['id'] == zone.get('room')), None)
            if room:
                x0, y0, x1, y1 = room['rect']
                out.append(Marker('zone.idle', (x0 + x1) / 2, (y0 + y1) / 2,
                                  extent=((x1 - x0) / 2, (y1 - y0) / 2, WALL_H / 2),
                                  extras={'room': room['id']}))

        elif kind == 'meeting':
            prop = _prop_by_id(layout, zone.get('prop'))
            sprite = sprites.get(prop['sprite']) if prop else None
            ring = next((s for s in (sprite or {}).get('slots', []) if 'ring' in s), None)
            if prop and ring:
                s = prop.get('scale', 1)
                cx = prop['at'][0] + sprite['size'][0] * s / 2
                cy = prop['at'][1] + sprite['size'][1] * s / 2
                # Места вокруг стола не перечисляем: участников встречи от
                # одного до восьми, и раскладывает их по эллипсу код. Пустышка
                # задаёт только сам эллипс.
                out.append(Marker('zone.meeting', cx, cy, extras={
                    'ring': ring['ring'],
                    'rx': round(ring['rx'] * s, 3),
                    'ry': round(ring['ry'] * s, 3),
                    'grow': bool(ring.get('grow')),
                }))

    # Дверь и хотспоты — там же, где стоят их панели: прижатыми к стене и
    # развёрнутыми в комнату. Брать их «сырое» `at` нельзя — это точка на
    # самой стене, и агент шёл бы внутрь неё.
    nailed = {p.key: p for p in place(layout, catalog, nailed_props(layout))}
    for zone in layout.get('zones', []):
        if zone.get('kind') != 'entrance' or not zone.get('at'):
            continue
        panel = nailed.get('spot-door')
        x, y = (panel.cx, panel.cy) if panel else tuple(zone['at'])
        out.append(Marker('hotspot.exit', x, y, -panel.rot if panel else 0.0,
                          extras={'panel': 'exit', 'title': zone.get('title', '')}))

    for hotspot in layout.get('hotspots', []):
        panel = nailed.get(f'spot-{hotspot["panel"]}')
        x, y = (panel.cx, panel.cy) if panel else tuple(hotspot['at'])
        out.append(Marker(f'hotspot.{hotspot["panel"]}', x, y,
                          -panel.rot if panel else 0.0, extras={
                              'panel': hotspot['panel'],
                              'key': hotspot.get('key', ''),
                              'title': hotspot.get('title', ''),
                          }))

    return out


# ── Проходимость ─────────────────────────────────────────────────────────────

def walkable_tiles(layout: dict, catalog: dict) -> list[tuple[int, int]]:
    """Тайлы, по которым сейчас ходит `findPath` — заготовка меша `nav.walkable`.

    Считается грубо и намеренно: пол комнат минус след предметов с `blocks`.
    Это стартовая форма, которую человек дальше правит в Blender руками, а не
    источник истины. Тонкости плоской проходимости (`passability` в layout.ts)
    сюда переносить незачем — они умрут вместе с раскладкой.
    """
    blocked: set[tuple[int, int]] = set()
    for prop in layout.get('props', []):
        sprite = catalog['sprites'].get(prop['sprite'])
        if not sprite or not sprite.get('blocks'):
            continue
        x, y, w, d = floor_rect(catalog, prop)
        for tx in range(math.floor(x), math.ceil(x + w)):
            for ty in range(math.floor(y), math.ceil(y + d)):
                # Тайл занят, если его центр попал под предмет.
                if x - 0.5 <= tx <= x + w - 0.5 and y - 0.5 <= ty <= y + d - 0.5:
                    blocked.add((tx, ty))

    tiles: list[tuple[int, int]] = []
    for room in layout.get('rooms', []):
        x0, y0, x1, y1 = room['rect']
        for tx in range(x0, x1):
            for ty in range(y0, y1):
                if (tx, ty) not in blocked:
                    tiles.append((tx, ty))
    return tiles
