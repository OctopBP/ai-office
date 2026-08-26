"""
Что на самом деле уехало в glTF.

Между «в Blender всё на месте» и «клиент это прочитал» лежит экспорт, и
ошибается он молча: маркер оказался в исключённой коллекции, custom property
не попало в `extras`, поворот уехал вместе с осями. Проверять это глазами в
браузере — самый долгий способ.

    python3 tools/blender/inspect_glb.py design/scenes/studio.glb

Печатает дерево узлов, маркеры с их `extras` и координатами **в системе плана**
(x вправо, y вниз) — то есть в тех же числах, которыми оперирует раскладка и
код офиса. Зависимостей нет: GLB — это заголовок и два куска, JSON читается
как есть.
"""
from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

#: Приставки имён, которые клиент считает маркерами (см. scene-format.md §2).
MARKER_PREFIXES = ('seat.', 'spot.', 'zone.', 'hotspot.', 'door.', 'nav.')


def read_glb(path: Path) -> dict:
    data = path.read_bytes()
    magic, _version, _length = struct.unpack_from('<III', data, 0)
    if magic != 0x46546C67:
        raise SystemExit(f'{path}: это не GLB')
    offset = 12
    while offset < len(data):
        chunk_len, chunk_type = struct.unpack_from('<II', data, offset)
        body = data[offset + 8: offset + 8 + chunk_len]
        if chunk_type == 0x4E4F534A:      # 'JSON'
            return json.loads(body.decode('utf-8'))
        offset += 8 + chunk_len + (-chunk_len % 4)
    raise SystemExit(f'{path}: в файле нет JSON-куска')


def base_name(name: str) -> str:
    """`seat.work.003` → `seat.work`: отрезать хвост, дописанный Blender.

    То же правило обязан применять загрузчик — иначе десять рабочих мест
    превращаются в одно рабочее место и девять неизвестных имён.
    """
    head, _, tail = name.rpartition('.')
    return head if head and tail.isdigit() else name


def plan_of(node: dict) -> tuple[float, float, float, float]:
    """Узел glTF → точка плана и поворот.

    glTF: x вправо, y вверх, z вниз по плану. План: x вправо, y вниз.
    Поворот вокруг вертикали достаётся из кватерниона — это тот самый `yaw`,
    которым оперируют занятия (`interests.ts`).
    """
    tx, ty, tz = node.get('translation', [0, 0, 0])
    qx, qy, qz, qw = node.get('rotation', [0, 0, 0, 1])
    yaw = math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qx * qx))
    return tx, tz, ty, yaw


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__.strip().splitlines()[-6].strip())
    path = Path(sys.argv[1])
    gltf = read_glb(path)
    nodes = gltf.get('nodes', [])

    parent = {}
    for i, node in enumerate(nodes):
        for child in node.get('children', []):
            parent[child] = i

    markers, meshes, unknown = [], [], []
    for i, node in enumerate(nodes):
        name = node.get('name', f'<{i}>')
        base = base_name(name)
        if base.startswith(MARKER_PREFIXES):
            markers.append((i, base, node))
        elif 'mesh' in node:
            meshes.append((i, base, node))
        elif not node.get('children'):
            unknown.append((i, base))

    print(f'{path}  —  {len(nodes)} узлов, '
          f'{len(gltf.get("meshes", []))} мешей, '
          f'{len(gltf.get("materials", []))} материалов')

    print(f'\nМАРКЕРЫ ({len(markers)})')
    if not markers:
        print('  нет ни одного — клиенту не за что зацепиться')
    by_kind: dict[str, list] = {}
    for i, base, node in markers:
        by_kind.setdefault(base, []).append((i, node))
    for base in sorted(by_kind):
        print(f'  {base}  ×{len(by_kind[base])}')
        for i, node in by_kind[base]:
            x, y, z, yaw = plan_of(node)
            line = f'      at [{x:7.2f}, {y:6.2f}]'
            if abs(z) > 1e-6:
                line += f'  z {z:.2f}'
            line += f'  yaw {math.degrees(yaw):7.1f}°'
            scale = node.get('scale')
            if scale and any(abs(s - 1) > 1e-6 for s in scale):
                line += f'  scale [{scale[0]:.2f}, {scale[2]:.2f}, {scale[1]:.2f}]'
            extras = node.get('extras')
            if extras:
                line += '  ' + json.dumps(extras, ensure_ascii=False)
            if 'mesh' in node:
                line += '  +меш'
            print(line)

    kinds: dict[str, int] = {}
    for _i, base, _node in meshes:
        kinds[base] = kinds.get(base, 0) + 1
    print(f'\nГЕОМЕТРИЯ ({len(meshes)} узлов с мешем)')
    for name in sorted(kinds):
        print(f'  {name}  ×{kinds[name]}')

    if unknown:
        print(f'\nПУСТЫШКИ БЕЗ ИМЕНИ ИЗ СПИСКА ({len(unknown)})')
        for i, base in unknown:
            print(f'  {base}')


if __name__ == '__main__':
    main()
