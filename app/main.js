/**
 * main.js —— 画面差异检查工具主控
 * 模块职责：
 *   导入状态（每张图独立） -> 对齐 -> Worker 差异计算 -> 视图渲染
 *   滑块 / 叠加 / 热图 三视图 + ROI + 缩放平移 + 像素检查器 + 报告导出
 */
import { alignImages, ALIGN_MODES } from "./align.js";
import { computeStats } from "./diff-core.js";
import { renderHeatmap, heatGradientCss } from "./heatmap.js";
import { buildJsonReport, downloadJson, renderPngReport, downloadBlob } from "./report.js";

// ----------------------------- 全局状态 ----------------------------- //
const state = {
  imgA: null,            // HTMLImageElement
  imgB: null,
  infoA: null,           // {fileName,width,height,hasAlpha,colorSpace}
  infoB: null,
  aligned: null,         // alignImages 输出
  diffResult: null,      // computeDiff 输出
  heatImage: null,       // 当前热图 ImageData
  view: "slider",        // slider | overlay | heat
  threshold: 0.08,
  normalizeBrightness: true,
  alphaAware: true,
  alphaWeight: 0.35,
  subThresholdMode: "dim",
  overlayOpacity: 0.5,
  split: 0.5,
  rois: [],
  nextRoiId: 1,
  zoom: 1,
  pan: { x: 0, y: 0 },
  logs: [],
  timings: { loadA: null, loadB: null, align: null, diff: null, total: null },
  jobSeq: 0,
};

const $ = (id) => document.getElementById(id);
const viewport = $("viewport");
const stage = $("stage");
const canvas = $("view-canvas");
const ctx = canvas.getContext("2d");
const roiLayer = $("roi-layer");
const splitHandle = $("split-handle");

// ----------------------------- 初始化 ----------------------------- //
function init() {
  document.querySelector(".legend-bar").style.background = heatGradientCss();
  bindImport("a");
  bindImport("b");
  bindControls();
  bindViewport();
  bindExport();
  $("btn-samples").addEventListener("click", loadSamples);
  $("btn-samples-2").addEventListener("click", loadSamples);
  log("工具就绪，请导入两张截图，或点击“载入内置示例”", "ok");
}

// ----------------------------- 图片导入 ----------------------------- //
function bindImport(which) {
  const input = $(`file-${which}`);
  const drop = $(`drop-${which}`);
  input.addEventListener("change", () => {
    if (input.files[0]) loadImageFile(which, input.files[0]);
  });
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("dragover");
    })
  );
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) loadImageFile(which, f);
  });
}

function setCardStatus(which, kind, text) {
  const el = $(`status-${which}`);
  el.innerHTML = `<span class="dot ${kind}"></span>${text}`;
}

/**
 * 每张图独立走完整的 读取 -> 解码 -> 元信息 流程，状态分别更新（需求 6）。
 */
function loadImageFile(which, file) {
  const t0 = performance.now();
  setCardStatus(which, "working", `读取中… 0%`);
  log(`图 ${which.toUpperCase()}：开始读取 ${file.name}（${formatBytes(file.size)}）`);

  const reader = new FileReader();
  reader.onprogress = (e) => {
    if (e.lengthComputable) {
      setCardStatus(which, "working", `读取中… ${((e.loaded / e.total) * 100).toFixed(0)}%`);
    }
  };
  reader.onerror = () => {
    setCardStatus(which, "error", "读取失败");
    log(`图 ${which.toUpperCase()}：文件读取失败`, "err");
  };
  reader.onload = () => {
    setCardStatus(which, "working", "解码中…");
    const blobUrl = URL.createObjectURL(new Blob([reader.result], { type: file.type }));
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(blobUrl);
      const info = inspectImage(img, file.name, file.type);
      if (which === "a") {
        state.imgA = img;
        state.infoA = info;
        state.timings.loadA = Math.round(performance.now() - t0);
      } else {
        state.imgB = img;
        state.infoB = info;
        state.timings.loadB = Math.round(performance.now() - t0);
      }
      renderCardMeta(which, info);
      setCardStatus(which, "ok", `已加载 · ${info.width}×${info.height}${info.hasAlpha ? " · 含透明通道" : ""}`);
      log(
        `图 ${which.toUpperCase()}：解码完成 ${info.width}×${info.height}` +
          `${info.hasAlpha ? "（含 alpha 通道）" : ""}，耗时 ${Math.round(performance.now() - t0)}ms`,
        "ok"
      );
      maybeRunPipeline();
    };
    img.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      setCardStatus(which, "error", "解码失败（格式不支持？）");
      log(`图 ${which.toUpperCase()}：图片解码失败`, "err");
    };
    img.src = blobUrl;
  };
  reader.readAsArrayBuffer(file);
}

