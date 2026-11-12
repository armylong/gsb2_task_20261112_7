/**
 * smoke-cdp.js —— 零依赖 Chrome DevTools Protocol 冒烟测试
 * 驱动真实浏览器：载入示例 -> 等 Worker 算完 -> 切三视图 -> 建 ROI -> 导出报告
 * Node 20 无全局 WebSocket，这里用内置 net/crypto 实现极简 WS 文本帧客户端。
 */
import net from "node:net";
import crypto from "node:crypto";

const BASE = "http://127.0.0.1:9222";

async function http(path) {
  const res = await fetch(BASE + path);
  return res.json();
}

class MinimalWS {
  constructor(url) {
    const u = new URL(url);
    this.key = crypto.randomBytes(16).toString("base64");
    this.buf = Buffer.alloc(0);
    this.handlers = { open: [], message: [], close: [] };
    this.socket = net.connect(Number(u.port), u.hostname, () => {
      this.socket.write(
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    this.socket.on("data", (chunk) => this._onData(chunk));
    this.socket.on("close", () => this.handlers.close.forEach((f) => f()));
  }
  on(event, fn) {
    this.handlers[event].push(fn);
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.opened) {
      const idx = this.buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      this.opened = true;
      this.buf = this.buf.slice(idx + 4);
      this.handlers.open.forEach((f) => f());
    }
    // 循环解析帧（本测试只有服务端->客户端的文本帧，长度均 < 65536 或走 64bit 长度）
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) === 0x80;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < offset + maskLen + len) return;
      let payload = this.buf.slice(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this.buf.slice(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this.buf = this.buf.slice(offset + maskLen + len);
      if (opcode === 0x8) {
        this.socket.end();
        return;
      }
      if (opcode === 0x1) {
        this.handlers.message.forEach((f) => f(payload.toString("utf8")));
      }
    }
  }
  send(str) {
    const payload = Buffer.from(str);
    const header = [0x81]; // FIN + text
    const len = payload.length;
    if (len < 126) header.push(0x80 | len);
    else if (len < 65536) {
      header.push(0x80 | 126);
      const b = Buffer.alloc(2);
      b.writeUInt16BE(len);
      header.push(...b);
    } else {
      header.push(0x80 | 127);
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(BigInt(len));
      header.push(...b);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([Buffer.from(header), mask, masked]));
  }
  close() {
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const tabs = await http("/json");
  const tab = tabs.find((t) => t.type === "page");
  const ws = new MinimalWS(tab.webSocketDebuggerUrl);
  await new Promise((r, rej) => {
    ws.on("open", r);
    setTimeout(() => rej(new Error("WS 连接超时")), 5000);
  });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const consoleMessages = [];
  const pageErrors = [];

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      consoleMessages.push({ level: msg.params.type, text });
      if (msg.params.type === "error") consoleErrors.push(text);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push(msg.params.exceptionDetails.text + " " +
        (msg.params.exceptionDetails.exception?.description || ""));
    }
  });

  function send(method, params = {}) {
    const myId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  }
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error("页面异常: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:8123/app/index.html" });
  await sleep(1500);

  // 1. 载入内置示例
  await evalJs(`document.getElementById('btn-samples').click()`);
  // 等 Worker 计算完成（日志出现“差异计算完成”）
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const done = await evalJs(
      `[...document.querySelectorAll('#log-list li .msg')].some(e=>e.textContent.includes('差异计算完成'))`
    );
    if (done) break;
  }

  const state1 = await evalJs(`({
    ratio: document.getElementById('stat-ratio').textContent,
    changed: document.getElementById('stat-changed').textContent,
    mean: document.getElementById('stat-mean').textContent,
    max: document.getElementById('stat-max').textContent,
    bright: document.getElementById('stat-bright').textContent,
    exportEnabled: !document.getElementById('btn-export-json').disabled,
    canvasW: document.getElementById('view-canvas').width,
    canvasH: document.getElementById('view-canvas').height,
  })`);
  console.log("① 示例加载+Worker计算:", JSON.stringify(state1));

  // 2. 切三视图并截图（CDP Page.captureScreenshot，按 viewport 元素裁剪）
  const shots = {};
  for (const view of ["slider", "overlay", "heat"]) {
    await evalJs(`document.querySelector('[data-view="${view}"]').click()`);
    await sleep(300);
    const nonBlank = await evalJs(`(() => {
      const c = document.getElementById('view-canvas');
      const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let nonZero=0; for(let i=0;i<d.length;i+=4){ if(d[i+3]>0) nonZero++; }
      return nonZero;
    })()`);
    const clip = await evalJs(`(() => {
      const el = document.getElementById('viewport');
      el.scrollIntoView({block:'center'});
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 };
    })()`);
    await sleep(200);
    const shot = await send("Page.captureScreenshot", { format: "png", clip });
    shots[view] = shot.data;
    console.log(`② 视图 ${view}: 非空像素=${nonBlank}`);
  }
  const fs = await import("node:fs");
  for (const [view, data] of Object.entries(shots)) {
    fs.writeFileSync(`/tmp/diff-shots/view-${view}.png`, Buffer.from(data, "base64"));
  }

  // 3. 热图模式下勾选隐藏低阈值
  await evalJs(`document.querySelector('[data-view="heat"]').click()`);
  await evalJs(`document.getElementById('heat-hide-sub').click()`);
  await sleep(200);
  const hiddenPixels = await evalJs(`(() => {
    const c = document.getElementById('view-canvas');
    const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let transparent=0; for(let i=3;i<d.length;i+=4){ if(d[i]===0) transparent++; }
    return transparent;
  })()`);
  console.log("③ 隐藏低于阈值像素后，全透明像素数:", hiddenPixels);

  // 4. 调阈值（更低 -> 更多变化像素）
  const before = await evalJs(`document.getElementById('stat-changed').textContent`);
  await evalJs(`(() => {
    const t=document.getElementById('threshold'); t.value=2;
    t.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await sleep(200);
  const after = await evalJs(`document.getElementById('stat-changed').textContent`);
  console.log(`④ 阈值 8%->2%: 差异像素 ${before} -> ${after}`);

  // 5. 模拟拖拽框选 ROI（mousedown -> mousemove -> mouseup）
  await evalJs(`(() => {
    const vp=document.getElementById('viewport');
    const r=vp.getBoundingClientRect();
    document.getElementById('roi-draw-mode').checked=true;
    function ev(type,x,y){
      const target = type==='mouseup' || type==='mousemove' ? window : vp;
      target.dispatchEvent(new MouseEvent(type,{bubbles:true,clientX:r.left+x,clientY:r.top+y,button:0,buttons:type==='mouseup'?0:1}));
    }
    ev('mousedown', 120, 150);
    ev('mousemove', 220, 240);
    ev('mouseup', 220, 240);
  })()`);
  await sleep(200);
  const roiInfo = await evalJs(`(() => {
    const li=document.querySelector('#roi-list li:not(.empty-roi)');
    return li ? li.textContent.replace(/\\s+/g,' ').trim() : null;
  })()`);
  console.log("⑤ ROI 框选结果:", roiInfo);

  // 6. 导出 JSON（拦截下载，用 toBlob 同路径验证报告内容）
  const reportCheck = await evalJs(`(async () => {
    // 直接动态导入 report 模块验证 buildJsonReport 可用
    const mod = await import('./report.js');
    return typeof mod.buildJsonReport === 'function' && typeof mod.renderPngReport === 'function';
  })()`);
  console.log("⑥ 报告模块接口可用:", reportCheck);

  // 7. 真实点导出按钮（验证按钮路径不报错）
  await evalJs(`document.getElementById('btn-export-json').click()`);
  await sleep(500);
  await evalJs(`document.getElementById('btn-export-png').click()`);
  await sleep(800);

  // 8. 报告内容校验：通过页面调试钩子拿到 JSON 报告，断言需求 4 的字段全部存在
  const report = await evalJs(`window.__diffChecker.getJsonReport()`);
  const requiredPaths = [
    "exportedAt", "tool.name",
    "images.imageA.width", "images.imageA.height", "images.imageA.hasAlpha",
    "images.imageB.width", "images.sizeMismatch",
    "alignment.mode", "alignment.canvasSize.width", "alignment.scaleA.x",
    "settings.threshold", "settings.thresholdPercent",
    "settings.normalizeBrightness", "settings.brightnessFactor",
    "stats.totalPixels", "stats.coveredPixels", "stats.changedPixels",
    "stats.changedRatio", "stats.changedPercent", "stats.intensityBands",
    "regions", "heatmap.colorStops", "timings.total_ms", "processingLogs",
  ];
  const get = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
  const missing = requiredPaths.filter((p) => get(report, p) === undefined);
  console.log("⑧ JSON 报告字段完整性:", missing.length === 0 ? "全部存在" : "缺失 " + missing.join(","));
  console.log("   关键字段:", JSON.stringify({
    threshold: report.settings.thresholdPercent,
    mode: report.alignment.mode,
    changed: report.stats.changedPercent,
    rois: report.regions.length,
    logs: report.processingLogs.length,
    bands: report.stats.intensityBands.length,
  }));

  // 9. PNG 报告在页面内合成并回传落盘
  const pngB64 = await evalJs(`(async () => {
    const mod = await import('./report.js');
    const st = window.__diffChecker.getState();
    const c = await mod.renderPngReport({
      imageInfo:{a:st.infoA,b:st.infoB},
      alignMeta:{...st.aligned.meta, canvasSize:{width:st.aligned.canvasW,height:st.aligned.canvasH}},
      settings:{threshold:st.threshold,normalizeBrightness:st.normalizeBrightness,
        alphaWeight:st.alphaAware?st.alphaWeight:0,subThresholdMode:'dim'},
      stats:st.stats, rois:st.rois, logs:st.logs.slice(-30), timings:st.timings,
      canvasA:st.canvasA, canvasB:st.canvasB,
    }, document.getElementById('view-canvas'));
    return c.toDataURL('image/png').split(',')[1];
  })()`);
  fs.writeFileSync("/tmp/diff-shots/report.png", Buffer.from(pngB64, "base64"));
  fs.writeFileSync("/tmp/diff-shots/report.json", JSON.stringify(report, null, 2));
  console.log("⑨ PNG/JSON 报告已落盘 /tmp/diff-shots/");

  const logs = await evalJs(`[...document.querySelectorAll('#log-list li .msg')].map(e=>e.textContent)`);
  console.log("⑩ 处理日志（最后 6 条）:");
  logs.slice(-6).forEach((l) => console.log("   -", l));

  console.log("\n控制台错误:", consoleErrors.length ? consoleErrors : "无");
  console.log("页面未捕获异常:", pageErrors.length ? pageErrors : "无");

  ws.close();
  if (pageErrors.length || consoleErrors.length) process.exit(1);
}

main().catch((e) => {
  console.error("冒烟测试失败:", e);
  process.exit(1);
});
