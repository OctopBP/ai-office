"""Разведочный скрипт: печатает скелет и анимации исходной модели блондина.

Одноразовый, не остаётся в репозитории.
"""
import bpy
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CHAR = os.path.join(ROOT, 'design/models/characters/character.fbx')
WALK = os.path.join(ROOT, 'design/models/characters/animations/walk.fbx')

bpy.ops.wm.read_homefile(use_empty=True)
bpy.ops.import_scene.fbx(filepath=CHAR)

arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
print('ARMATURE:', arm.name, 'bones:', len(arm.data.bones))
for b in arm.data.bones:
    parent = b.parent.name if b.parent else None
    print(f'  {b.name}  parent={parent}  head={tuple(round(x,3) for x in b.head_local)}  tail={tuple(round(x,3) for x in b.tail_local)}')

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
print('\nMESHES:', len(meshes))
for m in meshes:
    print(f'  {m.name}  verts={len(m.data.vertices)}  tris~={sum(len(p.vertices)-2 for p in m.data.polygons)}')
    print('   vertex groups:', [g.name for g in m.vertex_groups][:10], '...' if len(m.vertex_groups) > 10 else '')
    dims = m.dimensions
    print('   dims:', tuple(round(x,3) for x in dims))
    print('   location:', tuple(round(x,3) for x in m.location))

print('\nSCENE BBOX (all objects):')
import mathutils
mn = mathutils.Vector((1e9,1e9,1e9))
mx = mathutils.Vector((-1e9,-1e9,-1e9))
for o in bpy.data.objects:
    if o.type != 'MESH':
        continue
    for corner in o.bound_box:
        world = o.matrix_world @ mathutils.Vector(corner)
        mn.x=min(mn.x, world.x); mn.y=min(mn.y, world.y); mn.z=min(mn.z, world.z)
        mx.x=max(mx.x, world.x); mx.y=max(mx.y, world.y); mx.z=max(mx.z, world.z)
print('  min', tuple(round(x,3) for x in mn), 'max', tuple(round(x,3) for x in mx))

print('\nARMATURE object transform:', arm.location, arm.rotation_euler, arm.scale)
print('SCENE unit scale:', bpy.context.scene.unit_settings.scale_length)

# Импортируем анимацию отдельно, посмотрим на её кости/экшены
bpy.ops.import_scene.fbx(filepath=WALK)
print('\nAfter importing walk.fbx, actions:', [a.name for a in bpy.data.actions])
for a in bpy.data.actions:
    print(' ', a.name, 'fcurves:', len(a.fcurves), 'sample paths:', [fc.data_path for fc in a.fcurves[:5]])
