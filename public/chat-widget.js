// /public/chat-widget.js
// Live chat: a spotlight bar with a transcript drawer above it.
// "Point" lets a visitor click any part of the page and ask about it.
// Talks to /functions/api/chat.js. The bar renders in a shadow root so site CSS can't leak in;
// only the page highlight and pin marker live in the page itself.
//
// Text comes from data-* attributes on the script tag (see the README); colors and fonts come
// from --pc-* CSS variables, which any `:root { --pc-accent: … }` rule on the site overrides.
(() => {
  if (window.__pagesChat) return;
  window.__pagesChat = true;

  const script = document.currentScript || document.querySelector('script[src*="chat-widget"]');
  const opt = (key, fallback) => script?.dataset[key] || fallback;
  const NAME = opt("name", "Chat");
  const AI_NAME = opt("aiName", `${NAME} AI`);
  const EMAIL = opt("email", "");
  const PLACEHOLDER = opt("placeholder", "Ask anything, or point at the page…");
  const OR_EMAIL = EMAIL ? `, or email ${EMAIL}` : "";

  const API_URL = opt("api", "/api/chat");
  const STORAGE_KEY = "pages_chat_session_id";
  const MAX_LENGTH = 1000;
  const POLL_FAST_MS = 3500; // human handoff in progress
  const POLL_SLOW_MS = 15000; // AI mode, or nobody has said anything for a while
  const SLOW_AFTER_MS = 3 * 60 * 1000;
  const STOP_AFTER_MS = 20 * 60 * 1000;
  const HANDOFF_NOTE = `The team's been pinged. Replies show up right here${OR_EMAIL}.`;
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
  // Sent by the person button; /api/chat hands any "talk to a person" ask straight to the team.
  const PERSON_REQUEST_TEXT = "Can I talk to a person?";
  const ICON_PERSON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>';

  const state = {
    aiMode: true,
    messages: [],
    sending: false,
    loaded: false,
    errorText: "",
    lastActivity: Date.now(),
    pollTimer: null,
    isPickingElement: false,
    hoveredEl: null,
    selectedContext: null, // { snippet, fullContext } for the clicked page element
    activePinMarker: null,
  };

  // Session is created on first send, so visitors who never chat never hit the API.
  let memorySessionId = null;
  function getSessionId(create) {
    try {
      let id = localStorage.getItem(STORAGE_KEY);
      if (!id && create) {
        id = crypto.randomUUID();
        localStorage.setItem(STORAGE_KEY, id);
      }
      return id;
    } catch {
      if (!memorySessionId && create) memorySessionId = crypto.randomUUID();
      return memorySessionId;
    }
  }

  // 1. Page-level styles: theme defaults (zero specificity, so any site rule wins), plus the
  // "Point" highlight and the pin marker, the only things that touch the site's DOM.
  const pageStyle = document.createElement("style");
  pageStyle.textContent = `
    :where(:root) {
      --pc-bg: rgba(20, 20, 23, 0.92);
      --pc-text: #f4f4f5;
      --pc-muted: #a1a1aa;
      --pc-accent: #3b82f6;
      --pc-accent-text: #ffffff;
      --pc-ai: #fbbf24;
      --pc-human: #34d399;
      --pc-error: #f87171;
      --pc-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      --pc-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .pc-chat-highlight {
      outline: 2px dashed var(--pc-accent) !important;
      outline-offset: 4px !important;
      background-color: color-mix(in srgb, var(--pc-accent) 8%, transparent) !important;
      cursor: crosshair !important;
    }
    .pc-chat-pin {
      position: absolute; z-index: 999998; pointer-events: none;
      width: 24px; height: 24px; border-radius: 50% 50% 50% 2px;
      background: var(--pc-accent); box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
      transform: translate(-50%, -100%); animation: pcChatPin 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .pc-chat-pin::after { content: ""; position: absolute; inset: 8px; border-radius: 50%; background: var(--pc-accent-text); }
    @keyframes pcChatPin {
      from { transform: translate(-50%, -140%) scale(0.5); opacity: 0; }
      to { transform: translate(-50%, -100%) scale(1); opacity: 1; }
    }
  `;
  document.head.appendChild(pageStyle);

  // 2. Spotlight bar styles. Custom properties inherit into the shadow root; the --_* ones are
  // tints derived from the theme, so a light theme only needs --pc-bg and --pc-text flipped.
  const CSS = `
    :host {
      all: initial;
      --_line: color-mix(in srgb, var(--pc-text) 8%, transparent);
      --_fill: color-mix(in srgb, var(--pc-text) 8%, transparent);
      --_border: color-mix(in srgb, var(--pc-text) 16%, transparent);
      --_control-border: color-mix(in srgb, var(--pc-text) 12%, transparent);
      --_accent-soft: color-mix(in srgb, var(--pc-accent) 18%, transparent);
      --_accent-line: color-mix(in srgb, var(--pc-accent) 50%, transparent);
      --_accent-ink: color-mix(in srgb, var(--pc-accent) 55%, var(--pc-text));
    }
    * { box-sizing: border-box; font-family: var(--pc-font); }
    .wrap {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      width: min(640px, calc(100vw - 32px)); z-index: 999999; color: var(--pc-text);
    }
    button:focus-visible { outline: 2px solid var(--pc-accent); outline-offset: 2px; }

    /* Transcript drawer above the bar */
    .drawer {
      display: none; flex-direction: column; max-height: min(380px, calc(100vh - 140px));
      margin-bottom: 10px; overflow: hidden; border-radius: 16px;
      background: var(--pc-bg); border: 1px solid var(--_border);
      backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
      animation: slideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .drawer.open { display: flex; }
    @keyframes slideUp {
      from { opacity: 0; transform: translateY(12px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .header {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 10px 16px; border-bottom: 1px solid var(--_line);
      font-family: var(--pc-font-mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--pc-muted);
    }
    .status { display: inline-flex; align-items: center; gap: 8px; font-family: var(--pc-font-mono); font-weight: 500; color: var(--pc-text); }
    .led { width: 7px; height: 7px; border-radius: 50%; background: var(--pc-ai); box-shadow: 0 0 8px var(--pc-ai); }
    .led.human { background: var(--pc-human); box-shadow: 0 0 10px var(--pc-human); }
    .minimize { background: none; border: 0; color: var(--pc-muted); cursor: pointer; font-family: var(--pc-font-mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 4px; }
    .minimize:hover { color: var(--pc-text); }
    .messages { padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; font-size: 14px; line-height: 1.5; }
    .msg { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; max-width: 88%; }
    .msg.visitor { align-self: flex-end; align-items: flex-end; }
    .meta { font-family: var(--pc-font-mono); font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--pc-muted); }
    .bubble {
      padding: 10px 14px; border-radius: 12px; white-space: pre-wrap; overflow-wrap: anywhere;
      background: var(--_fill); border: 1px solid var(--_line); color: var(--pc-text);
    }
    .bubble a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
    .msg.visitor .bubble { background: var(--pc-accent); border-color: transparent; color: var(--pc-accent-text); }
    .msg.human .bubble { border-color: color-mix(in srgb, var(--pc-human) 45%, transparent); }
    .msg.typing .bubble { color: var(--pc-muted); }
    .context-tag {
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 11px; padding: 3px 8px; border-radius: 6px;
      background: var(--_accent-soft); border: 1px solid var(--_accent-line); color: var(--_accent-ink);
    }
    .note { margin: 0; padding: 8px 16px; font-size: 12px; color: var(--pc-muted); border-top: 1px solid var(--_line); }
    .note.error { color: var(--pc-error); }
    .note[hidden] { display: none; }

    /* Spotlight bar */
    .bar {
      display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 10px; border-radius: 999px;
      background: var(--pc-bg); border: 1px solid var(--_border);
      backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.3), 0 0 0 1px color-mix(in srgb, var(--pc-text) 4%, transparent);
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .bar:focus-within {
      border-color: color-mix(in srgb, var(--pc-accent) 70%, transparent);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.4), 0 0 0 2px color-mix(in srgb, var(--pc-accent) 30%, transparent);
    }
    .point {
      display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; cursor: pointer;
      padding: 7px 12px; border-radius: 999px; font-size: 12px; font-weight: 500;
      background: var(--_fill); border: 1px solid var(--_control-border); color: var(--pc-text);
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .point:hover, .point.active { background: var(--pc-accent); border-color: var(--pc-accent); color: var(--pc-accent-text); }
    .person {
      flex: none; width: 34px; height: 34px; display: grid; place-items: center; cursor: pointer; border-radius: 999px;
      background: var(--_fill); border: 1px solid var(--_control-border); color: var(--pc-text);
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .person:hover { background: var(--pc-accent); border-color: var(--pc-accent); color: var(--pc-accent-text); }
    .person:disabled { opacity: 0.5; cursor: default; }
    .person[hidden] { display: none; }
    .person svg { width: 16px; height: 16px; }
    .chip {
      display: none; align-items: center; gap: 6px; max-width: 170px; padding: 4px 10px; border-radius: 999px; font-size: 12px;
      background: var(--_accent-soft); border: 1px solid var(--_accent-line); color: var(--_accent-ink);
    }
    .chip.visible { display: inline-flex; }
    .chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip button { background: none; border: 0; padding: 0; color: var(--_accent-ink); cursor: pointer; font-size: 13px; line-height: 1; }
    .input { flex: 1; min-width: 120px; padding: 8px 4px; background: transparent; border: 0; outline: none; color: var(--pc-text); font-size: 14px; }
    .input::placeholder { color: var(--pc-muted); }
    .kbd {
      pointer-events: none; padding: 3px 7px; border-radius: 6px; font-family: var(--pc-font-mono); font-size: 11px; color: var(--pc-muted);
      background: color-mix(in srgb, var(--pc-text) 6%, transparent); border: 1px solid color-mix(in srgb, var(--pc-text) 10%, transparent);
    }
    .send {
      flex: none; width: 32px; height: 32px; border: 0; border-radius: 999px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      background: var(--pc-text); color: var(--pc-bg); font-weight: 700; transition: transform 0.15s ease;
    }
    .send:hover { transform: scale(1.06); }
    .send:disabled { opacity: 0.5; cursor: default; transform: none; }
    @media (hover: none), (max-width: 520px) { .kbd { display: none; } }
    @media (max-width: 520px) { .wrap { bottom: 16px; } .input { min-width: 0; } }
  `;

  // 3. Build the spotlight bar
  const host = document.createElement("div");
  host.id = "pages-chat";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>${CSS}</style>
    <div class="wrap">
      <section class="drawer">
        <div class="header">
          <span class="status"><span class="led"></span><span class="status-text"></span></span>
          <button type="button" class="minimize" aria-label="Minimize chat">Esc / Minimize ✕</button>
        </div>
        <div class="messages" role="log" aria-live="polite"></div>
        <p class="note" hidden></p>
      </section>
      <form class="bar">
        <button type="button" class="point" title="Click any part of the page to ask about it">
          <span aria-hidden="true">⌖</span> <span class="point-label">Point</span>
        </button>
        <button type="button" class="person" title="Talk to a person" aria-label="Talk to a person">${ICON_PERSON}</button>
        <div class="chip">
          <span class="chip-text"></span>
          <button type="button" class="clear-context" aria-label="Remove pinned element">✕</button>
        </div>
        <input type="text" class="input" maxlength="${MAX_LENGTH}" autocomplete="off" />
        <span class="kbd" aria-hidden="true">${IS_MAC ? "⌘K" : "Ctrl K"}</span>
        <button type="submit" class="send" aria-label="Send">↵</button>
      </form>
    </div>`;
  document.body.appendChild(host);

  const $ = (sel) => root.querySelector(sel);
  const drawer = $(".drawer");
  const msgContainer = $(".messages");
  const note = $(".note");
  const led = $(".led");
  const statusText = $(".status-text");
  const pointBtn = $(".point");
  const pointLabel = $(".point-label");
  const contextChip = $(".chip");
  const contextText = $(".chip-text");
  const input = $(".input");
  const form = $(".bar");
  const sendBtn = $(".send");
  const personBtn = $(".person");

  // Set via the DOM rather than the template so names and placeholders never need escaping.
  drawer.setAttribute("aria-label", `Chat with ${NAME}`);
  input.setAttribute("aria-label", `Ask ${NAME}`);
  input.placeholder = PLACEHOLDER;

  const isOwnUi = (e) => e.composedPath().includes(host);
  const isOpen = () => drawer.classList.contains("open");
  const hasHumanReply = () => state.messages.some((m) => m.sender === "agent" && !m.isAi);

  function setDrawer(open) {
    drawer.classList.toggle("open", open);
    if (open) {
      state.lastActivity = Date.now();
      render();
    }
    schedulePoll();
  }

  // 4. "Point at page" element picker
  function togglePickMode(forceState) {
    state.isPickingElement = typeof forceState === "boolean" ? forceState : !state.isPickingElement;
    pointBtn.classList.toggle("active", state.isPickingElement);
    pointLabel.textContent = state.isPickingElement ? "Click page…" : "Point";
    if (!state.isPickingElement && state.hoveredEl) {
      state.hoveredEl.classList.remove("pc-chat-highlight");
      state.hoveredEl = null;
    }
  }

  function clearContext() {
    state.selectedContext = null;
    contextChip.classList.remove("visible");
    state.activePinMarker?.remove();
    state.activePinMarker = null;
  }

  pointBtn.addEventListener("click", () => togglePickMode());
  $(".clear-context").addEventListener("click", clearContext);

  document.addEventListener("mousemove", (e) => {
    if (!state.isPickingElement || isOwnUi(e)) return;
    const target = e.target.closest?.("section, article, h1, h2, h3, p, li, img, button, a, div");
    if (target && target !== state.hoveredEl && target !== document.body && target !== document.documentElement) {
      state.hoveredEl?.classList.remove("pc-chat-highlight");
      state.hoveredEl = target;
      target.classList.add("pc-chat-highlight");
    }
  });

  document.addEventListener(
    "click",
    (e) => {
      if (!state.isPickingElement || isOwnUi(e)) return;
      e.preventDefault();
      e.stopPropagation();

      const el = state.hoveredEl || e.target;
      const tag = el.tagName.toLowerCase();
      const rawText = (el.innerText || el.getAttribute("alt") || el.id || tag).trim().replace(/\s+/g, " ");
      state.selectedContext = {
        snippet: rawText.slice(0, 48) || tag,
        fullContext: `<${tag}> "${rawText.slice(0, 140)}"`,
      };

      // Drop a pin on the page where the visitor pointed
      state.activePinMarker?.remove();
      const rect = el.getBoundingClientRect();
      const pin = document.createElement("div");
      pin.className = "pc-chat-pin";
      pin.style.left = `${window.scrollX + rect.left + Math.min(rect.width / 2, 60)}px`;
      pin.style.top = `${window.scrollY + rect.top + 12}px`;
      document.body.appendChild(pin);
      state.activePinMarker = pin;

      contextText.textContent = state.selectedContext.snippet;
      contextChip.classList.add("visible");
      togglePickMode(false);
      input.focus();
    },
    true
  );

  // 5. Keyboard shortcuts: ⌘K / Ctrl+K focuses the bar, Esc cancels pointing or closes the drawer
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      input.focus();
    } else if (e.key === "Escape") {
      if (state.isPickingElement) togglePickMode(false);
      else if (isOpen()) setDrawer(false);
    }
  });

  $(".minimize").addEventListener("click", () => setDrawer(false));
  input.addEventListener("focus", () => {
    if (state.messages.length > 0 && !isOpen()) setDrawer(true);
  });

  // 6. Render transcript and status. Message text is untrusted, so it only goes through textContent.
  function messageNode(m, extraClass = "") {
    const wrap = document.createElement("div");
    const isHuman = m.sender === "agent" && !m.isAi;
    wrap.className = `msg ${m.sender === "visitor" ? "visitor" : "agent"}${isHuman ? " human" : ""} ${extraClass}`;

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = m.sender === "visitor" ? "You" : m.isAi ? AI_NAME : m.agentName || "Team";
    wrap.appendChild(meta);

    if (m.elementContext) {
      const tag = document.createElement("div");
      tag.className = "context-tag";
      tag.textContent = `📍 ${m.elementContext}`;
      wrap.appendChild(tag);
    }

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    appendLinkified(bubble, m.text);
    wrap.appendChild(bubble);
    return wrap;
  }

  // Turns http(s) URLs into links (e.g. the demo link in config.js); everything else stays plain text.
  function appendLinkified(parent, text) {
    text.split(/(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)])/g).forEach((part, i) => {
      if (i % 2 === 0) {
        if (part) parent.appendChild(document.createTextNode(part));
        return;
      }
      const a = document.createElement("a");
      a.href = part;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = part;
      parent.appendChild(a);
    });
  }

  function render() {
    led.classList.toggle("human", !state.aiMode);
    statusText.textContent = state.aiMode
      ? `${AI_NAME} · Instant answers`
      : hasHumanReply() ? "Live chat · Connected with the team" : "Live chat · Team notified";

    const nodes = state.messages.map((m) => messageNode(m));
    if (state.sending && state.aiMode) nodes.push(messageNode({ sender: "agent", isAi: true, text: "…" }, "typing"));
    msgContainer.replaceChildren(...nodes);
    msgContainer.scrollTop = msgContainer.scrollHeight;

    note.textContent = state.errorText || HANDOFF_NOTE;
    note.classList.toggle("error", Boolean(state.errorText));
    note.hidden = !state.errorText && (state.aiMode || hasHumanReply());

    sendBtn.disabled = state.sending;
    personBtn.disabled = state.sending;
    personBtn.hidden = !state.aiMode; // already with the team
  }

  // Returns true if anything the visitor can see changed.
  function apply(data) {
    const prevAiMode = state.aiMode;
    const prevLastId = state.messages[state.messages.length - 1]?.id;
    state.aiMode = data.aiMode !== false;
    state.messages = Array.isArray(data.messages) ? data.messages : [];
    const last = state.messages[state.messages.length - 1];
    const newMessage = Boolean(last) && last.id !== prevLastId;
    if (newMessage) {
      state.lastActivity = Date.now();
      // A team reply pops the drawer open. The first load of an existing chat doesn't.
      if (state.loaded && last.sender === "agent") drawer.classList.add("open");
    }
    state.loaded = true;
    return newMessage || prevAiMode !== state.aiMode;
  }

  // 7. Send a message to /api/chat (typed in the bar, or from the person button)
  async function sendMessage(text) {
    if (!text || state.sending) return;

    const sessionId = getSessionId(true);
    const context = state.selectedContext;
    input.value = "";
    clearContext();

    state.errorText = "";
    state.sending = true;
    state.lastActivity = Date.now();
    state.messages = [...state.messages, { id: "pending", sender: "visitor", text, elementContext: context?.fullContext }];
    drawer.classList.add("open");
    render();

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, text, pageUrl: location.href, elementContext: context?.fullContext || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "");
      apply(data);
    } catch (err) {
      state.messages = state.messages.filter((m) => m.id !== "pending");
      input.value = text;
      state.errorText = err.message || `Couldn't send that. Try again${OR_EMAIL}.`;
    } finally {
      state.sending = false;
      render();
      schedulePoll();
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage(input.value.trim().slice(0, MAX_LENGTH));
  });
  personBtn.addEventListener("click", () => sendMessage(PERSON_REQUEST_TEXT));

  // 8. Poll for Google Chat replies, only while a conversation is live
  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (document.hidden || !getSessionId(false)) return;
    if (!isOpen() && state.aiMode) return; // closed and nobody human is involved: nothing to wait for
    const idle = Date.now() - state.lastActivity;
    if (idle > STOP_AFTER_MS) return;
    state.pollTimer = setTimeout(poll, !state.aiMode && idle < SLOW_AFTER_MS ? POLL_FAST_MS : POLL_SLOW_MS);
  }

  async function poll() {
    const sessionId = getSessionId(false);
    if (sessionId && !state.sending) {
      try {
        const res = await fetch(`${API_URL}?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
        if (res.ok && apply(await res.json())) render();
      } catch {
        // Network blip: try again on the next tick.
      }
    }
    schedulePoll();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(state.pollTimer);
    else poll();
  });

  render();
  // Returning visitor with an existing chat: pick up its state (e.g. a team reply that landed while away).
  if (getSessionId(false)) poll();
})();
