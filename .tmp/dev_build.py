"""Черновик сборки детализированной модели — итеративная разработка (не коммитится)."""
import json
import math
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path('/Users/boris_proshin/Projects/ai/office/.office/worktrees/o-2/T-93')
CHAR_FBX = ROOT / 'design/models/characters/character.fbx'
ANIM_DIR = ROOT / 'design/models/characters/animations'
TMP = Path('/tmp/claude-501/devbuild')
TMP.mkdir(parents=True, exist_ok=True)

POSE_FILES = {
    'walk': 'walk.fbx', 'idle': 'idle.fbx', 'talk': 'talk.fbx', 'type': 'type.fbx',
    'sitIdle': 'sit-idle.fbx', 'sitTalk': 'sit-talk.fbx', 'game': 'game.fbx',
    'pushup': 'push-up.fbx', 'drink': 'drink.fbx', 'dance': 'dance.fbx',
}
MOVE_FILES = {
    'sitDown': 'sit-down.fbx', 'standUp': 'stand-up.fbx',
    'sitToType': 'sit-to-type.fbx', 'typeToSit': 'type-to-sit.fbx',
    'getUp': 'push-up-to-idle.fbx',
}

MAGIC = 0x46546C67
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def run_assimp(src: Path, dst: Path):
    subprocess.run(['assimp', 'export', str(src), str(dst), '-f', 'glb2'],
                    check=True, capture_output=True)


def read_glb(path: Path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from('<III', data, 0)
    assert magic == MAGIC
    offset = 12
    gltf = None
    binbuf = b''
    while offset < len(data):
        chunk_len, chunk_type = struct.unpack_from('<II', data, offset)
        body = data[offset + 8: offset + 8 + chunk_len]
        if chunk_type == JSON_CHUNK:
            gltf = json.loads(body.decode('utf-8'))
        elif chunk_type == BIN_CHUNK:
            binbuf = body
        offset += 8 + chunk_len + (-chunk_len % 4)
    return gltf, binbuf


COMPONENT_DTYPE = {
    5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16,
    5125: np.uint32, 5126: np.float32,
}
TYPE_COUNT = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_accessor(gltf, binbuf, idx):
    acc = gltf['accessors'][idx]
    bv = gltf['bufferViews'][acc['bufferView']]
    dtype = COMPONENT_DTYPE[acc['componentType']]
    ncomp = TYPE_COUNT[acc['type']]
    offset = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    count = acc['count']
    stride = bv.get('byteStride')
    itemsize = np.dtype(dtype).itemsize * ncomp
    if stride and stride != itemsize:
        arr = np.zeros((count, ncomp), dtype=dtype)
        for i in range(count):
            o = offset + i * stride
            arr[i] = np.frombuffer(binbuf, dtype=dtype, count=ncomp, offset=o)
    else:
        arr = np.frombuffer(binbuf, dtype=dtype, count=count * ncomp, offset=offset).reshape(count, ncomp)
    if ncomp == 1:
        arr = arr.reshape(count)
    return arr.copy()


# --- 1. сконвертировать character.fbx и все клипы через assimp ---
char_glb = TMP / 'char.glb'
run_assimp(CHAR_FBX, char_glb)
g, b = read_glb(char_glb)

nodes = g['nodes']
name_to_idx = {n.get('name'): i for i, n in enumerate(nodes)}
print('nodes:', len(nodes))
print('Head idx', name_to_idx.get('Head'), 'Hips idx', name_to_idx.get('Hips'))

mesh_node_idx = next(i for i, n in enumerate(nodes) if 'mesh' in n)
mesh_node = nodes[mesh_node_idx]
mesh = g['meshes'][mesh_node['mesh']]
prim = mesh['primitives'][0]
attrs = prim['attributes']
positions = read_accessor(g, b, attrs['POSITION']).astype(np.float64)
normals = read_accessor(g, b, attrs['NORMAL']).astype(np.float64)
joints0 = read_accessor(g, b, attrs['JOINTS_0']).astype(np.int32)
weights0 = read_accessor(g, b, attrs['WEIGHTS_0']).astype(np.float64)
indices = read_accessor(g, b, prim['indices']).astype(np.int64)
print('verts', positions.shape, 'tris', indices.shape[0] // 3)

skin = g['skins'][mesh_node['skin']]
skin_joints = skin['joints']  # node index за локальным индексом сустава
print('skin joints count', len(skin_joints))

dominant_local = weights0.argmax(axis=1)
dominant_node = np.array([skin_joints[j] for j in dominant_local])
dominant_name = np.array([nodes[n]['name'] for n in dominant_node])

for region_name in ['Head', 'Hips', 'Spine', 'Chest', 'UpperChest', 'LeftUpLeg', 'LeftFoot']:
    mask = dominant_name == region_name
    print(region_name, mask.sum())
