// --- State ---
let currentSessionId = null;
let currentAbortController = null;
let isStreaming = false;

// --- DOM refs ---
const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const thinkingEl = document.getElementById("thinking");
const errorBanner = document.getElementById("error-banner");
const errorText = document.getElementById("error-text");
const sessionList = document.getElementById("session-list");
const authBanner = document.getElementById("auth-banner");
const authStatus = document.getElementById("auth-status");
const modelInfo = document.getElementById("model-info");
const newChatBtn = document.getElementById("new-chat");
const welcomeEl = document.querySelector(".welcome");

// --- Auto-resize textarea ---
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
  sendBtn.disabled = !inputEl.value.trim();
});

// --- Keyboard submit ---
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);

// --- New chat ---
newChatBtn.addEventListener("click", () => {
  currentSessionId = null;
  messagesEl.innerHTML = `
    <div class="welcome">
      <div class="welcome-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="8.5"/>
          <path d="M12 7v5l3 3"/>
        </svg>
      </div>
      <h2>Claude WebUI</h2>
      <p>Send a message to start a conversation with Claude Code.</p>
    </div>`;
  inputEl.focus();
  loadSessions();
});

// --- Dismiss error ---
document.getElementById("error-dismiss").addEventListener("click", () => {
  errorBanner.classList.add("hidden");
});
document.getElementById("auth-dismiss").addEventListener("click", () => {
  authBanner.classList.add("hidden");
});

