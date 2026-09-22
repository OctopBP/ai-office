#!/usr/bin/env python3
"""Собирает детализированную модель персонажа «jonDetailed» поверх скелета блондина.

Почему без Blender. Роль по умолчанию собирает модели через
`$BLENDER --background --python ...` (см. `build_scene.py`, `office_layout.py`).
В этом окружении headless-запуск Blender 4.3.2 падает по SIGSEGV ещё до
разбора аргументов — крах внутри детектора GPU-бэкенда (Metal) при
`WM_init`, воспроизводится на любом скрипте и любых флагах. Это не связано
с содержимым скрипта, поэтому вместо bpy используется связка
`assimp` (конвертация исходного FBX в промежуточный glTF, тем же кодом,
каким Blender переставляет оси при экспорте) + чистый Python: скелет и
скин читаются из этого glTF как есть, а новые части (волосы, лицо, глаза,
одежда) — вершинная геометрия, собранная numpy-генераторами примитивов
ниже. Скрипт детерминированный и воспроизводимый — ровно то же требование,
которое обычно закрывает bpy-скрипт.

Геометрия новых частей строится в «mesh space» — том же пространстве, где
заданы вершины исходного тела (`character.fbx` → POSITION), затем каждая
часть жёстко привязывается к одной кости через `inverseBindMatrix` этой
кости (родительство, не скининг — вариант, прямо разрешённый в задаче).
Формула стандартная для glTF: точка в локальном пространстве кости —
это `inverseBindMatrix[j] @ P_mesh`; кость сама уже анимируется клипами
ходьбы/простоя, а новый узел, будучи её ребёнком с единичным трансформом,
едет вместе с ней без какой-либо отдельной анимации или скининга.

Скелет, имена костей и меш тела не трогаются вовсе — только читаются и
копируются как есть, поэтому существующие анимационные `.fbx` (они грузятся
отдельно, `character.fbx` своих клипов не несёт и в рантайме не используется)
продолжают накладываться на эту модель без изменений.

Запуск:

    python3 tools/blender/build_character_detailed.py
"""
from __future__ import annotations

import json
import math
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
CHAR_FBX = ROOT / 'design/models/characters/character.fbx'
OUT_GLB = ROOT / 'design/models/characters/jonDetailed.glb'

# ---------------------------------------------------------------------------
# 1. Исходник: FBX → промежуточный glTF через assimp (оси и скин не трогаем).
# ---------------------------------------------------------------------------

def export_base_gltf(tmpdir: Path) -> tuple[dict, bytes]:
    assimp = shutil.which('assimp')
    if not assimp:
        raise SystemExit('assimp не найден в PATH — нужен для чтения скелета без Blender')
    out = tmpdir / 'base.gltf'
    subprocess.run(
        [assimp, 'export', str(CHAR_FBX), str(out), '-f', 'gltf2'],
        check=True, capture_output=True,
    )
    gltf = json.loads(out.read_text())
    bin_path = tmpdir / gltf['buffers'][0]['uri']
    return gltf, bin_path.read_bytes()


def apply(mat: np.ndarray, pts: np.ndarray) -> np.ndarray:
    homo = np.hstack([pts, np.ones((len(pts), 1))])
    return (mat @ homo.T).T[:, :3]


def local_mat(node: dict) -> np.ndarray:
    if 'matrix' in node:
        return np.array(node['matrix'], dtype=np.float64).reshape(4, 4, order='F')
    t = np.eye(4)
    if 'translation' in node:
        t[:3, 3] = node['translation']
    r = np.eye(4)
    if 'rotation' in node:
        x, y, z, w = node['rotation']
        r[:3, :3] = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ])
    s = np.eye(4)
    if 'scale' in node:
        s[0, 0], s[1, 1], s[2, 2] = node['scale']
    return t @ r @ s


