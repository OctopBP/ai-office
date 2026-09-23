"""
Собрать сцену офиса в Blender из нынешней тайловой раскладки.

Одноразовый мост. Комнату дальше ведёт человек в Blender, но начинать с
пустого файла незачем: всё, что уже стоит в офисе — пол, стены, окна, мебель,
посадочные места, — переносится сюда автоматически и один раз. Дальше
источником истины становится `.blend`, а раскладка и этот скрипт уходят.

    tools/blender/run.sh tools/blender/build_scene.py -- \
        --preset studio --blend design/scenes/studio.blend --glb design/scenes/studio.glb

Что получается в файле:

    Room      пол, стены, окна — сетка, которую можно править
    Props     мебель: модели набора Kenney, по одной на предмет
    Markers   пустышки: посадочные места, разговоры, зоны, хотспоты, дверь
    Nav       nav.walkable — плоский меш проходимой области

── Оси ──────────────────────────────────────────────────────────────────────

План двумерный: `x` вправо, `y` вниз. В glTF «вниз по плану» — это +Z.
Экспорт Blender→glTF переставляет оси как (x, y, z) → (x, z, −y), поэтому
в Blender план кладётся как **X = x, Y = −y, Z = высота**.

Следствие для человека: комната в Blender лежит в отрицательном Y, вид сверху
(Numpad 7) показывает её ровно так же, как план офиса на экране.

Взгляд сидящего — это −Y пустышки, то есть Blender's «перёд». В glTF он
превращается в +Z, а это `yaw = 0` в коде («смотрит вниз по плану»).
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import office_layout as L  # noqa: E402


# ── Мелочи Blender ───────────────────────────────────────────────────────────

def wipe():
    """Пустой файл. `--background` даёт стартовую сцену с кубом и лампой."""
    bpy.ops.wm.read_factory_settings(use_empty=True)


def collection(name: str, parent=None) -> bpy.types.Collection:
    col = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(col)
    return col


def material(name: str, rgb, alpha=1.0) -> bpy.types.Material:
    existing = bpy.data.materials.get(name)
    if existing:
        return existing
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*rgb, alpha)
    bsdf.inputs['Roughness'].default_value = 0.75
    if alpha < 1.0:
        bsdf.inputs['Alpha'].default_value = alpha
        # Название режима смешивания у Blender меняется от версии к версии,
        # а картинка в вьюпорте — не то, ради чего файл собирается.
        try:
            mat.blend_method = 'BLEND'
        except (AttributeError, TypeError):
            pass
    return mat


def add_box(name: str, box: L.Box, mat, col) -> bpy.types.Object:
    """Коробка раскладки → куб в сцене. Масштаб применяется сразу: сцену
    дальше правят руками, и объект с чужим масштабом в ней только мешает."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((box.w, box.d, box.h)), verts=bm.verts)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = (box.cx, -box.cy, box.base + box.h / 2)
    mesh.materials.append(mat)
    col.objects.link(obj)
    return obj


# ── Модели набора ────────────────────────────────────────────────────────────

def load_model(path: Path, stash: bpy.types.Collection) -> bpy.types.Object | None:
    """Загрузить .glb набора и привести к общему виду.

    Повторяет `PropModels` из `Props3D.tsx`: масштаб общий на весь набор,
    начало координат — середина по горизонтали и низ по вертикали. У набора
    Kenney начало где придётся (у дивана — в углу), и без этого предметы
    разъезжаются относительно своих следов.
    """
    # Объекты запоминаются по именам, а не ссылками: `join` удаляет
    # присоединённые объекты, и ссылка на удалённый объект в Blender
    # превращается в мину — обращение к ней роняет скрипт.
    before = set(bpy.data.objects.keys())
    bpy.ops.import_scene.gltf(filepath=str(path))
    imported = [n for n in bpy.data.objects.keys() if n not in before]
    meshes = [n for n in imported if bpy.data.objects[n].type == 'MESH']
    if not meshes:
        for name in imported:
            bpy.data.objects.remove(bpy.data.objects[name], do_unlink=True)
        return None

    # Импорт даёт дерево: корневая пустышка с поворотом (glTF смотрит вверх
    # по Y, Blender по Z) и меши внутри. Разворачиваем его в один объект —
    # предмет в комнате должен быть предметом, а не корнем с потрохами.
    bpy.ops.object.select_all(action='DESELECT')
    for name in meshes:
        bpy.data.objects[name].select_set(True)
    bpy.context.view_layer.objects.active = bpy.data.objects[meshes[0]]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active

    # Отвязка **с сохранением положения**: иначе предмет теряет разворот
    # корня и ложится на бок.
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    kept = obj.name
    for name in imported:
        leftover = bpy.data.objects.get(name)
        if leftover is not None and name != kept:
            bpy.data.objects.remove(leftover, do_unlink=True)

    obj.name = path.stem
    obj.data.name = path.stem

    # Масштаб набора → тайлы. Правится прямо в меше: дальше от объекта нужны
    # только данные, а копии предмета ставятся своими матрицами.
    obj.data.transform(Matrix.Diagonal((L.MODEL_SCALE,) * 3).to_4x4())

    # Центровка: середина по горизонтали, низ по вертикали. У набора Kenney
    # начало координат где придётся — у дивана в переднем углу, у стола у
    # левой кромки, — и без этого предмет разъезжается со своим следом.
    corners = [Vector(c) for c in obj.bound_box]
    xs = [c.x for c in corners]
    ys = [c.y for c in corners]
    zs = [c.z for c in corners]
    obj.data.transform(Matrix.Translation((
        -(min(xs) + max(xs)) / 2, -(min(ys) + max(ys)) / 2, -min(zs))))
    obj.location = (0, 0, 0)

    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    stash.objects.link(obj)
    return obj


