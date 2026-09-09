# Linux computer use 调研报告

> 状态：调研完成（2026-09-09）· 未实现任何代码
>
> 目标环境：本机 Arch Linux + Hyprland 0.56.2 / Wayland，双 4K 显示器（`DP-1` 横屏 + `HDMI-A-1` 竖屏，均 `scale=1.5`）。
>
> 本文记录**实测结论与选型依据**。所有标注「实测」的结论均在本机跑通并附命令；外部项目结论附 URL。若后续实现，本文可作为 PRD 输入，但**不是 PRD**。

## 0. 结论速览

| 问题 | 答案 |
|---|---|
| 有没有现成能用的？ | 有，但**没有一个是「装上就能驱动 Hyprland」的**。GNOME 生态最成熟；Hyprland 只有小项目（[hypruse](https://github.com/IlyasKhallouki/hypruse) 21★） |
| 官方支持？ | Anthropic / OpenAI **都不支持 Linux computer use**，Anthropic 参考实现死守 X11/Xvfb |
| 本机能不能做？ | **能，且不需要 root、不需要装新依赖**。截图 + 光标 + 键盘已实测打通；鼠标点击/滚轮/拖拽需自写约 80 行 C（`wlr-virtual-pointer-v1`） |
| 最大的坑 | ① Hyprland 0.56.2 把 `hyprctl dispatch` 改成 Lua，**写死旧语法的工具会静默失效**；② libei / RemoteDesktop portal 在 Hyprland 上**根本不存在** |
| 驱动真实桌面还是沙箱？ | 需要真实登录态/浏览器 profile → 真实桌面 + 隔离；否则沙箱更划算（本机 KVM 已就绪） |

**已拍板的路线**（2026-09-09）：

- 运行目标：**真实 Hyprland 桌面**
- grounding：**视觉为主 + 窗口语义辅助**（AT-SPI 当可选加速）
- 本轮只归档调研，不写代码

## 1. 本机环境实测

### 1.1 观测：屏幕捕获

| 方式 | 延迟（实测） | 权限摩擦 | 备注 |
|---|---|---|---|
| `grim -t jpeg -q80` 全画布 | **195 ms**（2.1 MB） | 无 | PNG 同尺寸约 1.2 s，**循环采样别用 PNG** |
| `grim -o <output>` | 单屏约 75 ms | 无 | |
| `grim -T <stableId>` 单窗口 | — | 无 | 可截被遮挡窗口，但实测拿到全黑（未重绘） |
| `grim -g "x,y WxH"` 区域 | 约 200 ms | 无 | 参数用**逻辑坐标** |
| Portal `Screenshot` | 约 1.0 s | 无弹窗 | 非流式 |
| Portal `ScreenCast` + PipeWire | 13–42 fps | **必弹授权框** | 适合连续帧，首次需人工点选 |

`grim` 实际走 `ext_image_copy_capture_v1`（不是旧 screencopy），Hyprland 已实现。

### 1.2 动作：输入注入

五条路径实测对比：

| 能力 | `hl.dsp.cursor.move` | `hl.dsp.send_shortcut` | `hl.dsp.send_key_state` | `wtype` | `wlr-virtual-pointer-v1` |
|---|---|---|---|---|---|
| 光标绝对移动 | ✅ 精确 | — | — | ❌ 无鼠标 | ✅ 精确 |
| 延迟 | **6 ms** | 约 5 ms | 约 5 ms | 10 ms/字符 | **4 ms**（常驻）/ 153 ms（一次性进程） |
| 左键点击 | — | ⚠️ 投递给光标下窗口但**不改变焦点** | 同左 | — | ✅ **真点击，会聚焦/raise** |
| 滚轮 | ❌ | ❌（`mouse:274/275` 变成 X11 button 8/9，GTK 收不到 scroll） | ❌ | — | ✅ **axis 事件，dir=4，dy=±1.5** |
| 拖拽 | — | 部分 | — | — | ✅ 12 步插值，press→motion×12→release 全通 |
| 键盘 | — | ✅ 含 modifier（`SHIFT`+`b`→`B`） | ✅ | ✅ ASCII + **CJK** | 可扩展 |
| 投递到**未聚焦**窗口 | — | ✅ `{window=w}` | ✅ `{window=w}` | ❌ 依赖焦点 | — |
| 需 root / 新依赖 | 否 | 否 | 否 | 否（已装） | 否（gcc + libwayland 即可） |

**关键差异（A/B 实测）**：光标移到窗口 B 上方点一下——

- `send_shortcut(mouse:272)` → B 收到 press 事件，但**焦点仍在 A**
- `wlr-virtual-pointer` 点击 → B 收到事件且**焦点切到 B**

即合成器内部的 `send_shortcut` 绕过了正常的点击聚焦路径。要让 agent 的「点击」表现得像人，必须用虚拟指针。

**键盘的「不抢焦点」特性很有用**：`send_key_state({key="z", window=未聚焦窗口})` 实测成功投递且焦点不动，适合后台填表。

### 1.3 坐标换算（像素级验证，mean abs diff = 0.0）

```
逻辑布局：DP-1(2560×1440) @ (0,475)      HDMI-A-1(1440×2560, transform=1) @ (2560,0)
逻辑 bbox = 4000×2560                    合成画布 = 6000×3840 px（× scale 1.5）
```

| 方向 | 规则 |
|---|---|
| `hyprctl clients` 的 `at`/`size` | **逻辑坐标** |
| `grim -g "X,Y WxH"` | 逻辑坐标 → 输出物理像素 `W*scale × H*scale` |
| 画布内定位 | `(logical - bbox_origin) * scale`（旋转屏同样适用，实测命中） |
| 输入坐标 | 逻辑坐标，Hyprland 自动 clamp 到输出并集（`y=2500` → `1914`） |
| 视觉模型给的坐标 | 必须 `logical = image_px / scale + bbox_origin`，且**自行降采样**（Anthropic 要求 ≤ XGA） |

### 1.4 定位 grounding：AT-SPI vs 视觉

**AT-SPI 在本机基本没用**（实测）：

| 应用 | 注册 a11y bus | 树质量 |
|---|---|---|
| waybar / vicinae / quickshell | ✅ | 有元素，但只有自己的 UI |
| **Chrome / VSCode / Obsidian / Electron** | ❌ | 完全没有 |
| 自建 GTK3 探针 | ✅ | 但 frame `children=0`（无控件） |

且 `get_extents(SCREEN)` **返回 (0,0)**，而 `hyprctl` 说窗口在 (3284,42) → **SCREEN 坐标不可信**，必须与 `hyprctl clients` 融合（官方确认：Wayland 下只有合成器知道绝对位置，[freedesktop GTK-a11y-revamp](https://www.freedesktop.org/wiki/Accessibility/GTK-a11y-revamp/)）。

**纯视觉也不够**：最好的开源 grounding 模型在 ScreenSpot-Pro 上只有 **40–47%** 准确率（[leaderboard](https://gui-agent.github.io/grounding-leaderboard/index.html)）：

| 模型 | ScreenSpot-Pro | OSWorld-G |
|---|---|---|
| SE-GUI-7B | 47.2 | — |
| OmniParser v2 + GPT-4o | 39.6 | — |
| Jedi-7B | 39.5 | 54.1 |
| Operator | 36.6 | 40.6 |
| UI-TARS-7B | 35.7 | 47.5 |
| Qwen2.5-VL-7B | 27.6 | 31.4 |

→ 现实做法：**`hyprctl clients` 拿窗口矩形 → 只截活动窗口 → 降采样 → 视觉模型出坐标 → 换算回逻辑坐标**；AT-SPI 当可选加速（有 Action 接口时可直接 `do_action`，零坐标）。

### 1.5 坑清单（均为实测撞出）

1. **`hyprctl dispatch` 语法已变**：`dispatch movecursor 500 500`、`dispatch exec ...`、`keyword general:gaps_in 5` **全部报错**，必须 `dispatch 'hl.dsp.cursor.move({x=500,y=500})'` / `hl.dsp.exec_cmd("...")` / `eval 'hl.config({...})'`。
2. **`org.freedesktop.portal.RemoteDesktop` 不存在**（`gdbus introspect` 确认只有 Screenshot / ScreenCast / InputCapture / GlobalShortcuts / …）→ 所有走 libei 注入的方案在 Hyprland 上**静默降级**（[xdph#252](https://github.com/hyprwm/xdg-desktop-portal-hyprland/issues/252)）。
3. **`wlr-virtual-pointer` 的 `motion_absolute` 有 fixed-point 偏差**：Hyprland 把 `wl_fixed_t` 当**裸整数**用。配方：`extent = bbox 尺寸`，x/y 直接传逻辑坐标的整数值（`(wl_fixed_t)logical`，**不是** `wl_fixed_from_double`）。实测 x = 0 / 123 / 2000 / 3999 全部精确命中。
4. **`hl.get_window()` 不可靠**：按 class / address / title 都可能返回 nil（静默失败），要用 `hl.get_windows()` 遍历匹配。
5. `hl.dsp.focus({window=handle})` 用 `get_window()` 拿的 handle 无效；遍历 `get_windows()` 得到的 handle 有效。
6. Hyprland 有权限系统（`ecosystem:enforce_permissions`，本机 false）：类型 `keyboard` / `screencopy` / `plugin` / `cursorpos`，可用 `hl.permission({binary, type, mode})` 白名单——**这正是给 agent 工具加闸门的地方**。
7. `hl.dsp.notification` 在 0.56.2 是 nil（文档里有、实现里没有）。

## 2. 生态现状

### 2.1 官方

| 项目 | Linux 支持 |
|---|---|
| Anthropic computer use | **X11/Xvfb 独占**，环境 Xvfb + Mutter + Tint2，文档全文 0 次出现 "Wayland"（[docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)） |
| Claude Desktop Linux beta | 明确「Computer Use 在 Linux 上不可用」（[docs](https://code.claude.com/docs/en/desktop-linux)） |
| OpenAI ChatGPT/Codex 桌面 Linux | 「Computer Use 尚不支持 Linux」；Operator 已并入 ChatGPT agent，只做浏览器 |

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
- 可迁移的经验：① a11y tree + 截图是最佳观测组合；② 显式枚举动作空间优于任意代码；③ **分辨率纪律**（≤ XGA）；④ 隔离环境是安全前提
- 不迁移：Flask-in-VM 架构、`pyautogui`（X11 only）

来源：[OSWorld](https://github.com/xlang-ai/OSWorld)、[OSWorld-V2](https://github.com/xlang-ai/OSWorld-V2)。

## 3. 沙箱 / VM 路线

| 档位 | 代表 | 本机就绪度 |
|---|---|---|
| Xvfb + X11 | Anthropic 官方 demo | 需装 `xorg-server-xvfb`；**无 GPU 加速**，WebGL/视频吃力 |
| Headless Wayland | `WLR_BACKENDS=headless` + wayvnc / `hyprctl output create headless` | ✅ 已装 wayvnc；实测 `output create headless` → 1920×1080，`grim -o HEADLESS` 31 ms |
| 容器化桌面 | KasmVNC / Selkies | ✅ Docker 29.7.2；**纯 CPU 可用**，建议 clamp 到 1920×1080 |
| 全 VM | QEMU/KVM + spice，或 OSWorld 的 VMware | ✅ `/dev/kvm` 存在且 world-writable、qemu-full 11.1.1、Radeon 780M、`/home` 剩 452 G；⚠️ 仅 10 G 可用内存、Docker 占 245 G 可回收；libvirt **未装** |

**隔离强度排序**（[Anthropic containment](https://www.anthropic.com/engineering/how-we-contain-claude)）：独立用户 + 嵌套合成器（最轻）→ bubblewrap/firejail（✅ 已装 bwrap）→ 容器化桌面 → **KVM 全 VM + 快照 + 默认拒网**（最强）。

Anthropic 自身的演进值得参考：claude.ai 用 gVisor 一次性容器；Claude Code 用 bubblewrap + 默认拒网（权限提示减 84%）；Cowork 用全 VM。

## 4. 推荐选型

**在本机跑通的组合：**

```
观测  grim -t jpeg -q80（全画布 195ms，或只截活动窗口后降采样到 XGA）
语义  hyprctl -j clients / monitors / activewindow / cursorpos   ← 窗口矩形与坐标系
定位  活动窗口截图 → 视觉模型 → 逻辑坐标换算
移动  hl.dsp.cursor.move({x,y})                      6ms，精确
点击  wlr-virtual-pointer-v1 自写 C daemon           4ms，真点击 + 聚焦 + 滚轮 + 拖拽
键盘  hl.dsp.send_key_state({..., window=w})         定向、不抢焦点
      wtype                                          ASCII + CJK 兜底
闸门  hl.permission() + 检测物理键盘事件即暂停 + 不可逆动作人工确认
```

**三条路线，按场景选：**

| 场景 | 路线 |
|---|---|
| 需要真实登录态 / 浏览器 profile | 真实 Hyprland 桌面 + 独立用户 + 独立 workspace/headless 输出隔离 |
| 通用任务、可接受没有你的账号 | **headless Wayland 沙箱**（`hyprctl output create headless` 或 sway+cage）——本机 30 ms 截图、无 root |
| 处理不可信网页/邮件内容 | **KVM 全 VM** + 快照回滚 + 默认拒网（本机 KVM 已验证） |

**若落成 pi 扩展**（本轮未做）：`extensions/pi-computer-use/`，工具面暴露 `screenshot` / `list_windows` / `move` / `click` / `type` / `key` / `scroll` / `drag`，用 `hl.permission` 做白名单 + 物理键盘介入即暂停。虚拟指针 daemon 建议独立进程常驻（一次性进程 153 ms vs 常驻 4 ms）。

## 5. 未验证 / 待确认

- `wlr-virtual-pointer` 的 fixed-point 偏差是 Hyprland 特有还是 wlroots 通用（换合成器需重测）
- 混合刷新率多显示器下 `cursor.move` 的准确性
- AT-SPI 对 Firefox / LibreOffice 的覆盖（本机未运行这两个）
- Portal ScreenCast 的 `persist_mode` / `restore_token` 免打扰效果
- 本机未实测 Xvfb / 容器化桌面的真实帧率与点击精度

## 附：探针源码

实测用到的探针（wayland-scanner 生成 `vptr.h`/`vptr.c` + 以下 C 程序）未入库，存于当次会话 scratchpad：

| 文件 | 作用 |
|---|---|
| `vpx.c` | 虚拟指针绝对移动 + 点击（一次性进程，修正 fixed-point 偏差） |
| `vpd2.c` | 常驻 daemon，stdin 读 `x y [btn]`，4 ms/次 |
| `vps.c` | 滚轮（axis / axis_source） |
| `vpd.c` | 拖拽（press → 12 步插值 → release） |
| `vpo.c` | 绑定指定 output 的虚拟指针（`create_virtual_pointer_with_output`） |
| `gtkprobe.py` / `gtkprobe2.py` | GTK3 事件探针，用于验证点击/滚轮/拖拽是否真的到达客户端 |

复现所需：`gcc`、`pkg-config --cflags --libs wayland-client`、`wayland-scanner`、`wlr-virtual-pointer-unstable-v1.xml`（在 `wayland-protocols-wlr` crate 或 wlr-protocols 仓库）。
