#!/usr/bin/env python3
"""Иконка приложения из исходной картинки.

Источник — `design/icon/app-icon.webp`, квадрат 1024. Скрипт делает из него
три файла, которые ждёт сборщик: `icon.png` (окно ожидания), `icon.icns`
(macOS) и `icon.ico` (Windows).

Квадрат не отдаётся системе как есть. У macOS иконка — скруглённый квадрат с
полем по краю: приложение с картинкой во весь квадрат торчит в доке крупнее
соседей и выглядит чужим. Поле и радиус взяты по пропорциям системных иконок
(824 из 1024, радиус около 22% стороны). Windows та же форма не мешает, и
иконка остаётся одной и той же на обеих системах.

    python3 scripts/desktop-icon.py
"""

from pathlib import Path
import subprocess
import tempfile

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "design/icon/app-icon.webp"
OUT = ROOT / "desktop/build"

SIDE = 1024
ART = 824                      # сама картинка внутри поля
RADIUS = 185                   # скругление, ~22% стороны картинки
PAD = (SIDE - ART) // 2
SS = 4                         # сглаживание маски через увеличение


def rounded_mask(side: int, radius: int) -> Image.Image:
    """Маска скруглённого квадрата. Рисуем крупно и уменьшаем — иначе край
    получается рваным: у ImageDraw сглаживания нет."""
    big = Image.new("L", (side * SS, side * SS), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, side * SS - 1, side * SS - 1), radius=radius * SS, fill=255,
    )
    return big.resize((side, side), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    art = Image.open(SRC).convert("RGBA").resize((ART, ART), Image.LANCZOS)
    art.putalpha(rounded_mask(ART, RADIUS))

    icon = Image.new("RGBA", (SIDE, SIDE), (0, 0, 0, 0))
    icon.paste(art, (PAD, PAD), art)
    icon.save(OUT / "icon.png")

    # Windows держит все размеры в одном .ico; 256 — верхний, больше не нужен.
    icon.save(OUT / "icon.ico",
              sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    # macOS собирает .icns из набора png своим iconutil — стороннего кода не надо.
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for size in (16, 32, 64, 128, 256, 512):
            icon.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
            icon.resize((size * 2, size * 2), Image.LANCZOS).save(iconset / f"icon_{size}x{size}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(OUT / "icon.icns")], check=True)

    print(f"иконки готовы: {OUT}")


if __name__ == "__main__":
    main()
