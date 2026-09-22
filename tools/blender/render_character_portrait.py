#!/usr/bin/env python3
"""Рендерит портрет 512×512 на прозрачном фоне из готового .glb персонажа.

Blender в этом окружении недоступен даже фоном (см. заголовок
build_character_detailed.py — headless-запуск падает по SIGSEGV на этапе
инициализации GPU-бэкенда, до всякого Python-кода). Поэтому портрет
рисует свой мини-растеризатор: собирает все меши в мировые координаты
(поза покоя), отбрасывает грани, отвёрнутые от камеры, и красит
оставшиеся плоским освещением с Z-буфером — этого достаточно для
портрета в простом, без-текстурном стиле, которым сделана вся модель.

Запуск:

    python3 tools/blender/render_character_portrait.py design/models/characters/jonDetailed.glb \
        design/models/characters/portraits/jonDetailed.png
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

SUPERSAMPLE = 2
OUT_SIZE = 512


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    _, _, length = struct.unpack('<III', data[:12])
    off = 12
    chunks = {}
    while off < length:
        clen, ctype = struct.unpack('<II', data[off:off + 8])
        off += 8
        chunks[ctype] = data[off:off + clen]
        off += clen
    return json.loads(chunks[0x4E4F534A]), chunks[0x004E4942]


_DTYPE = {5126: '<f4', 5125: '<u4', 5123: '<u2'}
_NCOMP = {'SCALAR': 1, 'VEC3': 3}


def read_accessor(gltf: dict, buf: bytes, idx: int) -> np.ndarray:
    a = gltf['accessors'][idx]
    bv = gltf['bufferViews'][a['bufferView']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    ncomp = _NCOMP[a['type']]
    dtype = _DTYPE[a['componentType']]
    arr = np.frombuffer(buf, dtype=dtype, count=a['count'] * ncomp, offset=off)
    return arr.reshape(a['count'], ncomp).astype(np.float64)


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
    nodes = gltf['nodes']
    world: list = [None] * len(nodes)

    def walk(i: int, parent: np.ndarray) -> None:
        m = parent @ local_mat(nodes[i])
        world[i] = m
        for c in nodes[i].get('children', []):
            walk(c, m)

    scene = gltf['scenes'][gltf.get('scene', 0)]
    for r in scene['nodes']:
        walk(r, np.eye(4))
    return world


def collect_triangles(gltf: dict, buf: bytes) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Все треугольники сцены в мировых координатах: (N,3,3) вершины, (N,3) цвет, (N,3) нормаль."""
    world = world_matrices(gltf)
    tris_v = []
    tris_color = []
    tris_normal = []
    for ni, node in enumerate(gltf['nodes']):
        if 'mesh' not in node:
            continue
        mesh = gltf['meshes'][node['mesh']]
        m = world[ni]
        normal_mat = np.linalg.inv(m[:3, :3]).T
        for prim in mesh['primitives']:
            pos = read_accessor(gltf, buf, prim['attributes']['POSITION'])
            idx = read_accessor(gltf, buf, prim['indices']).reshape(-1).astype(np.int64)
            homo = np.hstack([pos, np.ones((len(pos), 1))])
            world_pos = (m @ homo.T).T[:, :3]
            mat = gltf['materials'][prim['material']]
            color = np.array(mat['pbrMetallicRoughness']['baseColorFactor'][:3])
            tri_idx = idx.reshape(-1, 3)
            v = world_pos[tri_idx]
            e1 = v[:, 1] - v[:, 0]
            e2 = v[:, 2] - v[:, 0]
            n = np.cross(e1, e2)
            n = n / np.clip(np.linalg.norm(n, axis=1, keepdims=True), 1e-9, None)
            tris_v.append(v)
            tris_color.append(np.tile(color, (len(v), 1)))
            tris_normal.append(n)
    return np.vstack(tris_v), np.vstack(tris_color), np.vstack(tris_normal)