/** 检查尺寸、alpha 通道、色彩空间标记 */
function inspectImage(img, fileName, mime) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const probe = document.createElement("canvas");
  probe.width = w;
  probe.height = h;
  const pctx = probe.getContext("2d", { willReadFrequently: true });
  pctx.drawImage(img, 0, 0);
  let hasAlpha = false;
  try {
    const data = pctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) {
        hasAlpha = true;
        break;
      }
    }
  } catch {
    /* getImageData 失败时按无 alpha 处理 */
  }
  // 浏览器解码统一为 sRGB 8bit；JPEG 天然无 alpha
  const colorSpace = mime.includes("jpeg") || mime.includes("jpg") ? "sRGB(8bit, 无 alpha)" : "sRGB(8bit)";
  return { fileName, width: w, height: h, hasAlpha, colorSpace, mime };
}

function renderCardMeta(which, info) {
  $(`meta-${which}`).innerHTML = `
    <div>尺寸 <b>${info.width} × ${info.height}</b></div>
    <div>透明通道 <b>${info.hasAlpha ? "有" : "无"}</b></div>
    <div>色彩空间 <b>${info.colorSpace}</b></div>
    <div class="full">文件 <b>${escapeHtml(info.fileName)}</b></div>`;
}

async function loadSamples() {
  const jobs = [
    ["a", "../samples/group1_gameplay/scene_a_v1.png"],
    ["b", "../samples/group1_gameplay/scene_b_v2.png"],
  ];
  log("载入内置示例：group1_gameplay（实机画面，B 含 +8% 亮度与噪点）");
  for (const [which, url] of jobs) {
    setCardStatus(which, "working", "加载示例中…");
    try {
      const buf = await fetch(url).then((r) => {
        if (!r.ok) throw new Error(r.status);
        return r.arrayBuffer();
      });
      const file = new File([buf], url.split("/").pop(), { type: "image/png" });
      await new Promise((resolve) => {
        // 复用文件加载流程，保证示例与真实导入走同一条路径
        const t0 = performance.now();
        const blobUrl = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
        const img = new Image();
        img.onload = () => {
          const info = inspectImage(img, file.name, "image/png");
          if (which === "a") {
            state.imgA = img; state.infoA = info; state.timings.loadA = Math.round(performance.now() - t0);
          } else {
            state.imgB = img; state.infoB = info; state.timings.loadB = Math.round(performance.now() - t0);
          }
          renderCardMeta(which, info);
          setCardStatus(which, "ok", `已加载 · ${info.width}×${info.height}${info.hasAlpha ? " · 含透明通道" : ""}`);
          URL.revokeObjectURL(blobUrl);
          resolve();
        };
        img.src = blobUrl;
      });
    } catch (err) {
      setCardStatus(which, "error", "示例加载失败");
      log(`示例加载失败（${url}）：${err}。请确认通过 http 服务打开而非 file://`, "err");
      return;
    }
  }
  log("示例载入完成，开始差异计算", "ok");
  maybeRunPipeline();
}

// ----------------------------- 处理流水线 ----------------------------- //
let worker = null;
function getWorker() {
  if (!worker) worker = new Worker("./worker-diff.js", { type: "module" });
  return worker;
}

