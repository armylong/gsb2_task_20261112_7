/**
 * test-diff-core.js —— 差异算法核心的 Node 单元测试（零依赖，node tools/test-diff-core.js）
 *
 * 覆盖需求 3 的三个反误报场景：
 *   1. 仅整体亮度变化（+10%）且开启亮度归一化 -> 差异占比应接近 0
 *   2. 两张图都完全透明的像素 -> 差异必须为 0
 *   3. 单侧透明（内容出现/消失）-> 应报差异，但只在对应像素
 * 以及阈值统计、ROI 统计、未覆盖像素处理。
 */
import { computeDiff, computeStats } from "../app/diff-core.js";

let passed = 0;
let failed = 0;

function assert(cond, name, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

function makeImage(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const c = fill(p, w, h);
    data[p * 4] = c[0];
    data[p * 4 + 1] = c[1];
    data[p * 4 + 2] = c[2];
    data[p * 4 + 3] = c[3];
  }
  return { width: w, height: h, data };
}

const W = 40;
const H = 30;
const fullCoverage = new Uint8Array(W * H).fill(1);

console.log("== 1. 纯整体亮度变化不能满屏误报 ==");
{
  const base = makeImage(W, H, () => [120, 140, 160, 255]);
  const brighter = makeImage(W, H, () => [
    Math.min(255, Math.round(120 * 1.1)),
    Math.min(255, Math.round(140 * 1.1)),
    Math.min(255, Math.round(160 * 1.1)),
    255,
  ]);
  const on = computeDiff(base, brighter, fullCoverage, { normalizeBrightness: true });
  const statsOn = computeStats(on.diff, fullCoverage, 0.02);
  const off = computeDiff(base, brighter, fullCoverage, { normalizeBrightness: false });
  const statsOff = computeStats(off.diff, fullCoverage, 0.02);
  console.log(`    亮度补偿开: changedRatio=${(statsOn.changedRatio * 100).toFixed(2)}% mean=${on.meanDiff.toFixed(4)} factor=${on.brightnessFactor.toFixed(3)}`);
  console.log(`    亮度补偿关: changedRatio=${(statsOff.changedRatio * 100).toFixed(2)}% mean=${off.meanDiff.toFixed(4)}`);
  assert(statsOn.changedRatio < 0.02, "开启亮度归一化后 +10% 整体亮度几乎零误报", `ratio=${statsOn.changedRatio}`);
  assert(statsOff.changedRatio > 0.95, "关闭亮度归一化时同样变化能被检出（对照组）", `ratio=${statsOff.changedRatio}`);
  // 系数不是精确 1/1.1：亮度按 Rec.709 加权且在线性空间计算，验证其在合理区间
  // 且补偿后两图加权亮度基本拉平（meanLumaA ≈ meanLumaB * factor）
  const relLumaErr = Math.abs(on.meanLumaA - on.meanLumaB * on.brightnessFactor) / on.meanLumaA;
  assert(on.brightnessFactor > 0.75 && on.brightnessFactor < 0.95, `亮度补偿系数在合理区间（${on.brightnessFactor.toFixed(3)}）`);
  assert(relLumaErr < 0.01, "补偿后两图加权亮度拉平，残余 <1%", `err=${relLumaErr}`);
}

console.log("== 2. 透明通道：双边全透明不算差异 ==");
{
  const a = makeImage(W, H, (p) => (p < W * H / 2 ? [10, 20, 30, 0] : [100, 100, 100, 255]));
  const b = makeImage(W, H, (p) => (p < W * H / 2 ? [200, 50, 90, 0] : [100, 100, 100, 255]));
  const r = computeDiff(a, b, fullCoverage, { normalizeBrightness: false });
  let transparentNonZero = 0;
  for (let p = 0; p < W * H / 2; p++) if (r.diff[p] !== 0) transparentNonZero++;
  assert(transparentNonZero === 0, "全透明像素 RGB 完全不同也报 0 差异", `${transparentNonZero} 个误报`);
  const stats = computeStats(r.diff, fullCoverage, 0.08);
  assert(stats.changedRatio === 0, "全图差异占比为 0");
}

console.log("== 3. 单侧透明：内容出现/消失必须检出 ==");
{
  const a = makeImage(W, H, () => [0, 0, 0, 0]);
  const b = makeImage(W, H, () => [230, 60, 60, 255]);
  const r = computeDiff(a, b, fullCoverage, { normalizeBrightness: false });
  const stats = computeStats(r.diff, fullCoverage, 0.08);
  assert(stats.changedRatio > 0.95, "透明 -> 红色实色，95% 以上像素报差异", `ratio=${stats.changedRatio}`);
  assert(r.diff[0] > 0.3, "单像素差异值明显大于阈值", `d=${r.diff[0]}`);
}

