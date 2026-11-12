/**
 * smoke-cdp-jpeg.js —— JPEG（无 alpha）真实文件上传路径测试
 * 运行时用 macOS 自带 sips 把示例 PNG 转成临时 JPEG，测完即删，自包含无外部依赖。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCase } from "./smoke-helpers.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diff-jpeg-"));
const jpgA = path.join(tmp, "sample-a.jpg");
const jpgB = path.join(tmp, "sample-b.jpg");
try {
  // sips 是 macOS 内置图像工具；非 macOS 环境跳过本测试
  try {
    execFileSync("sips", ["-s", "format", "jpeg", "samples/group1_gameplay/scene_a_v1.png", "--out", jpgA], { stdio: "ignore" });
    execFileSync("sips", ["-s", "format", "jpeg", "samples/group1_gameplay/scene_b_v2.png", "--out", jpgB], { stdio: "ignore" });
  } catch {
    console.log("当前环境无 sips（非 macOS），跳过 JPEG 上传测试");
    process.exit(0);
  }

  await runCase({
    name: "JPEG 上传（无 alpha 通道）",
    fileA: jpgA,
    fileB: jpgB,
    async extraChecks(evalJs) {
      const report = await evalJs(`window.__diffChecker.getJsonReport()`);
      return {
        fileA: report.images.imageA.fileName,
        fileB: report.images.imageB.fileName,
        hasAlphaA: report.images.imageA.hasAlpha,
        hasAlphaB: report.images.imageB.hasAlpha,
        colorSpaceA: report.images.imageA.colorSpace,
        sizeA: `${report.images.imageA.width}x${report.images.imageA.height}`,
        changedPercent: report.stats.changedPercent,
        cardStatusA: await evalJs(`document.getElementById('status-a').textContent.trim()`),
      };
    },
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
