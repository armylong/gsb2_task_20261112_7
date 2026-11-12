# 游戏版本画面差异检查工具

本地运行的网页工具，用于对比同一场景两个版本的游戏截图，快速定位画面改动。
**纯静态页面、零运行时依赖、图片不出本机**，不使用 Docker。

## 启动方式

需要本机有 Python 3（macOS 自带）。在仓库根目录执行：

```bash
python3 -m http.server 8000
```

然后浏览器打开：

```
http://127.0.0.1:8000/app/index.html
```

> 必须通过 http 服务打开，不要直接双击 `index.html`（`file://` 下 Web Worker 和
> `fetch` 示例图会被浏览器安全策略拦截）。
> 换端口：`python3 -m http.server 9000`。
> 也可以用 Node：`npx serve .` 或 `npx http-server -p 8000`。

打开后点击右上角 **「载入内置示例」** 即可立即看到滑块、叠加、热图三种效果。

## 功能一览

| 需求 | 实现方式 |
| --- | --- |
| 不只是左右展示 | 三种视图：**滑块对照**（可拖拽分割线）、**半透明叠加**（可调不透明度）、**差异热图** |
| 尺寸不一致提示 + 按比例对齐 | 顶部黄色警告条明确显示两图尺寸；提供三种对齐：等比缩放（默认）、原始尺寸左上对齐、拉伸填满；未重叠区域用冷蓝色标记为「未覆盖」 |
| 透明通道不误报 | 两像素都全透明时差异为 0；其余像素预合成到中性灰背景后比较；alpha 变化单独加权（可调，默认 0.35） |
| 色彩空间处理 | 浏览器统一解码为 sRGB 8bit，比较前转线性光（gamma 2.4）并按 Rec.709 权重加权，暗部噪点不会与亮部改动同量级 |
| 轻微整体亮度变化不误报 | 默认开启亮度归一化：按两图有效像素平均亮度计算补偿系数（限制在 0.5–2），只保留结构性/颜色性差异，可一键关闭对照 |
| 阈值可调 | 0–60% 滑块实时重算（diff 数组只算一次，调阈值零重算开销）；低于阈值的像素在热图中可压暗保留结构或完全隐藏 |
| 框选 ROI | 勾选「拖拽框选模式」后在画面上拖框，每个 ROI 独立统计差异占比/均值/最大值，可单独删除 |
| 放大到像素 | 滚轮以鼠标为锚点缩放（5%–3200%），800% 以上显示像素网格；像素检查器实时显示该坐标 A/B 的 RGBA 值与差异值 |
| 真实处理状态 | 两张图各自有独立状态灯（读取进度% → 解码 → 完成/失败）；Worker 计算有进度条；底部时间戳日志记录每一步耗时 |
| 导出 | **PNG 报告**（A/B/当前视图三缩略图 + 指标卡 + 热图图例 + ROI 表）和 **JSON 报告**（完整元数据与分档统计） |

### 热图色带

低差异 → 高差异：暗红 → 红 → 橙红 → 橙 → 琥珀 → 亮黄。
色带经过 OKLCH 校验，明度从 0.32 单调升到 0.89，主要靠明度编码差异大小
（色盲友好），未覆盖区域固定为冷蓝色与暖色热图区分。

## 内置示例截图

`tools/generate_samples.py` 生成（零依赖，纯标准库 PNG 编码），已预生成在 `samples/`：

```
samples/
├── group1_gameplay/        # 实机画面，520×300，全不透明
│   ├── scene_a_v1.png      # 旧版本
│   └── scene_b_v2.png      # 新版本：角色位移/新增敌人/平台材质变化/HUD 变化/云移动
│                           #         + 整体 +8% 亮度 + 随机噪点（验证反误报）
└── group2_ui/              # UI 弹窗，带透明通道且两图尺寸不同
    ├── panel_a_v1.png      # 360×240
    └── panel_b_v2.png      # 380×252（验证尺寸警告与等比对齐、alpha 处理）
```

第二组示例的用法：分别把 `group2_ui` 下两张图拖入 A/B 导入区，
顶部会出现尺寸不一致警告，切换三种对齐方式观察「未覆盖」蓝色区域的变化。

重新生成示例：

```bash
python3 -I tools/generate_samples.py
```

## 报告字段（JSON）

- `images`：两图文件名、尺寸、是否含 alpha、色彩空间、各自加载耗时
- `alignment`：对齐模式、对齐画布尺寸、两图缩放系数/偏移/宽高比
- `settings`：阈值（小数与百分比）、亮度归一化开关与补偿系数、alpha 权重、子阈值处理模式
- `stats`：总/有效/未覆盖/差异像素数、**差异像素占比**、平均/最大差异、7 档差异强度分布
- `regions`：每个 ROI 的矩形坐标与独立统计
- `heatmap`：色带色值、未覆盖色、编码说明
- `timings` / `processingLogs`：各阶段耗时与带时间戳的处理日志

## 目录结构

```
app/
├── index.html        页面结构
├── styles.css        深色主题
├── main.js           主控：导入/调度/视图/ROI/缩放/导出
├── align.js          几何对齐与覆盖掩码
├── diff-core.js      差异算法核心（无 DOM 依赖，可在 Node 测试）
├── heatmap.js        热图渲染与色带
├── worker-diff.js    Web Worker 包装（后台计算 + 进度回报）
└── report.js         JSON/PNG 报告生成
samples/              两组示例截图
tools/
├── generate_samples.py  示例图生成器
├── test-diff-core.js    算法单元测试（28 项）
└── smoke-cdp.js         浏览器端到端冒烟测试（需无头 Chrome）
```

## 测试

```bash
# 算法单元测试：亮度补偿 / 透明通道 / 噪点抑制 / 阈值 / ROI / 未覆盖像素
node tools/test-diff-core.js
```

浏览器端到端冒烟测试（验证 Worker、三视图、ROI、报告导出、尺寸不一致、透明通道、JPEG 上传，无控制台错误）：

```bash
# 1. 启动服务
python3 -m http.server 8123
# 2. 另开终端启动无头 Chrome
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-diff about:blank
# 3. 依次运行（或 node tools/smoke-cdp.js 单独跑主流程）
node tools/smoke-cdp.js            # 主流程：示例/三视图/ROI/阈值/报告
node tools/smoke-cdp-mismatch.js   # 尺寸不一致 + alpha + 三种对齐
node tools/smoke-cdp-interact.js   # 滑块拖拽/透明度/像素网格/重新导入
node tools/smoke-cdp-jpeg.js       # JPEG 真实文件上传（自动用 sips 造临时文件）
```

> 冒烟脚本通过 Chrome DevTools Protocol 驱动真实浏览器，WS 客户端用 Node 内置
> `net`/`crypto` 手写，整个项目零第三方依赖。

## 支持的图片格式

PNG / JPG / WebP / BMP（浏览器原生解码能力）。浏览器解码后统一为 sRGB 8bit
RGBA 位图参与计算；JPEG 无 alpha 通道，会在导入卡片中标注。
