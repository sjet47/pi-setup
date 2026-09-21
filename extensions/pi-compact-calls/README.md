# pi-compact-calls

把连续的内置工具调用（`read` / `bash` / `edit` / `write` / `find` / `grep` / `ls`）折叠成一个紧凑块。

一轮里连续的工具调用（中间没有可见正文）合成一块，折叠态只占 3 行：

```
 ⠋ 3 tool calls · 6.1s
 ⠋ bash: sleep 3 && echo one (3.0s)
 … 2 more calls (Ctrl+O to expand)
```

`Ctrl+O` 展开后逐个工具一行，每行下面带结果预览（默认最多 5 行）：

```
 ✓ 3 tool calls · 6.1s
 ├ ✓ bash: sleep 3 && echo one (3.0s)
 │     one
 ├ ✓ bash: echo two (0.0s)
 │     two
 └ ✓ bash: ls /tmp | head -3 (0.0s)
       0qpUhMQtfbKra2Kkobvzb
       alma-logs
       atuin-1000
```

原生渲染同样的三次调用要占约 24 行（每次：空行 / `$ cmd` / 空行 / 输出 / 空行 / `Took X.Xs` / 空行）。

## 行为

| 情况 | 渲染 |
|---|---|
| **一轮里连续**（中间没有可见正文）的工具调用 | 合成一块 —— 同一条消息里的并行批、跨多条消息的多步调用都算；块头显示 `N tool calls · total` 与状态（`⠋` 进行中 / `✓` 全部成功 / `✗` 有失败） |
| 块里显示哪个调用 | 优先**正在跑**的那个（多个 pending 取最新的）；全部跑完则显示最后一个 |
| 只有 1 个工具 | 不加块头，直接一行 `⠋ bash: sleep 25 && echo one (17.5s)` |
| 出现可见正文 / 新用户消息 / 非内置工具 | 结束当前块，之后的工具调用另起一块 |
| 折叠态 | 块头 + 1 个工具行 + `… N more calls (Ctrl+O to expand)` |
| 展开态（`Ctrl+O`） | 每个工具一行（带树杈）+ 结果预览（最多 5 行 + `… N more lines`），运行中也能看到流式输出 |
| 恢复历史会话 / `/tree` / `/reload` 重放 | 重放的工具行没有实时事件，无法分块，退化成单行紧凑行（`✓ bash: echo A`） |
| thinking | 完全不碰，继续由 pi 原生渲染成 `Thinking...` 行（可点击展开全文） |

### 为什么跨消息合并、只在正文处断开

历史教训：第一版就是跨消息合并，但折叠态当时显示的是「最早的 3 个工具」，于是后来加入的工具渲染成 0 行、位置错位、活动被截断在计数里 —— 被当成 bug 报了回来。改成「一条 assistant 消息 = 一块」后合并不再发生，又不满足需求（要的是「一轮里连续的工具调用合为一条」）。

最终形态 = 跨消息合并 **+** 折叠态只显示「正在跑 / 最新」那一个：块变成一条随流程持续更新的活动行，当初「看不到当前在干什么」的根因消失。

两个**不能**用来做断点的信号（若以后想改回去）：

- `message_end(assistant)` 在工具开始执行**之前**触发 → 会把同一批并行调用拆散；
- `message_start(tool_result)` 会插在批内工具执行之间 → 同样拆散并行批次。

## 实现要点

