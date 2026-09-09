# pi-note PRD

> 状态：已实现并交付（commit `9c3e2d3` + 后续归档 commit）· 代码在 `extensions/pi-note/`，验收 checkbox 见 §9/§11
>
> 本文只定义**行为与验收标准**。pi 插件 API 的用法请查阅 `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`，本文提到的 API 名称仅作可行性提示。

## 1. 背景

pi 每次 `/new` 或重启都从零开始：用户的偏好、踩过的坑、项目约定全部丢失，只能靠用户反复重述或手写进 `AGENTS.md`（但 `AGENTS.md` 属于版本控制内容，不适合放个人事实）。

同时 pi 没有约定的临时文件工作区。agent 产出中间脚本、调试输出时，要么污染项目目录，要么散落在 `/tmp` 根下互相覆盖。

pi-note 把 Claude Code 的两个机制移植到 pi：**文件式记忆**（每条记忆一个文件 + 一份索引）和**会话级 scratchpad 目录**。

**非目标**：

- 不做语义召回 / 向量检索。索引进 system prompt + agent 按需自读，就是全部召回机制。
- 不做记忆的自动抽取或后台总结。写什么、什么时候写，由规则约束 agent 自行判断。
- 不替代 `AGENTS.md`。`AGENTS.md` 是团队共享的项目约定，记忆是本机私有的个人化事实。
- 不做全局记忆层。记忆仅项目级。
- 不接管 `~/dotfiles/pi-agent/pi-hermes-memory/` 的数据（另一个插件的存储，本插件不读不写不迁移）。
- 不提供查看/管理记忆的命令、工具或配置项。记忆就是普通 markdown 文件；要搬迁目录用 symlink；要禁用从 `package.json` 里移除入口。
- 不做 scratchpad 过期清理。本机 `/tmp` 是 tmpfs，且 `tmpfiles.d/tmp.conf` 配置了 10 天自动清理。

## 2. 插件职责

三个钩子，**不注册任何工具或命令**：

| 钩子 | 做什么 |
|---|---|
| `session_start` | 建目录；设 `process.env.PI_NOTE_SCRATCHPAD_DIR`；读一次 `MEMORY.md` 存为快照 |
| `before_agent_start` | 把规则文本 + 索引快照追加到 `event.systemPrompt` |
| `tool_call` | 非 shell 工具参数里的 `$PI_NOTE_SCRATCHPAD_DIR` 前缀替换为真实路径 |

记忆的增删改查全部由 agent 用自带的 read/write/edit/bash 工具完成。插件不解析记忆文件、不维护索引、不做去重。

## 3. 关键设计决策

### D1：memory 走绝对路径进 prompt，scratchpad 走环境变量

| | 隔离粒度 | 注入方式 |
|---|---|---|
| memory | 项目级，同项目所有 session 共享 | 规则文本里写**绝对路径** |
| scratchpad | session 级，每个 session 一个目录 | 规则文本里只出现 `$PI_NOTE_SCRATCHPAD_DIR`，真实路径通过环境变量给出 |

理由：memory 路径在同一项目内恒定，进 prompt 不影响缓存。scratchpad 路径每个 session 不同，`/fork`、`/clone` 会换目录；若写死在 prompt 里，fork 后 prompt 从第一个字节起就变了，继承的整段历史缓存作废。用变量则 prompt 保持不变，隔离由环境变量透明完成。

环境变量注入方式：`session_start` 里直接赋值 `process.env`。已核对 `bash.ts` 的 `resolveSpawnContext`，每次 spawn 都展开 `process.env`，`!` 用户命令走同一路径。**不要**覆盖 bash 工具或使用 `spawnHook`。

### D2：索引以内存快照进 system prompt，session 内不变

`session_start` 时读一次 `MEMORY.md` 存在内存里，之后每轮 `before_agent_start` 拼的都是这份快照，**session 内不重读磁盘**。

- 快照恒定，所以 agent 写新记忆不改 system prompt，已有前缀缓存全部保住。
- session 内新写的记忆不进快照没关系：那是 agent 自己刚写的，工具调用记录就在上下文里。
- 不用 `before_agent_start` 的 `message` 注入。那种消息会持久化进 session（`agent-session.js` 约 916 行），fork/resume/CLI 恢复时会堆积副本，且 compaction 可能吞掉它。system prompt 没有这些问题。

已知代价：`/fork`、`/resume`、`/reload`、CLI 恢复都会触发 `session_start`，重读索引。若期间 `MEMORY.md` 变了，继承的历史缓存作废一次，即一次 prefill。低频，接受。