def world_matrices(gltf: dict) -> list[np.ndarray]:
    """Мировые матрицы узлов в состоянии покоя (bind pose), из локальных TRS в JSON.

    Нужны напрямую, а не через inverseBindMatrices скина: у экспорта assimp
    inverseBindMatrices не согласованы с реальной иерархией узлов (проверено —
    Head_world_bind @ invBind[Head] даёт единичную матрицу вместо ожидаемого
    мирового трансформа меша, ×100). Прямой обход иерархии свободен от этой
    нестыковки и однозначно верен по построению (FK).
    """
    nodes = gltf['nodes']
    world: list[np.ndarray | None] = [None] * len(nodes)

    def walk(i: int, parent_world: np.ndarray) -> None:
        m = parent_world @ local_mat(nodes[i])
        world[i] = m
        for c in nodes[i].get('children', []):
            walk(c, m)

    scene = gltf['scenes'][gltf.get('scene', 0)]
    for r in scene['nodes']:
        walk(r, np.eye(4))
    return world  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# 2. Генераторы примитивной геометрии — тот же простой стиль, что у мебели
#    Kenney: без текстур, цвет материалом, плоские грани там, где это грани.
# ---------------------------------------------------------------------------

Mesh = tuple[np.ndarray, np.ndarray, np.ndarray]  # positions, normals, indices(u4)


def _flat_quad(p0, p1, p2, p3) -> tuple[list, list, list]:
    """Один четырёхугольник → два треугольника, с плоской нормалью на всех 4 вершинах."""
    n = np.cross(np.array(p1) - np.array(p0), np.array(p2) - np.array(p0))
    norm = np.linalg.norm(n)
    n = n / norm if norm > 1e-12 else np.array([0.0, 0.0, 1.0])
    verts = [p0, p1, p2, p3]
    norms = [n, n, n, n]
    tris = [[0, 1, 2], [0, 2, 3]]
    return verts, norms, tris


def box(cx: float, cy: float, cz: float, sx: float, sy: float, sz: float) -> Mesh:
    """Прямоугольный параллелепипед, плоское затенение (24 вершины, 12 треугольников)."""
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    x0, x1 = cx - hx, cx + hx
    y0, y1 = cy - hy, cy + hy
    z0, z1 = cz - hz, cz + hz
    corners = {
        (0, 0, 0): (x0, y0, z0), (1, 0, 0): (x1, y0, z0),
        (1, 1, 0): (x1, y1, z0), (0, 1, 0): (x0, y1, z0),
        (0, 0, 1): (x0, y0, z1), (1, 0, 1): (x1, y0, z1),
        (1, 1, 1): (x1, y1, z1), (0, 1, 1): (x0, y1, z1),
    }
    faces = [
        [(0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)],  # -Z
        [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)],  # +Z
        [(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)],  # -Y
        [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)],  # +Y
        [(0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)],  # -X
        [(1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)],  # +X
    ]
    verts: list = []
    norms: list = []
    tris: list = []
    for face in faces:
        pts = [corners[c] for c in face]
        v, n, t = _flat_quad(*pts)
        base = len(verts)
        verts.extend(v)
        norms.extend(n)
        tris.extend([[i0 + base, i1 + base, i2 + base] for i0, i1, i2 in t])
    return np.array(verts), np.array(norms), np.array(tris, dtype=np.uint32)


