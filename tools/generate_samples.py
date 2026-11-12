#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
示例截图生成器（零依赖，仅使用 Python 标准库）。

生成两组同场景、不同版本的游戏截图，放到 samples/ 目录：

  group1_gameplay/   游戏实机画面（不透明 PNG）
    scene_a_v1.png   旧版本
    scene_b_v2.png   新版本：角色位移、新增敌人、平台变色、HUD 变化、
                     云朵移动，并且整体亮度轻微抬升 + 轻微随机噪点
                     （用来验证亮度补偿 / 噪点抑制不会满屏误报）

  group2_ui/         UI 弹窗画面（带透明通道，且两张尺寸不一致）
    panel_a_v1.png   360x240
    panel_b_v2.png   380x252，内容改动 + 尺寸不同（用来验证尺寸提示与按比例对齐）

运行：python3 tools/generate_samples.py
"""
from __future__ import annotations

import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "samples")


# --------------------------------------------------------------------------- #
# 极简 PNG 编码器（RGBA，8bit）
# --------------------------------------------------------------------------- #
class Canvas:
    def __init__(self, width: int, height: int, fill=(0, 0, 0, 0)):
        self.w = width
        self.h = height
        self.px = bytearray(fill) * (width * height)

    def set(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h:
            i = (y * self.w + x) * 4
            self.px[i:i + 4] = bytes(c)

    def fill_rect(self, x0, y0, x1, y1, c):
        x0, y0 = max(0, int(x0)), max(0, int(y0))
        x1, y1 = min(self.w, int(x1)), min(self.h, int(y1))
        for y in range(y0, y1):
            row = y * self.w * 4
            for x in range(x0, x1):
                i = row + x * 4
                self.px[i:i + 4] = bytes(c)

    def circle(self, cx, cy, r, c):
        r2 = r * r
        for y in range(int(cy - r), int(cy + r) + 1):
            for x in range(int(cx - r), int(cx + r) + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r2:
                    self.set(x, y, c)

    def line(self, x0, y0, x1, y1, c, thick=1):
        steps = max(abs(x1 - x0), abs(y1 - y0), 1)
        for k in range(steps + 1):
            t = k / steps
            x = round(x0 + (x1 - x0) * t)
            y = round(y0 + (y1 - y0) * t)
            for dy in range(thick):
                for dx in range(thick):
                    self.set(x + dx, y + dy, c)

    def save_png(self, path: str):
        raw = bytearray()
        stride = self.w * 4
        for y in range(self.h):
            raw.append(0)  # filter type 0: None
            raw.extend(self.px[y * stride:(y + 1) * stride])
        compressed = zlib.compress(bytes(raw), 9)

        def chunk(tag: bytes, data: bytes) -> bytes:
            return (
                struct.pack(">I", len(data))
                + tag
                + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
            )

        ihdr = struct.pack(">IIBBBBB", self.w, self.h, 8, 6, 0, 0, 0)
        png = b"\x89PNG\r\n\x1a\n"
        png += chunk(b"IHDR", ihdr)
        png += chunk(b"IDAT", compressed)
        png += chunk(b"IEND", b"")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(png)
        print(f"  写出 {os.path.relpath(path, ROOT)}  ({self.w}x{self.h})")


# --------------------------------------------------------------------------- #
# 5x7 点阵字体（HUD 文本用）
# --------------------------------------------------------------------------- #
FONT = {
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
    ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
    " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
}


def draw_text(cv: Canvas, text: str, x: int, y: int, c, scale: int = 2):
    cx = x
    for ch in text.upper():
        glyph = FONT.get(ch, FONT[" "])
        for row, bits in enumerate(glyph):
            for col, bit in enumerate(bits):
                if bit == "1":
                    cv.fill_rect(
                        cx + col * scale,
                        y + row * scale,
                        cx + (col + 1) * scale,
                        y + (row + 1) * scale,
                        c,
                    )
        cx += 6 * scale


def draw_heart(cv: Canvas, x, y, c, s=2):
    for row in range(6):
        for col in range(7):
            v = (
                (row == 0 and col in (1, 2, 4, 5))
                or (row in (1, 2))
                or (row == 3 and 1 <= col <= 5)
                or (row == 4 and 2 <= col <= 4)
                or (row == 5 and col == 3)
            )
            if v:
                cv.fill_rect(x + col * s, y + row * s, x + (col + 1) * s, y + (row + 1) * s, c)


def draw_coin(cv: Canvas, x, y, c, s=2):
    cv.circle(x + 4 * s, y + 4 * s, 4 * s, c)
    cv.fill_rect(x + 3 * s, y + 1 * s, x + 5 * s, y + 7 * s, (255, 246, 200, 255))


def rounded_panel(cv: Canvas, x0, y0, x1, y1, r, fill, border):
    # 圆角矩形：先画主体，再把四个角的外部清掉，然后描边
    cv.fill_rect(x0 + r, y0, x1 - r, y1, fill)
    cv.fill_rect(x0, y0 + r, x1, y1 - r, fill)
    for cx, cy in ((x0 + r, y0 + r), (x1 - r - 1, y0 + r),
                   (x0 + r, y1 - r - 1), (x1 - r - 1, y1 - r - 1)):
        for yy in range(cy - r, cy + r + 1):
            for xx in range(cx - r, cx + r + 1):
                if (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r:
                    cv.set(xx, yy, fill)
    # 描边
    cv.line(x0 + r, y0, x1 - r, y0, border)
    cv.line(x0 + r, y1 - 1, x1 - r, y1 - 1, border)
    cv.line(x0, y0 + r, x0, y1 - r, border)
    cv.line(x1 - 1, y0 + r, x1 - 1, y1 - r, border)
    for cx, cy in ((x0 + r, y0 + r), (x1 - r - 1, y0 + r),
                   (x0 + r, y1 - r - 1), (x1 - r - 1, y1 - r - 1)):
        for a in range(0, 91):
            import math
            ang = math.radians(a)
            sx = cx + (r if cx > (x0 + x1) // 2 else -r)
            sy = cy + (r if cy > (y0 + y1) // 2 else -r)
            px = round(sx + (r - 0.5) * math.cos(ang) * (1 if cx > (x0 + x1) // 2 else -1))
            py = round(sy + (r - 0.5) * math.sin(ang) * (1 if cy > (y0 + y1) // 2 else -1))
            cv.set(px, py, border)


# --------------------------------------------------------------------------- #
# 第一组：游戏实机画面
# --------------------------------------------------------------------------- #
GW, GH = 520, 300
SKY_TOP = (74, 125, 205, 255)
SKY_BOT = (168, 206, 240, 255)


def draw_sky(cv: Canvas):
    for y in range(GH):
        t = y / (GH - 1)
        c = tuple(round(SKY_TOP[i] + (SKY_BOT[i] - SKY_TOP[i]) * t) for i in range(3)) + (255,)
        cv.fill_rect(0, y, GW, y + 1, c)


def draw_cloud(cv: Canvas, x, y, c=(255, 255, 255, 255)):
    cv.circle(x, y, 14, c)
    cv.circle(x + 16, y - 6, 17, c)
    cv.circle(x + 36, y, 13, c)
    cv.fill_rect(x - 12, y, x + 48, y + 12, c)


def draw_player(cv: Canvas, x, y):
    # 身体
    cv.fill_rect(x, y, x + 22, y + 26, (214, 69, 65, 255))
    # 头
    cv.fill_rect(x + 3, y - 14, x + 19, y, (247, 206, 160, 255))
    # 帽子
    cv.fill_rect(x + 1, y - 18, x + 21, y - 12, (60, 92, 180, 255))
    cv.fill_rect(x - 4, y - 14, x + 25, y - 11, (60, 92, 180, 255))
    # 眼睛
    cv.set(x + 13, y - 8, (40, 40, 40, 255))
    # 腿
    cv.fill_rect(x + 2, y + 26, x + 9, y + 36, (52, 60, 96, 255))
    cv.fill_rect(x + 13, y + 26, x + 20, y + 36, (52, 60, 96, 255))


def draw_enemy(cv: Canvas, x, y):
    cv.fill_rect(x, y, x + 24, y + 20, (139, 78, 190, 255))
    cv.set(x + 6, y + 7, (255, 255, 255, 255))
    cv.set(x + 17, y + 7, (255, 255, 255, 255))
    cv.set(x + 6, y + 7, (20, 20, 20, 255))
    cv.set(x + 17, y + 7, (20, 20, 20, 255))
    cv.line(x + 2, y + 20, x - 2, y + 28, (90, 50, 130, 255), 2)
    cv.line(x + 22, y + 20, x + 26, y + 28, (90, 50, 130, 255), 2)


def draw_hud(cv: Canvas, hearts: int, coins: int):
    cv.fill_rect(0, 0, GW, 30, (18, 22, 34, 255))
    for i in range(3):
        if i < hearts:
            draw_heart(cv, 12 + i * 20, 8, (232, 74, 96, 255))
        else:
            draw_heart(cv, 12 + i * 20, 8, (70, 76, 92, 255))
    draw_coin(cv, GW - 120, 9, (240, 196, 48, 255))
    draw_text(cv, "X " + str(coins), GW - 100, 9, (255, 255, 255, 255), scale=2)


def gameplay_base(cv: Canvas):
    draw_sky(cv)
    cv.circle(440, 56, 26, (255, 226, 120, 255))
    # 远山：一排互相重叠的实心三角（保持全部不透明）
    peaks = [(30, 74), (120, 96), (210, 66), (300, 88), (400, 70), (500, 92), (580, 64)]
    base_y = 232
    for px, ph in peaks:
        for k in range(ph):
            y = base_y - ph + k
            half = max(1, round((k + 1) * 52 / ph))
            t = k / ph
            c = (round(92 + 34 * t), round(146 + 30 * t), round(104 + 32 * t), 255)
            cv.fill_rect(px - half, y, px + half + 1, y + 1, c)
        # 山顶浅色
        for k in range(10):
            y = base_y - ph + k
            half = max(1, round((k + 1) * 52 / ph))
            cv.fill_rect(px - half, y, px + half + 1, y + 1, (150, 196, 138, 255))
    # 地面
    cv.fill_rect(0, 230, GW, GH, (92, 158, 78, 255))
    cv.fill_rect(0, 230, GW, 236, (126, 190, 96, 255))
    for x in range(0, GW, 26):
        cv.fill_rect(x + 4, 252, x + 10, 258, (72, 130, 60, 255))


def make_gameplay(version: str) -> Canvas:
    # 实机截图不允许出现透明区域：用不透明黑底初始化
    cv = Canvas(GW, GH, (0, 0, 0, 255))
    gameplay_base(cv)
    if version == "v1":
        draw_cloud(cv, 70, 64)
        # 木平台
        cv.fill_rect(120, 188, 260, 204, (168, 116, 62, 255))
        cv.fill_rect(120, 188, 260, 192, (196, 144, 84, 255))
        draw_player(cv, 150, 152)
        draw_hud(cv, hearts=3, coins=12)
    else:
        # v2：云移动、平台改成石质、玩家右移、新增敌人、HUD 改动
        draw_cloud(cv, 200, 58)
        cv.fill_rect(120, 188, 260, 204, (120, 126, 140, 255))
        cv.fill_rect(120, 188, 260, 192, (150, 156, 170, 255))
        for x in range(126, 256, 18):
            cv.set(x, 196, (96, 100, 112, 255))
        draw_player(cv, 196, 152)
        draw_enemy(cv, 330, 202)
        draw_hud(cv, hearts=2, coins=17)
    return cv


def add_grain_and_gain(cv: Canvas, seed: int, gain: int):
    # 确定性伪随机噪点（±2），模拟截图编解码噪声；gain 模拟整体亮度变化
    state = seed
    total = cv.w * cv.h * 4
    for i in range(total):
        channel = i % 4
        if channel == 3:
            continue
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        noise = (state % 5) - 2  # -2..2
        v = cv.px[i]
        if gain:
            v = round(v * (1 + gain / 100.0))
        cv.px[i] = max(0, min(255, v + noise))


# --------------------------------------------------------------------------- #
# 第二组：带透明通道的 UI 弹窗（两张尺寸不同）
# --------------------------------------------------------------------------- #
def make_panel(version: str) -> Canvas:
    if version == "v1":
        cv = Canvas(360, 240)
        x0, y0, x1, y1 = 8, 8, 352, 232
    else:
        cv = Canvas(380, 252)
        x0, y0, x1, y1 = 10, 10, 370, 242

    panel_fill = (30, 34, 48, 245)
    panel_border = (120, 134, 170, 255)
    rounded_panel(cv, x0, y0, x1, y1, 14, panel_fill, panel_border)

    # 标题栏
    cv.fill_rect(x0 + 14, y0 + 14, x1 - 14, y0 + 44, (52, 60, 86, 255))
    if version == "v1":
        draw_text(cv, "SETTINGS", x0 + 26, y0 + 20, (236, 240, 250, 255), scale=2)
    else:
        draw_text(cv, "OPTIONS", x0 + 26, y0 + 20, (236, 240, 250, 255), scale=2)
        # 新增的红色提示角标
        cv.circle(x1 - 28, y0 + 22, 9, (226, 74, 84, 255))
        draw_text(cv, "3", x1 - 31, y0 + 16, (255, 255, 255, 255), scale=2)

    # 两行设置项
    labels = ("MUSIC", "SFX") if version == "v1" else ("MUSIC", "VOICE")
    for idx, label in enumerate(labels):
        ry = y0 + 66 + idx * 52
        draw_text(cv, label, x0 + 26, ry + 6, (200, 208, 226, 255), scale=2)
        # 滑块槽
        cv.fill_rect(x0 + 130, ry + 8, x1 - 26, ry + 18, (66, 74, 98, 255))
        pct = 0.7 if version == "v1" else (0.8 if idx == 0 else 0.45)
        knob_x = round(x0 + 130 + (x1 - 26 - (x0 + 130)) * pct)
        track_c = (94, 168, 255, 255) if version == "v1" else (110, 214, 160, 255)
        cv.fill_rect(x0 + 130, ry + 8, knob_x, ry + 18, track_c)
        cv.circle(knob_x, ry + 13, 8, (245, 248, 255, 255))

    if version == "v2":
        # 新增第三行输入框
        ry = y0 + 170
        draw_text(cv, "NAME", x0 + 26, ry + 6, (200, 208, 226, 255), scale=2)
        cv.fill_rect(x0 + 130, ry, x1 - 26, ry + 26, (18, 22, 34, 255))
        cv.line(x0 + 130, ry, x1 - 26, ry, (110, 214, 160, 255))
        cv.line(x0 + 130, ry + 25, x1 - 26, ry + 25, (110, 214, 160, 255))
        draw_text(cv, "HERO-02", x0 + 138, ry + 7, (160, 220, 190, 255), scale=2)

    # 底部按钮
    btn_y1, btn_y2 = y1 - 44, y1 - 14
    if version == "v1":
        cv.fill_rect(x1 - 190, btn_y1, x1 - 104, btn_y2, (70, 80, 110, 255))
        draw_text(cv, "CANCEL", x1 - 180, btn_y1 + 8, (230, 234, 244, 255), scale=2)
        cv.fill_rect(x1 - 92, btn_y1, x1 - 14, btn_y2, (94, 168, 255, 255))
        draw_text(cv, "OK", x1 - 74, btn_y1 + 8, (255, 255, 255, 255), scale=2)
    else:
        # 按钮配色调换 + 文案变化
        cv.fill_rect(x1 - 200, btn_y1, x1 - 108, btn_y2, (70, 80, 110, 255))
        draw_text(cv, "BACK", x1 - 188, btn_y1 + 8, (230, 234, 244, 255), scale=2)
        cv.fill_rect(x1 - 96, btn_y1, x1 - 14, btn_y2, (110, 214, 160, 255))
        draw_text(cv, "SAVE", x1 - 76, btn_y1 + 8, (20, 40, 30, 255), scale=2)
    return cv


def main():
    print("生成示例截图 ->", os.path.relpath(OUT_DIR, ROOT) + "/")
    g1 = os.path.join(OUT_DIR, "group1_gameplay")
    a = make_gameplay("v1")
    a.save_png(os.path.join(g1, "scene_a_v1.png"))
    b = make_gameplay("v2")
    add_grain_and_gain(b, seed=20261112, gain=8)  # 整体 +8% 亮度 + 噪点
    b.save_png(os.path.join(g1, "scene_b_v2.png"))

    g2 = os.path.join(OUT_DIR, "group2_ui")
    p1 = make_panel("v1")
    p1.save_png(os.path.join(g2, "panel_a_v1.png"))
    p2 = make_panel("v2")
    p2.save_png(os.path.join(g2, "panel_b_v2.png"))
    print("完成。")


if __name__ == "__main__":
    main()