### D3：规则驱动，不提供专用工具

不注册 `memory_write` 之类的工具。多一个工具就多一份 schema 常驻上下文，且格式演进要改代码。规则文本改一行字就能调整行为。代价是格式一致性靠模型自觉，规则文本里给出模板来降低漂移。

### D4：项目 slug 复用 pi 的 session 目录命名规则

从 `ctx.sessionManager.getCwd()` 按 pi 的规则算 slug（`session-manager.js` 的 `getDefaultSessionDirPath`，未导出，自行复刻那一行正则）：解析为绝对路径，去掉开头的 `/`，`/` `\` `:` 替换为 `-`，前后各加 `--`。结果与 `~/.pi/agent/sessions/` 下的目录名一致（如 `--home-sjet-repo-pi-setup--`）。

**不要**用 `basename(getSessionDir())`：`--no-session` 时 sessionDir 是空串，所有 ephemeral session 会串到同一个记忆目录。

记忆根目录用 `getAgentDir()`（包入口已导出）拼接，不硬编码 `~/.pi/agent`。

### D5：scratchpad 每 session 一个目录

sessionId 由 `ctx.sessionManager.getSessionId()` 给出，任何 session（含 `--no-session`）都有，是全局唯一 UUID，不需要 slug 层级和兜底分支。

## 4. 目录布局

```
~/.pi/agent/pi-note/<slug>/          # 记忆目录
├── MEMORY.md                        # 索引，每条记忆一行
├── cli-preferences.md
└── two-clone-workflow.md

/tmp/pi-note-<uid>/<session-id>/     # scratchpad，权限 0700
```

## 5. 记忆文件格式

### 5.1 单条记忆

一个文件一个可独立更新的主题，文件名 kebab-case `.md`。**没有 frontmatter**，正文就是普通 markdown：

记忆只放跨会话仍成立的事实与决策；生命周期更短的内容（进行中状态、草稿、中间结果、一次性脚本、命令输出、日志）一律写 scratchpad，不写进记忆目录。

```markdown
用 `jq` 解析 JSON，用 `glab` 处理 GitLab 任务（不预检版本/登录态，直接执行，报错再处理）。
```

### 5.2 索引 MEMORY.md

每条记忆一行，格式 `- [标题](文件名.md) — 钩子`。钩子是一句极短的提示，帮 agent 判断要不要展开读全文。**绝不在索引里放记忆正文。**

```markdown
- [命令行工具偏好](cli-preferences.md) — jq/glab，不做前置检查
- [双 clone 提交流程](two-clone-workflow.md) — 改完要同步运行时 clone
```

## 6. 功能需求

### F1 — 目录准备（`session_start`，所有 reason）

1. 计算 slug 与 sessionId，`mkdir -p` 记忆目录和 scratchpad 目录（scratchpad 0700）。
2. `MEMORY.md` 不存在则创建为空文件。
3. 设 `process.env.PI_NOTE_SCRATCHPAD_DIR`。
4. 读 `MEMORY.md` 存为快照（空文件视为无索引）。
5. 任一步失败：`ctx.ui.notify(..., "error")`，并把插件置为 **未就绪**：`before_agent_start` 不注入任何文本，`tool_call` 不做展开。不做 memory / scratchpad 分开的降级。

`session_start` 里抛出的异常会被 pi 的扩展 runner 捕获（`runner.js` 约 640 行），**不会**让 pi 退出，所以不能靠抛错来阻止后续注入，必须用就绪标志。

**目录必须由插件预创建**，因为规则文本会告诉 agent "目录已存在，直接写，不要 mkdir，不要检查存在性"，省掉每次写记忆前的一轮工具调用。

### F2 — 规则与索引注入（`before_agent_start`，每轮）

追加到 `event.systemPrompt` 尾部：§7 规则文本（`<MEMORY_DIR>` 替换为绝对路径，`$PI_NOTE_SCRATCHPAD_DIR` 保留字面量），然后若快照非空，再追加：

```
## Memory index

