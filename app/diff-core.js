/**
 * diff-core.js —— 像素级差异计算核心（无 DOM 依赖，可在 Worker / Node 中运行）
 *
 * 设计目标（对应需求 3：透明通道、色彩空间、轻微整体亮度变化不能满屏误报）：
 *
 * 1. 透明通道：用 alpha 加权的合成差异，而不是直接比 RGBA 字节。
 *    - 两个像素都完全透明时差异为 0（透明背景不管底下存的是什么 RGB）；
 *    - 其余像素先按「预合成到中性灰背景」得到实际显示色，再比 RGB；
 *    - 再叠加一项 alpha 自身的变化，权重可配置，避免边缘 1px 的 alpha 抖动被放大。
 * 2. 亮度归一化（默认开启）：计算两图各自有效像素的平均亮度，按比例补偿
 *    整体亮度漂移（如引擎 tone mapping 微调），只保留结构性/颜色性差异。
 * 3. 噪点抑制：阈值以「归一化 0..1 差异」表达，低于阈值的像素不计入变化，
 *    但仍然保留原始差值，可随时调阈值实时重算，不需要重新解码图片。
 *
 * 色彩空间说明：浏览器 <img> 解码后 canvas 拿到的是 sRGB 8bit 值。
 * 计算加权欧氏距离前做 sRGB->linear 近似（gamma 2.2），使差值更接近
 * 人眼对明暗的感知，避免暗部噪点和亮部噪点产生同等量级的数值。
 */

/* eslint-disable no-restricted-globals */

/** sRGB 8bit -> 近似线性（查表，512 次计算 vs 每像素 pow） */
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const s = i / 255;
  SRGB_TO_LINEAR[i] = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * 计算两张已对齐 RGBA 位图的逐像素差异。
 *
 * @param {ImageData|{data:Uint8ClampedArray,width:number,height:number}} imgA
 * @param {ImageData|{data:Uint8ClampedArray,width:number,height:number}} imgB
 * @param {Uint8Array} coverage  每个像素是否两图都覆盖（1=有效，0=只有一张图有内容）
 * @param {object}   opts
 * @param {boolean}  opts.normalizeBrightness 亮度归一化开关
 * @param {number}   opts.alphaWeight  alpha 变化项权重，0..1（默认 0.35）
 * @returns {object} 同步环境返回结果对象；Worker 环境返回带 step()/result 的分片 runner。
 *   结果对象字段：
 *   diff: Float32Array,      // 每像素归一化差异 0..1；未覆盖像素为 -1
 *   meanDiff: number,        // 有效像素平均差异（原始，未按阈值过滤）
 *   maxDiff: number,
 *   meanLumaA: number, meanLumaB: number,
 *   brightnessFactor: number,// B 相对 A 的亮度补偿系数
 *   coveredPixels: number,
 *   totalPixels: number,
 *   width: number, height: number,
 */
export function computeDiff(imgA, imgB, coverage, opts) {
  const { width, height } = imgA;
  const n = width * height;
  const a = imgA.data;
  const b = imgB.data;
  const diff = new Float32Array(n);
  const { normalizeBrightness = true, alphaWeight = 0.35 } = opts || {};

  // ---- 第一步：统计两图有效像素的平均亮度（线性空间 Rec.709 权重） ----
  let sumLumaA = 0;
  let sumLumaB = 0;
  let coveredPixels = 0;
  for (let p = 0; p < n; p++) {
    if (!coverage[p]) continue;
    coveredPixels++;
    const i = p * 4;
    const alA = a[i + 3] / 255;
    const alB = b[i + 3] / 255;
    if (alA === 0 && alB === 0) continue;
    // 预合成到中性灰后的亮度（中性灰取 0.5 线性，约等于 sRGB 188）
    sumLumaA += premultLuma(a, i, alA);
    sumLumaB += premultLuma(b, i, alB);
  }
  const meanLumaA = coveredPixels ? sumLumaA / coveredPixels : 0;
  const meanLumaB = coveredPixels ? sumLumaB / coveredPixels : 0;
  // B 的亮度补偿系数：把 B 拉回 A 的量级。限制在 [0.5, 2]，防止极端图炸掉。
  let brightnessFactor = 1;
  if (normalizeBrightness && meanLumaA > 1e-4 && meanLumaB > 1e-4) {
    brightnessFactor = Math.min(2, Math.max(0.5, meanLumaA / meanLumaB));
  }

  // ---- 第二步：逐像素差异 ----
  let sumDiff = 0;
  let maxDiff = 0;
  const CHUNK = 1 << 16;
  let processed = 0;

  function processChunk(end) {
    for (; processed < end; processed++) {
      const p = processed;
      const i = p * 4;
      if (!coverage[p]) {
        diff[p] = -1;
        continue;
      }
      const alA = a[i + 3] / 255;
      const alB = b[i + 3] / 255;

      // 两边都全透明：显示上没有任何差异
      if (alA === 0 && alB === 0) {
        diff[p] = 0;
        continue;
      }

      // alpha 差异项（0..1）
      const alphaDelta = Math.abs(alA - alB);

      // 预合成到中性灰背景（模拟实际看到的颜色）
      const bg = 0.5;
      let rA = SRGB_TO_LINEAR[a[i]] * alA + bg * (1 - alA);
      let gA = SRGB_TO_LINEAR[a[i + 1]] * alA + bg * (1 - alA);
      let blA = SRGB_TO_LINEAR[a[i + 2]] * alA + bg * (1 - alA);
      let rB = SRGB_TO_LINEAR[b[i]] * alB + bg * (1 - alB);
      let gB = SRGB_TO_LINEAR[b[i + 1]] * alB + bg * (1 - alB);
      let blB = SRGB_TO_LINEAR[b[i + 2]] * alB + bg * (1 - alB);

      if (normalizeBrightness) {
        rB *= brightnessFactor;
        gB *= brightnessFactor;
        blB *= brightnessFactor;
      }

      // 加权欧氏距离（Rec.709 人眼权重），最大可能值约 1.414 -> 归一化
      const dr = rA - rB;
      const dg = gA - gB;
      const db = blA - blB;
      const colorDist = Math.sqrt(
        0.2126 * dr * dr + 0.7152 * dg * dg + 0.0722 * db * db
      );
      const colorDelta = Math.min(1, colorDist);

      // 合成差异：颜色项 + alpha 项。alpha 权重低，避免边缘抗锯齿抖动误报
      const d = Math.min(1, colorDelta * (1 - alphaWeight * 0.5) + alphaDelta * alphaWeight);
      diff[p] = d;
      sumDiff += d;
      if (d > maxDiff) maxDiff = d;
    }
  }

  // Worker（DedicatedWorkerGlobalScope）：返回分片 runner，由 worker-diff.js 驱动
  const inWorker =
    typeof self !== "undefined" &&
    typeof self.postMessage === "function" &&
    typeof window === "undefined";
  if (inWorker) {
    return {
      diff,
      step(next = Math.min(processed + CHUNK, n)) {
        processChunk(next);
        return { done: processed >= n, processed, total: n };
      },
      get result() {
        return finalize();
      },
    };
  }

  // 主线程 / Node：同步跑完
  processChunk(n);
  return finalize();

  function finalize() {
    return {
      diff,
      meanDiff: coveredPixels ? sumDiff / coveredPixels : 0,
      maxDiff,
      meanLumaA,
      meanLumaB,
      brightnessFactor,
      coveredPixels,
      totalPixels: n,
      width,
      height,
    };
  }
}

