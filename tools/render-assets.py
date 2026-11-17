#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Render the storefront assets from one wallpaper clip.

    python tools/render-assets.py <clip.mp4> [--at 1.2] [--anchor 0.24]

Writes `assets/icon-180.png`, `assets/screenshot-1.jpg` (1280x800) and
`docs/preview.jpg` (1000x625). The screenshot is a composed mock: the clip's own
frame, the three-column shell over it, and the control panel — everything is
drawn here, nothing is captured from a live window, so keep the layout in sync
with `client.js` when it changes.
"""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
DOCS = ROOT / "docs"
FONT = r"C:\Windows\Fonts\msyh.ttc"
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
WHITE = (255, 255, 255)
TEAL = (94, 216, 201)


def font(size, bold=False):
    try:
        return ImageFont.truetype(FONT_BOLD if bold else FONT, size)
    except Exception:
        return ImageFont.load_default()


def rounded(size, radius, fill):
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=fill)
    return layer


def frame_at(source, second, anchor, width=1280, height=800):
    """Grab one frame and crop it the way the wallpaper covers the window."""
    import cv2

    capture = cv2.VideoCapture(str(source))
    capture.set(cv2.CAP_PROP_POS_MSEC, second * 1000)
    ok, raw = capture.read()
    capture.release()
    if not ok:
        raise SystemExit(f"no frame at {second}s")
    image = Image.fromarray(cv2.cvtColor(raw, cv2.COLOR_BGR2RGB))
    scale = max(width / image.width, height / image.height)
    resized = image.resize((int(image.width * scale + 0.5), int(image.height * scale + 0.5)), Image.LANCZOS)
    left = (resized.width - width) // 2
    top = int((resized.height - height) * anchor)
    return resized.crop((left, top, left + width, top + height))


def build_icon():
    icon = Image.new("RGBA", (180, 180), (0, 0, 0, 0))
    draw = ImageDraw.Draw(icon)
    accent = (47, 111, 235, 255)
    draw.rounded_rectangle([22, 38, 158, 142], radius=28, outline=accent, width=12)
    draw.polygon([(76, 66), (76, 114), (118, 90)], fill=accent)
    draw.line([(46, 122), (134, 122)], fill=(47, 111, 235, 110), width=12)
    ASSETS.mkdir(parents=True, exist_ok=True)
    icon.save(ASSETS / "icon-180.png")
    print("icon:", (ASSETS / "icon-180.png").stat().st_size, "B")


def build_screenshot(source, second, anchor):
    width, height = 1280, 800
    canvas = frame_at(source, second, anchor).convert("RGBA")
    canvas.alpha_composite(rounded((width, height), 0, (10, 11, 14, 42)))
    draw = ImageDraw.Draw(canvas)

    # sidebar
    canvas.alpha_composite(rounded((260, height), 0, (16, 17, 21, 150)))
    draw.text((26, 34), "DeepSeek", font=font(20, True), fill=WHITE + (225,))
    canvas.alpha_composite(rounded((208, 38), 10, WHITE + (30,)), dest=(26, 78))
    draw.text((40, 87), "＋  新对话", font=font(16), fill=WHITE + (210,))
    for index, label in enumerate(["抖音壁纸", "日本梅津寺", "拉片流水线", "插件市场"]):
        y = 150 + index * 44
        if index == 0:
            canvas.alpha_composite(rounded((208, 34), 9, WHITE + (34,)), dest=(26, y - 8))
            draw.text((40, y), label, font=font(16), fill=WHITE + (238,))
        else:
            draw.text((40, y), label, font=font(16), fill=WHITE + (150,))
    draw.text((86, 742), "设置", font=font(15), fill=WHITE + (150,))
    draw.rounded_rectangle([42, 738, 70, 766], radius=8, fill=WHITE + (28,))
    draw.rounded_rectangle([48, 746, 64, 758], radius=3, outline=TEAL + (235,), width=2)
    draw.polygon([(53, 749), (53, 755), (59, 752)], fill=TEAL + (235,))

    # conversation
    draw.text((300, 34), "命运洪流不可阻挡", font=font(19, True), fill=WHITE + (232,))
    draw.text((300, 64), "抖音壁纸 · 已连接", font=font(13), fill=WHITE + (130,))
    draw.text((300, 118), "你", font=font(13, True), fill=WHITE + (150,))
    canvas.alpha_composite(rounded((330, 40), 12, WHITE + (36,)), dest=(300, 138))
    draw.text((316, 148), "把这条抖音设成壁纸", font=font(15), fill=WHITE + (238,))
    draw.text((300, 200), "DSH", font=font(13, True), fill=WHITE + (150,))
    canvas.alpha_composite(rounded((690, 40), 12, WHITE + (20,)), dest=(300, 220))
    draw.text((316, 230), "已取到直链，3.48 MB，铺满窗口了。", font=font(15), fill=WHITE + (226,))

    # composer
    canvas.alpha_composite(rounded((880, 84), 17, WHITE + (24,)), dest=(292, 700))
    draw.rounded_rectangle([292, 700, 1171, 783], radius=17, outline=WHITE + (44,), width=1)
    draw.text((316, 730), "给这个壁纸再加一点暗化", font=font(15), fill=WHITE + (150,))
    canvas.alpha_composite(rounded((60, 36), 11, TEAL + (240,)), dest=(1096, 724))
    draw.text((1119, 732), "↑", font=font(17, True), fill=(16, 17, 21, 255))

    # control panel
    pw, ph = 392, 396
    panel = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel)
    pd.rounded_rectangle([0, 0, pw - 1, ph - 1], radius=18, fill=(22, 23, 28, 244), outline=WHITE + (40,), width=1)
    pd.text((20, 16), "抖音壁纸", font=font(16, True), fill=WHITE + (235,))
    pd.text((pw - 38, 17), "×", font=font(16), fill=WHITE + (150,))
    pd.rounded_rectangle([18, 52, pw - 18, 86], radius=9, fill=WHITE + (26,), outline=WHITE + (42,), width=1)
    pd.text((32, 62), "粘贴抖音分享链接…", font=font(12), fill=WHITE + (120,))
    pd.rounded_rectangle([pw - 84, 52, pw - 18, 86], radius=9, fill=WHITE + (54,))
    pd.text((pw - 66, 62), "应用", font=font(13), fill=WHITE + (225,))
    for index, (label, value, ratio) in enumerate(
        [("玻璃浓度", "30%", 0.05), ("模糊", "0%", 0.0), ("暗化", "0%", 0.0), ("亮度", "130%", 1.0)]
    ):
        y = 108 + index * 42
        pd.text((20, y), label, font=font(13), fill=WHITE + (188,))
        pd.rounded_rectangle([112, y + 8, 288, y + 13], radius=3, fill=WHITE + (42,))
        knob = 118 + int((288 - 118) * ratio)
        pd.ellipse([knob - 7, y + 3, knob + 7, y + 17], fill=TEAL + (255,))
        pd.text((300, y), value, font=font(12), fill=WHITE + (150,))
    pd.line([(20, 288), (pw - 20, 288)], fill=WHITE + (26,), width=1)
    for index, label in enumerate(["静音", "循环"]):
        x = 20 + index * 140
        pd.rounded_rectangle([x, 308, x + 40, 330], radius=11, fill=TEAL + (215,))
        pd.ellipse([x + 22, 312, x + 36, 326], fill=(22, 23, 28, 255))
        pd.text((x + 48, 310), label, font=font(13), fill=WHITE + (180,))
    pd.text((20, 350), "视频铺满窗口，界面半透明叠在上面。", font=font(11), fill=WHITE + (118,))
    pd.text((20, 368), "设置存在本机，刷新自动恢复。", font=font(11), fill=WHITE + (118,))

    shadow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([40, 258, 40 + pw + 14, 258 + ph + 14], radius=24, fill=(0, 0, 0, 135))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(20)))
    canvas.alpha_composite(panel, (48, 266))

    ASSETS.mkdir(parents=True, exist_ok=True)
    DOCS.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").resize((1000, 625), Image.LANCZOS).save(DOCS / "preview.jpg", quality=88, optimize=True, progressive=True)
    canvas.convert("RGB").save(ASSETS / "screenshot-1.jpg", quality=90, optimize=True, progressive=True)
    print("screenshot:", (ASSETS / "screenshot-1.jpg").stat().st_size, "B")
    print("preview:", (DOCS / "preview.jpg").stat().st_size, "B")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("clip")
    parser.add_argument("--at", type=float, default=1.2, help="frame time in seconds")
    parser.add_argument("--anchor", type=float, default=0.24, help="vertical crop anchor, 0 = top")
    args = parser.parse_args()
    build_icon()
    build_screenshot(args.clip, args.at, args.anchor)