<快照原文>
```

快照为空时**不追加索引段**，不发"当前没有记忆"这类噪音。

pi 的 system prompt 每轮从 base 重建、扩展修改不累积，所以必须每轮追加。同一 session 内追加的内容逐字节相同。

### F3 — scratchpad 变量在非 shell 工具中的展开（`tool_call`）

read / write / edit / grep / find / ls 等工具不经过 shell。插件在 `tool_call` 里原地修改 `event.input`：

- `toolName` 为 `bash` 时跳过，那里靠真实环境变量。
- 只扫描 `event.input` 顶层字符串值，不递归。
- 只认 `$PI_NOTE_SCRATCHPAD_DIR` 与 `${PI_NOTE_SCRATCHPAD_DIR}` 两种写法，只匹配字符串**开头**，且变量名后必须是 `/` 或字符串结尾（`$PI_NOTE_SCRATCHPAD_DIR_BACKUP` 不匹配）。出现在中间（如文件内容）不动。
- 不做反向替换，工具结果里出现绝对路径是正常的。

## 7. 注入的规则文本

英文，面向模型。实现时原样使用，只替换 `<MEMORY_DIR>`。

````
# Memory

You have a persistent file-based memory for this project at `<MEMORY_DIR>`. This directory already exists — write to it directly. Do not run mkdir and do not check whether it exists.

Each memory is one markdown file holding one topic that can be updated on its own, named `<short-kebab-case-slug>.md`, no frontmatter. Worth saving: who the user is (role, expertise, preferences); guidance the user has given on how you should work, with the why; durable project or cross-project decisions and constraints not derivable from the code or git history (convert relative dates to absolute); pointers to external resources (URLs, dashboards, tickets).

Memory is for what is still true in a future session — durable facts and decisions. Anything with a shorter life — in-progress state, drafts, intermediate results, throwaway scripts, command output, logs — belongs in the scratchpad, never in memory. If you are unsure whether something outlives the current task, write it to the scratchpad.

After writing the file, add a one-line pointer in `<MEMORY_DIR>/MEMORY.md`: `- [Title](file.md) — hook`. One line per memory, never put memory content there.

Writing a memory file and updating this index are one atomic step: never create, rename, or delete a memory file without adding, fixing, or removing its `MEMORY.md` line in the same turn. A memory file with no index line is invisible to future sessions — the index snapshot is the only recall path.

The index is included below as a snapshot taken at session start. When a line looks relevant to the task at hand, read that file before acting on the topic; do not guess at its contents from the hook. Memories you write during this session will not appear in the snapshot; read `<MEMORY_DIR>/MEMORY.md` directly when you need the authoritative current list, and after context compaction before acting on past agreements.

Before saving, check the index for an existing entry that already covers it. Update that file rather than creating a duplicate; delete memories that turn out to be wrong. Don't save what the repo already records (code structure, past fixes, git history, AGENTS.md) or what only matters to the current conversation; if asked to remember one of those, ask what was non-obvious about it and save that instead. Never save secrets or credentials. Memories reflect what was true when written — if one names a file, function, or flag, verify it still exists before recommending it.

# Scratchpad

`$PI_NOTE_SCRATCHPAD_DIR` is a scratch directory for this session. Use it for temporary files — intermediate results, throwaway scripts, command output that doesn't belong in the project — instead of `/tmp`, the working directory, or the memory directory. It already exists and is session-specific. Write the path literally as `$PI_NOTE_SCRATCHPAD_DIR/<file>` in any tool; it is expanded for you. Only use `/tmp` if the user explicitly asks.
````

## 8. User Story

### US-1：第一次在新项目里用 pi

**Given** 项目从未用过 pi-note
**When** session 开始
**Then** 记忆目录与空 `MEMORY.md`、scratchpad 目录被创建；规则文本进 system prompt，**不含索引段**；用户感知不到插件存在，没有 notify、没有 footer 状态。

### US-2：agent 记下一条用户偏好

**Given** 用户说"以后用 jq 解析 JSON"
**When** agent 判断这是跨会话有效的偏好
**Then** agent 查 system prompt 里的索引确认无重复，写 `<MEMORY_DIR>/cli-preferences.md`，往 `MEMORY.md` 追加一行。
**And** system prompt **完全不变**，已有前缀缓存全部保住。

### US-3：下次 session 用上记忆

**Given** 记忆目录里已有 3 条记忆
**When** 用户在同一项目里 `/new` 或重启 pi
**Then** system prompt 含 3 行索引，不含正文；任务与其中一条相关时 agent 主动读那个文件；无关任务不读任何记忆文件。

### US-4：记忆过时了

**Given** 记忆里写着"部署走 `deploy.sh`"，但项目已改用 CI
**When** 用户纠正 agent
**Then** agent 修改**已有那个文件**并同步索引行，而不是新建一条；若彻底错误则删文件并删索引行。

### US-5：拒绝记没价值的东西

**Given** 用户说"记住这个函数在 `src/foo.ts:42`"
**Then** agent 不直接落盘，反问"这里有什么是从代码里看不出来的？"，只记真正非显然的部分。

### US-6：用 scratchpad 装中间产物

**Given** agent 需要跑一次性脚本分析日志
**Then** 脚本落在 `$PI_NOTE_SCRATCHPAD_DIR/` 而不是项目目录，`git status` 干净；bash 里 `ls "$PI_NOTE_SCRATCHPAD_DIR"` 可用，write 工具里 `$PI_NOTE_SCRATCHPAD_DIR/analyze.py` 可用。

### US-7：并行 session 互不干扰

**Given** 同一项目开了两个 pi 窗口，都往 scratchpad 写 `output.json`
**Then** 两份文件在各自 `<session-id>/` 下互不覆盖；两个 session 共享同一份项目记忆。

### US-8：fork 后自动隔离 scratchpad

**Given** 用户 `/fork` 出新 session
**Then** `$PI_NOTE_SCRATCHPAD_DIR` 指向新目录，agent 无需感知；若 fork 期间 `MEMORY.md` 未变，pi-note 注入的 system prompt 片段与 fork 前逐字节相同。

### US-9：初始化失败

**Given** 记忆根目录建不出来（磁盘只读、路径被占为普通文件）
**When** session 开始
**Then** 一条 error notify；system prompt 不含任何 pi-note 文本，`$PI_NOTE_SCRATCHPAD_DIR` 不展开；session 其余功能不受影响。

### US-10：临时内容不进记忆

**Given** agent 手头有中间结果、草稿、一次性脚本、日志这类内容
**When** 它想把这些落盘
**Then** 写到 `$PI_NOTE_SCRATCHPAD_DIR/`，不写进记忆目录——记忆只收跨会话仍成立的事实与决策；拿不准是否跨任务有效时，一律写 scratchpad。

## 9. 验收标准

- [x] 新项目首次启动后，记忆目录、空 `MEMORY.md`、scratchpad 目录均存在，scratchpad 权限 0700
- [x] `MEMORY.md` 为空时 system prompt 无索引段，规则文本照常
- [x] `MEMORY.md` 非空时 system prompt 含索引段，内容与 session 开始时的磁盘内容一致
- [ ] **同一 session 内** agent 写完新记忆后，pi-note 注入的 system prompt 片段逐字节不变（核心收益，必须验证；不承诺 provider 缓存一定命中）
- [ ] `--no-session` 启动时，不同 cwd 的记忆目录不同
- [ ] 初始化失败时 system prompt 不含 pi-note 文本
- [x] bash 工具里 `echo $PI_NOTE_SCRATCHPAD_DIR` 输出正确绝对路径；`!` 命令同样
- [x] write 工具传 `$PI_NOTE_SCRATCHPAD_DIR/a.txt` 落盘到 scratchpad
- [ ] `/fork` 后 `$PI_NOTE_SCRATCHPAD_DIR` 指向与父 session 不同的目录
- [x] system prompt 里不含任何 `/tmp/` 开头的 pi-note 路径
- [ ] 正常路径下没有 notify、没有 footer 状态项

## 10. 测试要点

按 `AGENTS.md` 的测试原则（纯逻辑层单测，mock pi 事件层，临时目录用 `mkdtempSync`）：

- **路径解析**：给定 cwd 和 sessionId，产出的 slug 与 `~/.pi/agent/sessions/` 下的目录名一致，记忆目录 / scratchpad 目录正确
- **变量展开**：`$PI_NOTE_SCRATCHPAD_DIR/x` 与 `${PI_NOTE_SCRATCHPAD_DIR}/x` 被展开；`$PI_NOTE_SCRATCHPAD_DIR_BACKUP` 不展开；出现在字符串中间不展开；bash 工具参数不展开；无变量的参数原样返回
- **规则文本组装**：`<MEMORY_DIR>` 被替换、`$PI_NOTE_SCRATCHPAD_DIR` 保留字面量；快照为空时无索引段；未就绪时返回原 system prompt；快照测试锁死规则文本

## 11. 落地清单

按 `AGENTS.md` 的「从头写新插件」流程：

- [x] `extensions/pi-note/` 目录与源码
- [x] 顶层 `package.json` 的 `pi.extensions` 加入口
- [x] 顶层 `tsconfig.json` 的 `include` 加 `extensions/pi-note`
- [x] `README.md` 插件表格加一行
- [x] `extensions/pi-note/README.md`：目录布局、如何 symlink 搬迁记忆目录
- [x] `npm run typecheck` 通过、测试通过
- [x] 按双 clone 流程同步到 `~/.pi/agent/git/.../pi-setup` 后 `/reload` 实测（2026-09-08 通过：env 正确、0700、write 工具变量展开落盘、无 /tmp 路径泄漏）
