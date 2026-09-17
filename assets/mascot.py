#!/usr/bin/env python3
"""Draw the Ningaui mascot.

One shape list, two outputs: assets/ningaui-icon.svg for humans and browsers, and the PNG
sizes the extensions need (16/32/48/128). Pillow rasterizes by supersampling, because a
mascot that only looks right at 512 px is not a mascot.

The animal: a ningaui is a small, big-eyed, crested-tailed carnivorous marsupial from the
Australian outback. The crest on the tail is the give-away, so it gets the dark brush tip.
The harness is the point of the project: the animal works, you hold the leash, and nothing
it proposes happens until you decide.
"""

import pathlib, sys
from PIL import Image, ImageDraw

W = 128                      # design grid
SS = 8                       # supersample factor
SAND, SAND_DARK, CREAM = "#E0B041", "#C9973A", "#F6E3B8"
DARK, BLUE, BG, EDGE = "#2B2018", "#4E9BD1", "#141A1F", "#243039"

# id -> colour, so the SVG can carry readable class names
SHAPES = [
    # --- crested tail: attached at the REAR, sweeping left then up, tapering, black brush tip ---
    {"t": "curve", "pts": [(52, 100), (38, 110), (22, 106), (13, 92), (14, 74), (22, 62)],
     "w": 9.0, "w2": 5.0, "c": SAND},
    {"t": "curve", "pts": [(22, 62), (26, 56), (31, 51)], "w": 11.0, "w2": 9.0, "c": DARK},

    # --- hind leg and foot, one connected mass ---
    {"t": "ellipse", "xy": (42, 70, 88, 112), "c": SAND},
    {"t": "ellipse", "xy": (50, 102, 84, 114), "c": SAND_DARK},

    # --- body ---
    {"t": "ellipse", "xy": (46, 56, 98, 104), "c": SAND},
    {"t": "ellipse", "xy": (64, 72, 92, 100), "c": CREAM},

    # --- foreleg from the shoulder down the chest, ending in a paw that stays inside the body ---
    {"t": "curve", "pts": [(84, 64), (86, 76), (88, 86)], "w": 10.0, "w2": 7.0, "c": SAND},
    {"t": "ellipse", "xy": (82, 84, 96, 96), "c": CREAM},

    # --- neck, head, pointed snout, nose, mouth line ---
    {"t": "ellipse", "xy": (80, 48, 100, 70), "c": SAND},
    {"t": "ellipse", "xy": (72, 30, 104, 64), "c": SAND},
    {"t": "poly", "pts": [(99, 41), (114, 47), (116, 52), (100, 56)], "c": SAND},
    {"t": "circle", "xy": (112, 45, 118, 51), "c": DARK},
    {"t": "curve", "pts": [(102, 57), (108, 56), (112, 54)], "w": 1.6, "w2": 1.6, "c": DARK},

    # --- ear: slightly darker than the head so it reads, with a pale inner ---
    {"t": "ellipse", "xy": (76, 20, 96, 40), "c": SAND_DARK},
    {"t": "ellipse", "xy": (81, 25, 91, 35), "c": CREAM},

    # --- eye, with a glint ---
    {"t": "circle", "xy": (92, 42, 101, 51), "c": DARK},
    {"t": "circle", "xy": (94.3, 43.8, 97.3, 46.8), "c": "#FFFDF7"},

    # --- harness: two bands that cross the whole body contour, so they read as wrapping ---
    # each band is drawn twice: a darker edge pass under the blue, for definition at 16 px
    {"t": "curve", "pts": [(56, 58), (63, 82), (70, 107)], "w": 7.4, "w2": 7.4, "c": "#2C6B96"},
    {"t": "curve", "pts": [(56, 58), (63, 82), (70, 107)], "w": 5.6, "w2": 5.6, "c": BLUE},
    {"t": "curve", "pts": [(74, 56), (81, 80), (88, 103)], "w": 7.4, "w2": 7.4, "c": "#2C6B96"},
    {"t": "curve", "pts": [(74, 56), (81, 80), (88, 103)], "w": 5.6, "w2": 5.6, "c": BLUE},

    # --- the ring sits on the back contour where the straps meet, and the leash hangs off it ---
    {"t": "circle", "xy": (62, 51, 74, 63), "c": "#2C6B96"},
    {"t": "circle", "xy": (64, 53, 72, 61), "c": BLUE},
    {"t": "circle", "xy": (66.5, 55.5, 69.5, 58.5), "c": BG},
    {"t": "curve", "pts": [(68, 52), (70, 32), (74, 3)], "w": 3.6, "w2": 3.6, "c": BLUE},
]