async function maybeRunPipeline() {
  if (!state.imgA || !state.imgB) return;
  $("empty-state").classList.add("hidden");
  $("btn-export-png").disabled = false;
  $("btn-export-json").disabled = false;

  // 尺寸提示
  const mismatch = state.infoA.width !== state.infoB.width || state.infoA.height !== state.infoB.height;
  const alertEl = $("size-alert");
  if (mismatch) {
    alertEl.classList.remove("hidden");
    $("size-alert-text").textContent =
      `图 A ${state.infoA.width}×${state.infoA.height}，图 B ${state.infoB.width}×${state.infoB.height}。` +
      `已按「${ALIGN_MODES.find((m) => m.id === getAlignMode()).label}」处理，可在左侧切换对齐方式。`;
    log(`尺寸不一致：A ${state.infoA.width}×${state.infoA.height} vs B ${state.infoB.width}×${state.infoB.height}`, "warn");
  } else {
    alertEl.classList.add("hidden");
  }

  runAlign();
  await runDiff();
  updateStatsAndRender();
}

function runAlign() {
  const t0 = performance.now();
  const mode = getAlignMode();
  const out = alignImages(state.imgA, state.imgB, mode);
  out.meta.modeLabel = ALIGN_MODES.find((m) => m.id === mode).label;
  state.aligned = out;
  state.timings.align = Math.round(performance.now() - t0);

  // 保留两个对齐后画布（报告缩略图用）
  state.canvasA = document.createElement("canvas");
  state.canvasA.width = out.canvasW;
  state.canvasA.height = out.canvasH;
  state.canvasA.getContext("2d").putImageData(out.imageDataA, 0, 0);
  state.canvasB = document.createElement("canvas");
  state.canvasB.width = out.canvasW;
  state.canvasB.height = out.canvasH;
  state.canvasB.getContext("2d").putImageData(out.imageDataB, 0, 0);

  canvas.width = out.canvasW;
  canvas.height = out.canvasH;
  roiLayer.style.width = out.canvasW + "px";
  roiLayer.style.height = out.canvasH + "px";

  const m = out.meta;
  $("align-meta").innerHTML =
    `画布 ${m.canvasSize.width}×${m.canvasSize.height}<br>` +
    `A 缩放 x:${m.scaleA.x} y:${m.scaleA.y} 偏移 (${m.offsetA.x},${m.offsetA.y})<br>` +
    `B 缩放 x:${m.scaleB.x} y:${m.scaleB.y} 偏移 (${m.offsetB.x},${m.offsetB.y})<br>` +
    `宽高比 A:${m.aspectA} / B:${m.aspectB}`;

  // 对齐变了，旧 ROI 坐标可能越界，清空
  state.rois = [];
  state.nextRoiId = 1;
  renderRoiList();
  fitZoom();
  log(`对齐完成（${m.modeLabel}），画布 ${m.canvasSize.width}×${m.canvasSize.height}，耗时 ${state.timings.align}ms`);
}

function runDiff() {
  return new Promise((resolve) => {
    const jobId = ++state.jobSeq;
    const w = getWorker();
    const t0 = performance.now();
    showProgress("正在计算像素差异…", 0);

    const cleanup = () => {
      w.removeEventListener("message", handler);
      w.removeEventListener("error", errHandler);
    };
    const handler = (e) => {
      const msg = e.data;
      if (msg.jobId !== jobId) return;
      if (msg.type === "progress") {
        if (jobId !== state.jobSeq) return; // 过期任务不再更新 UI
        const pctv = (msg.done / msg.total) * 100;
        showProgress("正在计算像素差异…", pctv);
      } else if (msg.type === "done") {
        cleanup();
        if (jobId !== state.jobSeq) {
          resolve(); // 已被更新的任务取代，丢弃结果
          return;
        }
        state.diffResult = msg.result;
        state.timings.diff = Math.round(performance.now() - t0);
        hideProgress();
        log(
          `差异计算完成：有效像素 ${msg.result.coveredPixels}，` +
            `平均差异 ${msg.result.meanDiff.toFixed(4)}，亮度补偿系数 ${msg.result.brightnessFactor.toFixed(3)}，` +
            `耗时 ${state.timings.diff}ms`,
          "ok"
        );
        resolve();
      }
    };
    const errHandler = (e) => {
      cleanup();
      worker = null; // Worker 出错后内部状态不可靠，下次重建
      if (jobId === state.jobSeq) {
        hideProgress();
        log(`Worker 错误：${e.message || "未知错误"}，请重试导入`, "err");
      }
      resolve();
    };
    w.addEventListener("message", handler);
    w.addEventListener("error", errHandler);
    // 发送给 Worker 的是克隆副本（主线程仍需用对齐后的 ImageData 做渲染/检查器/ROI），
    // 克隆出的 buffer 声明为 Transferable，避免 Worker 侧再做一次结构化克隆
    const imgAClone = new ImageData(
      new Uint8ClampedArray(state.aligned.imageDataA.data),
      state.aligned.canvasW,
      state.aligned.canvasH
    );
    const imgBClone = new ImageData(
      new Uint8ClampedArray(state.aligned.imageDataB.data),
      state.aligned.canvasW,
      state.aligned.canvasH
    );
    const coverageClone = new Uint8Array(state.aligned.coverage);
    w.postMessage(
      {
        type: "compute",
        jobId,
        imgA: imgAClone,
        imgB: imgBClone,
        coverage: coverageClone,
        options: {
          normalizeBrightness: state.normalizeBrightness,
          alphaWeight: state.alphaAware ? state.alphaWeight : 0,
        },
      },
      [imgAClone.data.buffer, imgBClone.data.buffer, coverageClone.buffer]
    );
  });
}