console.log("== 4. 局部真实改动 + 轻微噪点 ==");
{
  // 确定性伪噪点 ±2
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 5) - 2;
  };
  const a = makeImage(W, H, () => [90 + noise(), 120 + noise(), 160 + noise(), 255]);
  const b = makeImage(W, H, (p, w) => {
    const x = p % w;
    const base = [90 + noise(), 120 + noise(), 160 + noise()];
    if (x >= 30) return [220, 60, 60, 255]; // 右 1/4 区域真改动
    return [...base, 255];
  });
  const r = computeDiff(a, b, fullCoverage, { normalizeBrightness: true });
  const stats = computeStats(r.diff, fullCoverage, 0.08);
  const changedExpected = 10 / 40; // 只有右侧 25% 区域
  console.log(`    changedRatio=${(stats.changedRatio * 100).toFixed(2)}% 理论~${(changedExpected * 100).toFixed(0)}%`);
  assert(Math.abs(stats.changedRatio - 0.25) < 0.04, "噪点被阈值抑制，改动区域被定位", `ratio=${stats.changedRatio}`);

  // ROI 只框左侧无改动区
  const roiStats = computeStats(r.diff, fullCoverage, 0.08, { x: 0, y: 0, w: 30, h: H, width: W, height: H });
  assert(roiStats.changedRatio < 0.02, "ROI 框住无改动区时差异接近 0", `ratio=${roiStats.changedRatio}`);
  const roiStats2 = computeStats(r.diff, fullCoverage, 0.08, { x: 30, y: 0, w: 10, h: H, width: W, height: H });
  assert(roiStats2.changedRatio > 0.9, "ROI 框住改动区时差异 >90%", `ratio=${roiStats2.changedRatio}`);
}

console.log("== 5. 未覆盖像素不参与统计 ==");
{
  const a = makeImage(W, H, () => [10, 10, 10, 255]);
  const b = makeImage(W, H, () => [200, 200, 200, 255]);
  const coverage = new Uint8Array(W * H);
  coverage.fill(0);
  coverage.set(new Array(W * 10).fill(1), 0); // 只有前 10 行覆盖
  const r = computeDiff(a, b, coverage, { normalizeBrightness: false });
  assert(r.coveredPixels === W * 10, "coveredPixels 等于掩码计数");
  let sentinelOk = true;
  for (let p = W * 10; p < W * H; p++) if (r.diff[p] !== -1) sentinelOk = false;
  assert(sentinelOk, "未覆盖像素 diff 哨兵值为 -1");
  const stats = computeStats(r.diff, coverage, 0.08);
  assert(stats.coveredPixels === W * 10 && stats.changedPixels === W * 10, "统计只计算覆盖区");
}

console.log("== 6. 阈值可调：同一 diff 数组零重算切换阈值 ==");
{
  const a = makeImage(W, H, () => [100, 100, 100, 255]);
  const b = makeImage(W, H, (p) => {
    const v = p % 3 === 0 ? 130 : 104; // 一部分大差异，一部分小差异
    return [v, v, v, 255];
  });
  const r = computeDiff(a, b, fullCoverage, { normalizeBrightness: false });
  const low = computeStats(r.diff, fullCoverage, 0.01);
  const high = computeStats(r.diff, fullCoverage, 0.5);
  assert(low.changedPixels > high.changedPixels, "阈值越高变化像素越少", `low=${low.changedPixels} high=${high.changedPixels}`);
  assert(high.changedPixels === 0 || high.changedRatio < low.changedRatio, "高阈值过滤生效");
}

console.log("== 7. 输出结构完整性 ==");
{
  const a = makeImage(4, 4, () => [1, 2, 3, 255]);
  const b = makeImage(4, 4, () => [4, 5, 6, 255]);
  const r = computeDiff(a, b, new Uint8Array(16).fill(1), {});
  for (const k of ["diff", "meanDiff", "maxDiff", "meanLumaA", "meanLumaB", "brightnessFactor", "coveredPixels", "totalPixels", "width", "height"]) {
    assert(k in r, `结果包含字段 ${k}`);
  }
  assert(r.diff.length === 16 && r.width === 4 && r.height === 4, "尺寸与 diff 数组长度一致");
  assert(r.maxDiff + 1e-9 >= r.meanDiff, "maxDiff >= meanDiff");
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