def to_png(size: int) -> Image.Image:
    px = size * SS
    f = px / W
    im = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    def sc(v):
        return v * f

    r = int(26 * f)
    d.rounded_rectangle([0, 0, px - 1, px - 1], radius=r, fill=BG)
    d.rounded_rectangle([sc(3), sc(3), px - 1 - sc(3), px - 1 - sc(3)], radius=int(23 * f),
                        outline=EDGE, width=max(1, int(f)))

    for s in SHAPES:
        c = s["c"]
        if s["t"] == "ellipse":
            x0, y0, x1, y1 = [sc(v) for v in s["xy"]]
            d.ellipse([x0, y0, x1, y1], fill=c)
        elif s["t"] == "circle":
            x0, y0, x1, y1 = [sc(v) for v in s["xy"]]
            d.ellipse([x0, y0, x1, y1], fill=c)
        elif s["t"] == "poly":
            d.polygon([(sc(x), sc(y)) for x, y in s["pts"]], fill=c)
        elif s["t"] == "curve":
            # thick polyline with round caps: circles sampled along the path
            pts = densify(s["pts"], steps=24)
            w0, w1 = sc(s["w"]), sc(s.get("w2", s["w"]))
            n = len(pts)
            for i, (x, y) in enumerate(pts):
                rad = (w0 + (w1 - w0) * (i / (n - 1))) / 2
                d.ellipse([sc(x) - rad, sc(y) - rad, sc(x) + rad, sc(y) + rad], fill=c)
    return im.resize((size, size), Image.LANCZOS)


def densify(pts, steps=20):
    """Catmull-Rom through the control points: smooth curves, no angular joints."""
    if len(pts) < 3:
        return pts
    p = [pts[0]] + list(pts) + [pts[-1]]
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        for j in range(steps):
            t = j / steps
            t2, t3 = t * t, t * t * t
            x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t +
                       (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
                       (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3)
            y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t +
                       (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
                       (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
            out.append((x, y))
    out.append(pts[-1])
    return out


def to_svg() -> str:
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="Ningaui">',
        "  <title>Ningaui</title>",
        '  <rect width="128" height="128" rx="26" fill="#141A1F"/>',
        '  <rect x="3" y="3" width="122" height="122" rx="23" fill="none" stroke="#243039" stroke-width="1"/>',
    ]
    for s in SHAPES:
        if s["t"] in ("ellipse", "circle"):
            x0, y0, x1, y1 = s["xy"]
            parts.append(f'  <ellipse cx="{(x0 + x1) / 2:g}" cy="{(y0 + y1) / 2:g}" '
                         f'rx="{(x1 - x0) / 2:g}" ry="{(y1 - y0) / 2:g}" fill="{s["c"]}"/>')
        elif s["t"] == "poly":
            pts = " ".join(f"{x:g},{y:g}" for x, y in s["pts"])
            parts.append(f'  <polygon points="{pts}" fill="{s["c"]}"/>')
        elif s["t"] == "curve":
            d = "M " + " L ".join(f"{x:g} {y:g}" for x, y in s["pts"])
            parts.append(f'  <path d="{d}" fill="none" stroke="{s["c"]}" stroke-width="{s["w"]:g}" '
                         f'stroke-linecap="round" stroke-linejoin="round"/>')
    parts.append("</svg>\n")
    return "\n".join(parts)


if __name__ == "__main__":
    root = pathlib.Path(__file__).resolve().parent.parent
    assets = root / "assets"
    assets.mkdir(exist_ok=True)
    (assets / "ningaui-icon.svg").write_text(to_svg())
    for size in (16, 32, 48, 128, 512):
        to_png(size).save(assets / f"ningaui-{size}.png")
    # the extension bundles need the icons next to the manifest
    for target in ("chrome", "firefox"):
        dest = root / "platform" / target / "icons"
        dest.mkdir(exist_ok=True)
        for size in (16, 32, 48, 128):
            to_png(size).save(dest / f"icon-{size}.png")
    print("wrote assets/ningaui-icon.svg, ningaui-{16,32,48,128,512}.png and both icons/ dirs")