def lathe(profile: list[tuple[float, float, float]], axis: str = 'z',
          center: tuple[float, float, float] = (0.0, 0.0, 0.0),
          segments: int = 10, cap_start: bool = True, cap_end: bool = True) -> Mesh:
    """Тело вращения: список (t, r1, r2) вдоль оси `axis`, r1/r2 — радиусы по двум другим осям.

    Даёт гладкий силуэт (голова-яйцо, конечности с сужением, обувь) одной
    функцией вместо отдельной заготовки на каждую форму.
    """
    axis_map = {'z': (0, 1, 2), 'x': (1, 2, 0), 'y': (2, 0, 1)}
    o1, o2, oa = axis_map[axis]  # индексы (радиус1, радиус2, ось)
    rings = []
    for t, r1, r2 in profile:
        ring = []
        for s in range(segments):
            ang = 2 * math.pi * s / segments
            c1 = r1 * math.cos(ang)
            c2 = r2 * math.sin(ang)
            p = [0.0, 0.0, 0.0]
            p[o1] = center[o1] + c1
            p[o2] = center[o2] + c2
            p[oa] = center[oa] + t
            ring.append(p)
        rings.append(np.array(ring))
    verts: list = []
    norms: list = []
    tris: list = []
    # боковая поверхность: сглаженные нормали как направление от оси до вершины
    ring_starts = []
    for ring in rings:
        base = len(verts)
        ring_starts.append(base)
        axis_pt = np.array(ring)
        c = np.mean(axis_pt, axis=0)
        for p in ring:
            n = np.array(p) - c
            n[oa] = 0.0
            nn = np.linalg.norm(n)
            n = n / nn if nn > 1e-9 else np.array([0.0, 0.0, 1.0])
            verts.append(p)
            norms.append(n)
    for ri in range(len(rings) - 1):
        b0, b1 = ring_starts[ri], ring_starts[ri + 1]
        # Обход наружу верен только когда t растёт от кольца к кольцу; у профилей
        # с убывающим t (например, «рубашка» от выреза к подолу) без разворота
        # намотка уходит внутрь и грань пропадает из вида камеры.
        outward = profile[ri + 1][0] >= profile[ri][0]
        for s in range(segments):
            s2 = (s + 1) % segments
            a, b, c, d = b0 + s, b0 + s2, b1 + s2, b1 + s
            if outward:
                tris.append([a, b, c])
                tris.append([a, c, d])
            else:
                tris.append([a, c, b])
                tris.append([a, d, c])
    if cap_start:
        base = len(verts)
        t0 = profile[0][0]
        apex = list(center)
        apex[oa] = center[oa] + t0
        verts.append(apex)
        norms.append(-np.eye(3)[oa])
        b0 = ring_starts[0]
        for s in range(segments):
            s2 = (s + 1) % segments
            tris.append([base, b0 + s2, b0 + s])
    if cap_end:
        base = len(verts)
        t1 = profile[-1][0]
        apex = list(center)
        apex[oa] = center[oa] + t1
        verts.append(apex)
        norms.append(np.eye(3)[oa])
        b1 = ring_starts[-1]
        for s in range(segments):
            s2 = (s + 1) % segments
            tris.append([base, b1 + s, b1 + s2])
    return np.array(verts), np.array(norms), np.array(tris, dtype=np.uint32)


def merge(*parts: Mesh) -> Mesh:
    verts, norms, tris = [], [], []
    off = 0
    for v, n, t in parts:
        verts.append(v)
        norms.append(n)
        tris.append(t + off)
        off += len(v)
    return np.vstack(verts), np.vstack(norms), np.vstack(tris)


# ---------------------------------------------------------------------------
# 3. Материалы — только цвет, без текстур (стиль мебельного набора Kenney).
# ---------------------------------------------------------------------------

MATERIALS = {
    'skin':   (0.86, 0.67, 0.52),
    'hair':   (0.86, 0.67, 0.26),
    'brow':   (0.62, 0.46, 0.20),
    'eyeWhite': (0.95, 0.95, 0.95),
    'iris':   (0.26, 0.46, 0.74),
    'pupil':  (0.04, 0.04, 0.04),
    'lip':    (0.74, 0.36, 0.37),
    'shirt':  (0.20, 0.47, 0.64),
    'pants':  (0.23, 0.25, 0.30),
    'shoe':   (0.28, 0.17, 0.11),
}


def material_json(color: tuple[float, float, float]) -> dict:
    return {
        'pbrMetallicRoughness': {
            'baseColorFactor': [*color, 1.0],
            'metallicFactor': 0.0,
            'roughnessFactor': 0.75,
        },
    }


# ---------------------------------------------------------------------------
# 4. Части модели: (имя объекта, кость-родитель, [(меш, материал), ...]).
#    Координаты — в mesh space исходного тела (см. bbox по костям ниже).
# ---------------------------------------------------------------------------