// ----------------------------- 统计与渲染 ----------------------------- //
function updateStatsAndRender() {
  if (!state.diffResult) return;
  const { diff } = state.diffResult;
  const coverage = state.aligned.coverage;
  state.stats = computeStats(diff, coverage, state.threshold);
  state.stats.brightnessFactor = state.diffResult.brightnessFactor;

  // ROI 统计
  for (const roi of state.rois) {
    roi.stats = computeStats(diff, coverage, state.threshold, {
      x: roi.x, y: roi.y, w: roi.w, h: roi.h,
      width: state.aligned.canvasW,
      height: state.aligned.canvasH,
    });
  }

  renderStatsBar();
  renderRoiList();
  renderView();
}

function renderStatsBar() {
  const s = state.stats;
  $("stat-ratio").textContent = (s.changedRatio * 100).toFixed(2) + "%";
  $("stat-changed").textContent = s.changedPixels.toLocaleString();
  $("stat-covered").textContent = s.coveredPixels.toLocaleString();
  $("stat-mean").textContent = s.meanDiff.toFixed(4);
  $("stat-max").textContent = s.maxDiff.toFixed(4);
  $("stat-bright").textContent = state.diffResult.brightnessFactor.toFixed(3);
}

function renderView() {
  const { imageDataA, imageDataB, canvasW, canvasH } = state.aligned;
  ctx.clearRect(0, 0, canvasW, canvasH);

  if (state.view === "slider") {
    // 底层 B，上层按分割线裁剪 A（复用常驻临时画布，避免拖拽时反复创建）
    ctx.putImageData(imageDataB, 0, 0);
    const splitX = Math.round(state.split * canvasW);
    if (!state._sliceCanvas || state._sliceCanvas.width !== canvasW) {
      state._sliceCanvas = document.createElement("canvas");
      state._sliceCanvas.width = canvasW;
      state._sliceCanvas.height = canvasH;
    }
    state._sliceCanvas.getContext("2d").putImageData(imageDataA, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, splitX, canvasH);
    ctx.clip();
    ctx.drawImage(state._sliceCanvas, 0, 0);
    ctx.restore();
    splitHandle.classList.remove("hidden");
    splitHandle.style.left = splitX + "px";
  } else {
    splitHandle.classList.add("hidden");
    if (state.view === "overlay") {
      ctx.putImageData(imageDataA, 0, 0);
      ctx.globalAlpha = state.overlayOpacity;
      ctx.putImageData(withGlobalAlpha(imageDataB, state.overlayOpacity), 0, 0);
      ctx.globalAlpha = 1;
    } else if (state.view === "heat") {
      state.heatImage = renderHeatmap(state.diffResult.diff, state.aligned.coverage, {
        width: canvasW,
        height: canvasH,
        threshold: state.threshold,
        subThresholdMode: $("heat-hide-sub").checked ? "hide" : "dim",
        baseImage: imageDataA,
      });
      ctx.putImageData(state.heatImage, 0, 0);
    }
  }
  applyStageTransform();
}

