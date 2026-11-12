/**
 * report.js —— 检查报告导出
 *
 * 两种产物（对应需求 4 与“结果能导出成 png 和 json”）：
 *
 * 1. JSON 报告：完整保留阈值、对齐方式、图片尺寸、差异像素占比、
 *    差异强度分档、每个 ROI 的独立统计、处理日志。
 * 2. PNG 报告：把 A/B 缩略图、热图、关键指标、ROI 表格合成到一张图片里。
 */
import { HEAT_STOPS, UNCOVERED_COLOR } from "./heatmap.js";

const TOOL_NAME = "game-version-diff-checker";
const TOOL_VERSION = "1.0.0";

/**
 * 组装 JSON 报告对象。
 */
export function buildJsonReport(state) {
  const {
    imageInfo,
    alignMeta,
    settings,
    stats,
    rois,
    heatSnapshot,
    logs,
    timings,
  } = state;

  return {
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    exportedAt: new Date().toISOString(),
    images: {
      imageA: {
        fileName: imageInfo.a.fileName,
        width: imageInfo.a.width,
        height: imageInfo.a.height,
        hasAlpha: imageInfo.a.hasAlpha,
        colorSpace: imageInfo.a.colorSpace || "sRGB(8bit)",
        loadDurationMs: timings.loadA,
      },
      imageB: {
        fileName: imageInfo.b.fileName,
        width: imageInfo.b.width,
        height: imageInfo.b.height,
        hasAlpha: imageInfo.b.hasAlpha,
        colorSpace: imageInfo.b.colorSpace || "sRGB(8bit)",
        loadDurationMs: timings.loadB,
      },
      sizeMismatch: alignMeta.sizeMismatch,
    },
    alignment: {
      mode: alignMeta.mode,
      modeLabel: alignMeta.modeLabel,
      canvasSize: alignMeta.canvasSize,
      scaleA: alignMeta.scaleA,
      scaleB: alignMeta.scaleB,
      offsetA: alignMeta.offsetA,
      offsetB: alignMeta.offsetB,
      aspectA: alignMeta.aspectA,
      aspectB: alignMeta.aspectB,
    },
    settings: {
      threshold: settings.threshold,
      thresholdPercent: `${(settings.threshold * 100).toFixed(1)}%`,
      normalizeBrightness: settings.normalizeBrightness,
      brightnessFactor: stats.brightnessFactor,
      alphaWeight: settings.alphaWeight,
      subThresholdMode: settings.subThresholdMode,
    },
    stats: {
      totalPixels: stats.totalPixels,
      coveredPixels: stats.coveredPixels,
      uncoveredPixels: stats.totalPixels - stats.coveredPixels,
      changedPixels: stats.changedPixels,
      changedRatio: round6(stats.changedRatio),
      changedPercent: `${(stats.changedRatio * 100).toFixed(2)}%`,
      meanDiff: round6(stats.meanDiff),
      maxDiff: round6(stats.maxDiff),
      intensityBands: stats.band.map((b) => ({
        range: [b.range[0], b.range[1]],
        count: b.count,
        ratio: round6(b.ratio),
      })),
    },
    regions: rois.map((r) => ({
      id: r.id,
      label: r.label,
      rect: { x: r.x, y: r.y, width: r.w, height: r.h },
      stats: {
        coveredPixels: r.stats.coveredPixels,
        changedPixels: r.stats.changedPixels,
        changedRatio: round6(r.stats.changedRatio),
        changedPercent: `${(r.stats.changedRatio * 100).toFixed(2)}%`,
        meanDiff: round6(r.stats.meanDiff),
        maxDiff: round6(r.stats.maxDiff),
      },
    })),
    heatmap: {
      colorStops: HEAT_STOPS.map((c) => rgbHex(c)),
      uncoveredColor: rgbHex(UNCOVERED_COLOR),
      encoding: "明度单调递增（红->橙->黄），阈值以下像素按 subThresholdMode 处理",
    },
    timings: {
      loadImageA_ms: timings.loadA,
      loadImageB_ms: timings.loadB,
      align_ms: timings.align,
      diffCompute_ms: timings.diff,
      total_ms: timings.total,
    },
    processingLogs: logs,
  };
}

