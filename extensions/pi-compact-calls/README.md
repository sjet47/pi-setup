# pi-compact-calls

把连续的内置工具调用（`read` / `bash` / `edit` / `write` / `find` / `grep` / `ls`）折叠成一个紧凑块。

一轮里连续的工具调用（中间没有可见正文）合成一块，折叠态只占 2 行 —— 块头 + 一条活动行：

```
 ⠋ 7 tool calls (4 read, 2 grep, 1 bash) · 3.2s · Ctrl+O to expand
 └ ⠋ bash: sleep 3 && echo one (3.0s)
```

有失败时块头直接报数，活动行落在最近失败的那个调用上，并带上错误输出的末行：

```
 ✗ 4 tool calls · 1 failed · 5.0s · Ctrl+O to expand
 └ ✗ bash: cd /nonexistent-dir-xyz (0.0s) — cd: /nonexistent-dir-xyz: No such file or directory (exit 1)
```

`Ctrl+O` 展开后逐个工具一行，每行下面带结果预览；非最后一个工具的预览行延续 `│` rail：

```
 ✓ 4 tool calls (2 bash, 1 read, 1 edit) · 2.1s
 ├ ✓ bash: seq 1 200 (0.0s)
 │   … 195 earlier lines
 │   196
 │   …
 │   200
 ├ ✓ read: poem.txt:10-14 (0.0s)
 │   a patient eye the darkness had not fled.
 │   … 2 more lines
 ├ ✓ edit: poem.txt +2 −0 (0.0s)
 │     1 The Lantern by the Quiet Stream
 │   + 2 second line placeholder
 │   + 3 third line placeholder
 │     2 a vigil kept at the water's edge
 └ ✓ bash: for i in 1 2 3; do … (0.0s)
     1
     2
     3
```

原生渲染同样的三次调用要占约 24 行（每次：空行 / `$ cmd` / 空行 / 输出 / 空行 / `Took X.Xs` / 空行）。

## 行为

| 情况 | 渲染 |
|---|---|
| **一轮里连续**（中间没有可见正文）的工具调用 | 合成一块 —— 同一条消息里的并行批、跨多条消息的多步调用都算 |
| 块头（仅 ≥ 2 个调用） | `图标 N tool calls (类型分布) · M failed · 耗时 · Ctrl+O to expand`。类型分布只在块里混了 ≥ 2 种工具时出现；`M failed` 只在有失败时出现；`Ctrl+O to expand` 只在折叠态出现。宽度不够时按 提示 → 类型分布 → 耗时 → failed 的顺序丢弃，计数永远保留 |
| 块头图标 | `⠋` 有调用在跑；`⠿`（muted，静态，不跑定时器）块还开着但没有调用在跑 = 模型正在生成下一个调用，**此时不显示 `✓`**；块封口后才落定为 `✓` 全部成功 / `✗` 有失败 / `○` 有调用始终没执行 |
| 块头耗时 | 工具执行区间的**并集**（纯工具时间）：并行调用不重复计，消息之间模型生成的时间不计，在跑的调用计到当前时刻 |
| 工具行图标 | `○`（muted）queued：参数还在流式生成 / 排队中 / 最终没执行；`⠋` 执行中；`✓` / `✗` 已有结果 |
| 折叠态显示哪个调用 | **正在跑**的（多个取最新）> **最近失败**的 > 最后一个 |
| 只有 1 个工具 | 不加块头，直接一行 `⠋ bash: sleep 25 && echo one (17.5s)` |
| 出现可见正文 / 新用户消息 / `agent_end` | 结束当前块，之后的工具调用另起一块 |
| 非内置工具 | 在它的位置断块：已执行的留在旧块，还在排队（queued）的内置调用移到新块，视觉顺序与 transcript 一致 |
| 折叠态 | 块头 + 1 条活动行（`└` rail），共 2 行 |
| 展开态（`Ctrl+O`） | 每个工具一行（带树杈）+ 结果预览，运行中也能看到流式输出。`bash` 取**末** 5 行（上方 `… N earlier lines`）；`read`/`grep`/`find`/`ls`/`write` 取前 5 行（下方 `… N more lines`）；`edit` 成功时渲染 diff（pi 原生 `renderDiff`，最多 20 行）而不是 `Successfully replaced…` |
| 工具行排版 | 按终端宽度：先保 rail + 图标 + 工具名 + 统计 + 耗时，剩余宽度给摘要，超出用 `…` 截断 —— 窄终端下耗时不会被截掉。失败行的错误末行与摘要分享剩余宽度（最多占一半，摘要短则更多；截断后不足 12 列就不显示） |
| 摘要内容 | `read` 带范围（`foo.ts:120-179` / 只有 offset 时 `:120+` / 只有 limit 时 `:1-50`）；`grep` 带 glob（`TODO in src [*.ts]`）；多行 `bash` 只显示首个非空行 + ` …`；`edit` 追加 `+N −M`（按 `details.diff` 计数）；`write` 追加 `N lines`（参数流式生成时实时增长） |
| 失败行的错误末行 | 输出的最后一个非空行；bash 的 `Command exited with code N` 没有信息量，取它的上一行并追加 `(exit N)`，同时去掉 `/bin/bash: line 1: ` 前缀；无输出时只显示 `exit N` |
| 中断（Esc） | 没执行的调用不会显示 `✓`：pi 给出 `Operation aborted` 结果的显示 `✗`，没有任何结果的保持 `○` |
| 恢复历史会话 / `/tree` / `/reload` 重放 | 重放的工具行没有实时事件，无法分块，退化成单行紧凑行（`✓ edit: poem.txt +2 −0`）；有结果所以是 `✓`/`✗` 而不是 `○` |
| thinking | 完全不碰，继续由 pi 原生渲染成 `Thinking...` 行（可点击展开全文） |

