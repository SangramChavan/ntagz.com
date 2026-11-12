#!/usr/bin/env python3
"""Round-styled QR that every scanner reads: standard-polarity square QR core (ECC H),
white 4-module quiet zone, concentric-ring centre, decorative dots filling a circle around it.
Usage: python3 scripts/gen-universal-qr.py [URL] -> images/ntagz-qr-universal.{svg,png}"""
import math, random, sys
import segno
from PIL import Image, ImageDraw

URL = sys.argv[1] if len(sys.argv) > 1 else "https://ntagz.com/?utm_source=qr"
OUT = "images/ntagz-qr-universal"
M, INK, DECO, ORANGE = 14, "#1f2321", "#b4b8b6", "#ff4d00"
Q = 4                                   # quiet zone, modules

qr = segno.make(URL, error="h", boost_error=False)
n = qr.symbol_size(border=0)[0]
mat = [list(r) for r in qr.matrix]
finder = lambda r, c: (r < 7 and c < 7) or (r < 7 and c >= n - 7) or (r >= n - 7 and c < 7)
half = n / 2
R = math.hypot(half, half) + Q + 2.5     # circle radius in modules
S = int(2 * R * M); cx = S / 2; ox = cx - n * M / 2
px = lambda v: ox + v * M
br = n * 0.13                             # badge radius (modules); ~5% of area

dots, deco = [], []
for r in range(n):
    for c in range(n):
        if mat[r][c] and not finder(r, c) and math.hypot(r + .5 - half, c + .5 - half) > br + 0.8:
            dots.append((c, r))
rnd = random.Random(7)
lim = int(R) + 1
for r in range(-lim, n + lim):
    for c in range(-lim, n + lim):
        inside_core = -Q <= r < n + Q and -Q <= c < n + Q
        if not inside_core and math.hypot(r + .5 - half, c + .5 - half) < R - 0.5 and rnd.random() < .5:
            deco.append((c, r))

K = 2
img = Image.new("RGBA", (S * K, S * K), (255, 255, 255, 0)); d = ImageDraw.Draw(img)
d.ellipse((0, 0, S * K - 1, S * K - 1), fill="#ffffff")
def circ(x, y, rad, fill): d.ellipse([(x - rad) * K, (y - rad) * K, (x + rad) * K, (y + rad) * K], fill=fill)
def rr(x, y, w, rad, fill): d.rounded_rectangle([x * K, y * K, (x + w) * K, (y + w) * K], radius=rad * K, fill=fill)
for c, r in deco: circ(px(c + .5), px(r + .5), M * .3, DECO)
for c, r in dots: circ(px(c + .5), px(r + .5), M * .46, INK)
for fx, fy in [(0, 0), (n - 7, 0), (0, n - 7)]:
    X, Y = px(fx), px(fy)
    rr(X, Y, 7 * M, 2 * M, INK); rr(X + M, Y + M, 5 * M, 1.3 * M, "#ffffff"); rr(X + 2 * M, Y + 2 * M, 3 * M, M, INK)
cc = S / 2
for i, col in enumerate(["#ffffff", INK, "#ffffff", ORANGE, "#ffffff", INK]):
    circ(cc, cc, br * M * (1 - i * .17), col)
img = img.resize((S, S), Image.LANCZOS); img.save(OUT + ".png")

o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">',
     f'<circle cx="{cx}" cy="{cx}" r="{S/2}" fill="#fff"/>', f'<g fill="{DECO}">']
o += [f'<circle cx="{px(c+.5):.1f}" cy="{px(r+.5):.1f}" r="{M*.3:.1f}"/>' for c, r in deco]
o.append(f'</g><g fill="{INK}">')
o += [f'<circle cx="{px(c+.5):.1f}" cy="{px(r+.5):.1f}" r="{M*.46:.1f}"/>' for c, r in dots]
o.append('</g>')
for fx, fy in [(0, 0), (n - 7, 0), (0, n - 7)]:
    X, Y = px(fx), px(fy)
    o.append(f'<rect x="{X:.1f}" y="{Y:.1f}" width="{7*M}" height="{7*M}" rx="{2*M}" fill="{INK}"/>'
             f'<rect x="{X+M:.1f}" y="{Y+M:.1f}" width="{5*M}" height="{5*M}" rx="{1.3*M}" fill="#fff"/>'
             f'<rect x="{X+2*M:.1f}" y="{Y+2*M:.1f}" width="{3*M}" height="{3*M}" rx="{M}" fill="{INK}"/>')
for i, col in enumerate(["#ffffff", INK, "#ffffff", ORANGE, "#ffffff", INK]):
    o.append(f'<circle cx="{cc}" cy="{cc}" r="{br*M*(1-i*.17):.1f}" fill="{col}"/>')
o.append('</svg>'); open(OUT + ".svg", "w").write("\n".join(o))
print(f"{URL} -> {OUT}.svg/.png ({S}px)")