# ── Сборка ───────────────────────────────────────────────────────────────────

def build_room(layout, root: bpy.types.Collection):
    col = collection('Room', root)
    for room_id, floor, box in L.floors_of(layout):
        add_box(f'floor.{room_id}', box,
                material(f'floor.{floor}', L.FLOORS.get(floor, L.FLOORS['carpet'])), col)

    wall_mat = material('wall', L.WALL_COLOR)
    glass_mat = material('glass', L.GLASS_COLOR, alpha=0.25)
    for i, boxes in enumerate(L.walls_of(layout)):
        for j, box in enumerate(boxes):
            kind = 'glass' if box.glass else 'wall'
            add_box(f'{kind}.{i:02d}.{j:02d}', box,
                    glass_mat if box.glass else wall_mat, col)
    return col


def build_props(layout, catalog, root: bpy.types.Collection, presets_dir: Path):
    col = collection('Props', root)
    stash = bpy.data.collections.new('_models')   # не линкуется в сцену
    sources: dict[str, bpy.types.Object | None] = {}

    for item in L.place(layout, catalog):
        if item.models:
            group = bpy.data.objects.new(f'prop.{item.key}', None)
            group.empty_display_size = 0.2
            group.location = (item.cx, -item.cy, item.base)
            group.rotation_euler.z = -item.rot
            col.objects.link(group)

            for part in item.models:
                # Ключ — `<пресет>/<файл>`, как и на клиенте: модели лежат в
                # папках пресетов, и одно имя файла встречается в нескольких
                # (`loungeSofa.glb` у дивана и у двухместного).
                key = f'{item.sprite}/{part["file"]}'
                if key not in sources:
                    path = presets_dir / item.sprite / part['file']
                    sources[key] = load_model(path, stash) if path.exists() else None
                src = sources[key]
                if not src:
                    continue
                dup = bpy.data.objects.new(src.name, src.data)   # общие данные меша
                at = part.get('at', [0, 0, 0])
                dup.location = (at[0], -at[2], at[1])
                dup.rotation_euler.z = math.radians(part.get('rot', 0))
                dup.parent = group
                col.objects.link(dup)
            continue

        # Модели нет — коробка размером с предмет. Так же поступает клиент,
        # и так же человеку сразу видно, чему модель ещё не нашлась.
        box = L.Box(item.cx, item.cy, item.w, item.d, item.h, item.base)
        obj = add_box(f'prop.{item.key}', box,
                      material(f'prop.{item.tone}', L.TONES[item.tone]), col)
        obj.rotation_euler.z = -item.rot
    return col


#: Как рисовать пустышку в окне Blender. Точки — оси (видно, куда смотрит
#: сидящий), области — куб по габаритам зоны.
MARKER_DISPLAY = {
    'zone.idle': 'CUBE',
    'zone.meeting': 'SPHERE',
}


def build_markers(layout, catalog, root: bpy.types.Collection):
    col = collection('Markers', root)
    for m in L.markers_of(layout, catalog):
        obj = bpy.data.objects.new(m.name, None)
        obj.empty_display_type = MARKER_DISPLAY.get(m.name, 'ARROWS')
        obj.empty_display_size = 1.0
        obj.location = (m.x, -m.y, m.z)
        obj.rotation_euler.z = m.yaw
        if m.extent:
            obj.scale = m.extent
        else:
            obj.empty_display_size = 0.5
        for key, value in m.extras.items():
            obj[key] = value
        col.objects.link(obj)
    return col


