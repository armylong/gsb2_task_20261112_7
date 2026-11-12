/**
 * smoke-cdp-mismatch.js —— 尺寸不一致 + 透明通道场景冒烟测试
 * 加载 group2_ui（360×240 vs 380×252，带 alpha），验证：
 *   尺寸警告条、三种对齐模式、未覆盖蓝色区域、alpha 不误报、报告 sizeMismatch=true
 */
import { runCase } from "./smoke-helpers.js";

await runCase({
  name: "尺寸不一致+透明通道 (group2_ui)",
  urlA: "/samples/group2_ui/panel_a_v1.png",
  urlB: "/samples/group2_ui/panel_b_v2.png",
  async extraChecks(evalJs, sleep) {
    const out = {};
    // 1. 警告条可见且文案含两图尺寸
    out.alertVisible = await evalJs(`!document.getElementById('size-alert').classList.contains('hidden')`);
    out.alertText = await evalJs(`document.getElementById('size-alert-text').textContent`);
    // 2. 报告 sizeMismatch
    const report = await evalJs(`window.__diffChecker.getJsonReport()`);
    out.reportMismatch = report.images.sizeMismatch;
    out.reportSizeA = report.images.imageA.width + "x" + report.images.imageA.height;
    out.reportSizeB = report.images.imageB.width + "x" + report.images.imageB.height;
    out.hasAlphaA = report.images.imageA.hasAlpha;
    out.canvasSize = report.alignment.canvasSize.width + "x" + report.alignment.canvasSize.height;
    out.scaleB = JSON.stringify(report.alignment.scaleB);
    // 3. 热图中未覆盖蓝色像素数量（contain 模式应有未覆盖区）
    await evalJs(`document.querySelector('[data-view="heat"]').click()`);
    await sleep(200);
    out.blueUncovered = await evalJs(`(() => {
      const c=document.getElementById('view-canvas');
      const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let n=0; for(let i=0;i<d.length;i+=4){
        // UNCOVERED_COLOR = (58,96,168)，容差匹配
        if(Math.abs(d[i]-58)<12 && Math.abs(d[i+1]-96)<12 && Math.abs(d[i+2]-168)<12 && d[i+3]>100) n++;
      }
      return n;
    })()`);
    // 4. 切到 overlap 模式：画布应缩小为 360x240
    await evalJs(`document.querySelector('input[value="overlap"]').click()`);
    await sleep(400);
    out.overlapCanvas = await evalJs(`document.getElementById('view-canvas').width + 'x' + document.getElementById('view-canvas').height`);
    const report2 = await evalJs(`window.__diffChecker.getJsonReport()`);
    out.overlapMode = report2.alignment.mode;
    // 5. 切 stretch
    await evalJs(`document.querySelector('input[value="stretch"]').click()`);
    await sleep(400);
    const report3 = await evalJs(`window.__diffChecker.getJsonReport()`);
    out.stretchScale = JSON.stringify(report3.alignment.scaleB);
    // 6. 回到 contain + 热图，截图肉眼检查未覆盖蓝区
    await evalJs(`document.querySelector('input[value="contain"]').click()`);
    await sleep(400);
    await evalJs(`document.querySelector('[data-view="heat"]').click()`);
    await sleep(200);
    return out;
  },
  shotPath: "/tmp/diff-shots/mismatch-heat.png",
});
