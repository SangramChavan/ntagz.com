#!/usr/bin/env python3
"""Circular dash-style QR (dark disc, white pills) -> images/ntagz-qr.{svg,png}.

Inverted QR: white shapes are the QR's dark modules, so scanners need inversion
support (iOS/Android cameras have it). Usage: python3 scripts/gen-circle-qr.py [URL]
"""
import base64, io, math, sys
import segno
from PIL import Image, ImageDraw

URL = sys.argv[1] if len(sys.argv) > 1 else "https://ntagz.com/?utm_source=qr"
OUT = "images/ntagz-qr"
M = 14                      # px per module
DISC, INK = "#2f3331", "#ffffff"

qr = segno.make(URL, error="h", boost_error=False)
n = qr.symbol_size(border=0)[0]
mat = [list(r) for r in qr.matrix]

# finder/separator zones are drawn as clean rounded rings, not merged dashes
def in_finder(r, c):
    return (r < 8 and c < 8) or (r < 8 and c >= n - 8) or (r >= n - 8 and c < 8)

shapes = []                 # (x, y, w, h) in modules, all drawn as pills
for r in range(n):
    c = 0
    while c < n:
        if mat[r][c] and not in_finder(r, c):
            e = c
            while e + 1 < n and mat[r][e + 1] and not in_finder(r, e + 1) and e - c < 3:
                e += 1
            shapes.append((c, r, e - c + 1, 1))
            c = e + 1
        else:
            c += 1

finders = [(0, 0), (n - 7, 0), (0, n - 7)]
pad = 3.2                                          # disc margin around the square (modules)
R = (n * math.sqrt(2) / 2 + pad) * M
S = int(2 * R)
cx = S / 2
ox = cx - n * M / 2

def px(v): return ox + v * M

# centre badge: orange NFC icon cropped from the site logo, on a white circle
logo = Image.open("images/logo.png").convert("RGBA").crop((6, 14, 92, 106))
logo.thumbnail((int(n * M * 0.20),) * 2, Image.LANCZOS)
badge_r = n * M * 0.145
# clear the area under the badge so no module is half-hidden
shapes = [s for s in shapes if math.hypot(px(s[0] + s[2] / 2) - cx, px(s[1] + .5) - cx) > badge_r + M * 1.2]

# --- PNG (supersampled) ---
K = 2
img = Image.new("RGBA", (S * K, S * K), (255, 255, 255, 0))
d = ImageDraw.Draw(img)
d.ellipse((0, 0, S * K - 1, S * K - 1), fill=DISC)
for x, y, w, h in shapes:
    d.rounded_rectangle([px(x) * K + 1.5 * K, px(y) * K + 1.5 * K, px(x + w) * K - 1.5 * K, px(y + h) * K - 1.5 * K],
                        radius=M * K / 2, fill=INK)
for fx, fy in finders:
    d.rounded_rectangle([px(fx) * K, px(fy) * K, px(fx + 7) * K, px(fy + 7) * K], radius=1.1 * M * K, fill=INK)
    d.rounded_rectangle([px(fx + 1) * K, px(fy + 1) * K, px(fx + 6) * K, px(fy + 6) * K], radius=0.7 * M * K, fill=DISC)
    d.rounded_rectangle([px(fx + 2) * K, px(fy + 2) * K, px(fx + 5) * K, px(fy + 5) * K], radius=0.5 * M * K, fill=INK)
d.ellipse((cx * K - badge_r * K, cx * K - badge_r * K, cx * K + badge_r * K, cx * K + badge_r * K), fill="#ffffff")
lw, lh = logo.size
img.paste(logo.resize((lw * K, lh * K), Image.LANCZOS), (int(cx * K - lw * K / 2), int(cx * K - lh * K / 2)), logo.resize((lw * K, lh * K), Image.LANCZOS))
img = img.resize((S, S), Image.LANCZOS)
img.save(OUT + ".png")

# --- SVG ---
buf = io.BytesIO(); logo.save(buf, "PNG")
b64 = base64.b64encode(buf.getvalue()).decode()
o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">',
     f'<circle cx="{cx}" cy="{cx}" r="{R}" fill="{DISC}"/>', f'<g fill="{INK}">']
for x, y, w, h in shapes:
    o.append(f'<rect x="{px(x)+1.5:.1f}" y="{px(y)+1.5:.1f}" width="{w*M-3}" height="{M-3}" rx="{(M-3)/2}"/>')
o.append('</g>')
for fx, fy in finders:
    X, Y = px(fx), px(fy)
    o.append(f'<rect x="{X:.1f}" y="{Y:.1f}" width="{7*M}" height="{7*M}" rx="{1.1*M}" fill="{INK}"/>'
             f'<rect x="{X+M:.1f}" y="{Y+M:.1f}" width="{5*M}" height="{5*M}" rx="{0.7*M}" fill="{DISC}"/>'
             f'<rect x="{X+2*M:.1f}" y="{Y+2*M:.1f}" width="{3*M}" height="{3*M}" rx="{0.5*M}" fill="{INK}"/>')
o.append(f'<circle cx="{cx}" cy="{cx}" r="{badge_r:.1f}" fill="#fff"/>')
o.append(f'<image x="{cx-lw/2:.1f}" y="{cx-lh/2:.1f}" width="{lw}" height="{lh}" href="data:image/png;base64,{b64}"/>')
o.append('</svg>')
open(OUT + ".svg", "w").write("\n".join(o))
print(f"{URL} -> {OUT}.svg/.png ({S}px, {n}x{n} modules)")
