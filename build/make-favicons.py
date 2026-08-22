#!/usr/bin/env python3
"""Regenerate the raster icons from the same mark as public/favicon.svg.

The SVG is the source of truth; .ico and .png are opaque blobs, and without this script
nobody could redo them the day the logo changes. Keep the geometry below in sync with
public/favicon.svg — it is the same drawing in the same 64-unit space.

Runs on the HOST (python3 + Pillow), not in the app container: Node is not on the host
(see the 07/08 entry of the diary) and node_modules has no image library anyway.

    python3 build/make-favicons.py

Writes public/favicon.ico (16/32/48) and public/apple-touch-icon.png (180).
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

VB = 64                                             # viewBox of favicon.svg
RADIUS, STROKE = 16, 7                              # 25% corner, stroke of the ∑
SIGMA = [(46, 18), (19, 18), (34, 32), (19, 46), (46, 46)]
ACCENT, LILAC = (0x7E, 0xB0, 0xD5), (0xBD, 0x7E, 0xBE)
SUPER = 1024                                        # draw big, downscale: PIL has no AA

PUBLIC = Path(__file__).resolve().parent.parent / "public"


def render(size=SUPER, rounded=True):
    """The tile at `size`px. rounded=False keeps the square full-bleed (iOS masks it itself)."""
    yy, xx = np.mgrid[0:size, 0:size]
    t = ((xx + yy) / (2 * (size - 1)))[..., None]   # 135deg: 0 top-left → 1 bottom-right
    ramp = np.array(ACCENT) * (1 - t) + np.array(LILAC) * t
    img = Image.fromarray(ramp.astype(np.uint8)).convert("RGBA")

    k = size / VB
    d = ImageDraw.Draw(img)
    pts = [(x * k, y * k) for x, y in SIGMA]
    w = round(STROKE * k)
    d.line(pts, fill="white", width=w, joint="curve")
    for x, y in (pts[0], pts[-1]):                  # round caps: PIL only draws flat ones
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill="white")

    if rounded:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], RADIUS * k, fill=255)
        img.putalpha(mask)
    return img


if __name__ == "__main__":
    render().save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    apple = render(rounded=False).resize((180, 180), Image.LANCZOS).convert("RGB")
    apple.save(PUBLIC / "apple-touch-icon.png")
    print("written:", PUBLIC / "favicon.ico", "+", PUBLIC / "apple-touch-icon.png")
