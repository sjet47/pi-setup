# pi-setup 开发工作流

## 项目结构

```
pi-setup/
├── extensions/
│   ├── <plugin-name>/          # 每个插件一个子目录
│   │   ├── index.ts            # 入口文件（export default function）
│   │   ├── package.json        # 可选：插件自己的元数据（不用于安装）
│   │   └── ...                 # 插件的源码、测试等
│   └── ...
├── package.json                # 顶层 pi 包清单，声明所有插件入口
├── tsconfig.json               # 顶层 TypeScript 配置
└── README.md                   # 插件列表 + 安装说明
```

**关键规则**：每个插件在 `extensions/<name>/` 下，顶层 `package.json` 的 `pi.extensions` 里显式列出每个入口。

## 从已有仓库导入插件

```bash
# 1. 创建插件目录
mkdir -p extensions/<plugin-name>

# 2. 拷贝源码（保持内部目录结构）
cp -r <source-repo>/src extensions/<plugin-name>/
cp <source-repo>/index.ts extensions/<plugin-name>/

# 3. 处理导入路径
#    - 不同 pi 发行版的包名：@mariozechner/ → @earendil-works/
#    - 相对路径：同目录下的 import 不需要改，跨目录需要调整

# 4. 更新顶层 package.json，在 pi.extensions 数组里加一行
#    "./extensions/<plugin-name>/index.ts",

# 5. 合并依赖到顶层
#    - runtime deps → package.json.dependencies
#    - peerDeps（@earendil-works/*）→ package.json.peerDependencies
#    - devDeps（typescript, @types/node 等）→ package.json.devDependencies

# 6. 更新 tsconfig.json 的 include 数组
#    "extensions/<plugin-name>",

# 7. 更新 README.md 的插件表格
```

### 注意事项

- **不要删除源仓库** — 保持原地不动，方便回溯
- **`@mariozechner/pi-*` → `@earendil-works/pi-*`**：pi-intercom 遇到过这个 fork 差异，统一用 `@earendil-works`
- **原生模块**：`better-sqlite3` 等 native addon 需要在顶层 `package.json` 加 `allowScripts` 放行（见下方「npm 依赖管理」），且只能在 Node 下运行，bun 无法加载

## 从头写新插件

```bash
# 1. 创建目录
mkdir -p extensions/<plugin-name>

# 2. 写入口文件
cat > extensions/<plugin-name>/index.ts << 'EOF'
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("my-cmd", {
    description: "What this command does",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Hello from my plugin!", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // 初始化逻辑
  });
}
EOF
```

### pi 插件能力速查

| 能力 | API | 说明 |
|------|-----|------|
| 注册命令 | `pi.registerCommand("name", { description, handler })` | 用户输 `/name` 触发 |
| 注册快捷键 | `pi.registerShortcut("f3", { description, handler })` | F3 键，或 `Key.ctrlShift("f")` |
| 注册工具 | `pi.registerTool({ name, description, parameters, execute })` | LLM 可调用 |
| 注册 flag | `pi.registerFlag("my-flag", { type, default })` | CLI 参数 `--my-flag` |
| 拦截请求 | `pi.on("before_provider_request", handler)` | 修改发给 AI provider 的 payload |
| 状态栏 | `ctx.ui.setStatus("key", text)` | 显示在 footer |
| 通知 | `ctx.ui.notify(message, level)` | level: info/warning/error |
| 持久化 | `pi.appendEntry(type, data)` | 写入 session，跨 /new 不丢 |
| 自定义渲染 | `ctx.ui.custom()` | 复杂 UI 覆盖层 |
| 存储 | `pi.on("session_shutdown", ...)` → 写文件 | session 生命周期管理 |

完整 API 参见 pi 官方文档中的 [extensions.md](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md)。

### 状态栏设计模式

参考 pi-fast-mode 的实践：

| 状态 | 显示 | 颜色 | 含义 |
|------|------|------|------|
| OFF | *(空)* | — | 不占空间 |
| ON + 生效 | `⚡fast` | accent | 正在工作 |
| ON + 暂不适用 | `⚡` | muted | 开了但闲置 |

原则：不用星号或 warning 颜色表达「暂不适用」，那只传达「有问题」的错误信号。

## npm 依赖管理

### 纯 JS/WASM 依赖

零编译、Node/bun 双端通用，适合不需要原生性能的场景：

```json
{
  "dependencies": {
    "typebox": "^1.1.24"      // 参数 schema 定义
  }
}
```

### native addon（better-sqlite3）

npm 12 的 `install-scripts` 策略默认**阻止所有依赖的 install 脚本**，除非包名出现在 `package.json` 的 `allowScripts` 字段里。解法是直接在顶层 `package.json` 加字段放行：

