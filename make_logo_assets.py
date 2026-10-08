"""Makes transparent circular versions of static/logo.png for the web page. Run: python make_logo_assets.py"""
from PIL import Image, ImageDraw

src = Image.open("static/logo.png").convert("RGBA")
w, h = src.size
row = [src.getpixel((x, h // 2))[:3] for x in range(w)]
dark = [x for x, p in enumerate(row) if sum(p) < 120]  # where the near-black circle starts and ends
left, right = dark[0], dark[-1]
cx, r = (left + right) / 2, (right - left) / 2 - 2
box = (int(cx - r), int(h / 2 - r), int(cx + r), int(h / 2 + r))
badge = src.crop(box)
size = badge.size[0]
mask = Image.new("L", (size * 4, size * 4), 0)  # draw 4x bigger for smooth edges
ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
badge.putalpha(mask.resize(badge.size, Image.LANCZOS))
badge.resize((512, 512), Image.LANCZOS).save("static/logo-badge.png", optimize=True)
badge.resize((64, 64), Image.LANCZOS).save("static/logo-64.png", optimize=True)
print("saved static/logo-badge.png and static/logo-64.png; circle", box)