def build_nav(layout, catalog, root: bpy.types.Collection):
    """Меш проходимой области — из нынешней тайловой сетки.

    Тайлы склеиваются в один плоский меш и упрощаются: сетка из шестисот
    квадратов правится в Blender мучительно, а те же три-четыре многоугольника
    — двумя движениями.
    """
    col = collection('Nav', root)
    bm = bmesh.new()
    for tx, ty in L.walkable_tiles(layout, catalog):
        verts = [bm.verts.new((tx + dx, -(ty + dy), 0.02))
                 for dx, dy in ((0, 0), (1, 0), (1, 1), (0, 1))]
        bm.faces.new(verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1.0),
                             verts=bm.verts, edges=bm.edges)

    mesh = bpy.data.meshes.new('nav.walkable')
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new('nav.walkable', mesh)
    mat = material('nav', (0.35, 0.8, 0.45), alpha=0.35)
    mesh.materials.append(mat)
    # В окне Blender — сеткой поверх пола: видно область и видно пол под ней.
    # В кадре — не участвует вовсе, иначе полупрозрачная плита забеливает всю
    # комнату. На выгрузку это не влияет: экспорт берёт и скрытое от рендера.
    obj.display_type = 'WIRE'
    obj.hide_render = True
    col.objects.link(obj)
    return col


def build_view(layout):
    """Свет и камера — только для человека. В glTF не уезжают."""
    col = collection('View')
    cols, rows = layout['size']

    # Небо, а не чернота: сцена из плоских цветов без заполняющего света
    # уходит в грязь ровно так же, как уходила в клиенте (palette.ts).
    world = bpy.data.worlds.new('world')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (0.91, 0.92, 0.93, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = 0.35
    bpy.context.scene.world = world

    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.0
    sun.data.angle = math.radians(10)     # мягкая тень, а не бритвенная
    sun.location = (cols / 2 - 20, -rows / 2 + 15, 20)
    sun.rotation_euler = (math.radians(50), 0, math.radians(35))
    col.objects.link(sun)

    # Камера подобрана так, чтобы комната влезала целиком: угол обзора шире
    # обычного, а отлёт считается от размера раскладки, а не подобран для
    # одного пресета.
    cam = bpy.data.objects.new('camera', bpy.data.cameras.new('camera'))
    cam.data.lens = 28
    tilt = math.radians(55)
    distance = max(cols, rows) * 1.15
    cam.location = (cols / 2,
                    -rows / 2 - distance * math.cos(tilt),
                    distance * math.sin(tilt))
    cam.rotation_euler = (math.pi / 2 - tilt, 0, 0)
    col.objects.link(cam)
    bpy.context.scene.camera = cam
    return col


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opts = dict(zip(argv[::2], argv[1::2]))
    preset = opts.get('--preset', 'studio')
    root_dir = Path(__file__).resolve().parents[2]

    layout, catalog = L.load(root_dir, preset)
    wipe()

    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = L.TILE_M   # единица сцены = тайл = 75 см
    scene.unit_settings.length_unit = 'METERS'

    root = collection(preset)
    build_room(layout, root)
    build_props(layout, catalog, root, root_dir / 'design' / 'presets')
    build_markers(layout, catalog, root)
    build_nav(layout, catalog, root)
    build_view(layout)

    blend = opts.get('--blend')
    if blend:
        path = (root_dir / blend).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(path))
        print(f'[build_scene] blend → {path}')

    png = opts.get('--png')
    if png:
        # Кадр сцены. Нужен не для красоты: увидеть комнату целиком — самый
        # быстрый способ понять, что перенос не разъехался. Открывать ради
        # этого Blender значит ждать его запуск ещё раз.
        path = (root_dir / png).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        scene.render.engine = 'BLENDER_EEVEE_NEXT'
        scene.render.resolution_x = 1280
        scene.render.resolution_y = 800
        scene.render.filepath = str(path)
        scene.render.image_settings.file_format = 'PNG'
        bpy.ops.render.render(write_still=True)
        print(f'[build_scene] png → {path}')

    glb = opts.get('--glb')
    if glb:
        path = (root_dir / glb).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.export_scene.gltf(
            filepath=str(path),
            export_format='GLB',
            export_cameras=False,
            export_lights=False,
            export_extras=True,          # custom properties → node.extras
            export_apply=True,
            use_visible=False,
        )
        print(f'[build_scene] glb → {path}')


if __name__ == '__main__':
    main()
