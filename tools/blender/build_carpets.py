"""
Четыре ковра лаунжа из исходника владельца → `design/presets/lounge_rug/carpetN.glb`.

    tools/blender/run.sh tools/blender/build_carpets.py

Исходник — `design/models/carpets/Carpet_Sketchfab.fbx` (Maya, четыре меша
SM_Carpet_01..04) и две текстуры-атласа: 0102 на первые два ковра, 0304 на
вторые. Лицензии при нём не было — см. SOURCE.md там же.

Что делает скрипт и почему:

- **Габарит — от прежнего ковра.** Каждый ковёр укладывается плашмя, длинной
  стороной по X, и равномерно масштабируется так, чтобы вписаться в след
  Kenney `rugRectangle.glb` из набора `design/models/furniture`, — той модели,
  которую новые заменяют. Клиент всё равно вписывает модель в след пресета
  (`fitScale`), но масштаб набора держим общим: открыл файл рядом с Kenney —
  и видно, что они одного размера.
- **Начало координат — на полу в центре следа**, низ ровно на нуле: ковёр не
  висит и не проваливается.
- **Из текстур оставлен только цвет.** Узор ковра и есть то, чем четыре
  модели отличаются друг от друга, поэтому цвет материалом его бы стёр.
  Нормали, AO, шероховатость и металл при виде сверху с пикселизацией не
  видны, а весят мегабайты — их не берём. Атлас ужимается до TEX_SIZE.
"""
import os
import sys

import bpy
from mathutils import Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC_DIR = os.path.join(ROOT, 'design', 'models', 'carpets')
FBX = os.path.join(SRC_DIR, 'Carpet_Sketchfab.fbx')
KENNEY = os.path.join(ROOT, 'design', 'models', 'furniture', 'rugRectangle.glb')
OUT_DIR = os.path.join(ROOT, 'design', 'presets', 'lounge_rug')

# Сторона атласа в пикселях. Ковёр в комнате — пара сотен пикселей экрана
# под пикселизацией; 512 хватает с запасом и держит файл в сотне килобайт.
TEX_SIZE = 512

# Какой атлас у какого ковра: номер в имени текстуры — пара ковров.
ATLAS = {1: '0102', 2: '0102', 3: '0304', 4: '0304'}


def reset():
    bpy.ops.wm.read_homefile(use_empty=True)


def world_bbox(objs):
    # По вершинам, а не по `bound_box`: тот кешируется и после
    # `mesh.transform` до пересчёта графа показывает старый габарит.
    pts = [o.matrix_world @ v.co for o in objs if o.type == 'MESH' for v in o.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def kenney_size():
    """След прежнего ковра в единицах набора: (длина по X, ширина по Y, толщина)."""
    reset()
    bpy.ops.import_scene.gltf(filepath=KENNEY)
    lo, hi = world_bbox(bpy.context.scene.objects)
    size = hi - lo
    print(f'[kenney] rugRectangle: {size.x:.4f} × {size.y:.4f} × {size.z:.4f}')
    return size


def bake(obj):
    """Применить к мешу всю мировую матрицу и отвязать от родителя."""
    mw = obj.matrix_world.copy()
    obj.parent = None
    obj.data.transform(mw)
    obj.matrix_world = Matrix.Identity(4)


def lay_flat(obj):
    """Положить ковёр плашмя (тонкая ось → Z) длинной стороной по X."""
    lo, hi = world_bbox([obj])
    size = hi - lo
    thin = min(range(3), key=lambda i: size[i])
    if thin == 0:
        obj.data.transform(Matrix.Rotation(-1.5707963, 4, 'Y'))
    elif thin == 1:
        obj.data.transform(Matrix.Rotation(1.5707963, 4, 'X'))
    lo, hi = world_bbox([obj])
    size = hi - lo
    if size.y > size.x:
        obj.data.transform(Matrix.Rotation(1.5707963, 4, 'Z'))
    # Лицевая сторона — вверх: если нормали в среднем смотрят вниз, ковёр
    # лёг изнанкой, переворачиваем вокруг X.
    up = sum(p.normal.z * p.area for p in obj.data.polygons)
    if up < 0:
        obj.data.transform(Matrix.Rotation(3.14159265, 4, 'X'))


def fit_to(obj, target):
    """Равномерный масштаб по тесной оси следа и начало координат на полу в центре."""
    lo, hi = world_bbox([obj])
    size = hi - lo
    k = min(target.x / size.x, target.y / size.y)
    obj.data.transform(Matrix.Scale(k, 4))
    lo, hi = world_bbox([obj])
    centre = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    obj.data.transform(Matrix.Translation(-centre))
    obj.data.update()
    return k


def colour_material(n):
    """Материал только с цветом из атласа — узор ковра, остальное отброшено."""
    path = os.path.join(SRC_DIR, f'TX_Carpet_{ATLAS[n]}_albedo.jpg')
    img = bpy.data.images.load(path, check_existing=True)
    if img.size[0] > TEX_SIZE:
        img.scale(TEX_SIZE, TEX_SIZE)
    mat = bpy.data.materials.new(f'carpet{n}')
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = next(nd for nd in nodes if nd.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Roughness'].default_value = 1.0
    bsdf.inputs['Metallic'].default_value = 0.0
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = img
    mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    return mat


def build(n, target):
    reset()
    bpy.ops.import_scene.fbx(filepath=FBX)
    objs = list(bpy.context.scene.objects)
    name = f'SM_Carpet_{n:02d}'
    obj = next((o for o in objs if o.type == 'MESH' and o.name.startswith(name)), None)
    if obj is None:
        raise RuntimeError(f'в FBX нет {name}: {[o.name for o in objs]}')
    for o in objs:
        if o.type == 'MESH':
            print(f'[fbx] {o.name}: {len(o.data.vertices)} вершин, '
                  f'uv={[u.name for u in o.data.uv_layers]}, '
                  f'материалы={[m.name for m in o.data.materials if m]}')
    bake(obj)
    for o in objs:
        if o is not obj:
            bpy.data.objects.remove(o, do_unlink=True)
    lay_flat(obj)
    k = fit_to(obj, target)
    obj.name = f'carpet{n}'
    obj.data.name = f'carpet{n}'
    obj.data.materials.clear()
    obj.data.materials.append(colour_material(n))

    lo, hi = world_bbox([obj])
    size = hi - lo
    print(f'[carpet{n}] масштаб ×{k:.5f}, габарит {size.x:.4f} × {size.y:.4f} × {size.z:.4f}, '
          f'низ z={lo.z:.5f}, центр ({(lo.x + hi.x) / 2:.5f}, {(lo.y + hi.y) / 2:.5f})')

    out = os.path.join(OUT_DIR, f'carpet{n}.glb')
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', use_selection=False,
        export_image_format='JPEG', export_apply=True,
    )
    print(f'[carpet{n}] записано: {os.path.relpath(out, ROOT)} ({os.path.getsize(out)} байт)')


def main():
    target = kenney_size()
    for n in (1, 2, 3, 4):
        build(n, target)


try:
    main()
except Exception:
    import traceback
    traceback.print_exc()
    sys.exit(1)