/** 预合成到中性灰后的线性亮度 */
function premultLuma(data, i, alpha) {
  const bg = 0.5;
  const r = SRGB_TO_LINEAR[data[i]] * alpha + bg * (1 - alpha);
  const g = SRGB_TO_LINEAR[data[i + 1]] * alpha + bg * (1 - alpha);
  const b = SRGB_TO_LINEAR[data[i + 2]] * alpha + bg * (1 - alpha);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 基于已算好的 diff 数组做阈值统计（调阈值时零成本重算，不需要重解码）。
 *
 * @param {Float32Array} diff
 * @param {Uint8Array} coverage
 * @param {number} threshold 0..1
 * @param {{x:number,y:number,w:number,h:number,width:number,height:number}} [roi]
 *        roi 坐标基于对齐后的画布；不传则统计全图
 * @returns {{
 *   totalPixels:number, coveredPixels:number, changedPixels:number,
 *   changedRatio:number, meanDiff:number, maxDiff:number,
 *   band:{range:[number,number],count:number,ratio:number}[]
 * }}
 */
export function computeStats(diff, coverage, threshold, roi) {
  const n = diff.length;
  let x0 = 0;
  let y0 = 0;
  let x1 = Infinity;
  let y1 = Infinity;
  let width = null;
  if (roi) {
    ({ width } = roi);
    x0 = Math.max(0, roi.x);
    y0 = Math.max(0, roi.y);
    x1 = roi.x + roi.w;
    y1 = roi.y + roi.h;
  }

  let covered = 0;
  let changed = 0;
  let sum = 0;
  let max = 0;
  const edges = [0.02, 0.05, 0.1, 0.2, 0.4, 0.7, 1.01];
  const band = edges.map((e, idx) => ({
    range: [idx === 0 ? 0 : edges[idx - 1], e],
    count: 0,
    ratio: 0,
  }));

  for (let p = 0; p < n; p++) {
    const d = diff[p];
    if (d < 0 || !coverage[p]) continue;
    if (roi) {
      const px = p % width;
      const py = (p / width) | 0;
      if (px < x0 || px >= x1 || py < y0 || py >= y1) continue;
    }
    covered++;
    sum += d;
    if (d > max) max = d;
    if (d >= threshold) {
      changed++;
      for (let k = 0; k < edges.length; k++) {
        const lo = k === 0 ? 0 : edges[k - 1];
        if (d >= lo && d < edges[k]) {
          band[k].count++;
          break;
        }
      }
    }
  }

  for (const bnd of band) bnd.ratio = covered ? bnd.count / covered : 0;

  return {
    totalPixels: n,
    coveredPixels: covered,
    changedPixels: changed,
    changedRatio: covered ? changed / covered : 0,
    meanDiff: covered ? sum / covered : 0,
    maxDiff: max,
    band,
  };
}

// Node 环境导出（Worker 用 ESM import，浏览器 <script type=module> 同理）
if (typeof module !== "undefined" && module.exports) {
  module.exports = { computeDiff, computeStats, SRGB_TO_LINEAR };
}
