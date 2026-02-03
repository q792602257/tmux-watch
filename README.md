# tmux-watch

[中文](#zh) | [English](#en)

<a id="zh"></a>
## 中文

基于 tmux 输出的稳定性监测插件：当某个 pane 的输出在连续 N 次捕获中保持不变时，触发告警并唤醒 Agent，总结并通知你。

### 安装

#### 从 npm 安装

```bash
openclaw plugins install tmux-watch
```

#### 从本地目录安装

```bash
openclaw plugins install /path/to/tmux-watch
```

或使用软链接（便于开发调试）：

```bash
openclaw plugins install --link /path/to/tmux-watch
```

#### 从归档安装

```bash
openclaw plugins install ./tmux-watch.tgz
```

> 安装或启用插件后需要重启 Gateway。

### 配置

在 `~/.openclaw/openclaw.json` 中启用并配置：

```json5
{
  "plugins": {
    "entries": {
      "tmux-watch": {
        "enabled": true,
        "config": {
          "socket": "/private/tmp/tmux-501/default",
          "captureIntervalSeconds": 10,
          "stableCount": 6,
          "captureLines": 200,
          "stripAnsi": true,
          "maxOutputChars": 4000,
          "notify": {
            "mode": "targets",
            "targets": [
              { "channel": "gewe-openclaw", "target": "wxid_xxx", "label": "gewe" }
            ]
          }
        }
      }
    }
  }
}
```

#### 配置项说明

- `enabled`：是否启用插件（默认 `true`）。
- `socket`：tmux socket 路径（必填）。
- `captureIntervalSeconds`：每次捕获间隔（秒），默认 `10`。
- `stableCount`：连续多少次捕获内容一致才触发告警，默认 `6`。总时长 = `captureIntervalSeconds × stableCount`（例如 `3 × 5 = 15s`）。
- `pollIntervalMs`：**兼容字段**，捕获间隔（毫秒）。仅在需要与旧配置兼容时使用。
- `stableSeconds`：**兼容字段**，稳定时长（秒）。会按当前捕获间隔换算成次数。
- `captureLines`：从 pane 末尾向上截取的行数（默认 `200`）。
- `stripAnsi`：是否剥离 ANSI 转义码（默认 `true`）。
- `maxOutputChars`：通知中最多包含的输出字符数（默认 `4000`，超出将从末尾截断）。
- `sessionKey`：覆盖默认 Agent 会话（通常不需要改）。
- `notify.mode`：通知方式（`last` / `targets` / `targets+last`）。
- `notify.targets`：通知目标数组（支持多个 channel，按数组顺序发送）。

### 快速配置（onboarding）

插件提供一个最小化向导，仅要求设置 `socket`：

```bash
openclaw tmux-watch setup
```

你也可以手动指定：

```bash
openclaw tmux-watch setup --socket "/private/tmp/tmux-501/default"
```

#### socket 如何获取

进入目标 tmux 会话后执行：

```bash
echo $TMUX
```

输出形如：

```
/private/tmp/tmux-501/default,3191,4
```

逗号前的路径就是 socket，配置到 `socket` 字段即可。

### 订阅（通过 Agent 工具）

```json
{
  "action": "add",
  "target": "session:0.0",
  "label": "codex-tui",
  "note": "本会话是AI编程TUI助手，卡住时总结最后输出并通知我",
  "captureIntervalSeconds": 3,
  "stableCount": 5
}
```

### 发送输入到 pane

```bash
openclaw tmux-watch send test-dir:0.0 "your text"
```

默认行为等同于两步：先 `send-keys -l` 输入文本，再单独 `send-keys C-m` 提交。两步之间默认延迟 `20ms`。

常用选项：

- `--no-enter`：只输入，不回车。
- `--delay-ms 50`：调整输入与回车之间的延迟。
- `--socket /path/to/socket`：指定 tmux socket。
- `--target ... --text ...`：用参数替代位置参数。

### 捕获输出 / 截图

```bash
# 文本（默认）
openclaw tmux-watch capture session:0.0

# 图片（临时文件，默认 10 分钟 TTL）
openclaw tmux-watch capture session:0.0 --format image

# 文本 + 图片（可选 base64）
openclaw tmux-watch capture session:0.0 --format both --base64

# 指定输出路径（不会自动清理）
openclaw tmux-watch capture session:0.0 --format image --output /tmp/pane.png
```

说明：

- 图片优先使用 `cryosnap`，其次使用 `freeze`。若均未安装，请手动安装：
  - `openclaw tmux-watch install cryosnap`
  - `openclaw tmux-watch install freeze`
- 临时图片默认 TTL 为 10 分钟，可用 `--ttl-seconds` 覆盖。
- 可用 `--image-format png|svg|webp` 指定格式。

### 依赖

- 系统依赖：`tmux`
- 可选截图依赖：`cryosnap`（优先）或 `freeze`
- peer 依赖：`openclaw >= 2026.1.29`

<a id="en"></a>
## English

tmux-watch monitors a tmux pane and triggers an alert when the output stays unchanged for N consecutive captures.
The agent is woken up to summarize the last output and notify you.

### Install

#### From npm

```bash
openclaw plugins install tmux-watch
```

#### From a local directory

```bash
openclaw plugins install /path/to/tmux-watch
```

Or use a symlink (for local development):

```bash
openclaw plugins install --link /path/to/tmux-watch
```

#### From an archive

```bash
openclaw plugins install ./tmux-watch.tgz
```

> Restart the Gateway after installing or enabling the plugin.

### Configuration

Edit `~/.openclaw/openclaw.json`:

```json5
{
  "plugins": {
    "entries": {
      "tmux-watch": {
        "enabled": true,
        "config": {
          "socket": "/private/tmp/tmux-501/default",
          "captureIntervalSeconds": 10,
          "stableCount": 6,
          "captureLines": 200,
          "stripAnsi": true,
          "maxOutputChars": 4000,
          "notify": {
            "mode": "targets",
            "targets": [
              { "channel": "gewe-openclaw", "target": "wxid_xxx", "label": "gewe" }
            ]
          }
        }
      }
    }
  }
}
```

#### Configuration reference

- `enabled`: Enable/disable the plugin (default `true`).
- `socket`: tmux socket path (required).
- `captureIntervalSeconds`: Capture interval in seconds (default `10`).
- `stableCount`: Number of consecutive identical captures before alert (default `6`). Total duration = `captureIntervalSeconds × stableCount` (for example `3 × 5 = 15s`).
- `pollIntervalMs`: **Legacy** capture interval in milliseconds. Use only for backward compatibility.
- `stableSeconds`: **Legacy** stable duration in seconds. Converted into counts using the current interval.
- `captureLines`: Lines captured from the bottom of the pane (default `200`).
- `stripAnsi`: Strip ANSI escape codes (default `true`).
- `maxOutputChars`: Max output chars in the notification (default `4000`, tail-truncated).
- `sessionKey`: Override the default agent session (rare).
- `notify.mode`: Notification mode (`last` / `targets` / `targets+last`).
- `notify.targets`: Notification targets (multiple channels supported, sent in order).

#### Find the socket

Inside the target tmux session:

```bash
echo $TMUX
```

Output looks like:

```
/private/tmp/tmux-501/default,3191,4
```

Use the path before the first comma as `socket`.

### Quick setup (onboarding)

The plugin ships a minimal setup wizard that only requires the `socket`:

```bash
openclaw tmux-watch setup
```

Or pass it explicitly:

```bash
openclaw tmux-watch setup --socket "/private/tmp/tmux-501/default"
```

### Add a subscription (via agent tool)

```json
{
  "action": "add",
  "target": "session:0.0",
  "label": "codex-tui",
  "note": "This is an AI coding TUI; summarize the last output and notify me if it stalls.",
  "captureIntervalSeconds": 3,
  "stableCount": 5
}
```

### Send input to a pane

```bash
openclaw tmux-watch send test-dir:0.0 "your text"
```

Default behavior is two-step: send text with `send-keys -l`, then send `C-m` (Enter) separately.
The default delay between the two steps is `20ms`.

Common options:

- `--no-enter`: type only, do not press Enter.
- `--delay-ms 50`: adjust the delay between text and Enter.
- `--socket /path/to/socket`: specify tmux socket.
- `--target ... --text ...`: use flags instead of positional args.

### Capture output / snapshot

```bash
# Text only (default)
openclaw tmux-watch capture session:0.0

# Image only (temporary file, 10-min TTL)
openclaw tmux-watch capture session:0.0 --format image

# Both text + image (optional base64)
openclaw tmux-watch capture session:0.0 --format both --base64

# Persist image to a path (no TTL cleanup)
openclaw tmux-watch capture session:0.0 --format image --output /tmp/pane.png
```

Notes:

- Image capture prefers `cryosnap`, then falls back to `freeze`. If neither exists, install one:
  - `openclaw tmux-watch install cryosnap`
  - `openclaw tmux-watch install freeze`
- Temporary images default to a 10-minute TTL; override with `--ttl-seconds`.
- Use `--image-format png|svg|webp` to select the output format.

### Requirements

- System dependency: `tmux`
- Optional image tools: `cryosnap` (preferred) or `freeze`
- Peer dependency: `openclaw >= 2026.1.29`
