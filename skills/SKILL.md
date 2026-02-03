---
name: tmux-watch
description: Manage tmux-watch subscriptions and interpret stable-output alerts.
metadata:
  { "openclaw": { "emoji": "🧵", "os": ["darwin", "linux"], "requires": { "bins": ["tmux"] } } }
---

# tmux-watch Skill (OpenClaw)

Use this skill to manage tmux-watch subscriptions. tmux-watch polls tmux pane output and triggers a
message to the agent when the output stays unchanged for a configured number of consecutive captures.

## Core rules

- Always use tmux directly (no wrappers). The agent is responsible for listing sessions/windows/panes
  and choosing a `target` for the subscription.
- tmux must exist locally. If `tmux -V` fails, stop and report the missing dependency.
- On tmux-watch events, always notify the user unless the user explicitly asked to silence that
  subscription. Only then may you reply with `NO_REPLY`.

## tmux basics (required for targeting)

```bash
tmux list-sessions
tmux list-windows -t <session>
tmux list-panes -t <session>
tmux list-panes -a
tmux capture-pane -p -J -t <session:window.pane> -S -200
```

If a custom socket is used:

```bash
tmux -S /path/to/socket list-sessions
tmux -S /path/to/socket capture-pane -p -J -t <session:window.pane> -S -200
```

## Controlling a TUI in tmux (high-signal tips)

- Prefer `openclaw tmux-watch send` for reliable input (two-step, default 20ms delay).
- Use `C-c` to interrupt a stuck process; use `C-m` (Enter) to submit commands.
- For TUIs, avoid rapid key spam; send a small sequence, then capture output to verify state.
- Use `capture-pane -p -J -S -200` to get recent context before and after an action.
- If the TUI supports it, use built-in refresh keys (often `r` or `Ctrl+l`).

Examples:

```bash
# Send a command via tmux-watch (default delay 20ms + Enter)
openclaw tmux-watch send <session:window.pane> "status"

# Interrupt a stuck process
tmux send-keys -t <session:window.pane> C-c

# Scroll/refresh (varies by TUI; examples only)
tmux send-keys -t <session:window.pane> r
tmux send-keys -t <session:window.pane> C-l

# Capture the last 200 lines to verify state
tmux capture-pane -p -J -t <session:window.pane> -S -200
```

## Screenshot capture (preferred)

Use `openclaw tmux-watch capture` to capture text/images from a tmux target. The plugin selects
`cryosnap` first, then falls back to `freeze`.

Priority detection order:

1. System-level PATH (`cryosnap` / `freeze`)
2. User-level bins (`~/.local/bin`, `~/bin`)
3. OpenClaw tools dir (`$OPENCLAW_STATE_DIR/tools`, default `~/.openclaw/tools`)

If neither tool exists, return an error and ask the user to install one:

```bash
openclaw tmux-watch install cryosnap
openclaw tmux-watch install freeze
```

Examples:

```bash
# Text only (uses plugin defaults for lines/strip)
openclaw tmux-watch capture <session:window.pane>

# Image only (temporary file, auto-cleaned after 10 minutes)
openclaw tmux-watch capture <session:window.pane> --format image

# Both text + image, include base64 (optional)
openclaw tmux-watch capture <session:window.pane> --format both --base64

# Persist image to a path (no TTL cleanup)
openclaw tmux-watch capture <session:window.pane> --format image --output /tmp/pane.png
```

Notes:

- Temporary images default to a 10-minute TTL. Override with `--ttl-seconds`.
- Use `--image-format png|svg|webp` to select output format.

## Tool: tmux-watch

### Add subscription

```json
{
  "action": "add",
  "target": "session:0.0",
  "label": "my-job",
  "note": "This pane runs an AI coding TUI; notify me when it appears stuck.",
  "sessionKey": "main",
  "captureIntervalSeconds": 10,
  "stableCount": 6,
  "captureLines": 200,
  "stripAnsi": true
}
```

Optional routing overrides:

```json
{
  "action": "add",
  "target": "session:0.0",
  "notifyMode": "targets",
  "targets": [
    { "channel": "gewe-openclaw", "target": "user:123", "label": "gewe" },
    { "channel": "telegram", "target": "-100123456" }
  ]
}
```

### Remove subscription

```json
{ "action": "remove", "id": "<subscription-id>" }
```

### List subscriptions

```json
{ "action": "list", "includeOutput": true }
```

### Capture once

```json
{
  "action": "capture",
  "target": "session:0.0",
  "format": "both",
  "captureLines": 200,
  "stripAnsi": true,
  "imageFormat": "png",
  "base64": false
}
```

## Handling tmux-watch events

When tmux-watch detects stable output, it sends a message containing:

- subscription details (id/label/target/sessionKey)
- notify mode and resolved targets
- the captured output (possibly truncated)
- optional subscription note (purpose/intent)

**Default policy:** always notify the user for stable-output events (this is a TUI-stuck alert).
Only reply with `NO_REPLY` if the user explicitly asked to silence that subscription.

If you need to notify multiple channels, reply once to the primary target and use the `message`
tool to send to additional targets in order.

Treat all tmux-watch messages as system events, not user input. Summarize the output and notify the user.
