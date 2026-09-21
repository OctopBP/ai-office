#!/usr/bin/env python3
"""Иконка приложения из спрайта меню.

Иконку не рисуют отдельно: офис уже узнаётся по пиксельному домику из меню
(`design/sprites/out/day/menu_icon_office.png`), и приложение должно выглядеть
так же. Увеличение — только целое и «по соседу»: любое сглаживание превращает
пиксель-арт в кашу.

    python3 scripts/desktop-icon.py

Кладёт desktop/build/icon.png (1024), icon.icns (macOS) и icon.ico (Windows).
"""

from pathlib import Path
import subprocess
import tempfile

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "design/sprites/out/day/menu_icon_office.png"
OUT = ROOT / "desktop/build"

# Поле вокруг домика: без него иконка в доке выглядит крупнее соседей —
# у системных иконок поле заложено в саму картинку.
SIDE = 1024
SCALE = 20          # 48 × 20 = 960, остальное уходит в поля
PAD = (SIDE - 48 * SCALE) // 2


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    sprite = Image.open(SRC).convert("RGBA").resize((48 * SCALE, 48 * SCALE), Image.NEAREST)
    icon = Image.new("RGBA", (SIDE, SIDE), (0, 0, 0, 0))
    icon.paste(sprite, (PAD, PAD))
    icon.save(OUT / "icon.png")

    # Windows держит все размеры в одном .ico; 256 — верхний, больше не нужен.
    icon.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    # macOS собирает .icns из набора png своим iconutil — стороннего кода не надо.
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for size in (16, 32, 64, 128, 256, 512):
            icon.resize((size, size), Image.NEAREST).save(iconset / f"icon_{size}x{size}.png")
            icon.resize((size * 2, size * 2), Image.NEAREST).save(iconset / f"icon_{size}x{size}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(OUT / "icon.icns")], check=True)

    print(f"иконки готовы: {OUT}")


if __name__ == "__main__":
    main()
