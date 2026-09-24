# pi-footer

输入框上边框的**唯一 owner**：session name 与实时 TPS 统计行都画在这一行上，与 pi 原生的 working / compaction / retry / branchSummary spinner 共用同一行。

```
工作中  ── ⠼ Working ⚡42t/s 🔧3 ⏱1.2s 🧠12 ⏳2.1s──────────────── feat/auth ─
输入框  │ 在这里打字…                                                     │
        ──────────────────────────────────────────────────────────────────
空闲    ──⚡42t/s 🔧3 ⏱1.2s 🧠12 ⏳2.1s─────────────────────────── feat/auth ─
无内容  ──────────────────────────────────────────────────────────────────
```

- 左边是 pi 的内联 status（`── ⠼ Working `）+ **stats 行**（从 [pi-tps](https://github.com/summertime-wu/pi-tps) 收编）；右边是 session name（`/name` 设置的，Claude Code 风格），中间全是 dash 补白，整条上边框是一条连续的线。
- 没有 status 时（空闲/等待），stats 前面自己带 `──` 两列前导 dash，这样空闲态和工作中左端起点一致，stats 也不会贴到边框端点。没有 stats 时（run 还没产出数据）则整行是原生 dash。
- name 自身两侧各留一个空格做呼吸，外侧再接收尾的一列 `─`。
- **多行瀑布时间轴已移除** —— 单行边框放不下。
- **不显示 `↑`/`↓` token 计数**：pi 自己的 footer 就在下面一行报同样的数字（还带 cache 命中率），重复没意义。tracker 仍在计算这两个 run 累计（单测守住语义），要重新画只需在 `statsSegments` 里加回一个段。
- 空闲（`agent_end` 之后）：保留上一轮的数值，整行转 muted；`agent_start` 时清空，不会拿上一轮的数字冒充本轮。
- run 还没产出任何数据、且没有 session name 时，整行就是原生 dash，和没装本扩展一样。
- 编辑器内容滚动（输入超过屏高 30%）时交回 pi 原生渲染，此时上边框是 `↑ n more`，name 与 stats 都不显示（这是有意的：滚动指示比 name 重要）。

## 配置

`<Pi agent dir>/pi-footer.json`（默认 `~/.pi/agent/pi-footer.json`；设置 `PI_CODING_AGENT_DIR` 时跟随该目录）。文件不存在则用默认值，改动通过 `/pi-footer` 写入；保存失败会报错，当前会话仍应用新值，下一次成功保存时会一并写入：

```json
{
  "showStats": true,     // 关闭后边框只剩 session name
  "showTtft": true,      // 是否显示 ⏱ TTFT 段
  "colorPreset": "theme" // theme 跟随 pi 主题；其余为 256 色预设
}
```

`/pi-footer` 命令提供三个开关，预设子菜单带 4 色 swatch。预设名单（继承 pi-tps）：`morandi` `forest` `ocean` `retro` `ice` `dusk` `mono` `nord`。

## 窄屏降级

宽度是严格守恒的（永远等于终端宽度）。空间不够时按下面的顺序**丢段**，视觉顺序不变、不重排：

| 顺序 | 丢掉的段 | 含义 |
|-----|---------|------|
| 1 | `⏳2.1s` | 当前 LLM 调用耗时 |
| 2 | `🧠12` | thinking tokens |
| 3 | `🔧3` | 本 run 工具调用数 |
| 4 | `⏱1.2s` | TTFT（受 `showTtft` 开关） |
| 5 | `⚡42t/s` | 核心，整个 stats 段消失 |

保底优先级：**session name → working spinner → stats**。给的宽度放不下完整 `Working` 文案时，status 先退化成只有 spinner（与 pi 原生行为一致）；stats 会在 status 之前被削掉。

## 统计口径

| 段 | 定义 |
|----|------|
| `⚡Nt/s` | 当前消息的生成速率（首字之后 → `now`），再做 EMA（0.15 权重、80ms 节流）平滑。EMA **在每条消息的 `messageStart` 清零**，所以显示的永远是这一条消息自己的速率；分子与窗口同窗（thinking→text 不重置计时，也不把已计入的 thinking token 踢出分子）；`message_end` 用整条消息的窗口重算并**替换** EMA（冻结值≈这条消息的真实均值）。新消息拿到第一个样本之前，**继续显示上一条消息的速率**（不会退回 `⚡…`） |
| `🔧` | 本 run 的工具调用次数 |
| `⏱` | TTFT = 首个内容（正文、thinking 或工具参数）到达 − `before_provider_request` 时刻 |
| `🧠` | 当前消息 thinking 字符数 / 4 |
| `⏳` | 当前 LLM 调用耗时（请求发出 → `message_end`） |

TTFT 与耗时都按「本条消息的请求发出时刻」计算，因此消息结束后数值冻结、不会随 `now` 继续增长。TTFT 以**有内容**的首个 thinking / 正文 / 工具参数为准（pi 会先建一个空的 thinking 块，不能把它当首字）。

**同一 run 内换消息不留空档**：`⚡` / `⏱` / `🧠` 在新消息有自己的数之前沿用上一条消息的值（prefill、工具执行后的等待期间都保持），`⏳` 则立刻切到新请求的计时。`🧠` 在新消息开始出正文/工具参数且没有 thinking 时才清掉。`agent_start` 会把这些沿用值一并清空——跨 run 不保留。

token 在流式期间按字符估算（thinking /4、正文与工具参数 JSON /3.5），且**展示与 tps 共用同一个数**（不会一个用上报值、一个用估算值）。上报值不是无条件优先：`usage.output` 是真实 token 数、估算值是字符除以系数，**两者单位不同、不做数值比较**，判断标准是「这个计数还新不新鲜」——只有被**修订**（值变了）且此后**没有新内容**到达时才采用。所以 Anthropic 在 `message_start` 给的占位 `output_tokens: 1`（pi 在它被修订前，每个 delta 递的都是同一个计数）不会把计数和速率钉死在这一条上；代价是「只修订过一次就停住」的上报值会被估算接管，直到它再次修订。`message_end` 时：被修订过的上报值作为最终样本；未被修订的占位值继续使用估算来冻结展示与 tps。run 累计仍只使用 provider 上报值，估算值不会混入后续消息的累计。

## 已知限制 / 踩过的坑（别退回去）

- **边框只有一行**：任何多行内容都进不来（这正是砍掉瀑布的原因）。
- 所有宽度计算必须走 `visibleWidth`：Emoji（`⚡🔧🧠⏳`）算 2 列，用 `.length` 会少算。
- stats 只在 delta 到达时刷新（80ms 节流）。空闲时数值静止是有意的（空闲态显示的就是冻结值）；工作期间边框靠 pi 自身的 `Loader`（每 80ms `ui.requestRender()`）重绘，不需要额外定时器。
- 原实现的 `renderTopBorder` 在 `width=66` 时只画 65 列（`room = width - labelWidth - 1` 的 off-by-one），本次一并修正；宽度守恒由单测在 1..150 列上守住。
- **工具参数也是生成的 token**：`toolcall_delta` 必须计入分子。漏掉它时，纯工具调用的消息（比如大段 `write`）整条都只显示 `⚡…`，带 thinking 的消息则分子停涨、分母照走，速率一路下滑。
- **速率是「当前消息」的速率**：EMA 在 `messageStart` 清零（展示层靠 `heldTps` 沿用旧值，别为了「不闪」把 EMA 改回不清零）、分子与窗口同窗、`message_end` 用整条消息重算。别把 EMA 改成跨消息累积，也别让窗口在 thinking→text 时重置（前者会拖进上一条消息的速率，后者会在分母掉回 100ms 下限时把分子里的 thinking token 放大成尖峰）。
- 只有 `session_start` 里设置一次编辑器组件；`/reload` 会重新走这条路径，实测改动 `index.ts` 与 `tps.ts` 都能被 `/reload` 拾取。
- 不要在其他扩展里调 `ctx.ui.setEditorComponent`，会把本扩展顶掉。

## 测试

```bash
npm run test:footer            # 纯逻辑单测（node --test + tsx）
npm run typecheck              # 仓库级 tsc（本扩展 0 报错）
```

纯逻辑都在 `tps.ts`（不 import pi 运行时）：`TpsTracker` 的时序全部以 `now` 入参注入，`composeTopBorder` 是纯排版函数。

## 验证记录（2026-09-21 第二轮：stats 左置 + 去掉 ↑↓）

> 布局在这轮定型：stats 从右侧挪到左侧（紧跟 status，空闲时自带 `──` 前导），并不再显示 `↑↓`。下面是本轮改动的验证；第一轮（右置 + `↑↓`）的记录保留在下一节，其中**统计口径、事件接线、降级顺序的结论仍然有效**，只有行文里的示例字符串是旧版式。

单测 26 项全过（新增「核心替代 ↑↓ token 段」与「空闲 stats 带 `──` 前导」两条）；纯函数排版在 30 / 45 / 60 / 80 / 100 / 130 / 150 列逐档渲染，宽度全部严格等于终端宽度，降级顺序为 `⏳ → 🧠 → 🔧 → ⏱ → 整段消失`，`Working` 文案与 session name 在逐档收窄中始终保住：

```
150 ── ⠼ Working ⚡42t/s 🔧3 ⏱1.2s 🧠12 ⏳2.1s──────────────────────── feat/auth ─
 60 ── ⠼ Working ⚡42t/s 🔧3 ⏱1.2s 🧠12 ⏳2.1s────── feat/auth ─
 45 ── ⠼ Working ⚡42t/s 🔧3 ⏱1.2s─── feat/auth ─
空闲 ──⚡42t/s 🔧3 ⏱1.2s 🧠12 ⏳2.1s────────────────────────── feat/auth ─
```

界面本身由用户在真实会话里自行确认（本轮不再做 tmux 抓屏）。

## 验证记录（2026-09-21 第一轮：stats 右置 + ↑↓，pi 0.86.1）

单测 25 项全过：TpsTracker 时序（TTFT / think tokens / run 累计 / 冻结 / 换消息清零 / 忽略 turn 外的请求时刻 / 100ms 窗口下限 / `message_end` 的最终样本不被节流吞掉 / 上报值与估算值的一致性 / 估算不进入累计）、降级顺序（逐步丢段到只剩核心、核心也放不下或只剩占位符则整段消失）、边框宽度在 1..150 列 × 有无 name × 有无 status × 有无 stats 全部守恒。

实现完成后跑过一轮独立 review（对照上游源码逐条核），修掉了 6 个问题：最终 TPS 样本被 80ms 节流吞掉、展示与 tps 用了不同的 token 来源、窗口下限写成 50ms（上游等效是 100ms）、空 thinking 块导致 TTFT 偏小、估算值混进 run 累计、降级后只剩 `⚡…` 占位符。

tmux 实机（`pi -ne -e extensions/pi-footer/index.ts -n feat/auth`，150 / 60 / 42 / 30 列；**行文中的示例是当时右置 + `↑↓` 的版式**）：

- 150 列工作中 `── ⠼ Working ── ⚡177t/s ↑7.2k ↓132 🔧1 🧠24 ⏳1.1s  feat/auth ─`；空闲同内容转 muted（ANSI 全是 `38;2;128;128;128`）；name 是主题 accent、边框是 thinking 边框色 ✓
- 60 列 `── ⠏ Working ────⚡20t/s ↓13 ⏱0.7s 🧠13 ⏳0.8s  feat/auth ─`（status 保住）；stats 变宽时优先丢 `⏳`，不动 name 与 spinner ✓
- 42 列 `── ⠼ Working ───⚡171t/s  feat/auth ─`；30 列无 name `───⚡21t/s ↑193 ↓44 ⏱0.5s 🧠4─` ✓
- 无 session name：`── ⠋ Working ───⚡73t/s ↓73 ⏱0.8s 🧠11 ⏳1.6s─` ✓
- 多行输入触发滚动 → 上边框变 `↑ 2 more`（原生接管）✓
- 每帧用 `visibleWidth` 校验等于面板宽度：150 列与 60 列各 14 帧全部 OK ✓
- 布局按用户 2026-09-21 的两轮反馈定型：stats 从右侧挪到左侧（紧跟 status，空闲时带 2 列前导 dash），并去掉 `↑↓`；纯函数渲染在 30/45/60/80/100/130/150 列校验宽度仍严格守恒 ✓
- 配色：theme 模式实测 `core=text / ↓=success / ⏱=warning / 🧠=thinkingText / ⏳=dim`；`morandi` 预设实测 `252/108/180/103/244`；空闲统一 muted ✓
- `/pi-footer`：三个选项可切换并写入配置（实测关掉 `showStats` 后边框只剩 name），预设子菜单 4 色 swatch 正常 ✓
- `/reload`：分别给 `index.ts`（`showTtft` 默认值）和 `tps.ts`（`🔧`→`⚙` 标记）打标记后 `/reload`，两者都生效，编辑器重新注册后边框继续工作 ✓
- 全程无 pi-footer 相关报错
