"""
Насколько предметы уже живут по правилу единиц (docs/design/office-units/spec.md).

    python3 scripts/units.py            сводка
    python3 scripts/units.py --full     плюс те, у кого модели нет

Печатает по каждому пресету: габарит модели, нынешний след, след по новой
сетке и расхождение между ними. Это не гейт, а список работ: правило принято,
переезд не сделан, и скрипт показывает, сколько до него осталось.

Зависимостей нет. GLB — это заголовок и два куска, JSON читается как есть;
габарит собирается из `min`/`max` аксессоров позиций, прогнанных через матрицы
узлов, — вершины для этого разворачивать не нужно.
"""
from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRESETS = ROOT / 'design/presets'

#: Сколько метров в тайле по новому правилу (§2 спеки).
TILE = 0.5
#: Сколько метров в единице файла модели сейчас — наследство набора Kenney.
#: По правилу §1 должно стать 1.0, и тогда эта константа отсюда уедет.
UNIT_NOW = 2.0
#: На сколько модель имеет право торчать за след, метров на сторону (§4).
#: Диван торчит подлокотниками на 12 см — так и задумано; кресло вдвое
#: больше следа — ошибка, и ловится именно здесь.
OVERHANG = 0.15


def read_glb(path: Path) -> dict:
    data = path.read_bytes()
    if data[:4] != b'glTF':
        raise SystemExit(f'{path}: это не GLB')
    offset = 12
    while offset < len(data):
        length, kind = struct.unpack_from('<II', data, offset)
        if kind == 0x4E4F534A:
            return json.loads(data[offset + 8: offset + 8 + length].decode('utf-8'))
        offset += 8 + length + (-length % 4)
    raise SystemExit(f'{path}: в файле нет JSON-куска')


def node_matrix(node: dict) -> list[float]:
    """Матрица узла, по строкам. glTF хранит по столбцам — здесь разворот."""
    if 'matrix' in node:
        m = node['matrix']
        return [m[0], m[4], m[8], m[12],
                m[1], m[5], m[9], m[13],
                m[2], m[6], m[10], m[14],
                m[3], m[7], m[11], m[15]]
    out = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    if 'rotation' in node:
        x, y, z, w = node['rotation']
        out = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0,
               2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0,
               2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0,
               0, 0, 0, 1]
    if 'scale' in node:
        sx, sy, sz = node['scale']
        for r in range(3):
            out[r * 4 + 0] *= sx
            out[r * 4 + 1] *= sy
            out[r * 4 + 2] *= sz
    if 'translation' in node:
        tx, ty, tz = node['translation']
        out[3], out[7], out[11] = out[3] + tx, out[7] + ty, out[11] + tz
    return out


def mul(a: list[float], b: list[float]) -> list[float]:
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4))
            for r in range(4) for c in range(4)]


def apply(m: list[float], p: tuple[float, float, float]) -> tuple[float, float, float]:
    x, y, z = p
    return (m[0] * x + m[1] * y + m[2] * z + m[3],
            m[4] * x + m[5] * y + m[6] * z + m[7],
            m[8] * x + m[9] * y + m[10] * z + m[11])


def bounds(path: Path) -> tuple[list[float], list[float]]:
    """Габарит модели в единицах файла: (min, max) по трём осям."""
    gltf = read_glb(path)
    lo = [math.inf] * 3
    hi = [-math.inf] * 3

    def walk(index: int, parent: list[float]) -> None:
        node = gltf['nodes'][index]
        here = mul(parent, node_matrix(node))
        if 'mesh' in node:
            for prim in gltf['meshes'][node['mesh']]['primitives']:
                acc = gltf['accessors'][prim['attributes']['POSITION']]
                for cx in (acc['min'][0], acc['max'][0]):
                    for cy in (acc['min'][1], acc['max'][1]):
                        for cz in (acc['min'][2], acc['max'][2]):
                            p = apply(here, (cx, cy, cz))
                            for i in range(3):
                                lo[i] = min(lo[i], p[i])
                                hi[i] = max(hi[i], p[i])
        for child in node.get('children', []):
            walk(child, here)

    scene = gltf['scenes'][gltf.get('scene', 0)]
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    for root in scene['nodes']:
        walk(root, identity)
    return lo, hi


