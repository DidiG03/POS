#!/usr/bin/env python3
"""Regenerate Android launcher icons from build-resources/icon.png."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ICON_PATH = ROOT / 'build-resources/icon.png'
RES = ROOT / 'android/app/src/main/res'

# (legacy launcher px, adaptive foreground px)
DENSITIES: dict[str, tuple[int, int]] = {
    'mipmap-mdpi': (48, 108),
    'mipmap-hdpi': (72, 162),
    'mipmap-xhdpi': (96, 216),
    'mipmap-xxhdpi': (144, 324),
    'mipmap-xxxhdpi': (192, 432),
}

# Adaptive-icon safe zone is the inner ~66% of the 108dp canvas.
FOREGROUND_SCALE = 0.92


def ring_center_y(source: Image.Image) -> float:
    """Vertical center of the white ring artwork (0–1), for optical alignment."""
    w, h = source.size
    margin = int(w * 0.2)
    ys: list[int] = []
    for y in range(margin, h - margin):
        for x in range(margin, w - margin):
            r, g, b, a = source.getpixel((x, y))
            if a > 200 and min(r, g, b) > 220:
                ys.append(y)
    if not ys:
        return 0.5
    return (min(ys) + max(ys)) / 2 / h


def center_paste(
    canvas: Image.Image,
    layer: Image.Image,
    *,
    y_nudge: int = 0,
) -> None:
    x = (canvas.width - layer.width) // 2
    y = (canvas.height - layer.height) // 2 + y_nudge
    canvas.paste(layer, (x, y), layer)


def main() -> None:
    icon = Image.open(ICON_PATH).convert('RGBA')
    # Rings sit slightly above the geometric center in the master artwork.
    y_nudge = round((0.5 - ring_center_y(icon)) * icon.height)

    for folder, (launcher_size, fg_size) in DENSITIES.items():
        out_dir = RES / folder
        out_dir.mkdir(parents=True, exist_ok=True)

        launcher = icon.resize((launcher_size, launcher_size), Image.LANCZOS)
        launcher.save(out_dir / 'ic_launcher.png')
        launcher.save(out_dir / 'ic_launcher_round.png')

        fg_scale = max(1, int(fg_size * FOREGROUND_SCALE))
        scaled = icon.resize((fg_scale, fg_scale), Image.LANCZOS)
        fg = Image.new('RGBA', (fg_size, fg_size), (0, 0, 0, 0))
        nudge = round(y_nudge * fg_scale / icon.height)
        center_paste(fg, scaled, y_nudge=nudge)
        fg.save(out_dir / 'ic_launcher_foreground.png')

    # Splash + other centered logo assets.
    splash_logo = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
    scaled = icon.resize((384, 384), Image.LANCZOS)
    nudge = round(y_nudge * 384 / icon.height)
    center_paste(splash_logo, scaled, y_nudge=nudge)
    nodpi = RES / 'drawable-nodpi'
    nodpi.mkdir(parents=True, exist_ok=True)
    splash_logo.save(nodpi / 'splash_logo.png')

    print(f'Generated Android icons from {ICON_PATH.name}')


if __name__ == '__main__':
    main()