/** 触发浏览器下载（Blob URL） */
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadJson(report, fileName) {
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: "application/json",
  });
  downloadBlob(blob, fileName);
}

/**
 * 合成 PNG 报告。
 * @param {object} state 与 buildJsonReport 相同的状态
 * @param {HTMLCanvasElement} viewCanvas 当前视图画布（A/B/热图任一，作为主视觉）
 */
export async function renderPngReport(state, viewCanvas) {
  const W = 1280;
  const pad = 36;
  const headerH = 118;
  const thumbH = 250;
  const statsH = 168;
  const roiH = Math.max(70, state.rois.length * 34 + 56);
  const footerH = 70;
  const H = pad * 2 + headerH + thumbH + statsH + roiH + footerH;

  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d");

  // 背景
  ctx.fillStyle = "#14161a";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#1d2026";
  roundRect(ctx, pad, pad, W - pad * 2, H - pad * 2, 14);
  ctx.fill();

  let y = pad + 26;

  // ---- 标题区 ----
  ctx.fillStyle = "#f0efec";
  ctx.font = "600 26px system-ui, -apple-system, sans-serif";
  ctx.fillText("游戏版本画面差异检查报告", pad + 28, y);
  ctx.fillStyle = "#898781";
  ctx.font = "13px system-ui, -apple-system, sans-serif";
  ctx.fillText(
    `${TOOL_NAME} v${TOOL_VERSION} · 导出时间 ${new Date().toLocaleString("zh-CN")}`,
    pad + 28,
    y + 24
  );
  const metaText =
    `阈值 ${(state.settings.threshold * 100).toFixed(1)}% · ` +
    `对齐 ${state.alignMeta.modeLabel} · ` +
    `亮度补偿 ${state.settings.normalizeBrightness ? "开" : "关"}`;
  ctx.textAlign = "right";
  ctx.fillStyle = "#c3c2b7";
  ctx.font = "14px system-ui, -apple-system, sans-serif";
  ctx.fillText(metaText, W - pad - 28, y + 8);
  ctx.textAlign = "left";
  y += headerH - 20;

  // ---- 三张缩略图：A / B / 当前视图 ----
  const thumbW = (W - pad * 2 - 56 - 2 * 20) / 3;
  const thumbs = [
    { title: `A · ${state.imageInfo.a.fileName}`, source: state.canvasA },
    { title: `B · ${state.imageInfo.b.fileName}`, source: state.canvasB },
    { title: "当前视图（热图/叠加/滑块）", source: viewCanvas },
  ];
  thumbs.forEach((t, idx) => {
    const x = pad + 28 + idx * (thumbW + 20);
    ctx.fillStyle = "#262a32";
    roundRect(ctx, x, y, thumbW, thumbH, 10);
    ctx.fill();
    drawCover(ctx, t.source, x + 8, y + 8, thumbW - 16, thumbH - 40);
    ctx.fillStyle = "#c3c2b7";
    ctx.font = "12px system-ui, -apple-system, sans-serif";
    ctx.fillText(truncate(t.title, 42), x + 10, y + thumbH - 12);
  });
  y += thumbH + 22;

  // ---- 指标区 ----
  const cards = [
    { label: "差异像素占比", value: pct(state.stats.changedRatio), accent: true },
    { label: "差异像素数", value: String(state.stats.changedPixels) },
    { label: "有效像素数", value: String(state.stats.coveredPixels) },
    { label: "平均差异强度", value: state.stats.meanDiff.toFixed(4) },
    { label: "最大差异强度", value: state.stats.maxDiff.toFixed(4) },
    {
      label: "未覆盖像素",
      value: String(state.stats.totalPixels - state.stats.coveredPixels),
    },
  ];
  const cardW = (W - pad * 2 - 56 - 5 * 12) / 6;
  cards.forEach((c, idx) => {
    const x = pad + 28 + idx * (cardW + 12);
    ctx.fillStyle = "#262a32";
    roundRect(ctx, x, y, cardW, 96, 10);
    ctx.fill();
    ctx.fillStyle = c.accent ? "#f5b01f" : "#f0efec";
    ctx.font = "600 22px system-ui, -apple-system, sans-serif";
    ctx.fillText(c.value, x + 14, y + 42);
    ctx.fillStyle = "#898781";
    ctx.font = "12px system-ui, -apple-system, sans-serif";
    ctx.fillText(c.label, x + 14, y + 70);
  });
  y += 108;

  // 热图图例
  const grad = ctx.createLinearGradient(pad + 28, y, pad + 328, y);
  HEAT_STOPS.forEach((c, i) => {
    grad.addColorStop(i / (HEAT_STOPS.length - 1), rgbHex(c));
  });
  ctx.fillStyle = grad;
  roundRect(ctx, pad + 28, y, 300, 16, 8);
  ctx.fill();
  ctx.fillStyle = "#898781";
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  ctx.fillText(`低 ${(state.settings.threshold * 100).toFixed(1)}%`, pad + 28, y + 32);
  ctx.textAlign = "right";
  ctx.fillText("高 100%", pad + 328, y + 32);
  ctx.textAlign = "left";
  ctx.fillStyle = rgbHex(UNCOVERED_COLOR);
  ctx.fillRect(pad + 380, y, 16, 16);
  ctx.fillStyle = "#898781";
  ctx.fillText("未覆盖区域（仅一张图有内容）", pad + 404, y + 13);
  y += 52;

  // ---- ROI 表格 ----
  ctx.fillStyle = "#f0efec";
  ctx.font = "600 15px system-ui, -apple-system, sans-serif";
  ctx.fillText("区域统计（ROI）", pad + 28, y);
  y += 10;
  if (state.rois.length === 0) {
    ctx.fillStyle = "#898781";
    ctx.font = "13px system-ui, -apple-system, sans-serif";
    ctx.fillText("未框选区域（在视图中拖拽即可创建 ROI）", pad + 28, y + 22);
    y += 34;
  } else {
    state.rois.forEach((r, idx) => {
      const yy = y + 22 + idx * 34;
      ctx.fillStyle = idx % 2 ? "#20242c" : "#262a32";
      roundRect(ctx, pad + 28, yy - 14, W - pad * 2 - 56, 28, 6);
      ctx.fill();
      ctx.fillStyle = "#f0efec";
      ctx.font = "13px ui-monospace, monospace";
      const txt =
        `#${r.id} ${r.label}  ` +
        `[x:${r.x} y:${r.y} w:${r.w} h:${r.h}]  ` +
        `差异 ${pct(r.stats.changedRatio)} (${r.stats.changedPixels}px)  ` +
        `均值 ${r.stats.meanDiff.toFixed(4)}  最大 ${r.stats.maxDiff.toFixed(4)}`;
      ctx.fillText(txt, pad + 40, yy + 4);
    });
    y += 22 + state.rois.length * 34;
  }

  // ---- 页脚 ----
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.beginPath();
  ctx.moveTo(pad + 28, H - pad - 34);
  ctx.lineTo(W - pad - 28, H - pad - 34);
  ctx.stroke();
  ctx.fillStyle = "#898781";
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  ctx.fillText(
    `A:${state.imageInfo.a.width}x${state.imageInfo.a.height}  ` +
      `B:${state.imageInfo.b.width}x${state.imageInfo.b.height}  ` +
      `画布:${state.alignMeta.canvasSize.width}x${state.alignMeta.canvasSize.height}  ` +
      `处理耗时 ${state.timings.total}ms`,
    pad + 28,
    H - pad - 12
  );

  return cv;
}

// ----------------------------- 小工具 ----------------------------- //

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCover(ctx, source, x, y, w, h) {
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  const s = Math.min(w / sw, h / sh);
  const dw = sw * s;
  const dh = sh * s;
  ctx.drawImage(source, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function pct(v) {
  return `${(v * 100).toFixed(2)}%`;
}

function rgbHex(c) {
  return (
    "#" +
    c
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}
