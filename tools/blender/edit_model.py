"""
Правка одной модели предмета: открыть, навести камеру, сохранять по Ctrl+S.

Запускается из `scripts/model.sh` (`npm run model -- <пресет>`); путь к файлу
приходит переменной окружения `OFFICE_MODEL`, а не аргументом, потому что всё
после `--` Blender отдаёт скрипту вперемешку со своим и разбирать это руками
дороже, чем прочитать одну переменную.

Почему сохранение — операторy с клавишей, а не отдельной командой снаружи: до
запущенного Blender извне не достучаться, у него нет ни сокета, ни адреса.
Единственное место, откуда можно записать открытую сцену, — сам Blender.

Ctrl+S здесь означает «записать .glb обратно», а не «сохранить .blend». Для
сессии, которую открыли ради одной модели, это и есть сохранение; `.blend`
по-прежнему пишется через Save As (Ctrl+Shift+S), если он зачем-то нужен.
"""
import os

import bpy

SRC = os.environ.get('OFFICE_MODEL', '')


class OFFICE_OT_export_back(bpy.types.Operator):
    """Записать сцену обратно в тот .glb, из которого она открыта"""

    bl_idname = 'office.export_back'
    bl_label = 'Записать модель офиса'

    def execute(self, context):
        if not SRC:
            self.report({'ERROR'}, 'OFFICE_MODEL не задан — нечего перезаписывать')
            return {'CANCELLED'}
        # Настройки экспорта — дефолтные: круг импорт-экспорт на них проверен,
        # габариты и имена материалов сохраняются. Имена важны: по ним работает
        # свечение экрана (компонент `glow` в пресете).
        bpy.ops.export_scene.gltf(filepath=SRC, export_format='GLB')
        self.report({'INFO'}, f'записано: {os.path.basename(SRC)}')
        return {'FINISHED'}


def frame_model():
    """Навести камеру на модель и включить просмотр материалов.

    Отложено таймером: в момент выполнения стартового скрипта окна и области
    3D-вида ещё нет, а `view3d.view_selected` без неё не выполнить.
    """
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type != 'VIEW_3D':
                continue
            region = next(r for r in area.regions if r.type == 'WINDOW')
            with bpy.context.temp_override(window=window, area=area, region=region):
                bpy.ops.object.select_all(action='SELECT')
                bpy.ops.view3d.view_selected()
            area.spaces.active.shading.type = 'MATERIAL'
    return None


def bind_key():
    """Ctrl+S → экспорт. Только в графическом режиме: в фоновом keymap нет."""
    config = bpy.context.window_manager.keyconfigs.addon
    if config is None:
        return
    keymap = config.keymaps.new(name='Window', space_type='EMPTY')
    keymap.keymap_items.new(OFFICE_OT_export_back.bl_idname, 'S', 'PRESS', ctrl=True)


def main():
    bpy.utils.register_class(OFFICE_OT_export_back)
    bpy.ops.wm.read_homefile(use_empty=True)
    if SRC:
        bpy.ops.import_scene.gltf(filepath=SRC)
    bind_key()
    if not bpy.app.background:
        bpy.app.timers.register(frame_model, first_interval=0.6)


main()