/** putImageData 不尊重 globalAlpha，需要手工调 alpha 通道 */
function withGlobalAlpha(imageData, alpha) {
  const out = new ImageData(
    new Uint8ClampedArray(imageData.data),
    imageData.width,
    imageData.height
  );
  const d = out.data;
  for (let i = 3; i < d.length; i += 4) d[i] = Math.round(d[i] * alpha);
  return out;
}

// ----------------------------- 缩放 / 平移 ----------------------------- //
function applyStageTransform() {
  stage.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  $("zoom-value").textContent = Math.round(state.zoom * 100) + "%";
  renderRoiRects();
  renderPixelGrid();
}

function fitZoom() {
  if (!state.aligned) return;
  const r = viewport.getBoundingClientRect();
  const { canvasW, canvasH } = state.aligned;
  state.zoom = Math.min((r.width - 30) / canvasW, (r.height - 30) / canvasH, 1);
  state.pan = {
    x: (r.width - canvasW * state.zoom) / 2,
    y: (r.height - canvasH * state.zoom) / 2,
  };
  applyStageTransform();
}

function zoomAt(cx, cy, factor) {
  const old = state.zoom;
  state.zoom = Math.min(32, Math.max(0.05, old * factor));
  // 以鼠标位置为锚点缩放
  state.pan.x = cx - ((cx - state.pan.x) / old) * state.zoom;
  state.pan.y = cy - ((cy - state.pan.y) / old) * state.zoom;
  applyStageTransform();
}

function renderPixelGrid() {
  const existing = stage.querySelector(".pixel-grid");
  if (existing) existing.remove();
  if (state.zoom < 8 || !state.aligned) return;
  const { canvasW, canvasH } = state.aligned;
  const g = document.createElement("div");
  g.className = "pixel-grid";
  g.style.backgroundImage =
    "linear-gradient(to right, rgba(255,255,255,0.18) 1px, transparent 1px)," +
    "linear-gradient(to bottom, rgba(255,255,255,0.18) 1px, transparent 1px)";
  g.style.backgroundSize = `${state.zoom}px ${state.zoom}px`;
  g.style.width = canvasW + "px";
  g.style.height = canvasH + "px";
  stage.appendChild(g);
}

// ----------------------------- ROI ----------------------------- //
function renderRoiRects() {
  roiLayer.innerHTML = "";
  for (const roi of state.rois) {
    const el = document.createElement("div");
    el.className = "roi-rect";
    el.style.left = roi.x + "px";
    el.style.top = roi.y + "px";
    el.style.width = roi.w + "px";
    el.style.height = roi.h + "px";
    el.innerHTML = `<span class="roi-tag">#${roi.id} ${roi.label}</span>`;
    roiLayer.appendChild(el);
  }
  if (draftRoi) {
    const el = document.createElement("div");
    el.className = "roi-rect drawing";
    el.style.left = draftRoi.x + "px";
    el.style.top = draftRoi.y + "px";
    el.style.width = draftRoi.w + "px";
    el.style.height = draftRoi.h + "px";
    roiLayer.appendChild(el);
  }
}

function renderRoiList() {
  const ul = $("roi-list");
  if (state.rois.length === 0) {
    ul.innerHTML = `<li class="empty-roi">暂无 ROI，勾选“拖拽框选模式”后在画面上拖拽</li>`;
    return;
  }
  ul.innerHTML = "";
  for (const roi of state.rois) {
    const li = document.createElement("li");
    const s = roi.stats;
    li.innerHTML = `
      <div class="roi-row1">
        <span class="roi-name">#${roi.id} ${roi.label}</span>
        <button class="roi-del" data-id="${roi.id}" title="删除">✕</button>
      </div>
      <div class="roi-stat">
        位置 (${roi.x},${roi.y}) ${roi.w}×${roi.h}
        ${s ? `· 差异 <b style="color:var(--warning)">${(s.changedRatio * 100).toFixed(2)}%</b> · 均值 ${s.meanDiff.toFixed(4)}` : ""}
      </div>`;
    ul.appendChild(li);
  }
  ul.querySelectorAll(".roi-del").forEach((btn) =>
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      state.rois = state.rois.filter((r) => r.id !== id);
      renderRoiList();
      renderRoiRects();
      log(`删除 ROI #${id}`);
    })
  );
}