### 为什么跨消息合并、只在正文处断开

历史教训：第一版就是跨消息合并，但折叠态当时显示的是「最早的 3 个工具」，于是后来加入的工具渲染成 0 行、位置错位、活动被截断在计数里 —— 被当成 bug 报了回来。改成「一条 assistant 消息 = 一块」后合并不再发生，又不满足需求（要的是「一轮里连续的工具调用合为一条」）。

最终形态 = 跨消息合并 **+** 折叠态只显示「正在跑 / 最近失败 / 最新」那一个：块变成一条随流程持续更新的活动行，当初「看不到当前在干什么」的根因消失。

两个**不能**用来做断点的信号（若以后想改回去）：

- `message_end(assistant)` 在工具开始执行**之前**触发 → 会把同一批并行调用拆散；
- `message_start(tool_result)` 会插在批内工具执行之间 → 同样拆散并行批次。

## 实现要点

- **不 patch 任何 prototype**。分块靠「leader 行」：每组第一个工具行渲染整块，其他成员渲染 0 行。
- 0 行必须配合 `renderShell: "self"`：默认 shell 下即使内容为空，`ToolExecutionComponent` 自带的 `Spacer(1)` 仍会留下一个空行。
- 工具定义用 `{ ...createXTool(cwd), renderShell: "self", renderCall, renderResult }` 注册，因此 **description / promptSnippet / promptGuidelines / constrainedSampling 和原生 execute 全部保留**，只替换渲染。（对照：pi-compact-ui 手写定义，把描述退化成 `Built-in bash (rendering handled by compact-ui group)`，并丢掉 0.86.1 的 strict JSON-schema 采样。）
- pi 每帧全量重渲染整棵树、不做 dirty 跳过，所以 leader 会自动带上后加入的工具；重绘由 pi 自己的工具事件 + 我们的 spinner 定时器（100ms）驱动，定时器复用 `context.invalidate()`（内部已调 `ui.requestRender()`），因此**不需要通过 widget 去偷 TUI 实例**。
- 分块边界：`message_start(user)`（新的一轮 ⇒ 新块）、`tool_execution_start` 里非内置工具名（⇒ 在该处拆块）、出现可见正文（`text_*` 事件且对应块非空 ⇒ 断块）；`agent_end` 也封口。assistant 消息边界**不**断开。
- **入组时机**：`renderCall` 在参数还在流式生成时就会被调用，早于 `tool_execution_start`。用 `agent_start`/`agent_end` 记录 live 状态；live 期间 `renderCall` 见到新的 toolCallId 就立刻加入当前打开的块（没有则新建），所以不会先画成独立一行、执行开始后又塌成 0 行。`pending` / `startedAt` 仍然只由 `tool_execution_start` 设置。
- **三态**：`pending` ⇒ running；`hasResult`（`tool_execution_end`，或非 partial 的 `renderResult` —— 重放行走这条）⇒ ok/failed；两者都没有 ⇒ queued（`○`）。
- 纯逻辑（时长格式化、摘要、折叠态选取、区间并集、diff 计数、预览头/尾选取、块头与工具行的按宽度排版）都在 `format.ts`，不依赖 pi 运行时；`index.ts` 只管状态、事件和主题。宽度计算用 pi-tui 的 `visibleWidth` / `truncateToWidth`（字符串带 ANSI、可能有宽字符）。

## 测试

```bash
cd extensions/pi-compact-calls
node --test tests/*.test.ts
```

## 已知限制

