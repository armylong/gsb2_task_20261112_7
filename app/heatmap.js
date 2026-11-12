/**
 * heatmap.js —— 差异热图渲染
 *
 * 色带经过 OKLCH 校验：明度 L 从 0.32 单调升到 0.89，
 * 差异大小主要由明度编码（色盲安全），色相红->橙->黄只做辅助。
 * 低差异暗红贴近深色背景自然“隐入”，高差异亮黄最醒目。
 */

/** 热图色带 stops（低 -> 高） */
export const HEAT_STOPS = [
  [0x5e, 0x17, 0x13], // 暗红：极小差异，贴近深色背景
  [0x8f, 0x24, 0x18],
  [0xc4, 0x3a, 0x2c], // 红
  [0xeb, 0x68, 0x34], // 橙红
  [0xf0, 0x8a, 0x1e], // 橙
  [0xf5, 0xb0, 0x1f], // 琥珀
  [0xfd, 0xd8, 0x35], // 亮黄：最大差异
];

/** 未覆盖区域（对齐后只有一张图有像素）的提示色：冷蓝，与暖色热图明确区分 */
export const UNCOVERED_COLOR = [58, 96, 168];

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

/** 取 0..1 差异值对应的热图 RGB */
export function heatColor(t) {
  if (t <= 0) return HEAT_STOPS[0];
  const scaled = Math.min(0.999999, t) * (HEAT_STOPS.length - 1);
  const idx = Math.floor(scaled);
  const frac = scaled - idx;
  const c0 = HEAT_STOPS[idx];
  const c1 = HEAT_STOPS[idx + 1];
  return [
    lerp(c0[0], c1[0], frac),
    lerp(c0[1], c1[1], frac),
    lerp(c0[2], c1[2], frac),
  ];
}

/**
 * 渲染热图到一个 ImageData。
 *
 * @param {Float32Array} diff      computeDiff 产出的逐像素差异（-1=未覆盖）
 * @param {Uint8Array} coverage
 * @param {object} opts
 * @param {number} opts.threshold       0..1，低于阈值的像素按 subThresholdMode 处理
 * @param {'dim'|'hide'} opts.subThresholdMode
 *        dim  = 低差异像素压暗后仍画出来（能看到整体画面结构）
 *        hide = 低差异像素完全透明（只保留改动区域）
 * @param {ImageData|null} opts.baseImage  对齐后的 A 图，dim 模式下作为暗色底
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 */
export function renderHeatmap(diff, coverage, opts) {
  const {
    threshold,
    subThresholdMode = "dim",
    baseImage = null,
  } = opts;
  const n = diff.length;
  const out = new ImageData(
    new Uint8ClampedArray(n * 4),
    opts.width,
    opts.height
  );
  const o = out.data;
  const base = baseImage ? baseImage.data : null;

  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const d = diff[p];
    if (d < 0 || !coverage[p]) {
      // 未覆盖区域：蓝色斜纹感靠半透明蓝色表达
      o[i] = UNCOVERED_COLOR[0];
      o[i + 1] = UNCOVERED_COLOR[1];
      o[i + 2] = UNCOVERED_COLOR[2];
      o[i + 3] = 150;
      continue;
    }
    if (d < threshold) {
      if (subThresholdMode === "hide") {
        o[i + 3] = 0;
        continue;
      }
      // dim：用原图做 22% 亮度的暗色底，保留画面结构但不抢热图注意力。
      // alpha 沿用原图（透明背景不能被填成不透明黑块）
      if (base) {
        o[i] = base[i] * 0.22;
        o[i + 1] = base[i + 1] * 0.22;
        o[i + 2] = base[i + 2] * 0.22;
        o[i + 3] = base[i + 3];
      } else {
        o[i + 3] = 0;
      }
      continue;
    }
    // 阈值以上：把 [threshold, 1] 重新拉伸到 [0,1]，让色带动态范围用满
    const t = Math.min(1, (d - threshold) / Math.max(1e-6, 1 - threshold));
    const [r, g, bl] = heatColor(t);
    o[i] = r;
    o[i + 1] = g;
    o[i + 2] = bl;
    o[i + 3] = 255;
  }

  return out;
}

/** 生成热图图例的渐变 CSS（用于 UI 图例条与报告） */
export function heatGradientCss() {
  const stops = HEAT_STOPS.map(
    (c, i) =>
      `rgb(${c[0]},${c[1]},${c[2]}) ${(i / (HEAT_STOPS.length - 1)) * 100}%`
  );
  return `linear-gradient(to right, ${stops.join(", ")})`;
}