let draftRoi = null;
let dragPan = null;
let dragMode = null; // 'pan' | 'split' | 'roi' | null

function bindViewport() {
  const r = () => viewport.getBoundingClientRect();

  viewport.addEventListener("wheel", (e) => {
    if (!state.aligned) return;
    e.preventDefault();
    const rect = r();
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
  }, { passive: false });

  viewport.addEventListener("dblclick", () => fitZoom());

  viewport.addEventListener("mousedown", (e) => {
    if (!state.aligned || e.button !== 0) return;
    const rect = r();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const px = Math.floor((sx - state.pan.x) / state.zoom);
    const py = Math.floor((sy - state.pan.y) / state.zoom);

    if ($("roi-draw-mode").checked) {
      dragMode = "roi";
      draftRoi = { x: px, y: py, w: 0, h: 0 };
    } else if (state.view === "slider") {
      // 滑块模式：左键直接拖分割线
      dragMode = "split";
      moveSplit(e);
    } else {
      dragMode = "pan";
      dragPan = { startX: e.clientX, startY: e.clientY, panX: state.pan.x, panY: state.pan.y };
    }
  });

  window.addEventListener("mousemove", (e) => {
    const rect = r();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const px = Math.floor((sx - state.pan.x) / state.zoom);
    const py = Math.floor((sy - state.pan.y) / state.zoom);

    if (dragMode === "roi" && draftRoi) {
      draftRoi.w = px - draftRoi.x;
      draftRoi.h = py - draftRoi.y;
      renderRoiRects();
    } else if (dragMode === "pan" && dragPan) {
      state.pan.x = dragPan.panX + (e.clientX - dragPan.startX);
      state.pan.y = dragPan.panY + (e.clientY - dragPan.startY);
      applyStageTransform();
    } else if (dragMode === "split" && e.buttons === 1) {
      moveSplit(e);
    }
    updatePixelInspector(px, py);
  });

  window.addEventListener("mouseup", () => {
    if (dragMode === "roi" && draftRoi) {
      const norm = normalizeRect(draftRoi);
      draftRoi = null;
      if (norm.w >= 3 && norm.h >= 3 && state.aligned) {
        const clamped = clampRect(norm, state.aligned.canvasW, state.aligned.canvasH);
        if (clamped.w >= 3 && clamped.h >= 3) {
          const roi = {
            id: state.nextRoiId++,
            label: "ROI",
            ...clamped,
            stats: null,
          };
          roi.stats = computeStats(
            state.diffResult.diff,
            state.aligned.coverage,
            state.threshold,
            { ...clamped, width: state.aligned.canvasW, height: state.aligned.canvasH }
          );
          state.rois.push(roi);
          renderRoiList();
          log(
            `新增 ROI #${roi.id}：(${roi.x},${roi.y}) ${roi.w}×${roi.h}，` +
              `差异占比 ${(roi.stats.changedRatio * 100).toFixed(2)}%`,
            "ok"
          );
        }
      }
      renderRoiRects();
    }
    dragPan = null;
    dragMode = null;
  });

  $("btn-zoom-in").addEventListener("click", () => {
    const rect = r();
    zoomAt(rect.width / 2, rect.height / 2, 1.25);
  });
  $("btn-zoom-out").addEventListener("click", () => {
    const rect = r();
    zoomAt(rect.width / 2, rect.height / 2, 1 / 1.25);
  });
  $("btn-zoom-fit").addEventListener("click", fitZoom);
  $("btn-zoom-100").addEventListener("click", () => {
    const rect = r();
    state.zoom = 1;
    state.pan = { x: (rect.width - state.aligned.canvasW) / 2, y: (rect.height - state.aligned.canvasH) / 2 };
    applyStageTransform();
  });
  $("btn-clear-rois").addEventListener("click", () => {
    state.rois = [];
    renderRoiList();
    renderRoiRects();
    log("已清空全部 ROI");
  });

  window.addEventListener("resize", () => {
    if (state.aligned) fitZoom();
  });
}

