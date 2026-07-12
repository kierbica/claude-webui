import express from "express";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3300;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Session store ---
const SESSIONS_DIR = path.join(__dirname, "sessions");
const sessions = new Map(); // sessionId -> { title, messages }

async function ensureSessionsDir() {
  if (!existsSync(SESSIONS_DIR)) await mkdir(SESSIONS_DIR, { recursive: true });
}
ensureSessionsDir();

// --- SSE endpoint for streaming Claude responses ---
app.get("/api/chat", (req, res) => {
  const message = req.query.message?.trim();
  const sessionId = req.query.session_id || randomUUID();
  const cwd = req.query.cwd || process.cwd();

  if (!message) {
    res.status(400).json({ error: "Message is required" });
    return;
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send session_id first
  res.write(`data: ${JSON.stringify({ type: "session", session_id: sessionId })}\n\n`);

  // Build claude arguments
  const args = [
    "-p", message,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--session-id", sessionId,
  ];

  // If session exists, resume it
  if (existsSync(path.join(SESSIONS_DIR, `${sessionId}.json`))) {
    args.push("--resume", sessionId);
  }

  const claude = spawn("claude", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  let buffer = "";
  let aborted = false;
  let assistantContent = "";
  let sessionInfo = null;

  const cleanup = () => {
    claude.kill("SIGTERM");
    if (!aborted) {
      res.end();
    }
  };

  req.on("close", () => {
    aborted = true;
    claude.kill("SIGTERM");
  });

  claude.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);

        // Forward all events to the client
        res.write(`data: ${JSON.stringify(ev)}\n\n`);

        // Track assistant message content
        if (ev.type === "stream_event" && ev.event?.delta?.type === "text_delta") {
          assistantContent += ev.event.delta.text;
        }

        // Track system init for session info
        if (ev.type === "system" && ev.subtype === "init") {
          sessionInfo = ev;
        }

        // On result event, save the conversation
        if (ev.type === "result") {
          // Save session
          const session = sessions.get(sessionId) || {
            id: sessionId,
            title: message.slice(0, 60),
            messages: [],
            created: Date.now(),
          };
          session.messages.push({ role: "user", content: message });
          session.messages.push({ role: "assistant", content: assistantContent });
          session.updated = Date.now();
          sessions.set(sessionId, session);

          // Persist to disk
          writeFile(
            path.join(SESSIONS_DIR, `${sessionId}.json`),
            JSON.stringify(session, null, 2)
          ).catch(() => {});

          // Send done event with session info
          res.write(`data: ${JSON.stringify({
            type: "done",
            session_id: sessionId,
            cost: ev.total_cost_usd,
            usage: ev.usage,
            duration_ms: ev.duration_ms,
          })}\n\n`);
        }
      } catch (e) {
        // Skip malformed lines
      }
    }
  });

  claude.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    res.write(`data: ${JSON.stringify({ type: "stderr", text })}\n\n`);
  });

  claude.on("error", (err) => {
    if (!aborted) {
      res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
      res.end();
    }
  });

  claude.on("close", (code) => {
    if (!aborted) {
      res.write(`data: ${JSON.stringify({ type: "close", code })}\n\n`);
      res.end();
    }
  });
});

// --- List sessions ---
app.get("/api/sessions", async (_req, res) => {
  const { readdir, readFile: rf } = await import("fs/promises");
  try {
    const files = await readdir(SESSIONS_DIR);
    const list = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          try {
            const data = JSON.parse(await rf(path.join(SESSIONS_DIR, f), "utf-8"));
            return {
              id: data.id,
              title: data.title,
              created: data.created,
              updated: data.updated,
              message_count: data.messages?.length || 0,
            };
          } catch {
            return null;
          }
        })
    );
    res.json(list.filter(Boolean).sort((a, b) => (b.updated || 0) - (a.updated || 0)));
  } catch {
    res.json([]);
  }
});

// --- Get session messages ---
app.get("/api/sessions/:id", async (req, res) => {
  try {
    const data = JSON.parse(
      await readFile(path.join(SESSIONS_DIR, `${req.params.id}.json`), "utf-8")
    );
    res.json(data);
  } catch {
    res.status(404).json({ error: "Session not found" });
  }
});

// --- Delete session ---
app.delete("/api/sessions/:id", async (req, res) => {
  const { unlink } = await import("fs/promises");
  try {
    await unlink(path.join(SESSIONS_DIR, `${req.params.id}.json`));
    sessions.delete(req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "Session not found" });
  }
});

// --- Check claude auth status ---
app.get("/api/auth", (_req, res) => {
  const cp = spawn("claude", ["auth", "status"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  cp.stdout.on("data", (d) => (stdout += d));
  cp.on("close", () => {
    try {
      const status = JSON.parse(stdout);
      res.json(status);
    } catch {
      res.json({ loggedIn: false, raw: stdout });
    }
  });
});

app.listen(PORT, () => {
  console.log(`Claude WebUI running at http://localhost:${PORT}`);
  console.log(`Make sure you're logged in: claude auth status`);
});
