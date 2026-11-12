/**
 * align.js —— 两张截图的几何对齐
 *
 * 三种对齐方式（对应需求 2：尺寸不一致时明确提示，并允许按比例对齐）：
 *
 * - contain  等比缩放（默认，推荐）：两图各自等比缩放进同一个画布，完整可见，
 *            不重叠的区域标记为“未覆盖”，热图用冷蓝色提示。
 * - overlap  原始尺寸 1:1 左上对齐：不缩放，仅比较两图实际重叠的像素。
 * - stretch  拉伸填满：两图都强制缩放到同一画布尺寸（会改变比例，仅作兜底）。
 *
 * 输出：
 *   canvasW/canvasH 对齐画布尺寸
 *   imageDataA/imageDataB 对齐后的 RGBA
 *   coverage  Uint8Array，1=两图都覆盖
 *   meta  对齐参数（写入报告）
 */

export const ALIGN_MODES = [
  { id: "contain", label: "等比缩放对齐（推荐）" },
  { id: "overlap", label: "原始尺寸左上对齐" },
  { id: "stretch", label: "拉伸填满（忽略比例）" },
];

/**
 * @param {HTMLImageElement|HTMLCanvasElement} imgA
 * @param {HTMLImageElement|HTMLCanvasElement} imgB
 * @param {'contain'|'overlap'|'stretch'} mode
 */
export function alignImages(imgA, imgB, mode) {
  const aw = imgA.naturalWidth || imgA.width;
  const ah = imgA.naturalHeight || imgA.height;
  const bw = imgB.naturalWidth || imgB.width;
  const bh = imgB.naturalHeight || imgB.height;
  const sizeMismatch = aw !== bw || ah !== bh;

  let canvasW;
  let canvasH;
  if (mode === "overlap") {
    canvasW = Math.min(aw, bw);
    canvasH = Math.min(ah, bh);
  } else {
    canvasW = Math.max(aw, bw);
    canvasH = Math.max(ah, bh);
  }

  const canvasA = document.createElement("canvas");
  const canvasB = document.createElement("canvas");
  canvasA.width = canvasB.width = canvasW;
  canvasA.height = canvasB.height = canvasH;
  const ctxA = canvasA.getContext("2d", { willReadFrequently: true });
  const ctxB = canvasB.getContext("2d", { willReadFrequently: true });
  ctxA.imageSmoothingQuality = "high";
  ctxB.imageSmoothingQuality = "high";

  // 覆盖掩码画布：分别在上面画不透明白色块，最后取交集
  const maskA = document.createElement("canvas");
  const maskB = document.createElement("canvas");
  maskA.width = maskB.width = canvasW;
  maskA.height = maskB.height = canvasH;
  const mctxA = maskA.getContext("2d", { willReadFrequently: true });
  const mctxB = maskB.getContext("2d", { willReadFrequently: true });

  const rectA = { x: 0, y: 0, w: aw, h: ah };
  const rectB = { x: 0, y: 0, w: bw, h: bh };

  if (mode === "contain") {
    fitContain(rectA, aw, ah, canvasW, canvasH);
    fitContain(rectB, bw, bh, canvasW, canvasH);
  } else if (mode === "stretch") {
    rectA.w = canvasW;
    rectA.h = canvasH;
    rectB.w = canvasW;
    rectB.h = canvasH;
  }
  // overlap：保持 1:1，rect 即原始尺寸，画布是较小尺寸，超出部分自然裁掉

  drawWithCoverage(ctxA, mctxA, imgA, rectA);
  drawWithCoverage(ctxB, mctxB, imgB, rectB);

  const imageDataA = ctxA.getImageData(0, 0, canvasW, canvasH);
  const imageDataB = ctxB.getImageData(0, 0, canvasW, canvasH);
  const maskDataA = mctxA.getImageData(0, 0, canvasW, canvasH).data;
  const maskDataB = mctxB.getImageData(0, 0, canvasW, canvasH).data;

  const coverage = new Uint8Array(canvasW * canvasH);
  for (let p = 0; p < coverage.length; p++) {
    coverage[p] = maskDataA[p * 4 + 3] > 0 && maskDataB[p * 4 + 3] > 0 ? 1 : 0;
  }

  const meta = {
    mode,
    sizeMismatch,
    originalSizeA: { width: aw, height: ah },
    originalSizeB: { width: bw, height: bh },
    canvasSize: { width: canvasW, height: canvasH },
    scaleA: { x: round4(rectA.w / aw), y: round4(rectA.h / ah) },
    scaleB: { x: round4(rectB.w / bw), y: round4(rectB.h / bh) },
    offsetA: { x: Math.round(rectA.x), y: Math.round(rectA.y) },
    offsetB: { x: Math.round(rectB.x), y: Math.round(rectB.y) },
    aspectA: round4(aw / ah),
    aspectB: round4(bw / bh),
  };

  return { imageDataA, imageDataB, coverage, canvasW, canvasH, meta };
}

function fitContain(rect, w, h, cw, ch) {
  const s = Math.min(cw / w, ch / h);
  rect.w = w * s;
  rect.h = h * s;
  rect.x = (cw - rect.w) / 2;
  rect.y = (ch - rect.h) / 2;
}

/**
 * 画图片并同步在掩码画布上画白色占位块。
 * 图片自身的透明像素也算“被覆盖”（内容存在，只是 alpha=0），
 * 所以掩码用矩形而不是 alpha 通道。
 */
function drawWithCoverage(ctx, maskCtx, img, rect) {
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
  maskCtx.fillStyle = "#fff";
  maskCtx.fillRect(
    Math.round(rect.x),
    Math.round(rect.y),
    Math.round(rect.w),
    Math.round(rect.h)
  );
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}
