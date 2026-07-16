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
- **原生模块警惕**：`better-sqlite3` 之类的 native addon 在 `pi install` 时会因为 `install-scripts` 策略被拦截（见下方「npm 依赖管理」）

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

### 无原生模块的依赖（推荐）

```json
{
  "dependencies": {
    "sql.js": "^1.11.0",      // SQLite via WASM，零编译
    "typebox": "^1.1.24"      // 参数 schema 定义
  }
}
```

### 避免使用 native addon

`better-sqlite3` 的教训：

```
# 问题：pi install 时 install-scripts 被拦截
npm warn install-scripts   better-sqlite3@12.11.1 (install: prebuild-install || node-gyp rebuild --release)

# 需要手动 approve
npm install-scripts approve better-sqlite3
npm rebuild better-sqlite3
```

**每次重新 clone 安装都要重复这步**，所以在 pi 生态里优先选纯 JS/WASM 替代方案。

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
| `Could not locate the bindings file` | native addon 未编译 | 换成纯 JS 替代方案 |
| `Cannot find module 'sql.js'` | 依赖没装 | 在对应 git clone 路径下跑 `npm install` |
| 扩展加载成功但命令没注册 | 入口文件未在 `pi.extensions` 列出 | 检查顶层 `package.json` |

## 测试

```bash
# pi-stats 的测试（需要 bun）
cd extensions/pi-stats
TZ=UTC bun test

# pi-execution-time 的测试
cd extensions/pi-execution-time
node --test tests/*.test.ts
```

测试原则：

- 优先测 store/纯逻辑层，mock pi 事件层
- sql.js 的测试用 `mkdtempSync` 创建临时目录，测试完清理
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
