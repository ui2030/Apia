"""Generate the neutral Apia app icon (build/icon.ico).

Brand constraints (see memory: no IP/character names, model-swappable):
the mark must be generic — a rounded-square gradient badge with a soft
lowercase 'a' wordmark. No character art. Rendered at 4x supersample for
clean edges, then emitted as a multi-size .ico for Windows (taskbar 16px
up through the 256px shell/installer icon).
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SS = 4                      # supersample factor
BASE = 256
N = BASE * SS
CORNER = int(N * 0.225)     # iOS-ish rounded square

# Indigo -> violet diagonal gradient (calm "companion AI" palette, neutral).
TOP = (99, 102, 241)        # #6366F1
BOT = (139, 92, 246)        # #8B5CF6


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def gradient(size):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            # diagonal t in [0,1]
            t = (x + y) / (2 * (size - 1))
            px[x, y] = lerp(TOP, BOT, t)
    return img


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def load_font(px):
    for name in ("seguisb.ttf", "segoeuib.ttf", "arialbd.ttf", "Arial.ttf"):
        path = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", name)
        if os.path.exists(path):
            return ImageFont.truetype(path, px)
    return ImageFont.load_default()


def build():
    # Gradient badge clipped to a rounded square.
    badge = gradient(N)
    mask = rounded_mask(N, CORNER)

    # Soft top highlight for depth.
    hi = Image.new("L", (N, N), 0)
    dh = ImageDraw.Draw(hi)
    dh.ellipse([-N * 0.2, -N * 0.55, N * 1.2, N * 0.45], fill=70)
    hi = hi.filter(ImageFilter.GaussianBlur(N * 0.06))
    white = Image.new("RGB", (N, N), (255, 255, 255))
    badge = Image.composite(white, badge, hi.point(lambda v: int(v * 0.5)))

    canvas = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    canvas.paste(badge, (0, 0), mask)

    # Lowercase wordmark 'a' — friendly, approachable companion.
    draw = ImageDraw.Draw(canvas)
    font = load_font(int(N * 0.62))
    glyph = "a"
    bbox = draw.textbbox((0, 0), glyph, font=font)
    gw, gh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    gx = (N - gw) / 2 - bbox[0]
    gy = (N - gh) / 2 - bbox[1]
    # subtle drop shadow then the glyph
    draw.text((gx, gy + N * 0.012), glyph, font=font, fill=(60, 40, 120, 90))
    draw.text((gx, gy), glyph, font=font, fill=(255, 255, 255, 255))

    icon = canvas.resize((BASE, BASE), Image.LANCZOS)

    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build")
    os.makedirs(out_dir, exist_ok=True)
    ico_path = os.path.join(out_dir, "icon.ico")
    png_path = os.path.join(out_dir, "icon.png")
    icon.save(png_path)
    icon.save(ico_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("[ICON_OK]", ico_path)
    print("[ICON_OK]", png_path)


if __name__ == "__main__":
    build()