def origin_of(lo: list[float], hi: list[float]) -> str:
    """Где начало координат внутри габарита — словом, а не тремя долями."""
    def rel(i: int) -> float:
        span = hi[i] - lo[i]
        return 0.5 if span <= 1e-9 else (0 - lo[i]) / span
    x, y, z = rel(0), rel(1), rel(2)
    ok_x = abs(x - 0.5) < 0.05
    ok_y = abs(y) < 0.05
    ok_z = abs(z - 0.5) < 0.05
    if ok_x and ok_y and ok_z:
        return 'по правилу'
    return f'x{x:.2f} y{y:.2f} z{z:.2f}'


def main() -> None:
    full = '--full' in sys.argv
    rows = []
    for folder in sorted(PRESETS.iterdir()):
        file = folder / 'preset.json'
        if not file.exists():
            continue
        preset = json.loads(file.read_text('utf-8'))
        parts = preset.get('parts') or []
        fp = preset.get('footprint') or [0, 0, *preset['size']]
        # След сейчас записан в тайлах по 0.75 м — переводим в метры, чтобы
        # сравнивать с моделью, а не с самим собой.
        fp_m = (fp[2] * 0.75, fp[3] * 0.75)
        model = None
        origin = ''
        if parts:
            path = folder / parts[0]['file']
            if path.exists():
                lo, hi = bounds(path)
                model = ((hi[0] - lo[0]) * UNIT_NOW, (hi[2] - lo[2]) * UNIT_NOW)
                origin = origin_of(lo, hi)
        if model is None and not full:
            continue
        rows.append((preset['id'], model, fp_m, origin))

    print(f'тайл {TILE} м, единица модели {UNIT_NOW} м (по правилу должна стать 1.0)\n')
    head = f'{"пресет":16s} {"модель, м":>13s} {"след сейчас":>13s} {"след, тайлы":>12s} {"след−модель":>13s}  начало координат'
    print(head)
    print('-' * len(head))
    todo = 0
    for pid, model, fp_m, origin in rows:
        # След — авторское число, и на сетку он ложится сам по себе. Считать
        # его из модели нельзя: тогда раздутая модель выписывала бы себе
        # раздутый след и проверка всегда сходилась бы.
        cells = (max(1, round(fp_m[0] / TILE)), max(1, round(fp_m[1] / TILE)))
        claim = (cells[0] * TILE, cells[1] * TILE)
        if model is None:
            print(f'{pid:16s} {"—":>13s} {fp_m[0]:6.2f}×{fp_m[1]:5.2f} '
                  f'{cells[0]:5d}×{cells[1]:<6d} {"— (без модели)":>13s}')
            continue
        gap = ((claim[0] - model[0]) / 2 * 100, (claim[1] - model[1]) / 2 * 100)
        out = max((model[0] - claim[0]) / 2, (model[1] - claim[1]) / 2)
        mark = f'  ТОРЧИТ НА {out * 100:.0f} СМ' if out > OVERHANG else ''
        if origin != 'по правилу' or mark:
            todo += 1
        print(f'{pid:16s} {model[0]:6.2f}×{model[1]:5.2f} {fp_m[0]:6.2f}×{fp_m[1]:5.2f} '
              f'{cells[0]:5d}×{cells[1]:<6d} {gap[0]:+5.1f}/{gap[1]:+5.1f} см  {origin}{mark}')
    print(f'\nмоделей: {sum(1 for r in rows if r[1])}, из них требуют работы: {todo}')
    print('правило: docs/design/office-units/spec.md')


if __name__ == '__main__':
    main()