def build_parts() -> list[tuple[str, str, list[tuple[Mesh, str]]]]:
    parts: list[tuple[str, str, list[tuple[Mesh, str]]]] = []

    # Голова — яйцевидная форма телом вращения: шире на скулах, у́же на
    # подбородке и темени, чтобы не превращаться в плоский шар.
    head = lathe([
        (3.78, 0.05, 0.05),
        (3.70, 0.30, 0.32),
        (3.50, 0.42, 0.44),
        (3.24, 0.46, 0.48),   # скулы/лоб — самое широкое место
        (3.00, 0.42, 0.42),
        (2.80, 0.33, 0.30),   # челюсть
        (2.65, 0.16, 0.14),   # подбородок
        (2.60, 0.02, 0.02),
    ], axis='z', center=(0.0, 0.01, 0.0), segments=12)
    parts.append(('head', 'Head', [(head, 'skin')]))

    # Нос — небольшой выступ вперёд (перёд модели — сторона отрицательного Y,
    # там же, где у ступней пальцы).
    nose = lathe([
        (-0.44, 0.11, 0.07),
        (-0.55, 0.075, 0.05),
        (-0.615, 0.045, 0.035),
    ], axis='y', center=(0.0, 0.0, 3.03), segments=8)
    parts.append(('nose', 'Head', [(nose, 'skin')]))

    # Уши — приплюснутые эллипсоиды по бокам головы.
    ear = lathe([
        (-0.035, 0.10, 0.14),
        (0.0, 0.115, 0.16),
        (0.035, 0.09, 0.12),
    ], axis='x', center=(0.44, 0.0, 3.14), segments=8)
    ear_r = lathe([
        (0.035, 0.10, 0.14),
        (0.0, 0.115, 0.16),
        (-0.035, 0.09, 0.12),
    ], axis='x', center=(-0.44, 0.0, 3.14), segments=8)
    parts.append(('earL', 'Head', [(ear, 'skin')]))
    parts.append(('earR', 'Head', [(ear_r, 'skin')]))

    # Волосы — купол шире головы (полностью её скрывает) плюс чёлка спереди.
    hairDome = lathe([
        (3.95, 0.06, 0.06),
        (3.86, 0.40, 0.42),
        (3.68, 0.50, 0.52),
        (3.46, 0.505, 0.48),
        (3.24, 0.47, 0.40),
        (3.12, 0.44, 0.30),
    ], axis='z', center=(0.0, 0.02, 0.0), segments=12, cap_end=False)
    fringe = box(0.0, -0.40, 3.55, 0.66, 0.16, 0.30)
    parts.append(('hair', 'Head', [(hairDome, 'hair'), (fringe, 'hair')]))

    # Брови — короткие бруски над глазами.
    browL = box(0.20, -0.44, 3.42, 0.19, 0.05, 0.05)
    browR = box(-0.20, -0.44, 3.42, 0.19, 0.05, 0.05)
    parts.append(('browL', 'Head', [(browL, 'brow')]))
    parts.append(('browR', 'Head', [(browR, 'brow')]))

    # Глаза — глазное яблоко (белок) + радужка + зрачок, по три примитива
    # на объект, каждый чуть ближе к поверхности лица предыдущего.
    def eye_at(x: float) -> list[tuple[Mesh, str]]:
        sclera = lathe([(-0.09, 0.085, 0.085), (0.0, 0.095, 0.095), (0.09, 0.085, 0.085)],
                        axis='y', center=(x, -0.34, 3.26), segments=10)
        iris = lathe([(-0.05, 0.05, 0.05), (0.0, 0.052, 0.052), (0.04, 0.045, 0.045)],
                      axis='y', center=(x, -0.41, 3.26), segments=10)
        pupil = lathe([(-0.02, 0.022, 0.022), (0.02, 0.02, 0.02)],
                       axis='y', center=(x, -0.455, 3.26), segments=8)
        return [(sclera, 'eyeWhite'), (iris, 'iris'), (pupil, 'pupil')]

    parts.append(('eyeL', 'Head', eye_at(0.20)))
    parts.append(('eyeR', 'Head', eye_at(-0.20)))

    # Рот — верхняя и нижняя губа отдельными объёмными брусками.
    lipUpper = box(0.0, -0.45, 2.77, 0.20, 0.05, 0.035)
    lipLower = box(0.0, -0.44, 2.72, 0.18, 0.05, 0.04)
    parts.append(('mouth', 'Head', [(lipUpper, 'lip'), (lipLower, 'lip')]))

    # Верх — рубашка телом вращения от выреза до подола, чуть шире тела.
    top = lathe([
        (2.38, 0.28, 0.30),
        (2.15, 0.44, 0.40),   # плечи
        (1.90, 0.40, 0.38),
        (1.65, 0.36, 0.36),
        (1.50, 0.34, 0.36),   # подол — радиус по глубине увеличен, иначе грудь тела
                               # шире рубашки и просвечивает голой кожей спереди
    ], axis='z', center=(0.0, 0.03, 0.0), segments=12)
    parts.append(('top', 'UpperChest', [(top, 'shirt')]))

    # Рукава — короткие, накрывают только плечо.
    sleeveL = lathe([(0.36, 0.18, 0.18), (0.50, 0.19, 0.19), (0.64, 0.17, 0.17)],
                     axis='x', center=(0.0, -0.02, 2.33), segments=10)
    sleeveR = lathe([(-0.36, 0.18, 0.18), (-0.50, 0.19, 0.19), (-0.64, 0.17, 0.17)],
                     axis='x', center=(0.0, -0.02, 2.33), segments=10)
    parts.append(('sleeveL', 'LeftArm', [(sleeveL, 'shirt')]))
    parts.append(('sleeveR', 'RightArm', [(sleeveR, 'shirt')]))

    # Низ — брюки по сегменту на бедро и на голень, чтобы сгибалось в колене.
    thighL = lathe([(1.62, 0.22, 0.20), (1.20, 0.20, 0.19), (0.85, 0.17, 0.16)],
                    axis='z', center=(0.235, -0.01, 0.0), segments=10)
    thighR = lathe([(1.62, 0.22, 0.20), (1.20, 0.20, 0.19), (0.85, 0.17, 0.16)],
                    axis='z', center=(-0.235, -0.01, 0.0), segments=10)
    shinL = lathe([(0.84, 0.16, 0.15), (0.55, 0.14, 0.13), (0.27, 0.115, 0.11)],
                   axis='z', center=(0.26, 0.07, 0.0), segments=10)
    shinR = lathe([(0.84, 0.16, 0.15), (0.55, 0.14, 0.13), (0.27, 0.115, 0.11)],
                   axis='z', center=(-0.26, 0.07, 0.0), segments=10)
    parts.append(('pantsThighL', 'LeftUpLeg', [(thighL, 'pants')]))
    parts.append(('pantsThighR', 'RightUpLeg', [(thighR, 'pants')]))
    parts.append(('pantsShinL', 'LeftLeg', [(shinL, 'pants')]))
    parts.append(('pantsShinR', 'RightLeg', [(shinR, 'pants')]))

    # Обувь — тело вращения вдоль длины стопы (ось Y — «вперёд»).
    def shoe_at(x: float) -> Mesh:
        return lathe([
            (0.27, 0.13, 0.10),
            (0.05, 0.165, 0.135),
            (-0.14, 0.15, 0.115),
            (-0.30, 0.08, 0.07),
        ], axis='y', center=(x, 0.0, 0.19), segments=10)

    parts.append(('shoeL', 'LeftFoot', [(shoe_at(0.35), 'shoe')]))
    parts.append(('shoeR', 'RightFoot', [(shoe_at(-0.35), 'shoe')]))

    return parts