function moveSplit(e) {
  const rect = viewport.getBoundingClientRect();
  const localX = e.clientX - rect.left - state.pan.x;
  state.split = Math.min(1, Math.max(0, localX / (state.aligned.canvasW * state.zoom)));
  $("split").value = Math.round(state.split * 100);
  $("split-value").textContent = Math.round(state.split * 100) + "%";
  renderView();
}

function updatePixelInspector(px, py) {
  if (!state.aligned || !state.diffResult) {
    $("pixel-info").className = "muted";
    $("pixel-info").textContent = "在视图上移动鼠标查看该像素的 A/B 值与差异";
    return;
  }
  const { canvasW, canvasH, imageDataA, imageDataB, coverage } = state.aligned;
  if (px < 0 || py < 0 || px >= canvasW || py >= canvasH) return;
  const i = (py * canvasW + px) * 4;
  const a = imageDataA.data;
  const b = imageDataB.data;
  const d = state.diffResult.diff[py * canvasW + px];
  const covered = coverage[py * canvasW + px];
  const sw = (arr, idx) =>
    `<span class="swatch" style="background:rgba(${arr[idx]},${arr[idx + 1]},${arr[idx + 2]},${(arr[idx + 3] / 255).toFixed(2)})"></span>` +
    `rgba(${arr[idx]},${arr[idx + 1]},${arr[idx + 2]},${arr[idx + 3]})`;
  $("pixel-info").className = "";
  $("pixel-info").innerHTML =
    `坐标 <b>(${px}, ${py})</b>${covered ? "" : " · <span style='color:var(--critical)'>未覆盖</span>"}<br>` +
    `A ${sw(a, i)}<br>` +
    `B ${sw(b, i)}<br>` +
    (covered
      ? `差异 <span class="pdiff">${d.toFixed(4)}</span>` +
        `（阈值 ${state.threshold.toFixed(3)}，${d >= state.threshold ? "<b style='color:var(--critical)'>计为变化</b>" : "低于阈值，已隐藏"}）`
      : "");
}

// ----------------------------- 控件绑定 ----------------------------- //
function bindControls() {
  $("threshold").addEventListener("input", (e) => {
    state.threshold = Number(e.target.value) / 100;
    $("threshold-value").textContent = Number(e.target.value).toFixed(1) + "%";
    if (state.diffResult) updateStatsAndRender();
  });

  $("normalize-brightness").addEventListener("change", (e) => {
    state.normalizeBrightness = e.target.checked;
    if (state.imgA && state.imgB) runDiff().then(updateStatsAndRender);
  });
  $("alpha-aware").addEventListener("change", (e) => {
    state.alphaAware = e.target.checked;
    if (state.imgA && state.imgB) runDiff().then(updateStatsAndRender);
  });
  $("alpha-weight").addEventListener("input", (e) => {
    state.alphaWeight = Number(e.target.value);
    $("alpha-weight-value").textContent = state.alphaWeight.toFixed(2);
  });
  $("alpha-weight").addEventListener("change", () => {
    if (state.imgA && state.imgB) runDiff().then(updateStatsAndRender);
  });

  document.querySelectorAll('input[name="align"]').forEach((radio) => {
    radio.addEventListener("change", async () => {
      if (state.imgA && state.imgB) {
        runAlign();
        await runDiff();
        updateStatsAndRender();
      }
    });
  });

  document.querySelectorAll("#view-mode-group button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#view-mode-group button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.view = btn.dataset.view;
      $("slider-controls").classList.toggle("hidden", state.view !== "slider");
      $("overlay-controls").classList.toggle("hidden", state.view !== "overlay");
      $("heat-controls").classList.toggle("hidden", state.view !== "heat");
      if (state.aligned) renderView();
    });
  });

  $("overlay-opacity").addEventListener("input", (e) => {
    state.overlayOpacity = Number(e.target.value) / 100;
    $("overlay-opacity-value").textContent = e.target.value + "%";
    if (state.aligned) renderView();
  });
  $("heat-hide-sub").addEventListener("change", () => {
    if (state.aligned) renderView();
  });
  $("split").addEventListener("input", (e) => {
    state.split = Number(e.target.value) / 100;
    $("split-value").textContent = e.target.value + "%";
    if (state.aligned) renderView();
  });
}

