# Linux computer use 调研报告

> 状态：调研完成（2026-09-09）· 经独立复审后修订（2026-09-11）· 未实现任何代码
>
> 目标环境：本机 Arch Linux + Hyprland 0.56.2 / Wayland，双 4K 显示器（`DP-1` 横屏 + `HDMI-A-1` 竖屏，均 `scale=1.5`）。
>
> 本文记录**实测结论与选型依据**。标注「实测」的结论均在本机跑通；外部结论附 URL。**修订版修正了首版 8 处错误**（官方支持分层、坐标公式、分辨率与榜单数据、执行闭环、证据可复现性、`motion_absolute` 参数类型、权限与隔离边界、RemoteDesktop 结论范围），并新增「投键副作用」与「异常释放」两节实测结论。本文可作为 PRD 输入，但**不是 PRD**。

## 0. 结论速览

| 问题 | 答案 |
|---|---|
| 有没有现成能用的？ | 有，但**没有一个是「装上就能驱动 Hyprland」的**。GNOME 生态最成熟；Hyprland 只有小项目（[hypruse](https://github.com/IlyasKhallouki/hypruse) 21★） |
| 官方支持？ | 分三层看：**模型/API 与环境无关**（执行环境由调用方提供，Linux/Wayland 控制器可用）；厂商**没有提供** Linux/Wayland 的现成驱动——Anthropic 参考环境仍是 X11/Xvfb（新版 best-practices demo 甚至 macOS-only），Claude Desktop Linux 明确无 Computer Use，OpenAI 桌面端 Linux 未支持 |
| 本机能不能做？ | **能，且不需要 root、不需要装新依赖**。截图 + 光标 + 键盘已实测打通；鼠标点击/滚轮/拖拽需自写约 80 行 C（`wlr-virtual-pointer-v1`） |
| 最大的坑 | ① Hyprland 0.56.2 把 `hyprctl dispatch` 改成 Lua，**写死旧语法的工具会静默失效**；② **标准 RemoteDesktop portal 路线**（libei 注入）在 Hyprland 上不可用 |
| 驱动真实桌面还是沙箱？ | 需要真实登录态/浏览器 profile → 真实桌面（**首版单 seat**，与用户共用光标焦点）；否则沙箱更划算（本机 KVM 已就绪） |

**已拍板的路线**（2026-09-09）：

- 运行目标：**真实 Hyprland 桌面**，首版**单 seat**（Hyprland 不支持多 logical seat，用户已决定先按单 seat 做）
- grounding：**视觉为主 + 窗口语义辅助**（AT-SPI 当可选加速）
- 本轮只归档调研，不写代码

## 1. 本机环境实测

### 1.1 观测：屏幕捕获

| 方式 | 延迟（实测） | 权限摩擦 | 备注 |
|---|---|---|---|
| `grim -t jpeg -q80` 全画布 | **195 ms**（2.1 MB） | 无 | PNG 同尺寸约 1.2 s，**循环采样别用 PNG** |
| `grim -o <output>` | 单屏约 75 ms | 无 | |
| `grim -T <stableId>` 单窗口 | — | 无 | 可截被遮挡窗口；实测对 kitty 有正常内容，但对一个未重绘的 GTK 探针窗口拿到全黑——**不能假定一定有内容** |
| `grim -g "x,y WxH"` 区域 | 约 200 ms | 无 | 参数用**逻辑坐标** |
| Portal `Screenshot` | 约 1.0 s | 无弹窗 | 非流式 |
| Portal `ScreenCast` + PipeWire | 13–42 fps | **必弹授权框** | 适合连续帧，首次需人工点选 |

`grim` 实际走 `ext_image_copy_capture_v1`（不是旧 screencopy），Hyprland 已实现。

### 1.2 动作：输入注入

五条路径实测对比：

| 能力 | `hl.dsp.cursor.move` | `hl.dsp.send_shortcut` | `hl.dsp.send_key_state` | `wtype` | `wlr-virtual-pointer-v1` |
|---|---|---|---|---|---|
| 光标绝对移动 | ✅ 精确 | — | — | ❌ 无鼠标 | ✅ 精确 |
| 延迟 | **6 ms** | 约 5 ms | 约 5 ms | 10 ms/字符 | 连接+移动 ~3–4 ms；但一次性进程若不等合成器处理就断开可能丢事件（我的实现等 ~150 ms），常驻连接可消除这个等待（**往返延迟本次未单独计时**） |
| 左键点击 | — | ⚠️ 投递给光标下窗口但**不改变焦点** | 同左 | — | ✅ **真点击，会聚焦/raise** |
| 滚轮 | ❌ | ❌（`mouse:274/275` 只在客户端产生 X11 button 8/9，收不到 scroll） | ❌ | — | ✅ `wl_pointer.axis` 垂直滚动（值 0）+ fixed 值 |
| 拖拽 | — | 部分 | — | — | ✅ press → 插值 motion → release 全通 |
| 键盘 | — | ✅ 含 modifier（`SHIFT`+`b`→`B`） | ✅ | ✅ ASCII + **CJK** | 可扩展 |
| 投递到**未聚焦**窗口 | — | ✅ `{window=w}` | ✅ `{window=w}` | ❌ 依赖焦点 | — |
| 需 root / 新依赖 | 否 | 否 | 否 | 否（已装） | 否（gcc + libwayland 即可） |

**关键差异（A/B 实测）**：光标移到窗口 B 上方点一下——

- `send_shortcut(mouse:272)` → B 收到 press 事件，但**焦点仍在 A**
- `wlr-virtual-pointer` 点击 → B 收到事件且**焦点切到 B**

即合成器内部的 `send_shortcut` 绕过了正常的点击聚焦路径。要让 agent 的「点击」表现得像人，必须用虚拟指针。

> 滚轮注：首版报告写的「`dir=4`、`dy=±1.5`」是 **GTK 客户端侧**的观察值（`GDK_SCROLL_SMOOTH`），**不是注入参数**。注入侧应使用 `wl_pointer.axis`：垂直 = 0、水平 = 1，value 为 fixed。

#### 1.2.1 定向投键「不抢焦点」是**假象**（首版结论已推翻）

`send_key_state({key, window=未聚焦窗口})` 实测能投递成功，且执行后 `hyprctl -j activewindow` 仍是原窗口——首版据此写下「适合后台填表」。**这是错的。**

用带焦点事件日志的 GTK3 探针实测（每键一次调用）：

```
投键前            [MAP FOCUS-IN ENTER FOCUS-OUT LEAVE]
send_key_state 后 [ ... FOCUS-IN KEY FOCUS-OUT FOCUS-IN FOCUS-OUT ]
send_shortcut 后  [ ... FOCUS-IN KEY FOCUS-OUT ]
真正聚焦（对照）  [ ... FOCUS-IN ENTER ]
```

目标窗口**确实经历 focus-in / focus-out**（每键 1–2 次），只是最终焦点被还原。源码印证：`Actions::pass`（[ConfigActions.cpp:1465-1526](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/config/shared/actions/ConfigActions.cpp#L1465-L1526)）先 `setKeyboardFocus` + `setPointerFocus(..., {1,1})`，发送后再恢复。

**结论：定向投键 = 「最终不改变焦点归属」，不是「无焦点变化」。** 菜单会被关掉、选区/提交类处理器会被触发，**不能当作无干扰后台输入**。首版把它当推荐能力是错的。

### 1.3 坐标换算

```
逻辑布局：DP-1(2560×1440) @ (0,475)      HDMI-A-1(1440×2560, transform=1) @ (2560,0)
逻辑 bbox = 4000×2560                    合成画布 = 6000×3840 px（× scale 1.5）
```

| 方向 | 规则 |
|---|---|
| `hyprctl clients` 的 `at`/`size` | **逻辑坐标** |
| `grim -g "rx,ry rw rh"` | 参数是**逻辑坐标**，输出是**物理像素**（`rw*scale × rh*scale`） |
| 画布定位 | `canvas_px = (logical - bbox_origin) * scale`（旋转屏同样适用，实测命中） |
| **模型返回的图片坐标 → 逻辑坐标** | **不能除显示器 scale**。必须带上该次截图的**逻辑区域** `(rx, ry, rw, rh)` 与**实际图片尺寸** `(iw, ih)`：<br>`logical_x = rx + image_x * rw / iw`<br>`logical_y = ry + image_y * rh / ih`<br>`/scale` 只在「未裁剪、未缩放的全画布」这一特例下才等价 |
| 输入坐标（`motion_absolute`） | 是 **uint**，只能表达 `[0, extent]` → 传 `logical - bbox_origin`，`extent` 用 bbox 尺寸。**负坐标无法表达**；越界**静默 clamp**（实测 `5000,5000` → `4000,2560`），**不能把 clamp 当成功定位** |
| 空洞坐标 | 虚拟指针可把光标停在**无输出的空洞**（实测 `100,100`：此处 DP-1 逻辑 y 从 475 起、HDMI-A-1 逻辑 x 从 2560 起），此时没有任何 surface 接收点击。必须用 `hyprctl monitors` 校验落点确实落在某个输出的逻辑矩形内 |
| 两条路径不一致 | `hl.dsp.cursor.move(100,100)` → `100,475`（clamp 进输出）；虚拟指针 → `100,100`（停在空洞）。越界时 `3999,2559` vs `4000,2560`。扩展必须自定义坐标契约，**不能依赖任一方的 clamp** |

**公式实证**（首版公式错误，此次补测）：逻辑区域 `(7,517) 1269×1391` → `grim -g` 输出物理图 `1903×2086` → 降采样到 `951×1043`；在 **1437 个「两种假设预测出不同颜色」的采样点**上，正确公式平均色差 **2.38**，首版的 `px/scale` 是 **44.10**，正确公式 **1437/1437 全胜**。

仍需注意：截图与后续输入之间 UI 可能变化——**坐标映射正确 ≠ 目标状态不变**（见 §1.6）。

### 1.4 定位 grounding：AT-SPI vs 视觉

**AT-SPI 在本机基本没用**（实测）：

| 应用 | 注册 a11y bus | 树质量 |
|---|---|---|
| waybar / vicinae / quickshell | ✅ | 有元素，但只有自己的 UI |
| **Chrome / VSCode / Obsidian / Electron** | ❌ | 完全没有 |
| 自建 GTK3 探针 | ✅ | 但 frame `children=0`（无控件） |

且 `get_extents(SCREEN)` **返回 (0,0)**，而 `hyprctl` 说窗口在 (3284,42) → **SCREEN 坐标不可信**，必须与 `hyprctl clients` 融合（官方确认：Wayland 下只有合成器知道绝对位置，[freedesktop GTK-a11y-revamp](https://www.freedesktop.org/wiki/Accessibility/GTK-a11y-revamp/)）。

**纯视觉也不够，但首版数据引用有误。** 正确说法要分清「单步定位」与「多步/zoom 方法」，且**分源引用**：

| 类别 | 模型 | ScreenSpot-Pro | 来源 |
|---|---|---|---|
| 单步 grounding | SE-GUI-7B | 47.25 | [leaderboard JSON](https://gui-agent.github.io/grounding-leaderboard/results/screenspot_pro.json) |
| 单步 grounding | OmniParser v2 + GPT-4o | 39.6 | ScreenSpot-Pro **论文** Table |
| 单步 grounding | Jedi-7B | 39.5 | 论文 Table |
| 单步 grounding | Operator | 36.6 | 论文 Table |
| 单步 grounding | Qwen2.5-VL-7B | 26.76（榜单）/ 27.6（论文） | 两处 |
| **zoom / agentic** | UI-TARS-1.5（Apache-2.0 开源权重） | **61.61** | leaderboard JSON |
| **zoom / agentic** | Indeed-UI-32B（无 zoom 73.31） | **82.73** | leaderboard JSON |

- 首版称「最好的开源 grounding 模型在 ScreenSpot-Pro 上只有 40–47%」是**错的**：UI-TARS-1.5 = 61.61 自 2025-05 就在榜，Indeed-UI-32B 即使不算 zoom 也有 73.31；首版的表还自相矛盾（列了 27.6、35.7 却说区间是 40–47）。
- 首版挂了 leaderboard 的 URL，贴的却是**论文** Table 的数字——引用来源不一致。
- 榜单 JSON 无 method/zoom 结构化字段（zoom 只编码在条目名与描述文本里，97 条中 14 条带 zoom），**82.73 属多步/zoom 结果，不能当单步成功率或本机预期成功率**。

**正确结论：单步 grounding 仍在 35–47%；zoom-in / agentic 方法可到 60–82%。两者都不能直接当任务成功率，必须用当前 pi 模型 + 实际传图格式做端到端评测。**

**分辨率纪律（首版措辞有误）**：API 文档给的是**分任务建议**——桌面 `1024x768` 或 `1280x720`、网页 `1280x800` 或 `1366x768`，外加 `Avoid resolutions above 1920x1080`；真正的硬限是**模型图像上限**（按模型为 1568px/1.15MP 或 2576px/3.75MP），**不是 XGA**。而「≤ XGA」出自**参考实现 README** 的建议，不是 API 要求。确定成立的是：**API 不会替你缩放，超尺寸图会被直接拒**，所以必须自行降采样。

→ 现实做法：**`hyprctl clients` 拿窗口矩形 → 只截活动窗口 → 自行降采样 → 视觉模型出坐标 → 按 §1.3 公式换算回逻辑坐标**；AT-SPI 当可选加速（有 Action 接口时可直接 `do_action`，零坐标）。

### 1.5 坑清单（均为实测撞出）

1. **`hyprctl dispatch` 语法已变**：`dispatch movecursor 500 500`、`dispatch exec ...`、`keyword general:gaps_in 5` **全部报错**，必须 `dispatch 'hl.dsp.cursor.move({x=500,y=500})'` / `hl.dsp.exec_cmd("...")` / `eval 'hl.config({...})'`。
2. **标准 RemoteDesktop portal 路线不可用**：本机 `org.freedesktop.portal.RemoteDesktop` 不存在（`gdbus introspect` 确认只有 Screenshot / ScreenCast / InputCapture / GlobalShortcuts / …）→ 依赖它的注入方案在 Hyprland 上**静默降级**（[xdph#252](https://github.com/hyprwm/xdg-desktop-portal-hyprland/issues/252)）。**但不要推成「libei/EIS 在 Hyprland 不存在」**：Hyprland 有 [Eis.hpp](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/managers/input/Eis.hpp) / [InputCapture.cpp](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/protocols/InputCapture.cpp)，方向是 **EIS server —— 把用户真实输入捕获给 client**（`InputManager.cpp:757` 转发），**不是向 Hyprland 注入**；要采用需单独验证方向、激活条件与权限。
3. **`motion_absolute` 的参数类型是 `uint`，首版我传错了**（首版误称「Hyprland fixed-point 偏差」）。协议 XML 明确 `x/y/x_extent/y_extent` 全是 `uint`；Hyprland 实现一致（[VirtualPointer.cpp:26-33](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/protocols/VirtualPointer.cpp#L26-L33) 算 `x / xExtent`，**没有** `wl_fixed_to_double`，而同文件相对 `motion` 分支确实用了它）。正确用法：`extent` 传 bbox 尺寸，x/y 传 `logical - bbox_origin` **的整数值**（**不要** `wl_fixed_from_double`）。实测 x/y = 0 / 123 / 2000 / 3999 精确命中；越界静默 clamp。
4. **`hl.get_window()` 不可靠**：按 class / address / title 都可能返回 nil（静默失败），要用 `hl.get_windows()` 遍历匹配。
5. `hl.dsp.focus({window=handle})` 用 `get_window()` 拿的 handle 无效；遍历 `get_windows()` 得到的 handle 有效。
6. **权限系统拦不住鼠标注入**：`ecosystem:enforce_permissions`（本机 false），合法类型实测只有 `screencopy` / `plugin` / `keyboard` / `cursorpos` / `input-capture`（与 [DynamicPermissionManager.hpp:16-23](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/managers/permissions/DynamicPermissionManager.hpp#L16-L23) 一致），**没有指针/鼠标注入类权限**；`VirtualPointer.cpp` 与 `newVirtualMouse` 路径均无权限检查。`hl.permission` 只能约束键盘注入与截屏等，**不能作为虚拟指针注入的授权闸门**。
7. `hl.dsp.notification` 在 0.56.2 是 nil（文档里有、实现里没有）。

### 1.6 异常与停止语义（首版完全缺失）

对「拖拽按下时 helper 崩溃/退出」做了自校验实测（基线 click 必须恰好 1 PRESS + 1 RELEASE 才继续，探针用 `add_events` + `return True` 保证事件不重复计数）：

| 场景 | 客户端观察到 |
|---|---|
| 基线：`move + press + release` | 1 PRESS + 1 RELEASE ✅ |
| press 后**规范 `zwlr_virtual_pointer_v1_destroy()`** + 断开连接 | 只有 PRESS，**无 RELEASE**（等 1.5 s 仍无） |
| press 后**硬退出 `_exit(0)`**（模拟崩溃） | 只有 PRESS，**无 RELEASE** |
| 存活端**显式** `button(RELEASED)` | **恰好 1 次 RELEASE** → 恢复可行，且是 seat 全局的 |
| 恢复后再 `click` | 正常 1 PRESS + 1 RELEASE ✅ |

源码印证：`VirtualPointer.cpp:8-15/97-99` 销毁只 emit destroy；`destroyPointer` 只 erase + `setMouse`；`setMouse` 只换 `m_mouse`；**键盘有** `release_pressed_on_close` 分支而**指针没有**；`releaseAllMouseButtons()` 不在虚拟指针销毁路径上。

**结论**：**关闭连接/进程崩溃都不会释放按下的按钮**。扩展必须自持「停止 → 显式释放 → 重新观察确认」的恢复路径，未确认前不得继续；正常取消由存活 helper 显式释放。附带观察：hold 状态下收尾会**重复投递 PRESS**（1 次请求 → 2 次事件），机制未定位。

## 2. 生态现状

### 2.1 官方（分三层，别混为一谈）

| 层级 | 现状 |
|---|---|
| **模型 / API** | **与环境无关**。Anthropic：`your application runs every call in an environment you control`；OpenAI：`You provide the environment and execute the model's requests`。API 不接收显示尺寸、坐标以调用方返回截图的像素空间为准 → Linux/Wayland 控制器**可用**（[Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)、[OpenAI](https://developers.openai.com/api/docs/guides/tools-computer-use)） |
| **官方参考执行环境** | Anthropic `computer-use-demo` = Xvfb + Mutter + Tint2，文档全文 **0 次** `Wayland`；官方**新版** best-practices demo 反而是 **macOS-only**（`It targets macOS only`）。OpenAI 集成指南直接给 Linux 配方（Ubuntu + Xvfb + x11vnc + Firefox + scrot） |
| **桌面产品** | Claude Desktop Linux beta：`Computer Use: app and screen control isn't available on Linux`（[docs](https://code.claude.com/docs/en/desktop-linux)）；ChatGPT/Codex 桌面 Linux 预览：`Computer Use is available on macOS and Windows but not yet in the Linux preview`（[docs](https://learn.chatgpt.com/docs/linux/linux-app)）。Operator 已并入 ChatGPT agent，只做浏览器 |

**可下的结论**：厂商**未提供** Hyprland/Wayland 的现成驱动，且桌面产品都不支持 Linux；但**不是说 API 不能在 Linux 上用**。

### 2.2 开源（筛掉垃圾后）

| 项目 | 机制 | 合成器 | 许可 | 活跃 | 判定 |
|---|---|---|---|---|---|
| [agent-sh/computer-use-linux](https://github.com/agent-sh/computer-use-linux) | GNOME D-Bus + RemoteDesktop portal + wtype/ydotool | GNOME 完整；Hyprland **仅窗口枚举** | MIT | 507★ | ✅ 最成熟，但 GNOME 中心 |
| [IlyasKhallouki/hypruse](https://github.com/IlyasKhallouki/hypruse) | `grim` + `wlr-virtual-pointer` 裸协议 + wtype | **Hyprland 原生** | MIT | 21★ | ✅ **最贴近本机场景** |
| [trycua/cua](https://github.com/trycua/cua) | AT-SPI / libei / 私有插件 | X11 认证；Sway 有界；**Hyprland 实验** | MIT | 22.4k★ | ✅ 文档最严谨 |
| [isac322/kwin-mcp](https://github.com/isac322/kwin-mcp) | KWin D-Bus + 私有 EIS | 仅 KDE | MIT | 45★ | ✅ KDE 专用 |
| [domdomegg/computer-use-mcp](https://github.com/domdomegg/computer-use-mcp) | nut.js（纯像素，X11） | 跨平台 | MIT | 364★ | ⚠️ 无 a11y |
| nedos/linuse、AdvisorAGI/claude-workman、nordbyte/PeekabooX 等 | — | — | — | 0–9★ | ❌ 周末项目 / 生成式巨型仓库 / 安装即失败 |

**许可证注意**：`ydotool` 是 **AGPL-3.0**（传染性），且需常驻 `ydotoold` + `/dev/uinput`。本机 `/dev/uinput` 对 sjet 可写（ACL 已授权），但没必要——Hyprland 路线用 `wlr-virtual-pointer` 更干净。

### 2.3 基准的经验（OSWorld / OSWorld-V2）

- 环境是**完整 VM**（VMware/VirtualBox 或 Docker+KVM），guest 内跑 Flask `:5000/screenshot` + `pyautogui`
- ACI 观测 = `screenshot` / `a11y_tree` / `screenshot_a11y_tree` / `som`；动作 = `pyautogui` 代码或 `computer_13` 枚举
- 可迁移的经验：① a11y tree + 截图是最佳观测组合；② 显式枚举动作空间优于任意代码；③ 分辨率纪律（按模型与任务设定图像尺寸，并自行缩放）；④ 隔离环境是安全前提
- 不迁移：Flask-in-VM 架构、`pyautogui`（X11 only）

来源：[OSWorld](https://github.com/xlang-ai/OSWorld)、[OSWorld-V2](https://github.com/xlang-ai/OSWorld-V2)。

## 3. 沙箱 / VM 路线

| 档位 | 代表 | 本机就绪度 |
|---|---|---|
| Xvfb + X11 | Anthropic 的 `computer-use-demo` | 需装 `xorg-server-xvfb`；**无 GPU 加速**，WebGL/视频吃力 |
| Headless Wayland | `WLR_BACKENDS=headless` + wayvnc / `hyprctl output create headless` | ✅ 已装 wayvnc；实测 `output create headless` → 1920×1080，`grim -o HEADLESS` 31 ms |
| 容器化桌面 | KasmVNC / Selkies | ✅ Docker 29.7.2；**纯 CPU 可用**，建议 clamp 到 1920×1080 |
| 全 VM | QEMU/KVM + spice，或 OSWorld 的 VMware | ✅ `/dev/kvm` 存在且 world-writable、qemu-full 11.1.1、Radeon 780M、`/home` 剩 452 G；⚠️ 仅 10 G 可用内存、Docker 占 245 G 可回收；libvirt **未装** |

**这些手段解决的是不同边界，不能互相替代**（首版把它们排成一条「隔离强度」链是过度简化）：

| 手段 | 实际解决什么 | 不解决什么 |
|---|---|---|
| 独立用户 + 独立合成器 | 输入与窗口环境分离、文件系统权限 | 同一 agent 若能用 bash 触达原桌面，就不构成强制边界 |
| 同一合成器内新增 output / 换 workspace | 整理窗口、减少干扰 | **不隔离输入**——共享同一套键鼠与焦点 |
| bubblewrap / firejail（✅ 已装 bwrap） | 文件系统/网络限制 | 不解决输入与桌面访问 |
| 容器化桌面 / 全 VM + 快照 | 环境隔离、可回滚 | 不能撤回已发生在外部服务的账号操作 |

「独立用户」也不是写出名字就成立：要控制原桌面还需解决 Wayland/Hyprland socket 的访问与授权桥接。参考 Anthropic 自身的演进：claude.ai 用 gVisor 一次性容器；Claude Code 用 bubblewrap + 默认拒网；Cowork 用全 VM（[containment](https://www.anthropic.com/engineering/how-we-contain-claude)）。

## 4. 推荐选型

**在本机跑通的组合：**

```
观测  按目标裁剪 + 自行降采样（grim；全画布 JPEG 约 195 ms，循环采样别用 PNG）
语义  hyprctl -j clients / monitors / activewindow / cursorpos  ← 窗口矩形与坐标系
定位  只截活动窗口 → 视觉模型出坐标 → 按 §1.3 公式换算（不要除 scale）
移动  wlr-virtual-pointer-v1 绝对移动（uint 参数，bbox 相对坐标）
点击  同一虚拟指针路径：move + button（真点击、会聚焦）
滚轮  wl_pointer.axis（垂直 0 / 水平 1，value 为 fixed）
拖拽  同一虚拟指针路径一次完成 press → 插值 motion → release
键盘  先聚焦并验证目标，再用 wtype 输入文本与快捷键
```

**关于「闸门」（首版过度承诺，已修正）**：
`hl.permission` 能约束 `keyboard` / `screencopy` / `cursorpos` / `input-capture`，**但拦不住虚拟指针的鼠标注入**，而且同一个 agent 仍可通过 bash 触达桌面。所以扩展内部的开关、目标校验与停止入口只能**减少误操作**，**不构成对该 agent 的强制安全边界**。真正的边界要靠独立合成器/用户 + 文件系统与网络限制，或 VM。

**关于运行目标（首版措辞已修正）**：

| 场景 | 路线 |
|---|---|
| 需要真实登录态 / 浏览器 profile | 真实 Hyprland 桌面，**首版单 seat**：与用户**共用光标与焦点**，靠「明确接管 + 可停止」而不是「无干扰并行」。同一合成器内换 workspace / 新增 output 只是**减少干扰**，不是隔离 |
| 通用任务、可接受没有你的账号 | **独立合成器/沙箱**（`hyprctl output create headless` 或 sway+cage）——本机 30 ms 截图、无 root |
| 处理不可信网页/邮件内容 | **KVM 全 VM** + 快照回滚 + 默认拒网（本机 KVM 已验证） |

**若落成 pi 扩展**（本轮未做）：`extensions/pi-computer-use/`，建议**两段式工具面**而非首版列的八个平铺工具：

```
computer_observe(target?, region?)  → 图片 + observation_id + 图片尺寸 + 窗口/焦点元数据
computer_act(observation_id, action, ...) → 执行情况 + 新图片 + 新 observation_id
```

- 动作枚举 `focus / move / click / type / key / scroll / drag`；`drag` 在一次调用内完成按下、移动、松开，**不向模型暴露需跨调用保持的裸按键状态**
- 所有图片坐标**相对于该次 observation**，换算数据由扩展保存，不要求模型自己除 scale；`observation_id` / 图片尺寸 / 状态必须进工具 `content`（不能只放渲染用的 `details`）
- 复用 pi 原生 **`executionMode: "sequential"`**（`types.d.ts:370`；`agent-loop.js:287-290` 只要批内有任一 sequential 工具就整批串行），不必自建队列；它不替代跨实例互斥与停止状态
- **observation 失效规则**：接受动作即失效旧 O（动作可能部分执行，失败同样失效）；动作后成功截图才产生新 O；截图失败时保留「已执行/待确认」事实但**不恢复旧 O**
- **停止入口**必须绕过动作队列并**保持停止态**：先置停止、使待执行动作失效，再中止**全部**输入进程（含独立 `wtype`），最后走 §1.6 的显式释放与重新观察。pi 只把 `AbortSignal` 传给 `execute`，子进程中止要扩展自己实现
- 资源生命周期：不得在 extension factory 启动常驻进程（延迟到 `session_start` 或首次使用）；中止 / stdin EOF / helper 退出 / `/reload` / 会话切换都要清理

## 5. 未验证 / 待确认

- 其他合成器对 `motion_absolute` 的 extent 处理（Hyprland 与协议一致；wlroots 等未比对）
- §1.6 中「hold 状态收尾会重复投递 PRESS」的机制未定位
- 混合刷新率多显示器下 `cursor.move` 的准确性
- AT-SPI 对 Firefox / LibreOffice 的覆盖（本机未运行这两个）
- Portal ScreenCast 的 `persist_mode` / `restore_token` 免打扰效果
- 本机未实测 Xvfb / 容器化桌面的真实帧率与点击精度
- **未实测**：长文本输入 / 快捷键 / 拖拽进行中触发停止、helper 崩溃、`/reload` 的完整故障矩阵（§1.6 只覆盖了拖拽按下）
- **未实测**：同一 observation 在 UI 变化后的失效判定，以及菜单/弹窗/文件选择器下的截图与焦点行为

## 附：实测方法与复现

**结论**：本报告的输入/坐标/故障类实测**未形成可复现交付**——探针源码只存在于当次会话的 scratchpad，会话结束后即消失（本次修订时已确认 `vptr.h`/`vptr.c`/`vpx.c` 已不存在）。首版「所有实测均附命令」的承诺不成立。下面是重建所需的最小信息。

**重建配方**：

```bash
# 1) 生成协议绑定（XML 来自 wlr-protocols，本机在 wayland-protocols-wlr crate 内）
wayland-scanner client-header wlr-virtual-pointer-unstable-v1.xml vptr.h
wayland-scanner private-code  wlr-virtual-pointer-unstable-v1.xml vptr.c

# 2) 编译（gcc + libwayland）
gcc -o vp vp.c vptr.c $(pkg-config --cflags --libs wayland-client)
```

**探针 CLI 契约**（首版存在的程序及其作用）：

| 程序 | 作用 |
|---|---|
| `vp move X Y` / `vp press X Y` / `vp release` / `vp click X Y` / `vp scroll X Y DY` | 虚拟指针绝对移动 / 按下 / 释放 / 点击 / 滚动；`X,Y` 为 bbox 相对逻辑坐标整数值 |
| `vpstuck X Y` | press 后 `_exit(0)`，不复位不释放——用于测异常释放 |
| 常驻 daemon（stdin 读 `x y [btn]`） | 常驻连接，免去每次进程启动；**往返延迟本次未单独计时**（首版写的 4 ms 来自一次退化的 pipe 测量，不成立） |
| 绑定指定 output 的变体 | `create_virtual_pointer_with_output` |
| `gtkprobe.py` / `probe2.py` / `probe3.py` | GTK3 事件探针：按钮/滚轮/拖拽到达验证、精确事件计数（`add_events` + `return True`）、焦点与 crossing 事件 |

**事件日志证据**：§1.6 表格即原始事件序列（`PRESS` / `RELEASE` 行）；§1.2.1 即 `focus-in` / `focus-out` / `enter` / `leave` / `key-press` 序列。

**性能数据采样方法**（样本均很小，只作量级参考）：`grim -t jpeg -q80` 全画布本次 3 次 192–198 ms（**上一次会话 3 次为 225–241 ms，说明受负载影响**）；`grim -t png` 全画布 3 次 1.2–1.9 s；`wtype` 单字符 3 次 10–12 ms；`hl.dsp.cursor.move` 3 次 5–8 ms。

**虚拟指针延迟的正确说法**：`connect + 2 次 registry roundtrip + motion_absolute + flush` 实测约 3–4 ms。首版表格里的「153 ms（一次性进程）」**不是连接成本**，而是我的 helper 在断开前 `usleep` 等待合成器处理的保守值（不等就可能丢事件）；因此「153 ms vs 4 ms」实际上是「是否包含等待」，**不是**「常驻 vs 一次性」的净差。常驻 daemon 的单次往返延迟本次未单独计时。

**坐标公式实证方法**：对一比一区域 `(7,517) 1269×1391` 取 `grim -g` 物理图 → LANCZOS 降采样到 `951×1043` → 在网格上筛出「正确公式与错误公式预测颜色差异 > 25」的 1437 个判别性采样点 → 分别回采并比对平均色差。

**外部来源的版本标注**：Hyprland 源码引用均为 tag `v0.56.2`（commit `efb5099`）；协议 XML 来自 `wayland-protocols-wlr 0.3.12` 内的 wlr-protocols；榜单数据取自 `screenspot_pro.json`（2026-09-11 时点，97 条）。