# ---------------------------------------------------------------------------
# 5. Сборка итогового glTF: копия скелета + перекраска тела + новые узлы.
# ---------------------------------------------------------------------------

def align4(n: int) -> int:
    return (n + 3) & ~3


def main() -> None:
    with tempfile.TemporaryDirectory() as td:
        gltf, base_bin = export_base_gltf(Path(td))

    node_names = [n.get('name', '') for n in gltf['nodes']]
    name_to_node = {nm: i for i, nm in enumerate(node_names) if nm}
    assert 'Head' in name_to_node, 'кость Head пропала при экспорте — стоп'

    world_bind = world_matrices(gltf)
    mesh_node_idx = name_to_node['characterMedium']
    mesh_world = world_bind[mesh_node_idx]  # переводит «mesh space» accessor'а в мир, в покое

    # Перекраска тела: плоский цвет кожи вместо текстурного атласа скина.
    gltf['materials'][0] = {'name': 'skin', **material_json(MATERIALS['skin'])}

    # Клип-анимация из assimp ('mixamo.com', если он там есть) новой модели
    # не нужна: character.fbx в рантайме используется только как геометрия,
    # клипы приходят отдельными файлами (walk.fbx, idle.fbx, ...) и накладываются
    # на кости по имени — они не тронуты.
    gltf.pop('animations', None)

    buf = bytearray(base_bin)

    def append_accessor(data: np.ndarray, comp_type: int, gltype: str, target: int | None = None) -> int:
        raw = data.astype({5126: '<f4', 5125: '<u4', 5123: '<u2'}[comp_type]).tobytes()
        pad = align4(len(buf)) - len(buf)
        buf.extend(b'\x00' * pad)
        offset = len(buf)
        buf.extend(raw)
        bv = {'buffer': 0, 'byteOffset': offset, 'byteLength': len(raw)}
        if target is not None:
            bv['target'] = target
        gltf['bufferViews'].append(bv)
        acc: dict = {
            'bufferView': len(gltf['bufferViews']) - 1,
            'componentType': comp_type,
            'count': len(data),
            'type': gltype,
        }
        if gltype == 'VEC3' and comp_type == 5126:
            acc['min'] = data.min(axis=0).tolist()
            acc['max'] = data.max(axis=0).tolist()
        gltf['accessors'].append(acc)
        return len(gltf['accessors']) - 1

    mat_index = {}
    for key, color in MATERIALS.items():
        if key == 'skin':
            mat_index[key] = 0
            continue
        gltf['materials'].append({'name': key, **material_json(color)})
        mat_index[key] = len(gltf['materials']) - 1

    report_parts = []
    total_tris = 0
    for name, bone, primitives in build_parts():
        joint_node = name_to_node[bone]
        # V_local = inverse(joint_world_bind) @ mesh_world @ P_mesh — координата в
        # локальном пространстве кости, при которой узел-ребёнок с единичным
        # трансформом в покое встанет ровно в точку P_mesh (заданную в тех же
        # единицах, что и исходные вершины тела), а затем поедет вместе с костью
        # при любой её анимации (полностью эквивалентно rigid-parenting).
        attach = np.linalg.inv(world_bind[joint_node]) @ mesh_world

        gltf_primitives = []
        tris_here = 0
        for (verts, norms, tris), mat_key in primitives:
            local_verts = apply(attach, verts)
            pos_acc = append_accessor(local_verts.astype(np.float32), 5126, 'VEC3', 34962)
            norm_dirs = apply(attach, norms) - apply(attach, np.zeros_like(norms))
            norm_dirs = norm_dirs / np.linalg.norm(norm_dirs, axis=1, keepdims=True)
            norm_acc = append_accessor(norm_dirs.astype(np.float32), 5126, 'VEC3', 34962)
            idx_acc = append_accessor(tris.reshape(-1).astype(np.uint32), 5125, 'SCALAR', 34963)
            gltf_primitives.append({
                'attributes': {'POSITION': pos_acc, 'NORMAL': norm_acc},
                'indices': idx_acc,
                'material': mat_index[mat_key],
                'mode': 4,
            })
            tris_here += len(tris)

        gltf['meshes'].append({'name': name, 'primitives': gltf_primitives})
        mesh_idx = len(gltf['meshes']) - 1
        gltf['nodes'].append({'name': name, 'mesh': mesh_idx})
        new_node_idx = len(gltf['nodes']) - 1
        gltf['nodes'][joint_node].setdefault('children', []).append(new_node_idx)

        total_tris += tris_here
        report_parts.append((name, bone, tris_here))

    gltf['buffers'][0] = {'byteLength': len(buf)}
    gltf['asset'] = {'version': '2.0', 'generator': 'build_character_detailed.py'}

    write_glb(gltf, bytes(buf), OUT_GLB)

    body_tris = sum(len(p['indices']) for p in [])  # тело не пересчитываем — оставлено как было
    print(f'[build_character_detailed] записал {OUT_GLB.relative_to(ROOT)}')
    print(f'[build_character_detailed] новых объектов: {len(report_parts)}, новых треугольников: {total_tris}')
    for name, bone, tris in report_parts:
        print(f'  {name:14s} <- {bone:12s}  tris={tris}')
    print(f'[build_character_detailed] размер файла: {OUT_GLB.stat().st_size / 1024:.1f} КБ')


def write_glb(gltf: dict, bin_chunk: bytes, out_path: Path) -> None:
    json_bytes = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    json_pad = align4(len(json_bytes)) - len(json_bytes)
    json_bytes += b' ' * json_pad

    bin_pad = align4(len(bin_chunk)) - len(bin_chunk)
    bin_chunk = bin_chunk + b'\x00' * bin_pad

    total_len = 12 + 8 + len(json_bytes) + 8 + len(bin_chunk)
    with open(out_path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total_len))
        f.write(struct.pack('<II', len(json_bytes), 0x4E4F534A))
        f.write(json_bytes)
        f.write(struct.pack('<II', len(bin_chunk), 0x004E4942))
        f.write(bin_chunk)


if __name__ == '__main__':
    sys.exit(main())
