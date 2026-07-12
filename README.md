# Claude WebUI

A browser-based chat interface for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Streams responses in real-time via SSE, persists session history, and wraps the `claude` CLI into a clean dark-themed UI.

## Quick Start

```bash
git clone https://github.com/kierbica/claude-webui.git
cd claude-webui
npm install
npm start
# → http://localhost:3300
```

Make sure you're authenticated with Claude Code first:

```bash
claude auth status
```

## Features

- **Streaming responses** — SSE-powered real-time output from the `claude` CLI
- **Session history** — conversations are saved to disk and listed in the sidebar
- **Resume sessions** — pick up where you left off on any previous chat
- **Auth detection** — warns you if you're not logged in to Claude Code
- **Dark theme** — clean, minimal UI with responsive layout

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT`  | `3300`  | Server port |

## Tech Stack

- **Server:** Node.js + Express
- **Client:** Vanilla JS (no build step)
- **Backend:** `claude` CLI with `--output-format stream-json`
