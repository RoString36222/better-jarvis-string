"""Draws ZEN's app icon: the arc reactor on a navy rounded square."""
import math
from PIL import Image, ImageDraw, ImageFilter

S = 1024
SAPPHIRE = (47, 107, 255)
WHITE = (236, 243, 255)


def rounded_square():
    bg = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    grad = Image.new('RGBA', (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):  # navy, a touch lighter at the top
        t = y / S
        gd.line([(0, y), (S, y)], fill=(int(8 - 4 * t), int(18 - 8 * t), int(48 - 22 * t), 255))
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=200, fill=255)
    bg.paste(grad, (0, 0), mask)
    return bg


def arc(d, r, start, end, color, width):
    c = S / 2
    d.arc([c - r, c - r, c + r, c + r], start, end, fill=color, width=width)


def rings():
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    c = S / 2
    # outer dotted ring
    for i in range(72):
        a = math.radians(i * 5)
        x, y = c + 360 * math.cos(a), c + 360 * math.sin(a)
        d.ellipse([x - 5, y - 5, x + 5, y + 5], fill=WHITE + (200,))
    # tick ring
    for i in range(60):
        a = math.radians(i * 6)
        r1, r2 = (322, 346) if i % 5 == 0 else (330, 342)
        d.line([c + r1 * math.cos(a), c + r1 * math.sin(a), c + r2 * math.cos(a), c + r2 * math.sin(a)],
               fill=SAPPHIRE + (230,), width=5 if i % 5 == 0 else 3)
    # segmented white arcs
    for s0, s1 in [(-80, 10), (25, 60), (75, 165), (185, 215), (230, 260)]:
        arc(d, 290, s0, s1, WHITE + (255,), 14)
    # inner arcs
    for s0, s1 in [(200, 320), (20, 140)]:
        arc(d, 168, s0, s1, WHITE + (220,), 9)
    # crosshair + core
    for a in (0, 90, 180, 270):
        t = math.radians(a)
        d.line([c + 50 * math.cos(t), c + 50 * math.sin(t), c + 120 * math.cos(t), c + 120 * math.sin(t)],
               fill=WHITE + (220,), width=7)
    d.ellipse([c - 22, c - 22, c + 22, c + 22], fill=WHITE + (255,))
    return layer


def band():
    # the glowing sapphire band: blurred wide stroke under a crisp one
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    arc(ImageDraw.Draw(glow), 228, 0, 360, SAPPHIRE + (255,), 60)
    glow = glow.filter(ImageFilter.GaussianBlur(28))
    crisp = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(crisp)
    arc(d, 228, 0, 360, SAPPHIRE + (255,), 30)
    arc(d, 228, 0, 360, (190, 214, 255, 255), 6)
    return Image.alpha_composite(glow, crisp)


img = rounded_square()
img = Image.alpha_composite(img, band())
img = Image.alpha_composite(img, rings())
# keep everything inside the rounded square
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=200, fill=255)
out = Image.new('RGBA', (S, S), (0, 0, 0, 0))
out.paste(img, (0, 0), mask)
out.save('zen-1024.png')
print('ok')
