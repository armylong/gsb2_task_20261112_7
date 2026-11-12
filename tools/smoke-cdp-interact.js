/**
 * smoke-cdp-interact.js —— 交互细节冒烟测试
 * 覆盖：滑块拖拽改分割线、叠加透明度、缩放/像素网格、重新导入重置
 */
import { runCase } from "./smoke-helpers.js";

await runCase({
  name: "交互细节",
  urlA: "/samples/group1_gameplay/scene_a_v1.png",
  urlB: "/samples/group1_gameplay/scene_b_v2.png",
  async extraChecks(evalJs, sleep) {
    const out = {};

    // 1. 滑块拖拽：模拟在视图右侧按下并拖动，split 应从 0.5 变大
    const splitBefore = await evalJs(`window.__diffChecker.getState().split`);
    await evalJs(`(() => {
      const vp=document.getElementById('viewport');
      const r=vp.getBoundingClientRect();
      function ev(t,x,y,buttons){ vp.dispatchEvent(new MouseEvent(t,{bubbles:true,clientX:r.left+x,clientY:r.top+y,button:0,buttons:buttons??1})); }
      function wev(t,x,y,buttons){ window.dispatchEvent(new MouseEvent(t,{bubbles:true,clientX:r.left+x,clientY:r.top+y,button:0,buttons:buttons??1})); }
      ev('mousedown', 400, 300);
      wev('mousemove', 700, 300);
      wev('mouseup', 700, 300, 0);
    })()`);
    await sleep(150);
    out.splitBefore = splitBefore;
    out.splitAfter = await evalJs(`window.__diffChecker.getState().split`);
    out.splitSliderValue = await evalJs(`document.getElementById('split').value`);

    // 2. 叠加透明度改变会重渲染且不报错
    await evalJs(`document.querySelector('[data-view="overlay"]').click()`);
    await evalJs(`(() => { const o=document.getElementById('overlay-opacity'); o.value=80; o.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(150);
    out.overlayOpacity = await evalJs(`window.__diffChecker.getState().overlayOpacity`);

    // 3. 缩放到 800% 以上出现像素网格
    await evalJs(`document.querySelector('[data-view="heat"]').click()`);
    for (let i = 0; i < 14; i++) await evalJs(`document.getElementById('btn-zoom-in').click()`);
    await sleep(150);
    out.zoom = await evalJs(`window.__diffChecker.getState().zoom`);
    out.pixelGridVisible = await evalJs(`!!document.querySelector('.pixel-grid')`);
    await evalJs(`document.getElementById('btn-zoom-fit').click()`);
    out.zoomAfterFit = await evalJs(`window.__diffChecker.getState().zoom`);

    // 4. 像素检查器：移动鼠标后出现 rgba 文案
    await evalJs(`(() => {
      const vp=document.getElementById('viewport');
      const r=vp.getBoundingClientRect();
      window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:r.left+300,clientY:r.top+200}));
    })()`);
    await sleep(100);
    out.pixelInspectorText = (await evalJs(`document.getElementById('pixel-info').textContent`)).slice(0, 60);

    // 5. 重新导入同一张 A 图：流水线应重跑且不残留旧 ROI
    await evalJs(`(() => {
      // 先建一个 ROI
      document.getElementById('roi-draw-mode').checked=true;
      const vp=document.getElementById('viewport');
      const r=vp.getBoundingClientRect();
      vp.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+100,clientY:r.top+100,button:0,buttons:1}));
      window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:r.left+200,clientY:r.top+180,button:0,buttons:1}));
      window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:r.left+200,clientY:r.top+180,button:0,buttons:0}));
    })()`);
    await sleep(150);
    out.roiBeforeReimport = await evalJs(`window.__diffChecker.getState().rois.length`);
    await evalJs(`(async () => {
      const buf = await fetch('/samples/group1_gameplay/scene_a_v1.png').then(r=>r.arrayBuffer());
      const f = new File([buf], 'scene_a_v1.png', {type:'image/png'});
      const dt = new DataTransfer(); dt.items.add(f);
      const inp = document.getElementById('file-a');
      inp.files = dt.files; inp.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      const logs = await evalJs(`[...document.querySelectorAll('#log-list li .msg')].map(e=>e.textContent)`);
      if (logs.filter((l) => l.includes("差异计算完成")).length >= 2) break;
    }
    out.roiAfterReimport = await evalJs(`window.__diffChecker.getState().rois.length`);
    out.stillWorking = await evalJs(`!document.getElementById('progress-overlay').classList.contains('hidden')`);

    return out;
  },
});