- 重放的历史工具行渲染成单行紧凑行（没有实时事件可用于分组），不是原生多行样式。
- 重放行的展开态（`Ctrl+O`）依赖 `renderCall` 的 `context.expanded`，`isError` 依赖 `context.isError`（重放时也可用）；但 `renderResult` 拿到的 result 对象**不含** `isError`，不要用它覆盖状态。
- 块上**点击**展开依赖该行的 result 已经存在（pi 的 `createResultRegion` 先判 `this.result`），所以第一个工具还在跑时点击无效；`Ctrl+O` 任何时候都好用。
- 非内置工具不参与分块（我们只能控制自己注册的工具行）。
- 单工具块没有块头，所以第一个调用的参数刚开始流式生成时是 1 行（`○ bash: …`），第二个调用出现后变成 2 行（块头 + 活动行）—— 这 1 → 2 的增长是设计使然，不是闪烁。
- 单工具块的工具行在执行完后就显示 `✓`（那个调用确实成功了）；「块未封口不显示 `✓`」只约束块头。
- 常量（都在 `index.ts` 顶部，没有配置文件）：结果预览 `EXPANDED_RESULT_LINES = 5`、diff 预览 `EXPANDED_DIFF_LINES = 20`、结果保留 `RESULT_TEXT_LIMIT = 4000`（bash 留尾部，其他留头部，按整行裁；完整行数另存，所以 `… N` 行数是真实的）、diff 保留 `DIFF_TEXT_LIMIT = 8000`。摘要没有固定字符上限（`format.ts` 的 `SUMMARY_HARD_LIMIT = 240` 只是防御性上限，实际长度由终端宽度决定）。折叠态固定只显示 1 条活动行，没有对应常量。
- `Ctrl+O to expand` 是写死的文案，不跟随 `app.tools.expand` 的改键。
- 主题从 renderer 参数里取最新值（pi 没有主题切换事件），切换主题后需等一次重绘才刷新。
- 未实现 pi-compact-ui 的 `worked for Xs` 分隔线、compaction 行紧凑化、代码围栏面板美化 —— 这些要么需要额外 patch，要么与折叠无关。

## 验证记录（2026-09-21 第一轮，pi 0.86.1）

> 历史记录：其中的 3 行折叠样式（`… N more calls` 行）已被下方第二轮的 2 行样式取代，分块行为的结论仍然有效。

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

## 验证记录（2026-09-21 第二轮，UI/UX 改进批次，pi 0.86.1）

单测：`node --test tests/*.test.ts` 18 项全过。`npm run typecheck`：本扩展 0 报错（仓库里 `pi-execution-time/tests` 与 `pi-shots` 有 7 个既有报错，与本次无关，未动）。

tmux 实机跑 `pi -ne -e extensions/pi-compact-calls/index.ts`（0.1s 间隔连续 `capture-pane`）：

- **A3**：`write` 一个长文件，参数流式生成的 ~5s 内工具行始终是 `○ write: long.txt N lines`（行数实时增长），从未出现 `✓`；并行 4 次 bash 的参数流式阶段依次为 `○ bash: …` → `⠿ 2 tool calls` + `└ ○ bash: cd` → `⠿ 3 tool calls` → 执行开始后 `⠏ 4 tool calls`，没有「独立行 → 消失」的跳动 ✓
- **A3 中断**：流式生成 `write` 参数时按 Esc → `✗ write: long.txt 43 lines — Operation aborted`，块头 `✗ 2 tool calls … · 1 failed`，没有 `✓` ✓
- 并行批 `sleep 3` / `cd /nonexistent-dir-xyz` / `sleep 5` / `echo four` → 运行中 `⠏ 4 tool calls · 1 failed · 0.1s · Ctrl+O to expand` + 正在跑的 `sleep 5`；全部结束、模型生成回复期间块头 `⠿`、活动行落到失败的 `cd` 并带错误末行；正文出现后块头落定 `✗`。块头耗时 5.0s（并集，不是 3+5）✓
- 5 步各占一条消息、中间无正文 → 合成一块 `5 tool calls (3 bash, 1 read, 1 grep) · 2.1s`；步与步之间块头为 `⠿`，耗时不随模型生成时间增长（0.1s → 0.1s → 2.1s）✓
- 摘要：`read: poem.txt:10-14`、`grep: river in . [*.txt]`、多行 bash `for i in 1 2 3; do …` ✓
- 展开：`seq 1 200` 显示 `… 195 earlier lines` + 196–200；read 显示前 5 行 + `… 2 more lines`；非最后工具的预览行带 `│`，最后一个用空格 ✓
- `edit`：折叠/工具行 `edit: poem.txt +2 −0`，展开渲染带行号的彩色 diff ✓
- 去掉 shell 前缀的修复后复测：`└ ✗ bash: cd /nonexistent-dir-xyz (0.0s) — cd: /nonexistent-dir-xyz: No such file or directory (exit 1)` ✓
- 64 列：块头丢掉 `Ctrl+O` 提示后仍完整，工具行耗时保留、错误末行被截断；44 列：块头再丢类型分布 → `✗ 4 tool calls · 1 failed · 5.0s`，工具行 `└ ✗ bash: cd /nonexist… (0.0s) — /bin/bas…`（该次截图早于去掉 `/bin/bash: line 1:` 前缀的修复）✓
- `-c` 恢复会话 → 历史行为单行 `✓`/`✗`（不是 `○`），`edit` 仍带 `+2 −0`，失败行带错误末行 ✓
- 一条消息内 `bash` / `dummy_echo`（非内置）/ `bash` → 三行顺序与 transcript 一致，第二个 bash 在 dummy 之后另起一块 ✓

未在实机验证（仅单测覆盖）：`formatDuration` 进位、`≥ 1m` 的耗时显示、宽字符路径的截断、结果超过 `RESULT_TEXT_LIMIT` 时的头/尾裁剪。