- **不 patch 任何 prototype**。分块靠「leader 行」：每组第一个工具行渲染整块，其他成员渲染 0 行。
- 0 行必须配合 `renderShell: "self"`：默认 shell 下即使内容为空，`ToolExecutionComponent` 自带的 `Spacer(1)` 仍会留下一个空行。
- 工具定义用 `{ ...createXTool(cwd), renderShell: "self", renderCall, renderResult }` 注册，因此 **description / promptSnippet / promptGuidelines / constrainedSampling 和原生 execute 全部保留**，只替换渲染。（对照：pi-compact-ui 手写定义，把描述退化成 `Built-in bash (rendering handled by compact-ui group)`，并丢掉 0.86.1 的 strict JSON-schema 采样。）
- pi 每帧全量重渲染整棵树、不做 dirty 跳过，所以 leader 会自动带上后加入的工具；重绘由 pi 自己的工具事件 + 我们的 spinner 定时器（100ms）驱动，定时器复用 `context.invalidate()`（内部已调 `ui.requestRender()`），因此**不需要通过 widget 去偷 TUI 实例**。
- 分块边界：`message_start(user)`（新的一轮 ⇒ 新块）、`tool_execution_start` 里非内置工具名（⇒ 断块）、出现可见正文（`text_*` 事件且对应块非空 ⇒ 断块）；`agent_end` 也封口。assistant 消息边界**不**断开。

## 已知限制

- 重放的历史工具行渲染成单行紧凑行（没有实时事件可用于分组），不是原生多行样式。
- 重放行的展开态（`Ctrl+O`）依赖 `renderCall` 的 `context.expanded`，`isError` 依赖 `context.isError`（重放时也可用）；但 `renderResult` 拿到的 result 对象**不含** `isError`，不要用它覆盖状态。
- 块上**点击**展开依赖该行的 result 已经存在（pi 的 `createResultRegion` 先判 `this.result`），所以第一个工具还在跑时点击无效；`Ctrl+O` 任何时候都好用。
- 非内置工具不参与分块（我们只能控制自己注册的工具行）。
- 行数阈值：结果预览 `EXPANDED_RESULT_LINES = 5`、摘要 `SUMMARY_MAX_CHARS = 60`、结果保留 `RESULT_TEXT_LIMIT = 4000`（都是源码顶部常量）。折叠态固定只显示 1 个工具行，没有对应常量。
- 主题从 renderer 参数里取最新值（pi 没有主题切换事件），切换主题后需等一次重绘才刷新。
- 未实现 pi-compact-ui 的 `worked for Xs` 分隔线、compaction 行紧凑化、代码围栏面板美化 —— 这些要么需要额外 patch，要么与折叠无关。

## 验证记录（2026-09-21，pi 0.86.1）

tmux 实机跑 `pi -ne -e extensions/pi-compact-calls/index.ts`：

- 一条消息内并行 4 次 bash → 单块 5 行（块头 + 4 行，全部显示）✓（旧版行为，现折叠态只留最新 1 行）
- 3 步各占一条消息、中间无可见正文 → **合成为一块**（`✓ 3 tool calls · 1.8s` + 正在跑/最新一行 + `2 more calls`）✓
- 中间插入可见正文 → 断成两块（`echo K1` / 正文 / `echo K2`）✓
- 并行批里有一个 `sleep 20` 且不是最后一个 → 运行中显示仍在跑的那一个；全部完成后回落到最后一个 ✓
- 一条消息内并行 5 次 bash → 运行中 `⠋ 5 tool calls · 15.1s` + `✓ bash: echo N5` + `… 4 more calls (Ctrl+O to expand)`；完成后 `✓ 5 tool calls · …` 稳定不消失；`Ctrl+O` 展开显示全部 5 个 ✓
- 两条消息各 1 次 bash（中间无可见正文）→ **两行**，各自成块，无块头 ✓
- 两批各 4 个并行调用（中间无可见正文）→ **两个独立的 4 次块**（修复前会并成一块 8 次）✓
- 文本 → 工具 → 文本 → 工具（同一轮）→ 两个块，位置正确 ✓
- 失败命令（`cd /nonexistent-dir-xyz`）→ 块头与工具行显示 `✗`，展开可见 `Command exited with code 1` ✓
- 64 列窄终端 → 截断正常 ✓
- `-c` 恢复历史会话 → 历史行退化成单行紧凑行，无跨轮巨型块 ✓
- 中间夹 `dummy_echo`（非内置）→ 断成两块，dummy 保持原生渲染 ✓
- 新会话的系统提示里 `- bash: Execute bash commands (ls, grep, find, etc.)` 仍是原生描述；reload 时 pi 记录的 `toolsAdded` 里带 `constrainedSampling` ✓