```json
{
  "dependencies": {
    "better-sqlite3": "^12.9.0"
  },
  "allowScripts": {
    "better-sqlite3": true
  }
}
```

这样 `pi install git:...` 时 npm 就会放行编译，不用每次手动 `npm install-scripts approve`。

**两个坑**：

- `allowScripts` 只对「在哪个 package.json 里跑 npm install」生效。npm 源扩展（`pi install npm:...`）共享 `~/.pi/agent/npm/package.json` 的 allowlist；git 源扩展（pi-setup）在自己的 clone 目录 npm install，所以必须写进 pi-setup 自己的 package.json。
- better-sqlite3 是 native addon，**只能在 Node 下运行**，bun 无法加载（dlopen 失败，bun 官方 issue #4290）。pi-stats 因此把测试从 `bun test` 迁到了 vitest（Node 运行时）。

### 依赖升级流程

```bash
# 安装新依赖
npm install <pkg>

# 确保 devDependencies 齐全
#   顶层开发需要：@earendil-works/pi-coding-agent（类型）
#                   @earendil-works/pi-tui（部分插件需要）
#                   @types/node
#                   typescript

# 提交 lockfile（package-lock.json 要进版本管理，保证确定性安装）
git add package.json package-lock.json
```

## 两套 git clone 管理

pi 通过 `pi install git:github.com/sjet47/pi-setup` 会克隆到：

| 路径 | 用途 |
|------|------|
| `~/repo/pi-setup/` | **开发仓库** — 改代码、提交 |
| `~/.pi/agent/git/github.com/sjet47/pi-setup/` | **pi 运行时克隆** — 加载插件 |
| `~/dotfiles/pi-agent/git/.../pi-setup/` | **备用的 dotfiles 路径**（视配置） |

**提交流程**：

```bash
# 1. 在开发仓库改代码、提交、推送
cd ~/repo/pi-setup
git add -A && git commit -m "..." && git push

# 2. 更新 pi 运行时克隆（不然 /reload 的还是旧代码）
cd ~/.pi/agent/git/github.com/sjet47/pi-setup
git pull --ff-only

# 3. 如果有 dotfiles 路径也要更新
cd ~/dotfiles/pi-agent/git/github.com/sjet47/pi-setup
git pull --ff-only
```

**简便做法**（配置 git alias 或脚本一次性更新所有 clone）。

## README 同步

每次增删插件都要更新 `README.md` 的插件表格：

```markdown
| `pi-xxx/` | 一句话描述 | 来源链接 |
```

同时检查：

- `package.json` 的 `pi.extensions` 列表
- `tsconfig.json` 的 `include` 数组
- `README.md` 的插件表格

## 安装与调试

```bash
# 从源码目录直接测试（不需要发布）
pi -e .

# 检查 TypeScript 类型
npm run typecheck

# 查看 pi 加载了哪些扩展
pi list

# 实时重载（改完代码后）
# 在 pi TUI 里输入 /reload

# 查看错误日志
~/.pi/agent/pi-debug.log
```

### 常见错误排查

| 症状 | 原因 | 排查 |
|------|------|------|
| `ParseError: Unexpected reserved word` | `await` 在非 `async` 函数里 | 检查所有 `function` 声明是否漏了 `async` |
| `Could not locate the bindings file` | native addon 未编译 | 确认顶层 `package.json` 有 `allowScripts`，重跑 `npm install` |
| `Cannot find module 'better-sqlite3'` | 依赖没装 | 在对应 git clone 路径下跑 `npm install` |
| 扩展加载成功但命令没注册 | 入口文件未在 `pi.extensions` 列出 | 检查顶层 `package.json` |

## 测试

```bash
# pi-stats 的测试（vitest，Node 运行时；better-sqlite3 无法在 bun 下加载）
cd extensions/pi-stats
TZ=UTC vitest run

# pi-execution-time 的测试
cd extensions/pi-execution-time
node --test tests/*.test.ts
```

测试原则：

- 优先测 store/纯逻辑层，mock pi 事件层
- store/DB 测试用 `mkdtempSync` 创建临时目录，测试完清理
- WebSocket/进程级测试（如 pi-intercom）用独立的 broker startup 测试

## Fast Mode 设计模式（参考实现）

pi-fast-mode 的核心设计是一个 **FEATURES 表**：

```typescript
const DEFAULT_RULES = [
  { api: "openai-",     injectionKey: "service_tier", injectionValue: "priority" },
  { api: "anthropic-",  injectionKey: "speed",        injectionValue: "fast" },
];
```

匹配逻辑：`model.api.startsWith(rule.api)`，自动决定注入什么参数。这样新增 provider 时只需加一条规则，不用改 config 文件。

参考实现：[aliaksei-raketski/pi-packages/packages/fast-mode](https://github.com/aliaksei-raketski/pi-packages/tree/main/packages/fast-mode)
