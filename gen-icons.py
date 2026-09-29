#!/usr/bin/env python3
"""生成阅读 App 桌面版站点图标（favicon + PWA）"""
import math
from PIL import Image, ImageDraw

S = 2048  # 超采样画布
C = S // 2

# ---------- 背景：圆角方形渐变 ----------
bg = Image.new('RGBA', (S, S), (0, 0, 0, 0))
grad = Image.new('RGBA', (S, S))
gd = grad.load()
# 对角渐变：左上 #4C7BFF → 右下 #2A3FD0
c1 = (0x4C, 0x7B, 0xFF); c2 = (0x2A, 0x3F, 0xD0)
for y in range(S):
    for x in range(S):
        t = (x + y) / (2 * S)
        gd[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(c1, c2)) + (255,)
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=460, fill=255)
bg.paste(grad, (0, 0), mask)

img = bg
d = ImageDraw.Draw(img)

# ---------- 打开的书（两页白色书页） ----------
page_w, page_h = 620, 880
page_r = 120
# 左页：绘制在透明层上再旋转
def rotated_page(cx, cy, angle):
    lay = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lay)
    x0, y0 = cx - page_w // 2, cy - page_h // 2
    x1, y1 = cx + page_w // 2, cy + page_h // 2
    ld.rounded_rectangle([x0, y0, x1, y1], radius=page_r, fill=(255, 255, 255, 255))
    # 页面右侧阴影（中缝一侧略暗，增强立体感）
    shade = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    if angle < 0:  # 左页 → 右缘阴影
        sd.rounded_rectangle([x1 - 150, y0 + 40, x1 - 10, y1 - 40], radius=60, fill=(20, 40, 120, 60))
    else:          # 右页 → 左缘阴影
        sd.rounded_rectangle([x0 + 10, y0 + 40, x0 + 150, y1 - 40], radius=60, fill=(20, 40, 120, 60))
    lay = Image.alpha_composite(lay, shade)
    return lay.rotate(angle, center=(cx, cy), resample=Image.BICUBIC)

# 书页中心略低于画布中心，书脊在中央
page_cy = C + 30
left = rotated_page(C - 320, page_cy, -10)
right = rotated_page(C + 320, page_cy, 10)
img = Image.alpha_composite(img, left)
img = Image.alpha_composite(img, right)

# ---------- 中缝（书脊内凹） ----------
d = ImageDraw.Draw(img)
spine_w = 64
spine = Image.new('RGBA', (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(spine)
# 深色窄条表示书脊
sd.rounded_rectangle([C - spine_w // 2, page_cy - page_h // 2 + 90, C + spine_w // 2, page_cy + page_h // 2 - 90],
                     radius=26, fill=(30, 45, 120, 120))
# 书脊上的高光线
sd.rounded_rectangle([C - spine_w // 4, page_cy - page_h // 2 + 110, C + spine_w // 4, page_cy + page_h // 2 - 110],
                     radius=14, fill=(255, 255, 255, 90))
img = Image.alpha_composite(img, spine)

# ---------- 经典书签（顶部橙色，底部收尖） ----------
bm_top = page_cy - page_h // 2 - 170   # 露出书页顶部
bm_w = 170
bm_bottom = page_cy - page_h // 2 + 560
bm = Image.new('RGBA', (S, S), (0, 0, 0, 0))
bd = ImageDraw.Draw(bm)
# 书签主体：矩形 + 底部三角
bd.rounded_rectangle([C - bm_w // 2, bm_top, C + bm_w // 2, bm_bottom - 90], radius=44, fill=(255, 158, 36, 255))
bd.polygon([(C - bm_w // 2, bm_bottom - 90), (C + bm_w // 2, bm_bottom - 90), (C, bm_bottom)], fill=(255, 158, 36, 255))
# 书签高光
bd.rounded_rectangle([C - bm_w // 2 + 24, bm_top + 40, C - bm_w // 2 + 64, bm_bottom - 200], radius=20, fill=(255, 210, 120, 180))
img = Image.alpha_composite(img, bm)

# ---------- 输出各尺寸 ----------
def save(size, path):
    out = img.resize((size, size), Image.LANCZOS)
    out.save(path, 'PNG')
    print(f'{path}  {size}x{size}')

import os
os.makedirs('icons', exist_ok=True)
save(512, 'icons/icon-512.png')
save(192, 'icons/icon-192.png')
save(180, 'icons/icon-180.png')
save(48, 'icons/icon-48.png')
save(32, 'icons/icon-32.png')
save(16, 'icons/icon-16.png')
print('done')
