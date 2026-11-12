/**
 * worker-diff.js —— 差异计算 Web Worker
 *
 * 把逐像素计算挪出主线程，保证大图处理时 UI 不卡死，
 * 并通过 postMessage 回报真实进度（对应需求 6：真实处理状态）。
 *
 * 协议：
 *   主 -> Worker: {type:'compute', imgA, imgB, coverage, options, jobId}
 *   Worker -> 主: {type:'progress', jobId, done, total}
 *               {type:'done', jobId, result}  result.diff 为 Transferable
 */
import { computeDiff } from "./diff-core.js";

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type !== "compute") return;
  const { imgA, imgB, coverage, options, jobId } = msg;

  // 不传 onProgress：Worker 环境下 computeDiff 返回分片 runner，
  // 由 setInterval 逐段推进，每个事件循环只算一块，进度消息只有这一个来源
  const runner = computeDiff(imgA, imgB, coverage, options);

  if (runner && typeof runner.step === "function") {
    const timer = setInterval(() => {
      const r = runner.step();
      self.postMessage({ type: "progress", jobId, done: r.processed, total: r.total });
      if (r.done) {
        clearInterval(timer);
        const result = runner.result;
        // diff 的底层 buffer 转移给主线程，零拷贝
        self.postMessage({ type: "done", jobId, result }, [result.diff.buffer]);
      }
    }, 0);
  } else {
    // 兜底：环境判断失效时直接同步完成
    self.postMessage({ type: "done", jobId, result: runner });
  }
};
