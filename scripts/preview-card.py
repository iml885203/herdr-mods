# Makes an item's 16:10 gallery card: dot grid, shortcut keycaps, a one-line headline, the mod below.
# The gallery crops cards to 16:10 from the top-left, so every preview.png goes through this.
# usage: uv run --with pillow scripts/preview-card.py <screenshot.png> <out.png> "<keys, e.g. ⌘ K>" \
#          "<headline> " "<accented tail>" "#accent" [px to crop off the screenshot's top]
# Accents in use: #5b8def kubernetes, #e8875f agent-history + claude-goal, #4cc38a session-changes,
#                 #a48bfa smart-close, #2dd4bf orbit. Needs macOS (SF Pro fonts).
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
W, H, PAD = 2400, 1500, 150
SF, MONO = '/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/SFNSMono.ttf'
def sf(size, wght, path=SF):
    f = ImageFont.truetype(path, size)
    axes = [a['name'] for a in f.get_variation_axes()]
    f.set_variation_by_axes([{b'Width': 100, b'Optical Size': 96, b'GRAD': 400, b'Weight': wght}.get(a, 400) for a in axes])
    return f
def hexrgb(h): return tuple(int(h[i:i+2], 16) for i in (1, 3, 5))
src, dst, keys, head, tail, accent = sys.argv[1:7]; crop = int(sys.argv[7]) if len(sys.argv) > 7 else 0
CARDS = [(src, keys.split(), head, tail, accent, crop)]
for name, keys, head, tail, accent, crop in CARDS:
    ac = hexrgb(accent)
    im = Image.new('RGB', (W, H), (13, 14, 17)); d = ImageDraw.Draw(im)
    for y in range(36, H, 36):
        for x in range(36, W, 36): d.point([(x, y), (x+1, y), (x, y+1), (x+1, y+1)], fill=(30, 32, 38))
    glow = Image.new('L', (W, H), 0); ImageDraw.Draw(glow).ellipse((W - 1300, H - 900, W + 500, H + 700), fill=70)
    im.paste(Image.new('RGB', (W, H), ac), (0, 0), glow.filter(ImageFilter.GaussianBlur(300)))
    d = ImageDraw.Draw(im)
    # keycaps
    kf = sf(58, 600); x = PAD; y = 130
    for k in keys:
        w = max(110, int(d.textlength(k, font=kf)) + 60)
        d.rounded_rectangle((x, y + 10, x + w, y + 120), 22, fill=tuple(c // 3 for c in ac))
        d.rounded_rectangle((x, y, x + w, y + 108), 22, fill=(32, 34, 40), outline=ac, width=3)
        d.text((x + w / 2, y + 54), k, font=kf, fill=(236, 236, 240), anchor='mm')
        x += w + 18
    d.text((W - PAD, y + 54), 'herdr-mods', font=sf(40, 500, MONO), fill=(96, 100, 112), anchor='rm')
    # headline
    hf = sf(92, 700); hy = 300
    d.text((PAD, hy), head, font=hf, fill=(240, 240, 244))
    d.text((PAD + d.textlength(head, font=hf), hy), tail, font=hf, fill=ac)
    assert PAD + d.textlength(head + tail, font=hf) < W - PAD, name
    # the mod
    shot = Image.open(name).convert('RGB')
    if crop: shot = shot.crop((0, crop, shot.width, shot.height))
    area = 470; maxw, maxh = W - 2 * PAD, H - area - 100
    s = maxw / shot.width
    shot = shot.resize((round(shot.width * s), round(shot.height * s)), Image.LANCZOS)
    bleed = shot.height > H - area - 100
    sx = PAD
    if bleed:  # tall views run off the bottom edge
        sy = area; shot = shot.crop((0, 0, shot.width, H - sy + 40))
    else:
        sy = area + (H - area - 70 - shot.height) // 2
    sh = Image.new('L', (W, H), 0); ImageDraw.Draw(sh).rounded_rectangle((sx, sy + 30, sx + shot.width, sy + shot.height + 30), 28, fill=190)
    im.paste((0, 0, 0), (0, 0), sh.filter(ImageFilter.GaussianBlur(50)))
    m = Image.new('L', shot.size, 0); ImageDraw.Draw(m).rounded_rectangle((0, 0, *shot.size), 22, fill=255)
    im.paste(shot, (sx, sy), m)
    ImageDraw.Draw(im).rounded_rectangle((sx, sy, sx + shot.width - 1, sy + shot.height - 1), 22, outline=(58, 60, 68), width=2)
    im.save(dst, optimize=True); print(name, shot.size)