// --- Send message ---
async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || isStreaming) return;

  inputEl.value = "";
  inputEl.style.height = "auto";
  sendBtn.disabled = true;
  errorBanner.classList.add("hidden");

  // Remove welcome
  const welcome = messagesEl.querySelector(".welcome");
  if (welcome) welcome.remove();

  // Add user message
  addMessage("user", text);

  // Prepare
  isStreaming = true;
  thinkingEl.classList.remove("hidden");
  scrollToBottom();

  currentAbortController = new AbortController();

  // Build assistant bubble
  const assistantDiv = document.createElement("div");
  assistantDiv.className = "message assistant";
  assistantDiv.innerHTML = `
    <div class="message-header">
      <div class="avatar">C</div>
      <span>Claude</span>
    </div>
    <div class="message-content streaming" id="streaming-content"></div>
  `;
  messagesEl.appendChild(assistantDiv);
  const contentEl = assistantDiv.querySelector(".message-content");
  scrollToBottom();

  try {
    const params = new URLSearchParams({ message: text });
    if (currentSessionId) params.set("session_id", currentSessionId);

    const response = await fetch(`/api/chat?${params}`, {
      signal: currentAbortController.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;

        try {
          const ev = JSON.parse(jsonStr);
          handleEvent(ev, contentEl);
        } catch {
          // skip malformed
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    showError(err.message || "Request failed");
    assistantDiv.remove();
  } finally {
    isStreaming = false;
    thinkingEl.classList.add("hidden");
    contentEl.classList.remove("streaming");
    sendBtn.disabled = !inputEl.value.trim();
    currentAbortController = null;

    // Add timestamp
    if (!assistantDiv.querySelector(".timestamp")) {
      const ts = document.createElement("div");
      ts.className = "timestamp";
      ts.textContent = new Date().toLocaleTimeString();
      assistantDiv.appendChild(ts);
    }

    loadSessions();
  }
}

// --- Handle SSE events ---
function handleEvent(ev, contentEl) {
  switch (ev.type) {
    case "session":
      currentSessionId = ev.session_id;
      break;

    case "stream_event":
      if (ev.event?.delta?.type === "text_delta") {
        contentEl.textContent += ev.event.delta.text;
        scrollToBottom();
      }
      // Tool call input streaming
      if (ev.event?.delta?.type === "input_json_delta") {
        // We just append it to show tool calls are happening
      }
      break;

    case "assistant":
      // Full assistant message (sent after streaming completes)
      if (ev.message?.content) {
        const text = extractText(ev.message.content);
        if (text) contentEl.textContent = text;
        scrollToBottom();
      }
      break;

    case "system":
      if (ev.subtype === "init" && ev.model) {
        modelInfo.textContent = `claude • ${ev.model}`;
      }
      break;

    case "error":
      showError(ev.message || "Unknown error");
      break;

    case "stderr":
      // Log stderr but don't show
      console.log("[claude]", ev.text);
      break;

    case "done":
      // Final result with cost info
      const ts = document.createElement("div");
      ts.className = "timestamp";
      const parts = [];
      if (ev.cost) parts.push(`$${Number(ev.cost).toFixed(4)}`);
      if (ev.duration_ms) parts.push(`${(ev.duration_ms / 1000).toFixed(1)}s`);
      ts.textContent = parts.join(" • ");
      contentEl.parentElement.appendChild(ts);
      break;
  }
}

// --- Extract text from content blocks ---
function extractText(blocks) {
  if (!blocks) return "";
  if (typeof blocks === "string") return blocks;
  if (Array.isArray(blocks)) {
    return blocks
      .map((b) => {
        if (b.type === "text") return b.text || "";
        if (b.type === "thinking") return "";
        if (b.type === "tool_use") return "";
        return "";
      })
      .join("");
  }
  return "";
}

// --- Add a user message ---
function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.innerHTML = `
    <div class="message-header">
      <div class="avatar">${role === "user" ? "U" : "C"}</div>
      <span>${role === "user" ? "You" : "Claude"}</span>
    </div>
    <div class="message-content">${escapeHtml(text)}</div>
    <div class="timestamp">${new Date().toLocaleTimeString()}</div>
  `;
  messagesEl.appendChild(div);
  scrollToBottom();
}

// --- Load session from history ---
function loadSession(sessionId) {
  if (isStreaming) return;
  currentSessionId = sessionId;

  fetch(`/api/sessions/${sessionId}`)
    .then((r) => r.json())
    .then((session) => {
      messagesEl.innerHTML = "";
      const welcome = messagesEl.querySelector(".welcome");
      if (welcome) welcome.remove();

      for (const msg of session.messages || []) {
        if (msg.role === "user") {
          addMessage("user", msg.content);
        } else {
          const div = document.createElement("div");
          div.className = "message assistant";
          div.innerHTML = `
            <div class="message-header">
              <div class="avatar">C</div>
              <span>Claude</span>
            </div>
            <div class="message-content">${escapeHtml(msg.content)}</div>
          `;
          messagesEl.appendChild(div);
        }
      }
      scrollToBottom();
      highlightSession(sessionId);
    })
    .catch(() => showError("Failed to load session"));
}

// --- Load sessions list ---
async function loadSessions() {
  try {
    const list = await fetch("/api/sessions").then((r) => r.json());
    if (!list.length) {
      sessionList.innerHTML = '<div class="loading-sessions" style="padding:16px;color:var(--text-muted);font-size:13px;">No sessions yet</div>';
      return;
    }
    sessionList.innerHTML = list
      .map(
        (s) => `
          <div class="session-item${s.id === currentSessionId ? " active" : ""}"
               data-id="${s.id}">
            ${escapeHtml(s.title || "Untitled")}
          </div>`
      )
      .join("");

    sessionList.querySelectorAll(".session-item").forEach((el) => {
      el.addEventListener("click", () => loadSession(el.dataset.id));
    });
  } catch {
    sessionList.innerHTML = '<div class="loading-sessions">Failed to load</div>';
  }
}

function highlightSession(id) {
  sessionList.querySelectorAll(".session-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === id);
  });
}

// --- Check auth ---
async function checkAuth() {
  try {
    const status = await fetch("/api/auth").then((r) => r.json());
    if (status.loggedIn) {
      authStatus.textContent = "authenticated";
      authBanner.classList.add("hidden");
    } else {
      authStatus.textContent = "not logged in";
      authBanner.classList.remove("hidden");
    }
  } catch {
    authStatus.textContent = "unknown";
  }
}

// --- Helpers ---
function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function showError(msg) {
  errorText.textContent = msg;
  errorBanner.classList.remove("hidden");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Init ---
checkAuth();
loadSessions();
inputEl.focus();
