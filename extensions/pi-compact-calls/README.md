# pi-compact-calls

把连续的内置工具调用（`read` / `bash` / `edit` / `write` / `find` / `grep` / `ls`）折叠成一个紧凑块：

```
 ⠋ 3 次工具调用 · 6.1s
 ├ ✓ bash: sleep 3 && echo one (3.0s)
 ├ ✓ bash: echo two (0.0s)
 └ ✓ bash: ls /tmp | head -3 (0.0s)
```

原生渲染同样的三次调用要占约 24 行（每次：空行 / `$ cmd` / 空行 / 输出 / 空行 / `Took X.Xs` / 空行）。折叠后是 4 行，`Ctrl+O` 展开可在每个工具下面看到结果前 5 行。

## 行为

| 情况 | 渲染 |
|---|---|
| **同一条 assistant 消息**里的并行工具调用 | 合成一个块，块头显示 `N 次工具调用 · 总耗时` 与状态（`⠋` 进行中 / `✓` 全部成功 / `✗` 有失败） |
| 只有 1 个工具的消息 | 不加块头，直接一行 `⠋ bash: sleep 25 && echo one (17.5s)`（单工具下块头只是噪声） |
| 后续消息里的工具 | **另起一块**（每块 = 一条 assistant 消息）—— 块总是画在该批工具真实发生的位置 |
| 折叠态上限 | 最多 3 个工具行；恰好剩余 1 个时直接显示它（「… 另有 1 次」本身也占一行） |
| 展开态（`Ctrl+O`） | 每个工具下追加结果预览（最多 5 行 + `… 另有 N 行`），运行中也能看到流式输出 |
| 中间夹了非内置工具（MCP、subagent 等） | 断开分块，那个工具保持原生渲染 |
| 恢复历史会话 / `/tree` / `/reload` 重放 | 重放的工具行没有实时事件，无法分块，退化成单行紧凑行（`✓ bash: echo A`） |
| thinking | 完全不碰，继续由 pi 原生渲染成 `Thinking...` 行（可点击展开全文） |

### 为什么按「一条 assistant 消息 = 一块」切

早先的规则是「跨消息合并，只有可见正文才分界」，实测出两个真问题：

1. 块只画在**组内第一个工具行**的位置，后一条消息的工具渲染成 0 行 → 它们在 transcript 里的位置变成空白，活动记录被挤到块头的 `… 另有 N 次` 里；
2. 长 agentic 运行会累积成一个巨块，里面还只显示最早的工具，看不到当前在干什么。

所以分块边界改为 assistant 消息本身。正确信号是 `message_start(assistant)`：它在该消息内容（和工具行）出现之前触发。两个**不能用**的信号：

- `message_end(assistant)` 在工具开始执行之前触发 → 会把同一批并行调用拆散；
- `message_start(tool_result)` 会插在批内的工具执行之间 → 同样会拆散并行批次。

## 实现要点

- **不 patch 任何 prototype**。分块靠「leader 行」：每组第一个工具行渲染整块，其他成员渲染 0 行。
- 0 行必须配合 `renderShell: "self"`：默认 shell 下即使内容为空，`ToolExecutionComponent` 自带的 `Spacer(1)` 仍会留下一个空行。
- 工具定义用 `{ ...createXTool(cwd), renderShell: "self", renderCall, renderResult }` 注册，因此 **description / promptSnippet / promptGuidelines / constrainedSampling 和原生 execute 全部保留**，只替换渲染。（对照：pi-compact-ui 手写定义，把描述退化成 `Built-in bash (rendering handled by compact-ui group)`，并丢掉 0.86.1 的 strict JSON-schema 采样。）
- pi 每帧全量重渲染整棵树、不做 dirty 跳过，所以 leader 会自动带上后加入的工具；重绘由 pi 自己的工具事件 + 我们的 spinner 定时器（100ms）驱动，定时器复用 `context.invalidate()`（内部已调 `ui.requestRender()`），因此**不需要通过 widget 去偷 TUI 实例**。
- 分块边界：`message_start(assistant|user)`（新消息 ⇒ 新块）、`tool_execution_start` 里非内置工具名（⇒ 断块）、同一条消息内出现可见正文（`text_*` 事件，⇒ 断块）。

## 已知限制

- 重放的历史工具行渲染成单行紧凑行（没有实时事件可用于分组），不是原生多行样式。
- 重放行的展开态（`Ctrl+O`）依赖 `renderCall` 的 `context.expanded`，`isError` 依赖 `context.isError`（重放时也可用）；但 `renderResult` 拿到的 result 对象**不含** `isError`，不要用它覆盖状态。
- 块上**点击**展开依赖该行的 result 已经存在（pi 的 `createResultRegion` 先判 `this.result`），所以第一个工具还在跑时点击无效；`Ctrl+O` 任何时候都好用。
- 非内置工具不参与分块（我们只能控制自己注册的工具行）。
- 行数上限（折叠 3 行 / 展开 5 行 / 摘要 60 字符 / 结果保留 4000 字符）目前是源码顶部常量，没有配置文件。
- 主题从 renderer 参数里取最新值（pi 没有主题切换事件），切换主题后需等一次重绘才刷新。
- 未实现 pi-compact-ui 的 `worked for Xs` 分隔线、compaction 行紧凑化、代码围栏面板美化 —— 这些要么需要额外 patch，要么与折叠无关。

## 验证记录（2026-09-21，pi 0.86.1）

tmux 实机跑 `pi -ne -e extensions/pi-compact-calls/index.ts`：

- 一条消息内并行 4 次 bash → 单块 5 行（块头 + 4 行，全部显示）✓
- 两条消息各 1 次 bash（中间无可见正文）→ **两行**，各自成块，无块头 ✓
- 两批各 4 个并行调用（中间无可见正文）→ **两个独立的 4 次块**（修复前会并成一块 8 次）✓
- 文本 → 工具 → 文本 → 工具（同一轮）→ 两个块，位置正确 ✓
- 失败命令（`cd /nonexistent-dir-xyz`）→ 块头与工具行显示 `✗`，展开可见 `Command exited with code 1` ✓
- 64 列窄终端 → 截断正常 ✓
- `-c` 恢复历史会话 → 历史行退化成单行紧凑行，无跨轮巨型块 ✓
- 中间夹 `dummy_echo`（非内置）→ 断成两块，dummy 保持原生渲染 ✓
- 新会话的系统提示里 `- bash: Execute bash commands (ls, grep, find, etc.)` 仍是原生描述；reload 时 pi 记录的 `toolsAdded` 里带 `constrainedSampling` ✓
