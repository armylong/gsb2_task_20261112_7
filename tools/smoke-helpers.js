/**
 * smoke-helpers.js —— CDP 冒烟测试共用工具（零依赖）
 */
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";

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
  on(event, fn) { this.handlers[event].push(fn); }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.opened) {
      const idx = this.buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      this.opened = true;
      this.buf = this.buf.slice(idx + 4);
      this.handlers.open.forEach((f) => f());
    }
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
      if (opcode === 0x8) { this.socket.end(); return; }
      if (opcode === 0x1) this.handlers.message.forEach((f) => f(payload.toString("utf8")));
    }
  }
  send(str) {
    const payload = Buffer.from(str);
    const header = [0x81];
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
  close() { try { this.socket.end(); } catch { /* ignore */ } }
}

export async function runCase({ name, urlA, urlB, fileA = null, fileB = null, extraChecks = null, shotPath = null }) {
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
  const pageErrors = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push(msg.params.exceptionDetails.text + " " +
        (msg.params.exceptionDetails.exception?.description || ""));
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error("页面异常: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:8123/app/index.html" });
  await sleep(1200);

  if (fileA && fileB) {
    // 真实文件选择路径：CDP DOM.setFileInputFiles
    await send("DOM.enable");
    const doc = await send("DOM.getDocument");
    const nodeA = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#file-a" });
    const nodeB = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#file-b" });
    await send("DOM.setFileInputFiles", { files: [fileA], nodeId: nodeA.nodeId });
    await send("DOM.setFileInputFiles", { files: [fileB], nodeId: nodeB.nodeId });
  } else {
    // 通过 fetch + DataTransfer 注入（站点内资源）
    await evalJs(`(async () => {
      async function toFile(url) {
        const buf = await fetch(url).then(r => r.arrayBuffer());
        return new File([buf], url.split('/').pop(), { type: 'image/png' });
      }
      const [fa, fb] = await Promise.all([toFile('${urlA}'), toFile('${urlB}')]);
      const dtA = new DataTransfer(); dtA.items.add(fa);
      const dtB = new DataTransfer(); dtB.items.add(fb);
      const inA = document.getElementById('file-a');
      const inB = document.getElementById('file-b');
      inA.files = dtA.files; inA.dispatchEvent(new Event('change', {bubbles:true}));
      inB.files = dtB.files; inB.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
  }

  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const done = await evalJs(
      `[...document.querySelectorAll('#log-list li .msg')].some(e=>e.textContent.includes('差异计算完成'))`
    );
    if (done) break;
  }

  const summary = await evalJs(`({
    ratio: document.getElementById('stat-ratio').textContent,
    changed: document.getElementById('stat-changed').textContent,
    canvas: document.getElementById('view-canvas').width + 'x' + document.getElementById('view-canvas').height,
    mismatchVisible: !document.getElementById('size-alert').classList.contains('hidden'),
  })`);
  console.log(`\n[${name}]`);
  console.log("  基础统计:", JSON.stringify(summary));

  let extra = null;
  if (extraChecks) extra = await extraChecks(evalJs, sleep, send);
  if (extra) console.log("  专项检查:", JSON.stringify(extra, null, 2).replace(/\n/g, "\n  "));

  if (shotPath) {
    await evalJs(`document.getElementById('viewport').scrollIntoView({block:'center'})`);
    await sleep(200);
    const clip = await evalJs(`(() => {
      const r = document.getElementById('viewport').getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 };
    })()`);
    const shot = await send("Page.captureScreenshot", { format: "png", clip });
    fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
    console.log("  截图已保存:", shotPath);
  }

  console.log("  控制台错误:", consoleErrors.length ? consoleErrors : "无");
  console.log("  页面异常:", pageErrors.length ? pageErrors : "无");
  ws.close();
  if (pageErrors.length || consoleErrors.length) process.exit(1);
  return extra;
}