def render(glb_path: Path, out_path: Path) -> None:
    gltf, buf = read_glb(glb_path)
    verts, colors, normals = collect_triangles(gltf, buf)

    # Камера спереди (+Z смотрит на -Z), кадрируем по голове и плечам —
    # как в существующих портретах: погрудный план без разведённых в
    # T-позе рук и без бёдер (руки уходят к X≈±180, это отсекаем).
    x_lo, x_hi = -48.0, 48.0
    y_lo, y_hi = 165.0, 410.0

    # Кадр — это ещё и настоящая отбраковка геометрии: руки в T-позе тянутся
    # до X≈±180, и одного масштабирования по (x_lo,x_hi) недостаточно, раз
    # диапазон по Y шире и определяет масштаб — без явного отбора руки всё
    # равно попадают в кадр. Оставляем только грани, чей центр внутри рамки.
    centroid = verts.mean(axis=1)
    keep = (
        (centroid[:, 0] >= x_lo) & (centroid[:, 0] <= x_hi)
        & (centroid[:, 1] >= y_lo) & (centroid[:, 1] <= y_hi)
    )
    verts, colors, normals = verts[keep], colors[keep], normals[keep]

    w = SUPERSAMPLE * OUT_SIZE
    h = SUPERSAMPLE * OUT_SIZE
    span = max(x_hi - x_lo, y_hi - y_lo)
    cx, cy = (x_lo + x_hi) / 2, (y_lo + y_hi) / 2

    def to_px(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        px = (x - cx) / span * w * 0.92 + w / 2
        py = (cy - y) / span * h * 0.92 + h / 2
        return px, py

    px, py = to_px(verts[..., 0], verts[..., 1])
    depth = verts[..., 2]

    color_buf = np.zeros((h, w, 3), dtype=np.float64)
    alpha_buf = np.zeros((h, w), dtype=np.float64)
    zbuf = np.full((h, w), -1e9)

    light = np.array([0.35, 0.55, 0.75])
    light = light / np.linalg.norm(light)

    facing = normals[:, 2] > 1e-6  # отбросить грани, отвёрнутые от камеры (+Z)
    order = np.argsort(depth[facing].mean(axis=1))  # дальние сначала, для устойчивого краевого AA

    idxs = np.nonzero(facing)[0][order]
    for i in idxs:
        tx, ty = px[i], py[i]
        tz = depth[i]
        xmin = max(int(np.floor(tx.min())), 0)
        xmax = min(int(np.ceil(tx.max())) + 1, w)
        ymin = max(int(np.floor(ty.min())), 0)
        ymax = min(int(np.ceil(ty.max())) + 1, h)
        if xmin >= xmax or ymin >= ymax:
            continue
        gx, gy = np.meshgrid(np.arange(xmin, xmax), np.arange(ymin, ymax))
        gx = gx.astype(np.float64) + 0.5
        gy = gy.astype(np.float64) + 0.5

        x0, y0 = tx[0], ty[0]
        x1, y1 = tx[1], ty[1]
        x2, y2 = tx[2], ty[2]
        det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(det) < 1e-9:
            continue
        w0 = ((y1 - y2) * (gx - x2) + (x2 - x1) * (gy - y2)) / det
        w1 = ((y2 - y0) * (gx - x2) + (x0 - x2) * (gy - y2)) / det
        w2 = 1.0 - w0 - w1
        inside = (w0 >= -1e-4) & (w1 >= -1e-4) & (w2 >= -1e-4)
        if not inside.any():
            continue
        z_interp = w0 * tz[0] + w1 * tz[1] + w2 * tz[2]

        sub_zbuf = zbuf[ymin:ymax, xmin:xmax]
        pass_test = inside & (z_interp > sub_zbuf)
        if not pass_test.any():
            continue

        shade = max(0.35, float(np.dot(normals[i], light)))
        rgb = colors[i] * shade

        sub_color = color_buf[ymin:ymax, xmin:xmax]
        sub_alpha = alpha_buf[ymin:ymax, xmin:xmax]
        sub_color[pass_test] = rgb
        sub_alpha[pass_test] = 1.0
        sub_zbuf[pass_test] = z_interp[pass_test]

    rgb8 = np.clip(color_buf * 255, 0, 255).astype(np.uint8)
    a8 = np.clip(alpha_buf * 255, 0, 255).astype(np.uint8)
    rgba = np.dstack([rgb8, a8])
    img = Image.fromarray(rgba, mode='RGBA')
    img = img.resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)
    print(f'[render_character_portrait] записал {out_path}')


if __name__ == '__main__':
    render(Path(sys.argv[1]), Path(sys.argv[2]))
