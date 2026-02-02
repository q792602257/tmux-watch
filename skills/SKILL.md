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

- Prefer `send-keys -l` for literal text input to avoid tmux interpreting key names.
- For TUIs with input boxes (Codex/Claude Code), send text with `-l` first, then send `C-m`
  as a separate command to submit reliably.
- Use `C-c` to interrupt a stuck process; use `C-m` (Enter) to submit commands.
- For TUIs, avoid rapid key spam; send a small sequence, then capture output to verify state.
- Use `capture-pane -p -J -S -200` to get recent context before and after an action.
- If the TUI supports it, use built-in refresh keys (often `r` or `Ctrl+l`).

Examples:

```bash
# Send a command to the pane (two-step: text then Enter)
tmux send-keys -t <session:window.pane> -l -- "status"
tmux send-keys -t <session:window.pane> C-m

# Interrupt a stuck process
tmux send-keys -t <session:window.pane> C-c

# Scroll/refresh (varies by TUI; examples only)
tmux send-keys -t <session:window.pane> r
tmux send-keys -t <session:window.pane> C-l

# Capture the last 200 lines to verify state
tmux capture-pane -p -J -t <session:window.pane> -S -200
```

## Screenshot tools (priority + install)

Priority detection order:

1. System-level PATH (`command -v cryosnap` / `command -v freeze`)
2. User-level bins (`~/.local/bin`, `~/bin`)
3. OpenClaw tools dir (`$OPENCLAW_STATE_DIR/tools`, default `~/.openclaw/tools`)

If cryosnap exists, use it. If not, use freeze. If neither exists, **auto-install cryosnap**.

Install commands (downloads the latest GitHub release into the OpenClaw tools dir):

```bash
openclaw tmux-watch install cryosnap
openclaw tmux-watch install freeze
openclaw tmux-watch update cryosnap
openclaw tmux-watch update freeze
openclaw tmux-watch remove cryosnap
openclaw tmux-watch remove freeze
```

### cryosnap (preferred)

```bash
# tmux pane -> PNG
cryosnap --tmux --tmux-args "-t %3 -S -200 -J" --config full -o out.png
```

Notes:

- For zsh, wrap `%3` in quotes or escape `%` (e.g., `"-t %3 -S -200 -J"`).
- You can pass `-t session:window.pane` instead of `%pane_id`.

### freeze (fallback)

```bash
# Capture ANSI text first, then render with freeze
tmux capture-pane -p -J -e -t <session:window.pane> -S -200 | freeze -o out.png
```

## Tool: tmux-watch

### Add subscription

```json
{
  "action": "add",
  "target": "session:0.0",
  "label": "my-job",
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