function getAlignMode() {
  return document.querySelector('input[name="align"]:checked').value;
}

// ----------------------------- 导出 ----------------------------- //
function bindExport() {
  $("btn-export-json").addEventListener("click", () => {
    if (!state.diffResult) return;
    const t0 = performance.now();
    showProgress("生成 JSON 报告…", 30);
    state.timings.total = totalElapsed();
    const report = buildJsonReport(buildReportState());
    const name = `diff-report-${stamp()}.json`;
    setTimeout(() => {
      downloadJson(report, name);
      hideProgress();
      log(`JSON 报告已导出：${name}（${formatBytes(new Blob([JSON.stringify(report)]).size)}）`, "ok");
    }, 60);
  });

  $("btn-export-png").addEventListener("click", async () => {
    if (!state.diffResult) return;
    showProgress("合成 PNG 报告…", 20);
    log("开始合成 PNG 报告…");
    await new Promise((r) => setTimeout(r, 30));
    state.timings.total = totalElapsed();
    const reportCanvas = await renderPngReport(buildReportState(), canvas);
    showProgress("合成 PNG 报告…", 80);
    await new Promise((r) => setTimeout(r, 30));
    reportCanvas.toBlob((blob) => {
      const name = `diff-report-${stamp()}.png`;
      downloadBlob(blob, name);
      hideProgress();
      log(`PNG 报告已导出：${name}（${formatBytes(blob.size)}）`, "ok");
    }, "image/png");
  });
}

function buildReportState() {
  return {
    imageInfo: { a: state.infoA, b: state.infoB },
    alignMeta: {
      ...state.aligned.meta,
      canvasSize: { width: state.aligned.canvasW, height: state.aligned.canvasH },
    },
    settings: {
      threshold: state.threshold,
      normalizeBrightness: state.normalizeBrightness,
      alphaWeight: state.alphaAware ? state.alphaWeight : 0,
      subThresholdMode: $("heat-hide-sub").checked ? "hide" : "dim",
    },
    stats: state.stats,
    rois: state.rois,
    logs: state.logs.slice(-30),
    timings: state.timings,
    canvasA: state.canvasA,
    canvasB: state.canvasB,
  };
}

// ----------------------------- 小工具 ----------------------------- //
function showProgress(title, pctv) {
  $("progress-overlay").classList.remove("hidden");
  $("progress-title").textContent = title;
  $("progress-fill").style.width = pctv + "%";
  $("progress-text").textContent = pctv.toFixed(0) + "%";
}
function hideProgress() {
  $("progress-overlay").classList.add("hidden");
}

function log(msg, kind = "") {
  const now = new Date();
  const t = now.toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(now.getMilliseconds()).padStart(3, "0");
  state.logs.push({ t, msg, kind });
  const li = document.createElement("li");
  if (kind) li.className = kind;
  li.innerHTML = `<span class="t">${t}</span><span class="msg">${escapeHtml(msg)}</span>`;
  const ul = $("log-list");
  ul.appendChild(li);
  ul.scrollTop = ul.scrollHeight;
}

function totalElapsed() {
  return (state.timings.loadA || 0) + (state.timings.loadB || 0) +
    (state.timings.align || 0) + (state.timings.diff || 0);
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function normalizeRect(r) {
  return {
    x: Math.min(r.x, r.x + r.w),
    y: Math.min(r.y, r.y + r.h),
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}
function clampRect(r, W, H) {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  return {
    x, y,
    w: Math.min(r.w, W - x),
    h: Math.min(r.h, H - y),
  };
}

init();

// 调试/自动化测试钩子（不影响正常使用）：返回当前状态生成的 JSON 报告
window.__diffChecker = {
  getJsonReport: () => (state.diffResult ? buildJsonReport(buildReportState()) : null),
  getState: () => state,
};
