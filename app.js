/* The Stack — our installable team-chat app (desktop + phone + pocket). */
const state = {
  view: "home",
  channelSlug: "the-digest",
  listId: null,
  threadParentId: null,
  /** Where Back / pull-down should land after a phone chat sheet. */
  chatReturnTo: "chats",
  pollTimer: null,
  hostLabel: "local",
  pocketMode: false,
  cloudMode: false,
  deferredInstall: null,
  channels: [],
  unreads: {},
  /** Last rendered Computers cards keyed by id (mac / windows). */
  hostCards: {},
  /** agent name → last online heartbeat ISO */
  hostPresenceByAgent: {},
  openHostId: null,
  sending: 0,
  geminiStreaming: false,
  loadMessagesSeq: 0,
  geminiInteractionBySlug: {},
};

// Older iOS Safari: avoid raw TypeError: x is not a function.
if (!String.prototype.replaceAll) {
  String.prototype.replaceAll = function replaceAll(search, replacement) {
    return String(this).split(search).join(replacement);
  };
}
if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
  crypto.randomUUID = function randomUUID() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

/** Never show raw "TypeError: …" on the phone — map network/Safari failures. */
function friendlyError(err) {
  const raw = err && typeof err === "object" ? err.message || String(err) : String(err || "");
  const msg = String(raw || "Something went wrong");
  const lower = msg.toLowerCase();
  if (
    lower.includes("load failed") ||
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("network request failed") ||
    (err && err.name === "TypeError" && (lower === "typeerror" || lower.includes("fetch")))
  ) {
    return "Could not reach GitHub from this phone (network). Check signal/Wi‑Fi, then tap Open cloud hub again.";
  }
  if (err && err.rateLimited) return msg;
  if (lower.includes("bad credentials") || lower.includes("requires authentication") || lower.includes("401")) {
    return "GitHub token rejected — paste a fresh fine-grained PAT (Contents Read/Write on ai-workspace).";
  }
  if (lower.includes("not found") && lower.includes("404")) {
    return "Hub file not found on this branch — use Branch main.";
  }
  // Strip "TypeError: " / "Error: " prefixes so the card stays readable.
  return msg.replace(/^(TypeError|Error|SyntaxError|ReferenceError):\s*/i, "");
}

const READS_KEY = "stack-reads-v1";
// v2 key: only an accent the person actually tapped is remembered (v1 also saved the default on every
// load, which pinned old defaults like Lime after the default changed to Iridescent).
const LOOK_KEY = "stack-look-v2";
const QUICK_REACTIONS = ["👍", "👀", "✅", "❤️", "🔥"];

/** Phone-steerable accents on the dark Liquid Glass theme — tap Look in the menu. Lime is the default. */
const LOOKS = {
  iris: {
    label: "Iridescent",
    accent: "#cdbdff",
    strong: "#b3a0ff",
    soft: "rgba(205, 189, 255, 0.16)",
    on: "#17131f",
    // Chameleon headlight film: pearl → pink → lavender → ice blue → mint.
    grad: "linear-gradient(115deg, #ffe3f3 0%, #f3b8e6 18%, #cdbdff 38%, #a9dcff 58%, #b9f5dc 78%, #fff1d6 100%)",
    swatch: "linear-gradient(135deg, #f3b8e6, #cdbdff, #a9dcff, #b9f5dc)",
  },
  lime: { label: "Lime", accent: "#d4f25c", strong: "#b8d93c", soft: "rgba(212, 242, 92, 0.16)", on: "#151a05" },
  violet: { label: "Violet", accent: "#b9a2ff", strong: "#9a7dff", soft: "rgba(185, 162, 255, 0.16)", on: "#1a1230" },
  amber: { label: "Amber", accent: "#ffc94a", strong: "#f0ae1c", soft: "rgba(255, 201, 74, 0.16)", on: "#2a1f00" },
  mint: { label: "Mint", accent: "#6ff0c4", strong: "#3fd6a5", soft: "rgba(111, 240, 196, 0.16)", on: "#04241a" },
  coral: { label: "Coral", accent: "#ff8a70", strong: "#f2674a", soft: "rgba(255, 138, 112, 0.16)", on: "#2b0d06" },
  white: { label: "White", accent: "#f4f5f2", strong: "#d9dbd5", soft: "rgba(244, 245, 242, 0.14)", on: "#111214" },
};
const LOOK_DEFAULT = "iris";

function applyLook(id, remember = false) {
  const look = LOOKS[id] || LOOKS[LOOK_DEFAULT];
  const root = document.documentElement;
  root.style.setProperty("--accent", look.accent);
  root.style.setProperty("--accent-strong", look.strong);
  root.style.setProperty("--accent-soft", look.soft);
  root.style.setProperty("--on-accent", look.on || "#ffffff");
  root.style.setProperty("--accent-grad", look.grad || look.accent);
  root.toggleAttribute("data-iris", Boolean(look.grad));
  root.style.setProperty("--accent-glow", look.soft.replace(/0\.1\d\)/, "0.35)"));
  root.dataset.look = LOOKS[id] ? id : LOOK_DEFAULT;
  if (remember) {
    try {
      localStorage.setItem(LOOK_KEY, root.dataset.look);
      localStorage.removeItem("stack-look-v1");
    } catch {
      /* ignore */
    }
  }
  /* theme-color comes from the light/dark meta tags in index.html */
  document.querySelectorAll("#look-picker .look-swatch").forEach((btn) => {
    const on = btn.dataset.look === root.dataset.look;
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
}

function initLookPicker() {
  let saved = LOOK_DEFAULT;
  try {
    saved = localStorage.getItem(LOOK_KEY) || LOOK_DEFAULT;
  } catch {
    saved = LOOK_DEFAULT;
  }
  if (!LOOKS[saved]) saved = LOOK_DEFAULT;
  const host = document.getElementById("look-picker");
  if (host && !host.childElementCount) {
    host.innerHTML = Object.entries(LOOKS)
      .map(
        ([id, look]) =>
          `<button type="button" class="look-swatch" role="radio" data-look="${id}" aria-label="${look.label}" style="--swatch:${look.accent};${look.swatch ? `background:${look.swatch}` : ""}" title="${look.label}"></button>`
      )
      .join("");
    host.addEventListener("click", (e) => {
      const btn = e.target.closest(".look-swatch");
      if (!btn) return;
      applyLook(btn.dataset.look, true);
    });
  }
  applyLook(saved);
}

const POCKET_DB = "the-stack-pocket";
const POCKET_STORE = "kv";

function pocketAvailable() {
  return typeof indexedDB !== "undefined";
}

function pocketOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(POCKET_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(POCKET_STORE)) {
        db.createObjectStore(POCKET_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function pocketSet(key, value) {
  if (!pocketAvailable()) return;
  const db = await pocketOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(POCKET_STORE, "readwrite");
    tx.objectStore(POCKET_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function pocketGet(key) {
  if (!pocketAvailable()) return null;
  const db = await pocketOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(POCKET_STORE, "readonly");
    const req = tx.objectStore(POCKET_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function pocketOutboxPush(item) {
  const box = (await pocketGet("outbox")) || [];
  box.push(item);
  await pocketSet("outbox", box);
}

async function pocketFlushOutbox() {
  const box = (await pocketGet("outbox")) || [];
  if (!box.length) return;
  const remain = [];
  for (const item of box) {
    try {
      await api(item.path, {
        method: item.method || "POST",
        body: JSON.stringify(item.body),
      });
    } catch {
      remain.push(item);
    }
  }
  await pocketSet("outbox", remain);
  if (box.length !== remain.length) await refresh();
}

function wantsCloudHub() {
  try {
    return (
      new URLSearchParams(location.search).has("cloud") ||
      location.pathname.endsWith("/cloud.html") ||
      location.hash === "#cloud"
    );
  } catch {
    return false;
  }
}

function shellReady() {
  const shell = document.getElementById("shell");
  return Boolean(shell && !shell.classList.contains("hidden"));
}

async function api(path, options = {}) {
  // Cloud hub never hits relative /api on GitHub Pages (that 404s at site root).
  if (state.cloudMode || wantsCloudHub()) {
    if (typeof ghRoute !== "function") {
      throw new Error("Cloud GitHub client missing (github_hub.js)");
    }
    if (!ghState?.token) {
      throw new Error("Connect with a GitHub PAT first");
    }
    return ghRoute(path, options);
  }
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showCloudConnect(errMsg) {
  const status = document.getElementById("boot-status");
  const retry = document.getElementById("boot-retry");
  retry.classList.add("hidden");
  status.innerHTML = `
    <strong>Sign in</strong>
    <span class="boot-sub">Paste your GitHub token to open the vault hub.</span>
    ${errMsg ? `<span class="boot-err">${esc(errMsg)}</span>` : ""}
  `;
  let form = document.getElementById("cloud-connect");
  if (!form) {
    form = document.createElement("form");
    form.id = "cloud-connect";
    form.className = "cloud-connect";
    form.innerHTML = `
      <label class="token-label">GitHub token
        <input name="token" type="password" autocomplete="off" required placeholder="Paste token" />
      </label>
      <button type="submit">Continue</button>
      <details class="cloud-advanced">
        <summary>Advanced</summary>
        <label>Repo
          <input name="repo" value="lilfangsproject-wq/ai-workspace" autocomplete="off" required />
        </label>
        <label>Branch
          <input name="branch" value="main" autocomplete="off" required />
        </label>
        <label>Gemini API key (optional · instant streaming)
          <input name="gemini_key" type="password" autocomplete="off" placeholder="Optional · saved on device only" />
        </label>
      </details>
      <p class="cloud-help">Stays on this device only. Needs Contents access on the vault repo.</p>
    `;
    document.querySelector(".boot-card").appendChild(form);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      ghState.repo = String(fd.get("repo") || "").trim();
      ghState.branch = String(
        fd.get("branch") ||
          (typeof GH_DEFAULT_BRANCH === "string" ? GH_DEFAULT_BRANCH : "main")
      ).trim();
      const rawTok = String(fd.get("token") || "");
      ghState.token =
        typeof ghSanitizeToken === "function"
          ? ghSanitizeToken(rawTok)
          : rawTok.replace(/\s+/g, "").trim();
      ghSaveCreds();
      const gemKey = String(fd.get("gemini_key") || "").trim();
      if (gemKey) setGeminiKey(gemKey);
      await bootCloud();
    });
  }
  form.classList.remove("hidden");
  if (typeof ghLoadCreds === "function") {
    ghLoadCreds();
    if (ghState.token) form.querySelector('[name="token"]').value = ghState.token;
    if (ghState.repo) form.querySelector('[name="repo"]').value = ghState.repo;
    if (ghState.branch) form.querySelector('[name="branch"]').value = ghState.branch;
  }
  const gemInput = form.querySelector('[name="gemini_key"]');
  if (gemInput && getGeminiKey()) gemInput.value = getGeminiKey();
}

const STACK_VERSION = "v36.0";
const GEMINI_KEY_STORAGE = "stack-gemini-key-v1";
const GEMINI_MODEL_STORAGE = "stack-gemini-model-v1";
const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash-lite";
const GEMINI_MODELS_ALLOWED = new Set(["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-4-hydrogen"]);

function getGeminiKey() {
  try {
    return (localStorage.getItem(GEMINI_KEY_STORAGE) || "").trim();
  } catch {
    return "";
  }
}
function setGeminiKey(raw) {
  const clean = String(raw || "").replace(/\s+/g, "").trim();
  try {
    if (clean) localStorage.setItem(GEMINI_KEY_STORAGE, clean);
    else localStorage.removeItem(GEMINI_KEY_STORAGE);
  } catch {
    /* ignore */
  }
  updateGeminiSettingsUI();
  return clean;
}
function getGeminiModel() {
  try {
    const saved = localStorage.getItem(GEMINI_MODEL_STORAGE) || "";
    return GEMINI_MODELS_ALLOWED.has(saved) ? saved : GEMINI_DEFAULT_MODEL;
  } catch {
    return GEMINI_DEFAULT_MODEL;
  }
}
function setGeminiModel(model) {
  const next = GEMINI_MODELS_ALLOWED.has(model) ? model : GEMINI_DEFAULT_MODEL;
  try {
    localStorage.setItem(GEMINI_MODEL_STORAGE, next);
  } catch {
    /* ignore */
  }
  updateGeminiSettingsUI();
  return next;
}
function updateGeminiSettingsUI() {
  const key = getGeminiKey();
  const status = document.getElementById("gemini-key-status");
  const input = document.getElementById("gemini-key-input");
  const clearBtn = document.getElementById("gemini-key-clear");
  const select = document.getElementById("gemini-model-select");
  if (status) {
    status.textContent = key ? "live" : "off";
    status.classList.toggle("on", Boolean(key));
  }
  if (input && document.activeElement !== input) {
    input.value = "";
    input.placeholder = key ? `Saved (${key.slice(0, 4)}…${key.slice(-4)})` : "Optional · enables live streaming";
  }
  if (clearBtn) clearBtn.hidden = !key;
  if (select) select.value = getGeminiModel();
}
function initGeminiSettings() {
  updateGeminiSettingsUI();
  document.getElementById("gemini-key-save")?.addEventListener("click", () => {
    const input = document.getElementById("gemini-key-input");
    const val = (input?.value || "").trim();
    if (!val) {
      toast(getGeminiKey() ? "Gemini key already saved on this device" : "Paste a Gemini API key first", "err");
      return;
    }
    setGeminiKey(val);
    if (input) input.value = "";
    toast("Gemini streaming key saved on this device");
  });
  document.getElementById("gemini-key-clear")?.addEventListener("click", () => {
    setGeminiKey("");
    state.geminiInteractionBySlug = {};
    toast("Gemini key removed from this device");
  });
  document.getElementById("gemini-model-select")?.addEventListener("change", (e) => {
    const m = setGeminiModel(e.target.value);
    state.geminiInteractionBySlug = {};
    toast(`Gemini model set to ${m}`);
  });
}
function shouldInstantGemini(slug, body) {
  if (!getGeminiKey()) return false;
  if (!String(body || "").trim()) return false;
  return slug === "dm-gemini-seth" || /\B@gemini\b/i.test(String(body || ""));
}
function buildGeminiPromptInput(slug, userText, prevInteractionId) {
  if (prevInteractionId) return userText;
  const recent = (state.lastMessages || [])
    .slice(-6)
    .map((m) => `${m.author || "User"}: ${String(m.body || "").trim()}`)
    .filter(Boolean);
  if (!recent.length) return userText;
  return `Recent #${slug} context:\n${recent.join("\n")}\n\nSeth: ${userText}`;
}
async function streamGeminiOnce({ key, model, slug, userText, prevInteractionId, onDelta }) {
  const systemInstruction =
    'You are Gemini inside "The Stack", Seth\'s agent command centre (live peers: ChatGPT orchestrator, Cursor engineer, Gemini trial peer; Workhorse & Hermes are retired). Be direct, honest, technically sharp, and concise with zero fluff.';
  const payload = {
    model,
    system_instruction: systemInstruction,
    input: buildGeminiPromptInput(slug, userText, prevInteractionId),
    stream: true,
    store: true,
    generation_config: { max_output_tokens: 900 },
    ...(prevInteractionId ? { previous_interaction_id: prevInteractionId } : {}),
  };
  const res = await fetch("https://generativelanguage.googleapis.com/v1/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let msg = `Gemini API ${res.status}`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed?.error?.message) msg = parsed.error.message;
    } catch {
      if (errText) msg = `${msg}: ${errText.slice(0, 180)}`;
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (!res.body || typeof res.body.getReader !== "function") {
    throw new Error("Browser response stream unavailable");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let fullText = "";
  let interactionId = prevInteractionId || null;

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === "[DONE]") return;
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    if (ev.event_type === "error" || ev.error) {
      throw new Error(ev.error?.message || "Gemini stream error");
    }
    if (ev.event_type === "step.delta" && ev.delta?.type === "text" && ev.delta.text) {
      fullText += ev.delta.text;
      if (typeof onDelta === "function") onDelta(fullText);
    }
    if (ev.interaction?.id) {
      interactionId = ev.interaction.id;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const line of lines) processLine(line);
  }
  buf += decoder.decode();
  if (buf.trim()) {
    for (const line of buf.split(/\r?\n/)) processLine(line);
  }
  return { text: fullText.trim(), model, interactionId };
}
async function streamGeminiInteraction({ slug, userText, onDelta }) {
  const key = getGeminiKey();
  if (!key) throw new Error("Gemini API key not configured");
  const preferred = getGeminiModel();
  const prevId = state.geminiInteractionBySlug[slug] || null;
  const attempts = preferred === GEMINI_DEFAULT_MODEL ? [[preferred, prevId]] : [[preferred, prevId], [GEMINI_DEFAULT_MODEL, null]];
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    const [model, pid] = attempts[i];
    try {
      const out = await streamGeminiOnce({ key, model, slug, userText, prevInteractionId: pid, onDelta });
      if (out.interactionId) state.geminiInteractionBySlug[slug] = out.interactionId;
      if (out.text) return out;
      throw new Error(`Gemini (${model}) returned an empty response`);
    } catch (err) {
      lastErr = err;
      const canFallback = i + 1 < attempts.length && err.status !== 401 && err.status !== 403;
      if (!canFallback) break;
      if (typeof onDelta === "function") onDelta("");
    }
  }
  throw lastErr || new Error("Gemini streaming failed");
}
function paintVersion() {
  document.querySelectorAll("[data-stack-version]").forEach((el) => (el.textContent = STACK_VERSION));
}

/* Auto-update: when Pages deploys a new shell, pull the new SW and reload once. */
function setupAutoUpdate() {
  if (!("serviceWorker" in navigator)) return;
  const RELOAD_KEY = "stack-sw-reloaded";
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    try {
      if (sessionStorage.getItem(RELOAD_KEY) === STACK_VERSION) return;
      sessionStorage.setItem(RELOAD_KEY, STACK_VERSION);
    } catch {
      /* ignore */
    }
    toast(`Updated to ${STACK_VERSION} — refreshing…`);
    setTimeout(() => location.reload(), 400);
  });
  navigator.serviceWorker
    .register("./sw.js", { scope: "./" })
    .then((reg) => {
      const poke = () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      };
      poke();
      setInterval(poke, 5 * 60 * 1000);
      document.addEventListener("visibilitychange", poke);
      window.addEventListener("online", poke);
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            toast(`New Stack ${STACK_VERSION} ready…`);
          }
        });
      });
    })
    .catch(() => {});
}
async function bootCloud() {
  const bootEl = document.getElementById("boot");
  const status = document.getElementById("boot-status");
  const form = document.getElementById("cloud-connect");
  // Stay in cloud mode on Pages even before PAT — never fall back to /api/*.
  state.cloudMode = true;
  state.pocketMode = false;
  if (typeof ghLoadCreds === "function") ghLoadCreds();
  if (typeof ghSanitizeToken === "function" && ghState.token) {
    ghState.token = ghSanitizeToken(ghState.token);
    if (typeof ghSaveCreds === "function") ghSaveCreds();
  }
  paintVersion();
  if (!ghState.token) {
    showCloudConnect();
    paintVersion();
    return false;
  }
  status.textContent = "Opening the vault…";
  try {
    if (typeof ghProbeGithub === "function") {
      status.textContent = "Checking GitHub reachability…";
      await ghProbeGithub();
    }
    const health = await api("/api/health");
    // Prove hub readable
    const { channels } = await api("/api/channels");
    if (!channels || !channels.length) {
      throw new Error(
        `No hub channels on ${ghState.repo}@${ghState.branch}. Use Branch main and tap Open cloud hub again (or open with ?cloud=1&reset=1).`
      );
    }
    state.hostLabel = "github";
    status.textContent = `Cloud · ${health.host}`;
    if (form) form.classList.add("hidden");
    await loadTokenHint();
    const el = document.getElementById("phone-hint");
    el.hidden = false;
    el.textContent = `Cloud · ${ghState.repo}@${ghState.branch} · Add to Home Screen`;
    await loadChannels();
    await syncReadsFromHub();
    await loadLists();
    showView("home");
    setLive(true, health.host);
    bootEl.classList.add("hidden");
    document.getElementById("shell").classList.remove("hidden");
    showInstallBanner();
    return true;
  } catch (err) {
    // Keep cloudMode true so the poll never hits Pages /api/*.
    showCloudConnect(friendlyError(err));
    setLive(false, friendlyError(err));
    return false;
  }
}

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadReads() {
  try {
    return JSON.parse(localStorage.getItem(READS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveReads(reads) {
  localStorage.setItem(READS_KEY, JSON.stringify(reads));
}

let readsHubTimer = null;
function scheduleReadsHubSave() {
  if (!state.cloudMode || typeof ghSaveReads !== "function") return;
  clearTimeout(readsHubTimer);
  readsHubTimer = setTimeout(async () => {
    try {
      await ghSaveReads(loadReads());
    } catch {
      /* offline / conflict — local still wins until next sync */
    }
  }, 1200);
}

async function syncReadsFromHub() {
  if (!state.cloudMode || typeof ghLoadReads !== "function") return;
  try {
    const remote = (await ghLoadReads()) || {};
    const local = loadReads();
    const merged = { ...remote };
    for (const [k, v] of Object.entries(local)) {
      if (!merged[k] || String(v) > String(merged[k])) merged[k] = v;
    }
    saveReads(merged);
    if (JSON.stringify(merged) !== JSON.stringify(remote)) scheduleReadsHubSave();
  } catch {
    /* keep local */
  }
}

function markChannelRead(slug, iso) {
  if (!slug) return;
  const reads = loadReads();
  const prev = reads[slug] || "";
  if (!iso || String(iso) >= String(prev)) {
    reads[slug] = iso || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    saveReads(reads);
    scheduleReadsHubSave();
  }
}

function currentViewer() {
  const el = document.getElementById("author");
  return (el && el.value.trim()) || "Seth";
}

function formatBodyHtml(body) {
  // Escaped first, then wrap @Name (safe: only [A-Za-z0-9_-] in the name).
  return esc(body).replace(
    /(^|[^\w/])@([A-Za-z][A-Za-z0-9_-]{0,31})/g,
    '$1<span class="mention">@$2</span>'
  );
}

function dmLabel(ch, viewer) {
  if (!ch) return "DM";
  if (ch.kind !== "dm") return `#${ch.slug}`;
  const members = ch.members || [];
  const other =
    members.find((m) => String(m).toLowerCase() !== String(viewer).toLowerCase()) ||
    ch.name ||
    ch.slug;
  return other;
}

function navButtonHtml(ch, viewer) {
  const active = ch.slug === state.channelSlug ? "active" : "";
  const label = ch.kind === "dm" ? dmLabel(ch, viewer) : `#${ch.slug}`;
  const unread = state.unreads[ch.slug] || 0;
  const badge = unread > 0 ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : "";
  return `<button type="button" data-slug="${esc(ch.slug)}" class="${active}"><span class="nav-row"><span class="nav-label">${esc(label)}</span>${badge}</span></button>`;
}

function fmtTime(iso) {
  // "just now", "5m", "3h", "Yesterday", then a short date — readable on a phone.
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return iso || "";
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 172800) return "Yesterday";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

function fmtTimeFull(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso || "";
  }
}

function initialOf(name) {
  // v32.2: two-letter tag instead of one char — "Claude"/"Cursor"/"ChatGPT"/"Cursor-Cloud"
  // all started with "C" and were indistinguishable at a glance. "#channel" keeps its "#".
  const n = String(name || "?").trim();
  if (!n) return "?";
  if (n[0] === "#") return "#";
  const parts = n.split(/[\s\-_]+/).filter(Boolean);
  if (parts.length >= 2) return esc((parts[0][0] + parts[1][0]).toUpperCase());
  const w = parts[0] || n;
  if (w.length <= 1) return esc(w.toUpperCase());
  return esc(w[0].toUpperCase() + w[1].toLowerCase());
}

function channelLabel(slug, kind) {
  const ch = (state.channels || []).find((c) => c.slug === slug);
  if (ch) return ch.kind === "dm" ? `DM · ${dmLabel(ch, currentViewer())}` : `#${ch.slug}`;
  return kind === "dm" ? "DM" : `#${slug}`;
}

function setLive(ok, detail = "") {
  const pill = document.getElementById("live-pill");
  const label = document.getElementById("live-label");
  pill.classList.toggle("offline", !ok);
  if (state.pocketMode && !ok) {
    label.textContent = "pocket · offline";
  } else if (state.pocketMode && ok) {
    label.textContent = `online · ${state.hostLabel}`;
  } else {
    label.textContent = ok ? `online · ${state.hostLabel}` : "offline";
  }
  if (detail) pill.title = detail;
}

function setRailOpen(open) {
  document.getElementById("shell").classList.toggle("rail-open", open);
  const backdrop = document.getElementById("rail-backdrop");
  if (open) backdrop.removeAttribute("hidden");
  else backdrop.setAttribute("hidden", "");
  if (!open && typeof setActiveTab === "function" && !document.getElementById("lists-pane").classList.contains("open")) {
    setActiveTab(
      state.view === "home"
        ? "home"
        : state.view === "agents"
          ? "agents"
          : state.view === "notes"
            ? "notes"
            : "chats"
    );
  }
}

function closeOverlays() {
  setRailOpen(false);
  document.getElementById("lists-pane").classList.remove("open");
}

function autosize(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function showInstallBanner() {
  const banner = document.getElementById("install-banner");
  if (!banner || isStandalone()) {
    if (banner) banner.hidden = true;
    return;
  }
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const copy = document.getElementById("install-copy");
  const btn = document.getElementById("install-btn");
  if (isIos) {
    copy.textContent = "Add The Stack to your Home Screen — Share → Add to Home Screen";
    btn.hidden = true;
  } else if (state.deferredInstall) {
    copy.textContent = "Install The Stack as an app on this phone";
    btn.hidden = false;
    btn.textContent = "Install";
  } else {
    copy.textContent = "Tip: Add to Home Screen for the full-screen app";
    btn.hidden = true;
  }
  banner.hidden = false;
}

function bindChannelNav(nav) {
  if (!nav) return;
  nav.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.channelSlug = btn.dataset.slug;
      state.threadParentId = null;
      document.getElementById("thread").classList.add("hidden");
      setRailOpen(false);
      showView("channel");
    });
  });
}

function refreshUnreadBadges() {
  const reads = loadReads();
  const unreads = {};
  for (const ch of state.channels || []) {
    const updated = ch.updated_at || ch.created_at || "";
    const since = reads[ch.slug] || "";
    if (!updated) continue;
    if (!since || String(updated) > String(since)) unreads[ch.slug] = 1;
  }
  // Active room is read.
  if (state.view === "channel" && state.channelSlug) delete unreads[state.channelSlug];
  state.unreads = unreads;
}

function paintChannelNav() {
  const viewer = currentViewer();
  const pubs = state.channels.filter((c) => c.kind !== "dm");
  const dms = state.channels.filter((c) => {
    if (c.kind !== "dm") return false;
    const label = String(dmLabel(c, viewer)).toLowerCase();
    return !ARCHIVED_AGENTS.has(label);
  });
  const nav = document.getElementById("channel-list");
  const dmNav = document.getElementById("dm-list");
  refreshUnreadBadges();
  nav.innerHTML = pubs.map((c) => navButtonHtml(c, viewer)).join("");
  if (dmNav) dmNav.innerHTML = dms.map((c) => navButtonHtml(c, viewer)).join("");
  bindChannelNav(nav);
  bindChannelNav(dmNav);
  paintSessionStrip();
  paintChatsInbox();
}

/* v26: session strip on the chat screen — live agents first, then channels. */
const LAST_CHAT_KEY = "stack-last-chat-v1";
const AGENT_ORDER = ["chatgpt", "cursor", "gemini", "claude"];
const ARCHIVED_AGENTS = new Set(["nori", "workhorse", "hermes"]);
function sessionList() {
  const viewer = currentViewer();
  const dms = (state.channels || []).filter((c) => {
    if (c.kind !== "dm") return false;
    const label = String(dmLabel(c, viewer)).toLowerCase();
    return !ARCHIVED_AGENTS.has(label);
  });
  const pubs = (state.channels || []).filter((c) => c.kind !== "dm");
  const rank = (c) => {
    const i = AGENT_ORDER.indexOf(String(dmLabel(c, viewer)).toLowerCase());
    return i < 0 ? 99 : i;
  };
  dms.sort((a, b) => rank(a) - rank(b));
  return [...dms, ...pubs];
}
function defaultChatSlug() {
  let last = "";
  try {
    last = localStorage.getItem(LAST_CHAT_KEY) || "";
  } catch {
    last = "";
  }
  const list = sessionList();
  if (last && list.some((c) => c.slug === last)) return last;
  return (list[0] && list[0].slug) || state.channelSlug;
}
function paintSessionStrip() {
  const strip = document.getElementById("session-strip");
  if (!strip) return;
  const viewer = currentViewer();
  strip.innerHTML =
    sessionList()
      .map((c) => {
        const dm = c.kind === "dm";
        const label = dm ? dmLabel(c, viewer) : `#${c.slug}`;
        const active = c.slug === state.channelSlug && state.view === "channel";
        const unread = state.unreads[c.slug] ? '<span class="chip-dot" aria-label="unread"></span>' : "";
        return `<button type="button" class="session-chip${dm ? "" : " channel"}${active ? " active" : ""}" data-slug="${esc(
          c.slug
        )}" role="tab" aria-selected="${active}">${dm ? `<span class="chip-av" aria-hidden="true">${initialOf(label)}</span>` : ""}${esc(
          label
        )}${unread}</button>`;
      })
      .join("") + `<button type="button" class="session-chip more" data-more="1" aria-label="More chats and new channel">＋</button>`;
  const act = strip.querySelector(".session-chip.active");
  if (act) act.scrollIntoView({ block: "nearest", inline: "center" });
}
document.getElementById("session-strip")?.addEventListener("click", (e) => {
  const chip = e.target.closest(".session-chip");
  if (!chip) return;
  if (chip.dataset.more) {
    setRailOpen(true);
    return;
  }
  state.channelSlug = chip.dataset.slug;
  state.threadParentId = null;
  document.getElementById("thread").classList.add("hidden");
  showView("channel");
});

async function loadChannels() {
  let channels;
  try {
    ({ channels } = await api("/api/channels"));
    await pocketSet("channels", channels);
  } catch (err) {
    channels = (await pocketGet("channels")) || [];
    if (!channels.length) throw err;
    state.pocketMode = true;
  }
  state.channels = channels || [];
  state.messageIndexBuilt = false;
  paintChannelNav();
}

function isPhoneShell() {
  return window.matchMedia("(max-width: 720px)").matches;
}

function hideAllMains() {
  ["home-pane", "chats-pane", "chat-pane", "agents-pane", "notes-pane"].forEach((id) => {
    document.getElementById(id)?.classList.add("hidden");
  });
  document.getElementById("lists-pane")?.classList.remove("open");
}

function paintChatsInbox() {
  const inbox = document.getElementById("chats-inbox");
  if (!inbox) return;
  const viewer = currentViewer();
  refreshUnreadBadges();
  const rows = sessionList();
  if (!rows.length) {
    inbox.innerHTML = `<p class="home-empty">No chats yet. Open an agent DM from Home or Agents.</p>`;
    return;
  }
  inbox.innerHTML = rows
    .map((c) => {
      const dm = c.kind === "dm";
      const label = dm ? dmLabel(c, viewer) : `#${c.slug}`;
      const last = (state.lastPreviewBySlug && state.lastPreviewBySlug[c.slug]) || "";
      const preview = last || c.purpose || (dm ? "Direct messages" : "Channel");
      const time = c.updated_at ? `<time class="chat-inbox-time">${esc(fmtTime(c.updated_at))}</time>` : "";
      const unread = state.unreads[c.slug]
        ? `<span class="chat-inbox-unread" aria-label="unread"></span>`
        : "";
      return `<button type="button" class="chat-inbox-row" data-slug="${esc(c.slug)}">
        <span class="chat-inbox-av" aria-hidden="true">${esc(initialOf(label))}</span>
        <span class="chat-inbox-main">
          <strong>${esc(label)}${time}</strong>
          <span>${esc(preview)}</span>
        </span>
        ${unread}
      </button>`;
    })
    .join("");
}

function showChatsInbox() {
  hideAllMains();
  const pane = document.getElementById("chats-pane");
  if (pane) pane.classList.remove("hidden");
  document.getElementById("shell")?.classList.remove("chat-sheet-open");
  const chat = document.getElementById("chat-pane");
  chat?.classList.remove("sheet-open", "sheet-dragging", "sheet-exiting");
  chat?.style.removeProperty("transform");
  paintChatsInbox();
  if (typeof setActiveTab === "function") setActiveTab("chats");
}

function rememberChatReturn() {
  const v = state.view;
  state.chatReturnTo = v === "home" || v === "agents" || v === "notes" || v === "chats" ? v : "chats";
}

function openChatSheet() {
  const chat = document.getElementById("chat-pane");
  if (!chat) return;
  if (isPhoneShell()) {
    // Underlay matches where Back should land (Home stays under if you opened from Home).
    const under = state.chatReturnTo || "chats";
    document.getElementById("chats-pane")?.classList.toggle("hidden", under !== "chats");
    document.getElementById("home-pane")?.classList.toggle("hidden", under !== "home");
    document.getElementById("agents-pane")?.classList.toggle("hidden", under !== "agents");
    document.getElementById("notes-pane")?.classList.toggle("hidden", under !== "notes");
    const already = chat.classList.contains("sheet-open") && !chat.classList.contains("hidden");
    chat.classList.remove("hidden", "sheet-exiting", "sheet-dragging");
    chat.style.removeProperty("transform");
    if (!already) {
      chat.classList.remove("sheet-open");
      void chat.offsetWidth;
      requestAnimationFrame(() => chat.classList.add("sheet-open"));
    } else {
      chat.classList.add("sheet-open");
    }
    document.getElementById("shell")?.classList.add("chat-sheet-open");
  } else {
    chat.classList.remove("hidden", "sheet-exiting", "sheet-dragging", "sheet-open");
    chat.style.removeProperty("transform");
    document.getElementById("chats-pane")?.classList.add("hidden");
    document.getElementById("shell")?.classList.remove("chat-sheet-open");
  }
}

function closeChatSheet({ to } = {}) {
  const chat = document.getElementById("chat-pane");
  if (!chat) return;
  const dest = to || state.chatReturnTo || "chats";
  state.threadParentId = null;
  document.getElementById("thread")?.classList.add("hidden");

  if (!isPhoneShell() || !chat.classList.contains("sheet-open")) {
    chat.classList.remove("sheet-open", "sheet-dragging", "sheet-exiting");
    chat.style.removeProperty("transform");
    document.getElementById("shell")?.classList.remove("chat-sheet-open");
    showView(dest === "channel" ? "chats" : dest);
    return;
  }

  if (chat.classList.contains("sheet-exiting")) return;
  chat.classList.add("sheet-exiting");
  chat.classList.remove("sheet-open", "sheet-dragging");
  chat.style.removeProperty("transform");
  const box = document.getElementById("messages");
  if (box) box.style.overflow = "hidden";

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    chat.classList.add("hidden");
    chat.classList.remove("sheet-exiting", "sheet-dragging");
    chat.style.removeProperty("transform");
    if (box) box.style.overflow = "";
    document.getElementById("shell")?.classList.remove("chat-sheet-open");
    if (dest === "home") showView("home");
    else if (dest === "agents") showView("agents");
    else if (dest === "notes") showView("notes");
    else showChatsInbox();
  };
  chat.addEventListener("transitionend", finish, { once: true });
  setTimeout(finish, 420);
}

function setupChatSheetGestures() {
  const chat = document.getElementById("chat-pane");
  const box = document.getElementById("messages");
  if (!chat || chat.dataset.sheetBound) return;
  chat.dataset.sheetBound = "1";

  let startY = 0;
  let startX = 0;
  let dragging = false;
  let armed = false;
  let dy = 0;

  const onStart = (y, x, target) => {
    if (!isPhoneShell() || !chat.classList.contains("sheet-open")) return false;
    if (chat.classList.contains("sheet-exiting")) return false;
    if (document.getElementById("thread") && !document.getElementById("thread").classList.contains("hidden")) {
      return false;
    }
    // Only the grabber / header — never the message list (that fights scroll).
    const inGrab = target.closest(".sheet-grabber, .main-head, .chat-back");
    if (!inGrab) return false;
    if (target.closest("button, a, input, textarea, select, label")) {
      // Let real controls (Back, Lists) win; grabber + title area still dismiss.
      if (!target.closest(".sheet-grabber, .main-head-text, h1, .purpose")) return false;
    }
    startY = y;
    startX = x;
    dy = 0;
    armed = true;
    dragging = false;
    return true;
  };

  const onMove = (y, x, ev) => {
    if (!armed) return;
    const rawY = y - startY;
    const rawX = x - startX;
    if (!dragging) {
      if (Math.abs(rawX) > 12 && Math.abs(rawX) > Math.abs(rawY)) {
        armed = false;
        return;
      }
      if (rawY < 10) return;
      dragging = true;
      chat.classList.add("sheet-dragging");
    }
    dy = Math.max(0, rawY);
    const resist = Math.min(dy, 420);
    chat.style.transform = `translate3d(0, ${resist}px, 0)`;
    if (ev && ev.cancelable) ev.preventDefault();
  };

  const onEnd = () => {
    if (!armed && !dragging) return;
    armed = false;
    if (!dragging) return;
    dragging = false;
    chat.classList.remove("sheet-dragging");
    if (dy > 110) {
      closeChatSheet();
    } else {
      chat.style.removeProperty("transform");
    }
    dy = 0;
  };

  chat.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      onStart(e.touches[0].clientY, e.touches[0].clientX, e.target);
    },
    { passive: true }
  );
  chat.addEventListener(
    "touchmove",
    (e) => {
      if (!armed || e.touches.length !== 1) return;
      onMove(e.touches[0].clientY, e.touches[0].clientX, e);
    },
    { passive: false }
  );
  chat.addEventListener("touchend", onEnd, { passive: true });
  chat.addEventListener("touchcancel", onEnd, { passive: true });
}

function showView(view) {
  // Capture where chat should return before we overwrite state.view.
  if (view === "channel" && state.view !== "channel") rememberChatReturn();
  state.view = view;
  const agentsPane = document.getElementById("agents-pane");
  const notesPane = document.getElementById("notes-pane");
  const chatsPane = document.getElementById("chats-pane");
  if (agentsPane) agentsPane.classList.toggle("hidden", view !== "agents");
  if (notesPane) notesPane.classList.toggle("hidden", view !== "notes");

  if (view === "notes") {
    document.getElementById("home-pane").classList.add("hidden");
    chatsPane?.classList.add("hidden");
    closeChatSheetImmediate();
    document.getElementById("lists-pane").classList.remove("open");
    if (typeof setActiveTab === "function") setActiveTab("notes");
    loadNotes().catch((err) => {
      document.getElementById("notes-list").innerHTML = `<p class="home-empty">${esc(friendlyError(err))}</p>`;
    });
    return;
  }
  if (view === "agents") {
    document.getElementById("home-pane").classList.add("hidden");
    chatsPane?.classList.add("hidden");
    closeChatSheetImmediate();
    if (typeof setActiveTab === "function") setActiveTab("agents");
    loadAgentsView().catch((err) => {
      const b = document.getElementById("agents-body");
      if (b) b.innerHTML = `<p class="home-empty">${esc(friendlyError(err))}</p>`;
    });
    return;
  }
  if (view === "chats") {
    document.getElementById("home-pane").classList.add("hidden");
    closeChatSheetImmediate();
    showChatsInbox();
    return;
  }
  if (typeof setActiveTab === "function") {
    setActiveTab(view === "home" ? "home" : view === "agents" ? "agents" : view === "notes" ? "notes" : "chats");
  }
  const home = document.getElementById("home-pane");
  const chat = document.getElementById("chat-pane");
  const homeNav = document.getElementById("home-nav");
  if (view === "home") {
    home.classList.remove("hidden");
    chatsPane?.classList.add("hidden");
    closeChatSheetImmediate();
    if (homeNav) homeNav.classList.add("active");
    document.querySelectorAll("#channel-list button").forEach((b) => b.classList.remove("active"));
    loadHome().catch((err) => {
      const body = document.getElementById("home-body");
      const headline = document.getElementById("home-headline");
      if (headline) headline.textContent = "Couldn’t load hub";
      if (body) {
        body.innerHTML = `<section class="home-section home-offline">
          <h2>Home</h2>
          <p>${esc(friendlyError(err))}</p>
          <button type="button" id="home-reconnect" class="primary-btn">Reconnect</button>
        </section>`;
        document.getElementById("home-reconnect")?.addEventListener("click", () => {
          document.getElementById("shell")?.classList.add("hidden");
          document.getElementById("boot")?.classList.remove("hidden");
          showCloudConnect(friendlyError(err));
        });
      }
    });
  } else {
    // channel — rememberChatReturn() must be called by the opener before showView.
    try {
      localStorage.setItem(LAST_CHAT_KEY, state.channelSlug);
    } catch {
      /* ignore */
    }
    home.classList.add("hidden");
    if (homeNav) homeNav.classList.remove("active");
    openChatSheet();
    paintSessionStrip();
    paintChatsInbox();
    refresh();
  }
}

function closeChatSheetImmediate() {
  const chat = document.getElementById("chat-pane");
  if (!chat) return;
  chat.classList.add("hidden");
  chat.classList.remove("sheet-open", "sheet-dragging", "sheet-exiting");
  chat.style.removeProperty("transform");
  document.getElementById("shell")?.classList.remove("chat-sheet-open");
  const box = document.getElementById("messages");
  if (box) box.style.overflow = "";
}

/* ---- Command centre (v34.0): live agents, model pickers, git-main feed ---- */
const AGENT_ROSTER = [
  { name: "ChatGPT", role: "Orchestrator + verify", aliases: ["chatgpt"] },
  { name: "Cursor", role: "Build + integrate", aliases: ["cursor"] },
  { name: "Cursor-Cloud", role: "Cloud coordinator", aliases: ["cursor-cloud", "cursor cloud"] },
  { name: "Gemini", role: "Trial peer (Antigravity)", aliases: ["gemini"] },
  { name: "Real-Claude", role: "The Stack collaborator (manual)", aliases: ["real-claude", "claude", "claude pro"] },
  { name: "Workhorse", role: "Retired (19 Nov 2026) — former CLI grind", aliases: ["workhorse"], archived: true },
  { name: "Hermes", role: "Wiped / parked (19 Nov 2026)", aliases: ["hermes", "windows-migration"], archived: true },
  { name: "Nori", role: "Separate Grok lane (archived)", aliases: ["nori", "grok"], archived: true },
];
const DM_WIRE_SHARE = { "Real-Claude": "Claude", Workhorse: "Claude", "Cursor-Cloud": "Cursor" };
const MODEL_OPTIONS = {
  ChatGPT: ["Default", "Fast", "Deep reasoning"],
  Cursor: ["Auto", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT (latest)", "Gemini (latest)"],
  "Cursor-Cloud": ["Auto", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT (latest)"],
  Gemini: ["Gemini 4 Argon (Medium)", "Gemini 4 Carbon", "Gemini 4 Hydrogen"],
  "Real-Claude": ["Claude Opus 5.5", "Claude Sonnet 5.5", "Claude Haiku 5.5"],
  Workhorse: ["retired"],
  Hermes: ["wiped"],
  Nori: ["Grok (latest)", "Grok fast"],
};
const AGENT_ACTIVE_MS = 2 * 3600 * 1000;
const AGENT_RECENT_MS = 24 * 3600 * 1000;
const AGENT_CHAT_ACTIVE_MS = 15 * 60 * 1000;

function liveAgentRoster() {
  return AGENT_ROSTER.filter((a) => !a.archived);
}

function canonicalAgent(raw) {
  const low = String(raw || "").trim().toLowerCase();
  const hit = AGENT_ROSTER.find((a) => a.aliases.includes(low));
  return hit ? hit.name : null;
}

function agentStatus(iso, chatIso, hostIso) {
  const chatT = chatIso ? new Date(chatIso).getTime() : NaN;
  if (!Number.isNaN(chatT) && Date.now() - chatT < AGENT_CHAT_ACTIVE_MS) {
    return { key: "active", label: "In chat" };
  }
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isNaN(t)) {
    const age = Date.now() - t;
    if (age < AGENT_ACTIVE_MS) return { key: "active", label: "Running" };
    if (age < AGENT_RECENT_MS) return { key: "recent", label: "Recent" };
  }
  // v32: if this agent's machine heartbeat is fresh, don't look fully idle.
  const hostT = hostIso ? new Date(hostIso).getTime() : NaN;
  if (!Number.isNaN(hostT) && Date.now() - hostT < 15 * 60000) {
    return { key: "recent", label: "Host online" };
  }
  if (Number.isNaN(t)) return { key: "idle", label: "No activity logged" };
  return { key: "idle", label: "Idle" };
}

function clip(text, n) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

function dmSlugFor(agent) {
  const viewer = currentViewer().toLowerCase();
  const lookFor = (DM_WIRE_SHARE[agent] || agent).toLowerCase();
  const ch = (state.channels || []).find(
    (c) =>
      c.kind === "dm" &&
      (c.members || []).some((m) => String(m).toLowerCase() === lookFor) &&
      (c.members || []).some((m) => String(m).toLowerCase() === viewer)
  );
  return ch ? ch.slug : "";
}

async function loadCommandCentre() {
  const out = { agents: [], agentsHtml: "", feedHtml: "", agentsSource: "", feedSource: "" };
  const cloud = state.cloudMode && typeof ghSharedMemory === "function" && ghState && ghState.token;
  let events = [];
  let commits = [];
  let prefs = { agents: {} };
  let pulls = null;
  let heartbeats = [];
  let handovers = [];
  let needsSeth = [];
  if (cloud) {
    const [mem, com, pref, prs, hb, js, hos, ns] = await Promise.allSettled([
      ghSharedMemory(),
      ghRecentCommits(20),
      ghLoadAgentPrefs(),
      ghRecentPulls(15),
      typeof ghHostHeartbeats === "function" ? ghHostHeartbeats() : Promise.resolve([]),
      typeof ghLoadJobState === "function" ? ghLoadJobState() : Promise.resolve({ dismissed: {} }),
      typeof ghListHandovers === "function" ? ghListHandovers() : Promise.resolve([]),
      typeof ghLoadNeedsSeth === "function" ? ghLoadNeedsSeth() : Promise.resolve([]),
    ]);
    if (prs.status === "fulfilled") pulls = prs.value;
    if (hb.status === "fulfilled") heartbeats = hb.value;
    state.dismissedJobs = js.status === "fulfilled" ? js.value.dismissed || {} : {};
    out.pullsSource = prs.status === "fulfilled" ? "pull requests" : "merge commits";
    if (mem.status === "fulfilled") events = mem.value;
    if (com.status === "fulfilled") commits = com.value;
    if (pref.status === "fulfilled") prefs = pref.value;
    if (hos.status === "fulfilled") handovers = hos.value || [];
    if (ns.status === "fulfilled") needsSeth = ns.value || [];
    state.handovers = handovers;
    state.ccErrors = [mem, com].filter((r) => r.status === "rejected").map((r) => friendlyError(r.reason));
  }
  state.agentPrefs = prefs.agents || {};

  // Latest shared-memory event per agent = "what it's doing"; chat presence from recent DM posts.
  const latest = {};
  for (const ev of events) {
    const name = canonicalAgent(ev.agent);
    if (!name) continue;
    if (!latest[name] || String(ev.at) > String(latest[name].at)) latest[name] = ev;
  }
  // Presence: recent DM activity (channel updated_at) — no extra GitHub GETs on each Home poll.
  const chatPresence = {};
  for (const a of liveAgentRoster()) {
    const slug = dmSlugFor(a.name);
    const ch = (state.channels || []).find((c) => c.slug === slug);
    if (ch && ch.updated_at) chatPresence[a.name] = ch.updated_at;
  }
  // Warm host→agent presence before status labels (Computers sheet + Home lines).
  buildHosts(heartbeats, events, cloud);
  out.agents = liveAgentRoster()
    .map((a) => {
      const ev = latest[a.name];
      const hostAt = (state.hostPresenceByAgent && state.hostPresenceByAgent[a.name]) || "";
      const st = agentStatus(ev && ev.at, chatPresence[a.name], hostAt);
      return { ...a, ev, chatAt: chatPresence[a.name] || "", hostAt, status: st.key, statusLabel: st.label };
    })
    .sort((x, y) => {
      const rank = { active: 0, recent: 1, idle: 2 };
      return rank[x.status] - rank[y.status] || String((y.ev && y.ev.at) || "").localeCompare(String((x.ev && x.ev.at) || ""));
    });
  out.agentsSource = cloud
    ? `shared memory · DMs · ${ghState.branch}`
    : "connect cloud hub for live status";

  function agentLine(a) {
    const line = a.ev ? clip(a.ev.text, 84) : a.role || "Idle";
    const quiet = a.status === "idle" && !a.ev ? " is-quiet" : "";
    const dm = dmSlugFor(a.name);
    const open = dm
      ? ` data-open-agent="${esc(a.name)}" aria-label="Open chat with ${esc(a.name)}"`
      : "";
    return `<button type="button" class="agent-line status-${a.status}${quiet}"${open}>
      <span class="agent-avatar" aria-hidden="true">${initialOf(a.name)}</span>
      <span class="agent-line-main"><strong>${esc(a.name)}</strong><span>${esc(line)}</span></span>
      <span class="aw-pill"><span class="dot"></span>${esc(a.statusLabel)}</span>
    </button>`;
  }
  out.rosterHtml = out.agents.map(agentLine).join("");

  out.agentsHtml = `<div class="agent-list">${out.agents
    .map((a) => {
      const pref = state.agentPrefs[a.name] || {};
      const opts = MODEL_OPTIONS[a.name] || ["Default"];
      const current = pref.model || "";
      const optionHtml = [
        `<option value="" ${current ? "" : "selected"}>Model: not set</option>`,
        ...opts.map((m) => `<option ${m === current ? "selected" : ""}>${esc(m)}</option>`),
        current && !opts.includes(current) ? `<option selected>${esc(current)}</option>` : "",
        `<option value="__custom">Other…</option>`,
      ].join("");
      const dm = dmSlugFor(a.name);
      const unread = dm ? state.unreads[dm] || 0 : 0;
      return `
      <article class="agent-window status-${a.status} home-tap" data-agent="${esc(a.name)}"${
        dm ? ` data-open-agent="${esc(a.name)}" tabindex="0" role="link" aria-label="Open chat with ${esc(a.name)}"` : ""
      }>
        <div class="aw-top">
          <span class="agent-avatar" aria-hidden="true">${initialOf(a.name)}</span>
          <div class="aw-id">
            <strong>${esc(a.name)}</strong>
            <span class="aw-role">${esc(a.role)}</span>
          </div>
          <span class="aw-pill"><span class="dot"></span>${esc(a.statusLabel)}</span>
        </div>
        ${sparkline(events, a.name)}
        <p class="aw-now">${
          a.ev
            ? `${esc(clip(a.ev.text, 150))}`
            : `<span class="muted">Nothing in shared memory yet.</span>`
        }</p>
        <div class="aw-foot">
          <label class="model-pick" data-stop-nav="1">
            <span class="sr-only">Preferred model for ${esc(a.name)}</span>
            <select data-agent="${esc(a.name)}" ${cloud ? "" : "disabled"}>${optionHtml}</select>
          </label>
          <time title="${esc(a.ev ? fmtTimeFull(a.ev.at) : "")}">${a.ev ? esc(fmtTime(a.ev.at)) : ""}</time>
          ${
            dm
              ? `<button type="button" class="aw-open home-open-channel" data-slug="${esc(dm)}" data-stop-nav="1">Chat${
                  unread ? ` <span class="unread-badge">${unread}</span>` : ""
                }</button>`
              : ""
          }
        </div>
      </article>`;
    })
    .join("")}</div>`;

  ({ html: out.jobsHtml, needs: out.needsCount, needsList: out.needsList, doneList: out.doneList } = buildJobs({
    events,
    commits,
    pulls,
    agents: out.agents,
    cloud,
    handovers,
    needsSeth,
  }));
  out.handovers = handovers;
  out.hostsHtml = buildHosts(heartbeats, events, cloud);
  const nl = out.needsList || [];
  // v31: Home keeps one Needs-you surface (digest CTA + orange stat). Full list lives on Agents.
  out.needsHtml = "";
  out.digestHtml = buildDigest({ events, pulls, commits, needs: out.needsList || [], done: out.doneList || [] });
  // Feed: shared memory + commits on main, newest first.
  const feed = [
    ...events.map((ev) => ({
      kind: ev.kind === "result" ? "Result" : ev.kind === "note" ? "Note" : "Update",
      who: canonicalAgent(ev.agent) || ev.agent || "Agent",
      at: ev.at,
      title: clip(String(ev.id || "").replace(/-\d{8}$/, "").replace(/[-_]+/g, " "), 60),
      text: ev.text || "",
    })),
    ...commits
      .filter((c) => !/^(Shared memory:|stack:)/i.test(c.message))
      .map((c) => {
        const [first, ...rest] = String(c.message).split("\n");
        return {
          kind: /^Merge pull request/i.test(first) ? "Merged" : "Commit",
          who: c.author || "git",
          at: c.at,
          title: clip(
            first.replace(/^Merge pull request (#\d+) from [^/]+\/(?:[a-z]+\/)?(.+?)(?:-\d{8}.*)?$/i, (_, n, b) => `PR ${n} merged · ${b.replace(/[-_]+/g, " ")}`),
            80
          ),
          text: rest.join(" ").replace(/Co-authored-by:.*$/gim, "").trim(),
          url: c.url,
        };
      }),
  ]
    .filter((f) => f.at)
    .sort((x, y) => String(y.at).localeCompare(String(x.at)))
    .slice(0, 14);
  out.feedSource = cloud ? `git ${ghState.branch} · ${feed.length} latest` : "connect cloud hub";
  out.feedHtml = feed.length
    ? `<ol class="feed">${feed
        .map((f) => {
          const agent = canonicalAgent(f.who);
          return `
      <li class="feed-item kind-${esc(f.kind.toLowerCase())}">
        <details>
          <summary>
            <span class="feed-kind">${esc(f.kind)}</span>
            <span class="feed-title">${esc(f.title || clip(f.text, 70))}</span>
            <span class="feed-meta">${esc(f.who)} · <time title="${esc(fmtTimeFull(f.at))}">${esc(fmtTime(f.at))}</time></span>
          </summary>
          ${f.text ? `<p>${esc(f.text)}</p>` : ""}
          <div class="feed-actions">
            ${f.url ? `<a class="act" href="${esc(f.url)}" target="_blank" rel="noopener">Open on GitHub ↗</a>` : ""}
            ${agent ? `<button type="button" class="act" data-open-agent="${esc(agent)}">Chat with ${esc(agent)}</button>` : ""}
          </div>
        </details>
      </li>`;
        })
        .join("")}</ol>`
    : `<p class="home-empty">${
        cloud
          ? (state.ccErrors || []).join(" ") || "Nothing on main yet."
          : "Connect the cloud hub to see git main activity."
      }</p>`;
  return out;
}


/* Vercel-style 24h activity: one bar per hour from shared-memory events. */
function sparkline(events, agent) {
  const now = Date.now();
  const bins = new Array(24).fill(0);
  for (const ev of events || []) {
    if (canonicalAgent(ev.agent) !== agent) continue;
    const age = now - new Date(ev.at).getTime();
    if (!(age >= 0 && age < 86400000)) continue;
    bins[23 - Math.floor(age / 3600000)] += 1;
  }
  const total = bins.reduce((x, y) => x + y, 0);
  const max = Math.max(1, ...bins);
  const bars = bins
    .map((v, i) => {
      const h = v ? Math.max(3, Math.round((v / max) * 18)) : 1.5;
      return `<rect x="${i * 5}" y="${20 - h}" width="3.4" height="${h}" rx="1" class="${v ? "on" : "off"}"/>`;
    })
    .join("");
  return `<div class="aw-spark" title="${total} update${total === 1 ? "" : "s"} in the last 24h">
    <svg viewBox="0 0 120 20" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>
    <span>${total} in 24h</span>
  </div>`;
}

/* Linear-style triage + Codex-style job cards. */
// Live asks only — mirrored in Projects/The-Stack/lib/needs_you.mjs (push sender + tests).
function eventAsksSeth(ev) {
  if (!ev) return false;
  const kind = String(ev.kind || "").toLowerCase();
  if (kind === "blocked") return true;
  const text = String(ev.text || "");
  if (!text) return false;
  const metaAboutRule =
    /\b(literal(ly)?|contain(s|ed)?|describ\w*|about the|rule says|says? BLOCKED|shout(s|ing)?\s+BLOCKED|word BLOCKED|false.?positiv|tripped the rule|while describing|in caps for)\b/i.test(
      text
    ) && /\bBLOCKED\b/.test(text);
  const blockedLead =
    /(?:^|[.!?]\s|\n)\s*BLOCKED\b|\bBLOCKED:\s|\bBLOCKED\b(?:\s+from\b|\s+until\b|\s*—|\s+-)|status:\s*BLOCKED\b/i.test(
      text
    );
  if (metaAboutRule && !blockedLead) return false;
  const sethAsk =
    /\b[Ss]eth (still )?needs\b|\bneeds [Ss]eth\b|\bwaiting on [Ss]eth\b|\b[Ss]eth must\b|\b[Ss]eth: (tap|type|open|paste|run|approve|add|merge|wake)/.test(
      text
    );
  const blockedStatus =
    blockedLead ||
    (/\bBLOCKED\b/.test(text) && !/\b(says?|saying|said|shout|literal|rule|word|contain|describ|about)\b/i.test(text));
  if (kind === "result") return blockedStatus;
  return blockedStatus || sethAsk;
}

function prNeedsSeth(p, dismissed) {
  if (!p || p.state !== "open" || p.draft) return false;
  if (dismissed && dismissed[`pr-${p.number}`]) return false;
  const title = String(p.title || "");
  if (
    /^(Log |Review:|Theme kit:|Test phone alert)/i.test(title) &&
    !/\b(approve|needs you|please merge)\b/i.test(title)
  ) {
    return false;
  }
  return true;
}

function jobCard(j) {
  const pill = {
    open: ["Open", "pill-open"],
    draft: ["Draft", "pill-draft"],
    merged: ["Merged", "pill-merged"],
    closed: ["Closed", "pill-closed"],
    blocked: ["Needs you", "pill-blocked"],
    running: ["Running", "pill-running"],
    done: ["Done", "pill-merged"],
  }[j.status] || ["Update", "pill-draft"];
  return `
    <article class="job-card">
      <div class="job-top">
        <span class="job-pill ${pill[1]}">${pill[0]}</span>
        ${j.number ? `<span class="job-num">#${j.number}</span>` : ""}
        <time title="${esc(fmtTimeFull(j.at))}">${esc(fmtTime(j.at))}</time>
      </div>
      <strong class="job-title">${esc(clip(j.title, 90))}</strong>
      ${j.text ? `<p class="job-text">${esc(clip(j.text, 170))}</p>` : ""}
      ${jobActions(j)}
      <div class="job-foot">
        <span class="job-who">${esc(j.who || "")}${j.branch ? ` · <code>${esc(clip(j.branch, 34))}</code>` : ""}</span>
        ${j.url ? `<a href="${esc(j.url)}" target="_blank" rel="noopener">${j.number ? "View PR" : "Open"} ↗</a>` : ""}
      </div>
    </article>`;
}

function buildJobs({ events, commits, pulls, agents, cloud, handovers, needsSeth }) {
  const now = Date.now();
  const within = (iso, ms) => iso && now - new Date(iso).getTime() < ms;
  const needs = [];
  const running = [];
  const done = [];
  // Latest entry per agent only; classifier ignores meta "BLOCKED" talk. Approvals in hub/jobs.json.
  const evs = [...(events || [])].sort((x, y) => String(y.at).localeCompare(String(x.at)));
  const latestByAgent = {};
  for (const ev of evs) {
    const who = canonicalAgent(ev.agent) || ev.agent;
    if (!latestByAgent[who]) latestByAgent[who] = ev;
  }
  const dismissed = state.dismissedJobs || {};
  const seenNeedKeys = new Set();
  // v31.0: structured handovers + needs_seth.json feed the unified Needs-you inbox first.
  for (const item of needsSeth || []) {
    if (!item || item.resolved) continue;
    const key = item.key || `ns-${item.at}-${item.title}`;
    if (dismissed[key] || seenNeedKeys.has(key)) continue;
    seenNeedKeys.add(key);
    needs.push({
      status: "blocked",
      title: item.title || "Needs Seth",
      text: item.reason || item.recommended_action || "",
      who: item.origin || "system",
      at: item.at || "",
      key,
      kind: "needs_seth",
      priority: item.priority,
    });
  }
  for (const h of handovers || []) {
    if (typeof ghHandoverToNeedsJob !== "function") break;
    const job = ghHandoverToNeedsJob(h);
    if (!job || !job.urgent) continue;
    const key = `ho-${h.id}`;
    if (dismissed[key] || seenNeedKeys.has(key)) continue;
    seenNeedKeys.add(key);
    needs.push({ ...job, key });
  }
  for (const ev of evs) {
    const who = canonicalAgent(ev.agent) || ev.agent;
    const title = String(ev.id || "").replace(/-\d{8}$/, "").replace(/[-_]+/g, " ");
    const text = ev.text || "";
    const asks = eventAsksSeth(ev);
    const key = `ev-${who}-${String(ev.at)}`;
    if (latestByAgent[who] === ev && asks && within(ev.at, 72 * 3600000) && !dismissed[key] && !seenNeedKeys.has(key)) {
      seenNeedKeys.add(key);
      needs.push({ status: "blocked", title, text, who, at: ev.at });
    } else if (ev.kind === "result" && within(ev.at, 24 * 3600000)) {
      done.push({ status: "done", title, text, who, at: ev.at });
    }
  }
  if (Array.isArray(pulls)) {
    for (const p of pulls) {
      const job = { status: p.draft ? "draft" : p.state, number: p.number, title: p.title, who: p.author, branch: p.branch, at: p.at, url: p.url };
      if (prNeedsSeth(p, dismissed)) needs.unshift({ ...job, text: "Waiting for review / merge" });
      else if (p.state === "merged" && within(p.at, 48 * 3600000)) done.push(job);
    }
  } else {
    for (const c of commits || []) {
      const m = /^Merge pull request #(\d+) from [^/]+\/(\S+)/.exec(c.message || "");
      if (m && within(c.at, 48 * 3600000)) {
        const human = m[2].replace(/^[a-z]+\//, "").replace(/-\d{8}.*$/, "").replace(/[-_]+/g, " ");
        const title = String(c.message).split("\n").slice(1).join(" ").trim() || human;
        done.push({ status: "merged", number: Number(m[1]), title, who: c.author, branch: m[2], at: c.at, url: c.url });
      }
    }
  }
  for (const a of agents || []) {
    if (a.status === "active" && a.ev) {
      running.push({ status: "running", title: a.name, text: a.ev.text, who: a.role, at: a.ev.at });
    }
  }
  state.jobIndex = {};
  [...needs, ...running, ...done].forEach((j, i) => {
    j.key = j.number ? `pr-${j.number}` : `ev-${j.who}-${String(j.at)}`;
    state.jobIndex[j.key] = j;
  });
  const snoozed = loadSnoozes();
  const visibleNeeds = needs.filter((j) => !snoozed[j.key] || snoozed[j.key] < Date.now());
  const snoozedCount = needs.length - visibleNeeds.length;
  needs.length = 0;
  needs.push(...visibleNeeds);
  done.sort((x, y) => String(y.at).localeCompare(String(x.at)));
  const tabs = [
    ["needs", "Needs you", needs],
    ["running", "Running", running],
    ["done", "Done", done.slice(0, 10)],
  ];
  const empty = {
    needs: cloud ? "Nothing waiting on you." : "Connect the cloud hub to see jobs.",
    running: "No agent has logged work in the last 2 hours.",
    done: "Nothing finished in the last day.",
  };
  const first = needs.length ? "needs" : running.length ? "running" : "done";
  state.lastJobs = { needs, running, done };
  return { needs: needs.length, needsList: needs, doneList: done, html: `
    <div class="seg" role="tablist">
      ${tabs
        .map(
          ([id, label, list]) =>
            `<button type="button" role="tab" data-seg="${id}" class="${id === first ? "active" : ""}${
              id === "needs" && list.length ? " alert" : ""
            }" aria-selected="${id === first}">${label}<span class="seg-n">${list.length}</span></button>`
        )
        .join("")}
    </div>
    ${tabs
      .map(
        ([id, , list]) =>
          `<div class="job-list" data-seg-panel="${id}" ${id === first ? "" : "hidden"}>${
            list.length ? list.map(jobCard).join("") : `<p class="home-empty">${empty[id]}</p>`
          }${
            id === "needs" && snoozedCount
              ? `<button type="button" class="link-btn" data-unsnooze="1">Show ${snoozedCount} snoozed</button>`
              : ""
          }</div>`
      )
      .join("")}` };
}

document.getElementById("home-body")?.addEventListener("click", (e) => {
  const tab = e.target.closest(".seg button[data-seg]");
  if (!tab) return;
  const host = tab.closest(".cc-panel");
  host.querySelectorAll(".seg button").forEach((b) => {
    const on = b === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  host.querySelectorAll("[data-seg-panel]").forEach((p) => {
    p.hidden = p.dataset.segPanel !== tab.dataset.seg;
  });
});


/* ---- v24 push: iPhone needs the Home Screen app (iOS 16.4+) ---- */
const VAPID_PUBLIC = "BJtKWO5AwD7ajbBhvCNptJNqetUfHH8nYE9OYng23t9hZIQivN447khfM9ebqLiFHGN9DxTqovvmkYtUXMFGs3s";
function b64urlToBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
function pushState() {
  if (!pushSupported()) {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    return ios && !isStandalone() ? "needs-install" : "unsupported";
  }
  return Notification.permission; // default | granted | denied
}
async function enablePush() {
  const st = pushState();
  if (st === "needs-install") throw new Error("On iPhone, first Share → Add to Home Screen, open The Stack from the icon, then tap this again.");
  if (st === "unsupported") throw new Error("This browser can't do push notifications.");
  if (st === "denied") throw new Error("Notifications are blocked. Turn them on in Settings → Notifications → The Stack.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications not allowed.");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(VAPID_PUBLIC) });
  }
  await ghSavePushSubscription(sub, currentViewer());
  try {
    localStorage.setItem("stack-push-on", "1");
  } catch {
    /* ignore */
  }
  toast("Alerts on — you'll get a ping when an agent needs you");
  loadHome().catch(() => {});
}
function pushPromptHtml() {
  const st = pushState();
  let on = false;
  try {
    on = localStorage.getItem("stack-push-on") === "1";
  } catch {
    on = false;
  }
  if (st === "granted" && on) return "";
  if (st === "unsupported" || st === "denied") return "";
  const copy =
    st === "needs-install"
      ? "Add The Stack to your Home Screen to get alerts when an agent is blocked or mentions you."
      : "Get a ping when an agent is blocked or @mentions you.";
  return `<section class="push-card">
    <span class="push-ico" aria-hidden="true">🔔</span>
    <p>${copy}</p>
    ${st === "needs-install" ? "" : `<button type="button" class="act act-primary" data-push-enable="1">Turn on</button>`}
  </section>`;
}

/* ---- v24: snooze, job actions, hosts, digest, photos ---- */
const SNOOZE_KEY = "stack-snooze-v1";
const LAST_SEEN_KEY = "stack-last-seen-v1";
function loadSnoozes() {
  try {
    return JSON.parse(localStorage.getItem(SNOOZE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
function saveSnoozes(map) {
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function jobActions(j) {
  if (j.status === "open" || j.status === "draft") {
    return `<div class="job-actions">
      <button type="button" class="act act-primary" data-act="merge" data-key="${esc(j.key)}"${j.status === "draft" ? " disabled" : ""}>Merge</button>
      <button type="button" class="act" data-act="snooze" data-key="${esc(j.key)}">Snooze</button>
    </div>`;
  }
  if (j.status === "blocked") {
    const resolveBtn =
      j.kind === "needs_seth" || j.kind === "handover"
        ? `<button type="button" class="act" data-act="resolve" data-key="${esc(j.key)}">Resolve</button>`
        : "";
    return `<div class="job-actions">
      <button type="button" class="act act-primary" data-act="approve" data-key="${esc(j.key)}">Approve</button>
      <button type="button" class="act" data-act="reply" data-key="${esc(j.key)}">Reply</button>
      ${resolveBtn}
      <button type="button" class="act" data-act="snooze" data-key="${esc(j.key)}">Snooze</button>
    </div>`;
  }
  return "";
}

function agentForJob(j) {
  const who = canonicalAgent(j.who) || j.who || "";
  // Cursor-Cloud has no DM of its own; route to Cursor.
  return who === "Cursor-Cloud" ? "Cursor" : who;
}

async function openAgentDm(agent, prefill) {
  let slug = dmSlugFor(agent);
  if (!slug) {
    const ch = await api("/api/dms", { method: "POST", body: JSON.stringify({ me: currentViewer(), member: agent }) });
    await loadChannels();
    slug = (ch && ch.slug) || dmSlugFor(agent);
  }
  if (!slug) throw new Error(`No DM with ${agent}`);
  state.channelSlug = slug;
  showView("channel");
  const box = document.getElementById("body");
  if (prefill && box) {
    box.value = prefill;
    autosize(box);
    setTimeout(() => box.focus(), 50);
  }
}

function toast(msg, kind = "") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.className = `toast show ${kind}`;
  el.textContent = msg;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2600);
}

function refreshJobsView() {
  return (state.view === "agents" ? loadAgentsView() : loadHome()).catch(() => {});
}
async function onJobsClick(e) {
  const go = e.target.closest("[data-goto-agents]");
  if (go && !e.target.closest("[data-stop-nav]")) {
    state.agentsSeg = go.dataset.gotoAgents || "";
    state.agentFilter = "";
    state.openTask = go.dataset.task || "";
    showView("agents");
    return;
  }

  const openUrl = e.target.closest("[data-open-url]");
  if (openUrl && !e.target.closest("[data-stop-nav]")) {
    e.preventDefault();
    const url = openUrl.dataset.openUrl;
    if (url) window.open(url, "_blank", "noopener");
    return;
  }

  const openHost = e.target.closest("[data-open-host]");
  if (openHost && !e.target.closest("[data-stop-nav]")) {
    e.preventDefault();
    openHostSheet(openHost.dataset.openHost);
    return;
  }

  const openAgent = e.target.closest("[data-open-agent]");
  if (openAgent && !e.target.closest("[data-stop-nav], .model-pick, select")) {
    e.preventDefault();
    openAgentDm(openAgent.dataset.openAgent).catch((err) => toast(friendlyError(err), "err"));
    return;
  }

  const openChannel = e.target.closest("[data-open-channel]");
  if (openChannel && !e.target.closest("[data-stop-nav]")) {
    state.channelSlug = openChannel.dataset.openChannel;
    state.threadParentId = null;
    document.getElementById("thread")?.classList.add("hidden");
    showView("channel");
    return;
  }

  const openList = e.target.closest("[data-open-list]");
  if (openList && !e.target.closest("[data-stop-nav], .tick")) {
    const id = openList.dataset.openList;
    if (id) {
      state.listId = id;
      document.getElementById("lists-pane")?.classList.add("open");
      loadLists().catch(() => {});
    }
    return;
  }

  const scrollTo = e.target.closest("[data-scroll-to]");
  if (scrollTo) {
    const el = document.getElementById(scrollTo.dataset.scrollTo);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  const homeTick = e.target.closest(".home-todo .tick[data-row]");
  if (homeTick) {
    homeTick.disabled = true;
    homeTick.closest(".home-todo")?.classList.add("ticked");
    try {
      await ghSetRowStatus(homeTick.dataset.list, homeTick.dataset.row, "done");
      toast("Ticked off");
      setTimeout(() => refreshJobsView(), 350);
    } catch (err) {
      homeTick.disabled = false;
      homeTick.closest(".home-todo")?.classList.remove("ticked");
      toast(friendlyError(err), "err");
    }
    return;
  }
  if (e.target.closest("[data-unsnooze]")) {
    saveSnoozes({});
    refreshJobsView();
    return;
  }
  if (e.target.closest("[data-digest-ok]")) {
    try {
      localStorage.setItem(LAST_SEEN_KEY, new Date().toISOString());
    } catch {
      /* ignore */
    }
    state.digestSince = new Date().toISOString();
    e.target.closest(".digest")?.remove();
    return;
  }
  if (e.target.closest("[data-push-enable]")) {
    enablePush().catch((err) => toast(friendlyError(err), "err"));
    return;
  }
  const btn = e.target.closest(".job-actions .act");
  if (!btn) return;
  const j = (state.jobIndex || {})[btn.dataset.key];
  if (!j) return;
  const act = btn.dataset.act;
  const card = btn.closest(".job-card, .task");
  if (act === "snooze") {
    const map = loadSnoozes();
    map[j.key] = Date.now() + 24 * 3600 * 1000;
    saveSnoozes(map);
    card?.classList.add("leaving");
    toast("Snoozed for 24 hours");
    setTimeout(() => refreshJobsView(), 250);
    return;
  }
  if (act === "reply") {
    openAgentDm(agentForJob(j), `Re: ${clip(j.title, 60)} — `).catch((err) => toast(friendlyError(err), "err"));
    return;
  }
  btn.disabled = true;
  try {
    if (act === "resolve") {
      try {
        if (typeof ghResolveNeedsSeth === "function" && (j.kind === "needs_seth" || String(j.key || "").startsWith("ho-"))) {
          await ghResolveNeedsSeth(j.key, { action: "resolved", by: currentViewer() });
        }
        await ghDismissJob(j.key, { action: "resolved", title: j.title, agent: agentForJob(j), by: currentViewer() });
      } catch (err) {
        toast(`Couldn't save resolve: ${friendlyError(err)}`, "err");
        btn.disabled = false;
        return;
      }
      toast("Resolved");
    } else if (act === "approve") {
      const agent = agentForJob(j);
      let slug = dmSlugFor(agent);
      if (!slug) {
        const ch = await api("/api/dms", { method: "POST", body: JSON.stringify({ me: currentViewer(), member: agent }) });
        slug = (ch && ch.slug) || "";
        await loadChannels();
      }
      await api(`/api/channels/${encodeURIComponent(slug)}/messages`, {
        method: "POST",
        body: JSON.stringify({ author: currentViewer(), body: `@${agent} ✅ Approved: ${clip(j.title, 80)} — go ahead.` }),
      });
      const map = loadSnoozes();
      map[j.key] = Date.now() + 7 * 24 * 3600 * 1000;
      saveSnoozes(map);
      try {
        await ghDismissJob(j.key, { action: "approved", title: j.title, agent, by: currentViewer() });
        if (typeof ghResolveNeedsSeth === "function" && (j.kind === "needs_seth" || String(j.key || "").startsWith("ho-"))) {
          await ghResolveNeedsSeth(j.key, { action: "approved", by: currentViewer() });
        }
      } catch (err) {
        // Message went through; only the cross-device record failed. Say so instead of failing silently.
        toast(`Approved, but couldn't save it for your other devices: ${friendlyError(err)}`, "err");
      }
      toast(`Approved — sent to ${agent}`);
    } else if (act === "merge") {
      if (!window.confirm(`Merge PR #${j.number} into main?\n\n${j.title}`)) {
        btn.disabled = false;
        return;
      }
      await ghMergePull(j.number, j.title);
      toast(`PR #${j.number} merged`);
    }
    card?.classList.add("leaving");
    setTimeout(() => refreshJobsView(), 300);
  } catch (err) {
    btn.disabled = false;
    const status = err && err.status;
    if (act === "merge" && (status === 403 || status === 404)) {
      toast("Your token can't merge. Give it Pull requests: Read and write.", "err");
    } else if (act === "merge" && status === 405) {
      toast(`Can't merge yet: ${friendlyError(err)}`, "err");
    } else {
      toast(friendlyError(err), "err");
    }
  }
}
document.getElementById("home-body")?.addEventListener("click", onJobsClick);
document.getElementById("agents-body")?.addEventListener("click", onJobsClick);

/* ---- v28 Agents screen: Linear-style triage + Codex-style task list ---- */
state.agentFilter = "";
state.agentsSeg = "";
state.openTask = "";
function dayBucket(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Earlier";
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (d >= start) return "Today";
  if (d >= new Date(start.getTime() - 86400000)) return "Yesterday";
  return "Earlier";
}
const STATUS_ICON = {
  blocked: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.6v4.2M8 10.9v.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  open: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.6 2"/></svg>`,
  draft: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.6 2"/></svg>`,
  running: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 1.5a6.5 6.5 0 0 1 0 13z" fill="currentColor"/></svg>`,
  done: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="currentColor"/><path d="M4.8 8.2l2.1 2.1 4.3-4.5" fill="none" stroke="var(--bg)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  merged: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="currentColor"/><path d="M4.8 8.2l2.1 2.1 4.3-4.5" fill="none" stroke="var(--bg)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  closed: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
};

function taskRow(j) {
  const open = state.openTask === j.key;
  const who = canonicalAgent(j.who) || j.who || "";
  const meta = [who, j.number ? `PR #${j.number}` : "", j.branch ? clip(j.branch, 28) : ""].filter(Boolean);
  return `<article class="task st-${esc(j.status)}${open ? " open" : ""}" data-task="${esc(j.key)}">
    <button type="button" class="task-head" data-toggle-task="${esc(j.key)}" aria-expanded="${open}">
      <span class="task-ico">${STATUS_ICON[j.status] || STATUS_ICON.open}</span>
      <span class="task-main">
        <span class="task-title">${esc(clip(j.title, 90))}</span>
        <span class="task-meta">${meta.map(esc).join(" · ")}</span>
      </span>
      <time class="task-time" title="${esc(fmtTimeFull(j.at))}">${esc(fmtTime(j.at))}</time>
    </button>
    ${
      open
        ? `<div class="task-detail">
            ${j.text ? `<p>${esc(j.text)}</p>` : ""}
            <div class="job-card task-actions-host">${jobActions(j)}</div>
            ${j.url ? `<a class="task-link" href="${esc(j.url)}" target="_blank" rel="noopener">${j.number ? "View PR" : "Open"} ↗</a>` : ""}
          </div>`
        : ""
    }
  </article>`;
}

function paintAgentsView() {
  const body = document.getElementById("agents-body");
  const cc = state.agentsCC;
  if (!body || !cc) return;
  const jobs = state.lastJobs || { needs: [], running: [], done: [] };
  const f = state.agentFilter;
  const match = (j) => !f || (canonicalAgent(j.who) || j.who) === f || (j.title === f && j.status === "running");
  const lists = {
    needs: jobs.needs.filter(match),
    running: jobs.running.filter((j) => !f || j.title === f),
    done: jobs.done.filter(match),
  };
  if (!state.agentsSeg) state.agentsSeg = lists.needs.length ? "needs" : lists.running.length ? "running" : "done";
  const seg = state.agentsSeg;
  const running = cc.agents.filter((a) => a.status === "active").length;
  document.getElementById("agents-headline").textContent = `${running} running · ${lists.needs.length} need you`;

  const strip = cc.agents
    .map((a) => {
      const model = (state.agentPrefs[a.name] || {}).model || "";
      const on = f === a.name;
      return `<button type="button" class="agent-pill st-${a.status}${on ? " on" : ""}" data-agent-filter="${esc(a.name)}" aria-pressed="${on}">
        <span class="agent-avatar sm" aria-hidden="true">${initialOf(a.name)}<i class="sdot"></i></span>
        <span class="ap-text"><strong>${esc(a.name)}</strong><span>${esc(model || a.statusLabel)}</span></span>
      </button>`;
    })
    .join("");

  const rows = lists[seg];
  // Codex-style day groups.
  const groups = {};
  for (const j of rows) (groups[dayBucket(j.at)] = groups[dayBucket(j.at)] || []).push(j);
  const order = ["Today", "Yesterday", "Earlier"].filter((g) => groups[g]);
  const empty = {
    needs: "Nothing waiting on you.",
    running: f ? `${f} hasn't logged work in the last 2 hours.` : "No agent has logged work in the last 2 hours.",
    done: "Nothing finished in the last day.",
  }[seg];
  const openHandovers = (state.handovers || []).filter(
    (h) => h && !["COMPLETED", "CANCELLED"].includes(String(h.status || ""))
  );
  const handoverHtml = openHandovers.length
    ? `<section class="handover-panel"><h3 class="task-day">Handovers</h3>${openHandovers
        .slice(0, 12)
        .map((h) => {
          const st = esc(h.status || "?");
          const ack = esc(h.ack_status || "pending");
          return `<article class="task st-${h.status === "FAILED_DISPATCH" || h.status === "BLOCKED" || h.status === "ESCALATED" ? "blocked" : "open"}">
            <div class="task-head">
              <span class="task-ico">${STATUS_ICON.blocked}</span>
              <span class="task-main">
                <span class="task-title">${esc(clip(h.description || h.id, 90))}</span>
                <span class="task-meta">${esc(h.from_agent || "?")} → ${esc(h.to_agent || "?")} · ${st} · ack ${ack}${
                  h.task_id ? ` · ${esc(h.task_id)}` : ""
                }</span>
              </span>
              <time class="task-time">${esc(fmtTime(h.created_at))}</time>
            </div>
          </article>`;
        })
        .join("")}</section>`
    : `<section class="handover-panel"><h3 class="task-day">Handovers</h3><p class="home-empty">No open handovers. Dispatches without acknowledgement never count as done.</p></section>`;
  const agentsHtml = `
    <div class="agents-controls">
    <div class="agent-strip">${strip}</div>
    <div class="seg linear-seg" role="tablist">
      ${[
        ["needs", "Needs you"],
        ["running", "Running"],
        ["done", "Done"],
      ]
        .map(
          ([id, label]) =>
            `<button type="button" role="tab" data-agents-seg="${id}" class="${id === seg ? "active" : ""}${
              id === "needs" && lists.needs.length ? " alert" : ""
            }" aria-selected="${id === seg}">${label}<span class="seg-n">${lists[id].length}</span></button>`
        )
        .join("")}
    </div>
    ${f ? `<button type="button" class="link-btn clear-filter" data-agent-filter="">Showing ${esc(f)} only · Show all</button>` : ""}
    </div>
    ${handoverHtml}
    <div class="task-list">
      ${
        order.length
          ? order.map((g) => `<h3 class="task-day">${g}</h3>${groups[g].map(taskRow).join("")}`).join("")
          : `<p class="home-empty">${esc(empty)}</p>`
      }
    </div>`;
  if (body.dataset.sig === agentsHtml) return;
  const sc = body.scrollTop;
  body.dataset.sig = agentsHtml;
  body.innerHTML = agentsHtml;
  body.scrollTop = sc;
}

async function loadAgentsView() {
  const body = document.getElementById("agents-body");
  if (body && !state.agentsCC) body.innerHTML = `<p class="home-empty">Loading agents…</p>`;
  state.agentsCC = await loadCommandCentre();
  paintAgentsView();
}

document.getElementById("agents-body")?.addEventListener("click", (e) => {
  const fb = e.target.closest("[data-agent-filter]");
  if (fb) {
    state.agentFilter = state.agentFilter === fb.dataset.agentFilter ? "" : fb.dataset.agentFilter;
    state.agentsSeg = "";
    state.openTask = "";
    paintAgentsView();
    return;
  }
  const sb = e.target.closest("[data-agents-seg]");
  if (sb) {
    state.agentsSeg = sb.dataset.agentsSeg;
    state.openTask = "";
    paintAgentsView();
    return;
  }
  const tb = e.target.closest("[data-toggle-task]");
  if (tb) {
    state.openTask = state.openTask === tb.dataset.toggleTask ? "" : tb.dataset.toggleTask;
    paintAgentsView();
  }
});
document.getElementById("agents-refresh")?.addEventListener("click", () => loadAgentsView().catch(() => {}));

/* ---- v30 Notes tab: personal notes, saved from messages or typed ---- */
const NOTES_LOCAL_KEY = "stack-notes-local-v1";
function notesCloud() {
  return state.cloudMode && typeof ghLoadNotes === "function" && ghState && ghState.token;
}
async function readNotes() {
  if (notesCloud()) return ghLoadNotes();
  try {
    return JSON.parse(localStorage.getItem(NOTES_LOCAL_KEY) || "[]");
  } catch {
    return [];
  }
}
async function writeNotes(mutate, message) {
  if (notesCloud()) {
    await ghSaveNotes(mutate, message);
    return;
  }
  const next = mutate(await readNotes());
  localStorage.setItem(NOTES_LOCAL_KEY, JSON.stringify(next));
}
function noteId() {
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
async function saveMessageToNotes(id, btn) {
  const m = (state.lastMessages || []).find((x) => x.id === id);
  if (!m) return;
  const ch = state.lastChannel || {};
  const where = ch.kind === "dm" ? `DM with ${dmLabel(ch, currentViewer())}` : `#${ch.slug || state.channelSlug}`;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }
  try {
    await writeNotes(
      (list) => [
        {
          id: noteId(),
          text: "",
          quote: String(m.body || (m.attachments ? "📷 Photo" : "")).slice(0, 4000),
          source: { channel: ch.slug || state.channelSlug, where, author: m.author, message_id: m.id, at: m.created_at },
          pinned: false,
          created_at: new Date().toISOString(),
        },
        ...list,
      ],
      `stack: note saved from ${ch.slug || state.channelSlug}`
    );
    if (btn) btn.textContent = "★ Saved";
    toast("Saved to Notes");
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "☆ Save";
    }
    toast(friendlyError(err), "err");
  }
}
function noteCard(n) {
  const src = n.source;
  return `<article class="note${n.pinned ? " pinned" : ""}" data-note="${esc(n.id)}">
    ${n.text ? `<p class="note-text">${formatBodyHtml(n.text)}</p>` : ""}
    ${n.quote ? `<blockquote class="note-quote">${formatBodyHtml(n.quote)}</blockquote>` : ""}
    <div class="note-foot">
      ${
        src
          ? `<button type="button" class="note-src" data-open-chat="${esc(src.channel)}">${esc(src.author || "")} · ${esc(src.where || "")} · ${esc(fmtTime(src.at))}</button>`
          : `<span class="note-src plain">${esc(fmtTime(n.created_at))}</span>`
      }
      <span class="note-actions">
        <button type="button" data-note-pin="${esc(n.id)}" aria-label="${n.pinned ? "Unpin" : "Pin"}">${n.pinned ? "📌" : "Pin"}</button>
        <button type="button" data-note-copy="${esc(n.id)}" aria-label="Copy">Copy</button>
        <button type="button" data-note-del="${esc(n.id)}" aria-label="Delete">Delete</button>
      </span>
    </div>
  </article>`;
}
function paintNotes() {
  const list = document.getElementById("notes-list");
  if (!list) return;
  const q = (document.getElementById("note-search")?.value || "").trim().toLowerCase();
  const notes = (state.notes || [])
    .filter((n) => !q || [n.text, n.quote, n.source && n.source.author, n.source && n.source.where].some((v) => String(v || "").toLowerCase().includes(q)))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || String(b.created_at).localeCompare(String(a.created_at)));
  document.getElementById("notes-headline").textContent = `${(state.notes || []).length} note${(state.notes || []).length === 1 ? "" : "s"}${
    notesCloud() ? " · synced to your vault" : " · on this device"
  }`;
  const html = notes.length
    ? notes.map(noteCard).join("")
    : `<p class="home-empty">${q ? "No notes match." : "No notes yet. Write one above, or tap any message in Chats → ☆ Save."}</p>`;
  if (list.dataset.sig === html) return;
  list.dataset.sig = html;
  list.innerHTML = html;
}
async function loadNotes() {
  state.notes = await readNotes();
  paintNotes();
}
document.getElementById("note-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const ta = document.getElementById("note-text");
  const text = ta.value.trim();
  if (!text) return;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  const draft = { id: noteId(), text, quote: "", source: null, pinned: false, created_at: new Date().toISOString() };
  state.notes = [draft, ...(state.notes || [])];
  ta.value = "";
  paintNotes();
  try {
    await writeNotes((list) => [draft, ...list.filter((n) => n.id !== draft.id)], "stack: note added");
    toast("Note saved");
  } catch (err) {
    toast(friendlyError(err), "err");
    ta.value = text;
    state.notes = state.notes.filter((n) => n.id !== draft.id);
    paintNotes();
  } finally {
    btn.disabled = false;
  }
});
document.getElementById("note-search")?.addEventListener("input", () => paintNotes());
document.getElementById("notes-list")?.addEventListener("click", async (e) => {
  const open = e.target.closest("[data-open-chat]");
  if (open) {
    state.channelSlug = open.dataset.openChat;
    showView("channel");
    return;
  }
  const copy = e.target.closest("[data-note-copy]");
  if (copy) {
    const n = (state.notes || []).find((x) => x.id === copy.dataset.noteCopy);
    try {
      await navigator.clipboard.writeText([n.text, n.quote].filter(Boolean).join("\n\n"));
      toast("Copied");
    } catch {
      toast("Couldn't copy on this browser", "err");
    }
    return;
  }
  const pin = e.target.closest("[data-note-pin]");
  const del = e.target.closest("[data-note-del]");
  if (!pin && !del) return;
  const id = (pin || del).dataset.notePin || (pin || del).dataset.noteDel;
  if (del && !window.confirm("Delete this note?")) return;
  const before = state.notes;
  state.notes = del
    ? state.notes.filter((n) => n.id !== id)
    : state.notes.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n));
  paintNotes();
  try {
    await writeNotes(
      (list) => (del ? list.filter((n) => n.id !== id) : list.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n))),
      del ? "stack: note deleted" : "stack: note pinned"
    );
  } catch (err) {
    state.notes = before;
    paintNotes();
    toast(friendlyError(err), "err");
  }
});

/* Hosts: heartbeat branch first, shared memory as fallback.
 * v31.8: tap a computer → detail sheet (install cmd, Tailscale, mentions, refresh). */
const HOSTS = [
  {
    id: "mac",
    name: "Mac",
    role: "MacBook Pro (live build host)",
    ids: ["mac", "macbook", "seths-macbook"],
    match: /\bMacBook\b|\bMac (asleep|sleep|awake|wake|offline|online|not listed|DC|host)\b|\bwake Mac\b/i,
    install: "bash Projects/The-Stack/heartbeat/install-mac.sh",
    runs: "Cursor · Gemini (Antigravity) · Obsidian vault",
    agents: ["Cursor", "Gemini"],
  },
  {
    id: "windows",
    name: "Windows PC",
    role: "Parked (Hermes wiped 19 Nov)",
    ids: ["desktop-kg22uf0", "windows", "win"],
    match: /DESKTOP-KG22UF0|\bWindows (PC|host|DC|box|machine)\b/i,
    install: "powershell -ExecutionPolicy Bypass -File Projects\\The-Stack\\heartbeat\\install-windows.ps1",
    runs: "Parked — Hermes runtime offline until rebuilt",
    agents: [],
  },
];
function hostClause(ev, re) {
  // Pull just the fragment about this PC out of a longer shared-memory line.
  const parts = String(ev.text || "").split(/[;.]\s+|\s—\s/);
  const hit = parts.find((p) => re.test(p)) || ev.text || "";
  const who = canonicalAgent(ev.agent) || ev.agent || "";
  return `${who ? who + ": " : ""}${clip(hit, 90)}`;
}
function hostMentions(events, re, limit = 3) {
  return [...(events || [])]
    .filter((x) => re.test(x.text || ""))
    .sort((x, y) => String(y.at).localeCompare(String(x.at)))
    .slice(0, limit)
    .map((ev) => ({
      at: ev.at || "",
      agent: canonicalAgent(ev.agent) || ev.agent || "",
      text: hostClause(ev, re),
    }));
}
function buildHosts(heartbeats, events, cloud) {
  const now = Date.now();
  const rows = HOSTS.map((h) => {
    const hb = (heartbeats || []).find((b) =>
      h.ids.some((id) => String(b.host || b.file || "").toLowerCase().replace(/\.json$/, "").includes(id))
    );
    const mentions = hostMentions(events, h.match);
    if (hb && hb.at) {
      const age = now - new Date(hb.at).getTime();
      const key = age < 15 * 60000 ? "online" : age < 2 * 3600000 ? "stale" : "offline";
      const label = { online: "Online", stale: "Quiet", offline: "Offline" }[key];
      const bits = [hb.tailscale ? `Tailscale ${hb.tailscale}` : "", hb.uptime ? `up ${hb.uptime}` : "", hb.battery || ""].filter(Boolean).join(" · ");
      return {
        ...h,
        key,
        label,
        at: hb.at,
        detail: bits || "Heartbeat received",
        source: "heartbeat",
        tailscale: hb.tailscale || "",
        uptime: hb.uptime || "",
        battery: hb.battery || "",
        os: hb.os || "",
        hostName: hb.host || "",
        mentions,
      };
    }
    const ev = mentions[0];
    return {
      ...h,
      key: "unknown",
      label: "No heartbeat",
      at: ev ? ev.at : "",
      detail: ev ? ev.text : "Nothing reported yet.",
      source: "memory",
      tailscale: "",
      uptime: "",
      battery: "",
      os: "",
      hostName: "",
      mentions,
    };
  });
  state.hostCards = Object.fromEntries(rows.map((h) => [h.id, h]));
  const presence = {};
  for (const h of rows) {
    if (h.key !== "online" || !h.at) continue;
    for (const agent of h.agents || []) presence[agent] = h.at;
  }
  state.hostPresenceByAgent = presence;
  return `<div class="host-row">${rows
    .map(
      (h) => `
    <button type="button" class="host host-${h.key} home-tap" data-open-host="${esc(h.id)}" aria-label="${esc(h.name)} · ${esc(h.label)}. Open details.">
      <div class="host-top">
        <span class="host-ico" aria-hidden="true">${h.name === "Mac" ? "⌘" : "⊞"}</span>
        <div class="host-id"><strong>${esc(h.name)}</strong><span>${esc(h.role)}</span></div>
        <span class="aw-pill"><span class="dot"></span>${esc(h.label)}</span>
      </div>
      <p class="host-detail">${esc(h.detail)}</p>
      ${h.at ? `<time title="${esc(fmtTimeFull(h.at))}">${h.source === "heartbeat" ? "Heartbeat" : "Seen"} ${esc(fmtTime(h.at))}</time>` : ""}
    </button>`
    )
    .join("")}</div>${
    cloud && !(heartbeats || []).length
      ? `<p class="home-empty small">Heartbeats start once each PC runs <code>Projects/The-Stack/heartbeat</code> (handed to Cursor).</p>`
      : ""
  }`;
}

async function copyText(text, okMsg) {
  const value = String(text || "");
  if (!value) {
    toast("Nothing to copy", "err");
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast(okMsg || "Copied");
    return true;
  } catch {
    toast("Could not copy on this phone", "err");
    return false;
  }
}

function closeHostSheet() {
  state.openHostId = null;
  const sheet = document.getElementById("host-sheet");
  if (!sheet) return;
  sheet.hidden = true;
  sheet.classList.remove("open");
  document.getElementById("shell")?.classList.remove("host-sheet-open");
}

function openHostSheet(id) {
  const host = state.hostCards?.[id];
  const sheet = document.getElementById("host-sheet");
  if (!host || !sheet) return;
  state.openHostId = id;
  document.getElementById("host-sheet-title").textContent = host.name;
  document.getElementById("host-sheet-sub").textContent = host.role;
  const pill = document.getElementById("host-sheet-pill");
  pill.className = `aw-pill host-${host.key}`;
  pill.innerHTML = `<span class="dot"></span>${esc(host.label)}`;

  const facts = [
    host.hostName ? ["Host", host.hostName] : null,
    host.os ? ["OS", host.os] : null,
    host.at ? ["Last beat", fmtTimeFull(host.at)] : null,
    host.uptime ? ["Uptime", host.uptime] : null,
    host.battery ? ["Battery", host.battery] : null,
    host.tailscale ? ["Tailscale", host.tailscale] : null,
    ["Source", host.source === "heartbeat" ? "Heartbeat branch" : "Shared memory fallback"],
    host.runs ? ["Usually runs", host.runs] : null,
  ].filter(Boolean);

  const mentions = (host.mentions || [])
    .map(
      (m) => `<li>
        <strong>${esc(m.agent || "agent")}</strong>
        <span>${esc(m.text)}</span>
        ${m.at ? `<time>${esc(fmtTime(m.at))}</time>` : ""}
      </li>`
    )
    .join("");

  document.getElementById("host-sheet-body").innerHTML = `
    <p class="host-sheet-lead">${esc(host.detail)}</p>
    <dl class="host-facts">${facts
      .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
      .join("")}</dl>
    ${
      mentions
        ? `<div class="host-mentions"><h3>Recent mentions</h3><ul>${mentions}</ul></div>`
        : `<p class="home-empty small">No recent shared-memory lines about this PC.</p>`
    }
  `;

  const needsInstall = host.key === "unknown" || host.key === "offline";
  const chatBtns = (host.agents || [])
    .map((name) => `<button type="button" class="act" data-host-act="chat" data-agent="${esc(name)}">Chat with ${esc(name)}</button>`)
    .join("");
  document.getElementById("host-sheet-actions").innerHTML = `
    ${chatBtns}
    <button type="button" class="act act-primary" data-host-act="copy-install">${needsInstall ? "Copy install command" : "Copy heartbeat install"}</button>
    ${host.tailscale ? `<button type="button" class="act" data-host-act="copy-tailscale">Copy Tailscale IP</button>` : ""}
    <button type="button" class="act" data-host-act="refresh">Refresh status</button>
    <button type="button" class="act ghost" data-host-act="close">Close</button>
  `;

  sheet.hidden = false;
  sheet.classList.add("open");
  document.getElementById("shell")?.classList.add("host-sheet-open");
}


/* Digest v30: what changed since Seth last tapped "Got it", with a per-agent breakdown. */
function buildDigest({ events, pulls, commits, needs, done }) {
  let since = state.digestSince;
  if (!since) {
    try {
      since = localStorage.getItem(LAST_SEEN_KEY) || "";
    } catch {
      since = "";
    }
    if (!since) since = new Date(Date.now() - 24 * 3600000).toISOString();
    state.digestSince = since;
  }
  const sinceT = new Date(since).getTime();
  const after = (iso) => iso && new Date(iso).getTime() > sinceT;
  const newEvents = (events || []).filter((e) => after(e.at));
  const finished = (done || []).filter((j) => after(j.at));
  const repo = state.cloudMode && typeof ghState !== "undefined" ? ghState.repo : "";
  const merged = Array.isArray(pulls)
    ? pulls
        .filter((p) => p.state === "merged" && after(p.at))
        .map((p) => ({
          n: p.number,
          title: p.title,
          at: p.at,
          url: p.url || (repo ? `https://github.com/${repo}/pull/${p.number}` : ""),
        }))
    : (commits || [])
        .map((c) => ({ c, m: /^Merge pull request #(\d+) from [^/]+\/(?:[a-z]+\/)?(.+?)(?:-\d{8}.*)?$/i.exec(String(c.message).split("\n")[0]) }))
        .filter(({ c, m }) => m && after(c.at))
        .map(({ c, m }) => ({
          n: Number(m[1]),
          title: String(c.message).split("\n").slice(1).join(" ").trim() || m[2].replace(/[-_]+/g, " "),
          at: c.at,
          url: c.url || (repo ? `https://github.com/${repo}/pull/${m[1]}` : ""),
        }));
  const blocked = needs || [];
  if (!newEvents.length && !merged.length && !blocked.length) return "";
  // Per agent: count + latest headline.
  const byAgent = {};
  for (const e of newEvents) {
    const who = canonicalAgent(e.agent) || e.agent || "Agent";
    const row = (byAgent[who] = byAgent[who] || { n: 0, results: 0, latest: null });
    row.n += 1;
    if (e.kind === "result") row.results += 1;
    if (!row.latest || String(e.at) > String(row.latest.at)) row.latest = e;
  }
  const agentRows = Object.entries(byAgent)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([who, r]) => {
      const head = String(r.latest.id || "").replace(/-\d{8}$/, "").replace(/[-_]+/g, " ");
      return `<li><button type="button" class="dg-row home-tap" data-open-agent="${esc(who)}"><span class="dg-av" aria-hidden="true">${initialOf(who)}</span><span class="dg-main"><strong>${esc(who)}</strong> · ${r.n} update${
        r.n === 1 ? "" : "s"
      }${r.results ? `, ${r.results} finished` : ""}<span class="dg-sub">Latest: ${esc(clip(head || r.latest.text, 60))} · ${esc(fmtTime(r.latest.at))}</span></span></button></li>`;
    })
    .join("");
  const parts = [];
  if (finished.length) parts.push(`<strong>${finished.length}</strong> finished`);
  if (merged.length) parts.push(`<strong>${merged.length}</strong> PR${merged.length > 1 ? "s" : ""} merged`);
  if (blocked.length) parts.push(`<strong class="warn">${blocked.length}</strong> need${blocked.length > 1 ? "" : "s"} you`);
  const agentsActive = Object.keys(byAgent).length;
  const lead = `${parts.length ? parts.join(" · ") + ". " : ""}${agentsActive ? `${agentsActive} agent${agentsActive === 1 ? "" : "s"} logged ${newEvents.length} update${newEvents.length === 1 ? "" : "s"}.` : ""}`;
  const mergedHtml = merged.length
    ? `<h4>Merged</h4><ul class="dg-list">${merged
        .slice(0, 5)
        .map((m) =>
          m.url
            ? `<li><a class="dg-row home-tap" href="${esc(m.url)}" target="_blank" rel="noopener"><span class="task-ico st-merged">${STATUS_ICON.merged}</span><span class="dg-main">PR #${m.n} · ${esc(clip(m.title, 60))}<span class="dg-sub">${esc(fmtTime(m.at))} · GitHub ↗</span></span></a></li>`
            : `<li><span class="dg-row"><span class="task-ico st-merged">${STATUS_ICON.merged}</span><span class="dg-main">PR #${m.n} · ${esc(clip(m.title, 60))}<span class="dg-sub">${esc(fmtTime(m.at))}</span></span></span></li>`
        )
        .join("")}</ul>`
    : "";
  const needsHtml = blocked.length
    ? `<h4>Needs you</h4><ul class="dg-list">${blocked
        .slice(0, 4)
        .map((j) => `<li><button type="button" class="dg-row home-tap" data-scroll-to="cc-needs"><span class="task-ico st-blocked">${STATUS_ICON.blocked}</span><span class="dg-main">${esc(clip(j.title, 60))}<span class="dg-sub">${esc(canonicalAgent(j.who) || j.who || "")} · ${esc(fmtTime(j.at))}</span></span></button></li>`)
        .join("")}</ul>`
    : "";
  return `<section class="digest" aria-label="Since you last looked">
    <div class="digest-head"><strong>Since you last looked</strong><span>${esc(fmtTime(since))}</span></div>
    <p>${lead}</p>
    ${agentRows ? `<ul class="dg-list dg-agents">${agentRows}</ul>` : ""}
    ${mergedHtml || needsHtml ? `<details class="dg-more"><summary>More detail</summary>${needsHtml}${mergedHtml}</details>` : ""}
    <div class="digest-actions">
      ${blocked.length ? `<button type="button" class="act act-primary" data-goto-agents="needs">See what needs you</button>` : ""}
      <button type="button" class="act" data-digest-ok="1">Got it</button>
    </div>
  </section>`;
}

document.getElementById("home-body")?.addEventListener("change", async (e) => {
  const sel = e.target.closest(".model-pick select");
  if (!sel) return;
  const agent = sel.dataset.agent;
  let model = sel.value;
  if (model === "__custom") {
    model = (window.prompt(`Preferred model for ${agent}:`, "") || "").trim();
    if (!model) {
      sel.value = (state.agentPrefs[agent] || {}).model || "";
      return;
    }
  }
  if (!model) return;
  const card = sel.closest(".agent-window");
  card?.classList.add("saving");
  try {
    await ghSaveAgentModel(agent, model, currentViewer());
    state.agentPrefs[agent] = { model };
    card?.classList.remove("saving");
    card?.classList.add("saved");
    setTimeout(() => card?.classList.remove("saved"), 1600);
    if (model && ![...sel.options].some((o) => o.value === model || o.text === model)) {
      sel.insertAdjacentHTML("beforeend", `<option selected>${esc(model)}</option>`);
    }
  } catch (err) {
    card?.classList.remove("saving");
    window.alert(`Couldn’t save model: ${friendlyError(err)}`);
    sel.value = (state.agentPrefs[agent] || {}).model || "";
  }
});

async function loadHome() {
  let data;
  try {
    if (typeof ghLoadCreds === "function") ghLoadCreds();
    data = await api(`/api/home?viewer=${encodeURIComponent(currentViewer())}`);
    await pocketSet("home", data);
    state.pocketMode = false;
  } catch (err) {
    data = await pocketGet("home");
    if (!data) throw err;
    state.pocketMode = true;
  }
  const channelCount =
    (Array.isArray(data.channels) ? data.channels.length : 0) ||
    data.summary?.channels ||
    0;
  const dmCount =
    (Array.isArray(data.channels)
      ? data.channels.filter((c) => c.kind === "dm").length
      : 0) ||
    data.summary?.dms ||
    0;
  // v33.3: this used to show dmCount as "agents" — the number of 1:1 DM channels that happen to
  // exist, not the number of actual agents (Workhorse had none, so it silently undercounted).
  // Use the real roster so this always matches what the Agents tab shows.
  const agentCount = liveAgentRoster().length;
  const branchLabel =
    state.cloudMode && typeof ghState !== "undefined"
      ? `${ghState.repo}@${ghState.branch}`
      : state.hostLabel;
  document.getElementById("home-headline").textContent = state.cloudMode
    ? `Live · ${channelCount - dmCount} channels · ${agentCount} agents`
    : data.summary?.headline || "Agent hub";
  const body = document.getElementById("home-body");
  const todos = data.todos || [];
  const reports = data.reports || [];
  const mentions = data.mentions || [];
  const emptyHub =
    state.cloudMode && !channelCount && !dmCount && !mentions.length && !reports.length;
  // Stale empty pocket/home after hub landed on main — kick back to connect.
  if (emptyHub && !state._emptyKick) {
    state._emptyKick = true;
    try {
      await pocketSet("home", null);
      await pocketSet("channels", null);
    } catch {
      /* ignore */
    }
    document.getElementById("shell").classList.add("hidden");
    document.getElementById("boot").classList.remove("hidden");
    showCloudConnect(
      "Hub looked empty (old phone cache). Branch should be main — tap Open cloud hub again."
    );
    const form = document.getElementById("cloud-connect");
    if (form) {
      form.classList.remove("hidden");
      const branch = form.querySelector('[name="branch"]');
      if (branch) branch.value = "main";
    }
    return;
  }
  const emptyBanner = emptyHub
    ? `<section class="home-section home-fix">
        <h2>Hub empty</h2>
        <p>Old phone cache, or wrong branch. Use <code>main</code> and reconnect.</p>
        <p class="owner">Now: <code>${esc(branchLabel)}</code></p>
        <button type="button" id="home-reconnect" class="primary-btn">Reconnect to main</button>
      </section>`
    : "";
  const todoHtml = todos.length
    ? todos
        .map(
          (t) => `
      <div class="home-todo home-tap" data-open-list="${esc(t.list_id || "")}" role="link" tabindex="0" aria-label="Open list for ${esc(t.item || "todo")}">
        <button type="button" class="tick" data-list="${esc(t.list_id || "")}" data-row="${esc(t.row_id || "")}" data-stop-nav="1" aria-label="Mark done: ${esc(t.item || "")}"></button>
        <div>
          <div>${esc(t.item || "(untitled)")}</div>
          <div class="owner">${esc(t.list || "")}${t.owner ? " · " + esc(t.owner) : ""}</div>
        </div>
        <button type="button" class="ghost home-open-list" data-list="${esc(t.list_id || "")}" data-stop-nav="1">List</button>
      </div>`
        )
        .join("")
    : `<p class="home-empty">No open todos — agents can add rows to Agent todos.</p>`;
  const mentionHtml = mentions.length
    ? `<div class="home-cards">${mentions
        .map(
          (r) => `
      <button type="button" class="home-card home-mention home-open-channel" data-slug="${esc(r.channel)}">
        <div class="meta">
          <strong>${esc(r.author)}</strong>
          <span class="ch">${esc(channelLabel(r.channel, r.kind))}</span>
          <time title="${esc(fmtTimeFull(r.created_at))}">${esc(fmtTime(r.created_at))}</time>
        </div>
        <div class="preview">${esc(r.preview || r.body || "")}</div>
      </button>`
        )
        .join("")}</div>`
    : `<p class="home-empty">No @${esc(currentViewer())} mentions yet. Agents can ping you with @${esc(currentViewer())}.</p>`;
  const reportHtml = reports.length
    ? `<div class="home-cards">${reports
        .map(
          (r) => `
      <button type="button" class="home-card home-open-channel" data-slug="${esc(r.channel)}">
        <div class="meta">
          <strong>${esc(r.author)}</strong>
          <span class="ch">${esc(channelLabel(r.channel, "channel"))}</span>
          <time title="${esc(fmtTimeFull(r.created_at))}">${esc(fmtTime(r.created_at))}</time>
        </div>
        <div class="preview">${esc(r.preview || r.body || "")}</div>
      </button>`
        )
        .join("")}</div>`
    : `<p class="home-empty">No reports yet. Agents post into #the-digest.</p>`;
  const cc = await loadCommandCentre();
  const running = cc.agents.filter((x) => x.status === "active").length;
  const needs = cc.needsList || [];
  // Stats stay on Home and scroll to the section. Full triage is still on Agents.
  const stats = [
    ["Needs you", needs.length, "cc-needs", needs.length ? "alert" : ""],
    ["Running now", running, "cc-roster", running ? "live" : ""],
    ["To-dos", todos.length, "cc-todos", ""],
  ]
    .map(
      ([k, v, dest, cls]) =>
        `<button type="button" class="stat ${cls} home-tap" data-scroll-to="${esc(dest)}"><strong>${v}</strong><span>${k}</span></button>`
    )
    .join("");
  const needsBlock = needs.length
    ? `<div class="job-list">${needs.map(jobCard).join("")}</div>`
    : `<p class="home-empty">${state.cloudMode ? "Nothing waiting on you." : "Connect the cloud hub to see jobs."}</p>`;
  const homeHtml = `
    ${emptyBanner}
    <label class="jump">
      <span class="jump-icon" aria-hidden="true">⌕</span>
      <input id="jump-input" type="search" placeholder="Search chats & messages" autocomplete="off" enterkeyhint="go" />
    </label>
    <div id="jump-results" class="jump-results" hidden></div>
    <form id="home-quick-dispatch" class="home-dispatch" aria-label="Quick command to #peer-floor">
      <div class="hd-row">
        <select id="hd-target" aria-label="Target agent">
          <option value="@ChatGPT @Cursor ">@All live</option>
          <option value="@ChatGPT ">@ChatGPT</option>
          <option value="@Cursor ">@Cursor</option>
          <option value="@Gemini ">@Gemini</option>
        </select>
        <input id="hd-input" type="text" placeholder="Drop a task or question to #peer-floor…" autocomplete="off" enterkeyhint="send" />
        <button type="submit" class="act act-primary">Send</button>
      </div>
    </form>
    ${state.cloudMode ? pushPromptHtml() : ""}
    <div class="stat-row">${stats}</div>
    <section class="home-section cc-panel" id="cc-needs">
      <div class="cc-head"><h2>Needs you</h2><span class="cc-src">${needs.length} open</span></div>
      ${needsBlock}
    </section>
    ${cc.digestHtml || ""}
    <section class="home-section cc-panel" id="cc-roster">
      <div class="cc-head"><h2>Agents</h2><span class="cc-src">${running ? `${running} running` : "all quiet"}</span></div>
      <div class="agent-lines">${cc.rosterHtml || ""}</div>
    </section>
    <section class="home-section cc-panel" id="cc-todos">
      <div class="cc-head"><h2>To-dos</h2><span class="cc-src">${todos.length} open</span></div>
      <div class="home-cards">${todoHtml}</div>
    </section>
    <section class="home-section cc-panel" id="cc-hosts">
      <div class="cc-head"><h2>Computers</h2><span class="cc-src">tap for actions · heartbeat</span></div>
      ${cc.hostsHtml || ""}
    </section>
    <details class="home-more">
      <summary>Models and the feed</summary>
      <section class="home-section cc-panel" id="cc-agents">
        <div class="cc-head"><h2>Models</h2><span class="cc-src">${esc(cc.agentsSource)}</span></div>
        ${cc.agentsHtml}
      </section>
      <section class="home-section cc-panel" id="cc-feed">
        <div class="cc-head"><h2>What’s going on</h2><span class="cc-src">${esc(cc.feedSource)}</span></div>
        ${cc.feedHtml}
      </section>
      <section class="home-section" id="cc-mentions">
        <div class="cc-head"><h2>Mentions</h2></div>
        ${mentionHtml}
      </section>
      <section class="home-section">
        <div class="cc-head"><h2>Digest</h2></div>
        ${reportHtml}
      </section>
    </details>`;
  if (body.dataset.sig === homeHtml) return;
  const jumpVal = document.getElementById("jump-input")?.value || "";
  const openFeed = [...body.querySelectorAll(".feed details[open] .feed-title")].map((x) => x.textContent);
  const scroll = body.scrollTop;
  body.dataset.sig = homeHtml;
  body.innerHTML = homeHtml;
  body.scrollTop = scroll;
  if (jumpVal) {
    const ji = document.getElementById("jump-input");
    ji.value = jumpVal;
    ji.dispatchEvent(new Event("input", { bubbles: true }));
  }
  body.querySelectorAll(".feed details").forEach((d) => {
    if (openFeed.includes(d.querySelector(".feed-title")?.textContent)) d.open = true;
  });
  document.getElementById("home-reconnect")?.addEventListener("click", () => {
    if (typeof ghState !== "undefined") {
      ghState.branch =
        typeof GH_DEFAULT_BRANCH === "string" ? GH_DEFAULT_BRANCH : "main";
      if (typeof ghSaveCreds === "function") ghSaveCreds();
    }
    document.getElementById("shell").classList.add("hidden");
    document.getElementById("boot").classList.remove("hidden");
    showCloudConnect("Branch set to main — tap Open cloud hub again.");
    const form = document.getElementById("cloud-connect");
    if (form) {
      form.classList.remove("hidden");
      const branch = form.querySelector('[name="branch"]');
      if (branch) branch.value = "main";
    }
  });
}

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function renderMessages(data) {
  const ch = data.channel || {};
  state.lastMessages = data.messages || [];
  state.lastChannel = ch;
  const viewer = currentViewer();
  const title =
    ch.kind === "dm" ? dmLabel(ch, viewer) : `#${ch.slug || state.channelSlug}`;
  document.getElementById("channel-title").textContent = title;
  document.getElementById("channel-purpose").textContent =
    ch.purpose || (ch.kind === "dm" ? "Direct messages" : "");
  document.getElementById("body").placeholder =
    ch.kind === "dm"
      ? `Ask ${dmLabel(ch, viewer)} anything…`
      : `Message #${ch.slug} · @Name to ping an agent`;
  const box = document.getElementById("messages");
  const stick = nearBottom(box) || box.dataset.empty === "1";
  if (!data.messages.length) {
    box.dataset.empty = "1";
    box.dataset.sig = "";
    box.innerHTML =
      ch.kind === "dm"
        ? `<p class="empty-state">No DMs yet. Say hi — agents can reply in this room.</p>`
        : `<p class="empty-state">No messages yet. Say hello, or import Wispr digests with <code>post_digest.py --all</code>.</p>`;
    markChannelRead(ch.slug || state.channelSlug, new Date().toISOString());
    return;
  }
  box.dataset.empty = "0";
  // v30: day separators + group consecutive messages from one author (within 5 min).
  const dayKey = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toDateString();
  };
  const dayLabel = (iso) => {
    const b = dayBucket(iso);
    if (b !== "Earlier") return b;
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  };
  let prev = null;
  const nextHtml = data.messages
    .map((m) => {
      const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
      const cont =
        prev &&
        !newDay &&
        String(prev.author).toLowerCase() === String(m.author).toLowerCase() &&
        new Date(m.created_at) - new Date(prev.created_at) < 5 * 60000;
      prev = m;
      const sep = newDay ? `<div class="day-sep" role="separator"><span>${esc(dayLabel(m.created_at))}</span></div>` : "";
      const mine = new Set(
        (m.reactions || [])
          .filter((r) => (r.authors || []).some((a) => String(a).toLowerCase() === viewer.toLowerCase()))
          .map((r) => r.emoji)
      );
      const chips = (m.reactions || [])
        .map(
          (r) =>
            `<button type="button" class="react-chip${
              mine.has(r.emoji) ? " mine" : ""
            }" data-id="${esc(m.id)}" data-emoji="${esc(r.emoji)}" title="${esc(
              (r.authors || []).join(", ")
            )}">${esc(r.emoji)} ${r.count}</button>`
        )
        .join("");
      const adders = QUICK_REACTIONS.map(
        (e) =>
          `<button type="button" class="react-add" data-id="${esc(m.id)}" data-emoji="${esc(
            e
          )}" aria-label="React ${esc(e)}">${esc(e)}</button>`
      ).join("");
      const isMine = String(m.author || "").toLowerCase() === viewer.toLowerCase();
      return `${sep}
      <article class="msg${isMine ? " mine" : " agent"}${cont ? " cont" : ""}${m.pending ? " pending" : ""}" data-id="${esc(m.id)}">
        <span class="msg-avatar" aria-hidden="true">${initialOf(m.author)}</span>
        <div class="meta"><strong>${esc(m.author)}</strong><time title="${esc(
          fmtTimeFull(m.created_at)
        )}">${esc(fmtTime(m.created_at))}</time></div>
        ${m.body ? `<div class="body">${formatBodyHtml(m.body)}</div>` : ""}
        ${
          Array.isArray(m.attachments) && m.attachments.length
            ? `<div class="msg-photos">${m.attachments
                .map(
                  (a) =>
                    `<button type="button" class="photo" data-photo="${esc(a.path)}" aria-label="Open photo ${esc(a.name || "")}"><span class="photo-loading">Loading photo…</span></button>`
                )
                .join("")}</div>`
            : ""
        }
        <div class="react-row">
          <div class="react-chips">${chips}</div>
          <div class="react-picker" hidden>${adders}</div>
          <button type="button" class="ghost react-toggle" data-id="${esc(
            m.id
          )}" aria-label="Add reaction">+</button>
          <button type="button" class="save-note" data-save-note="${esc(m.id)}" aria-label="Save to notes">☆ Save</button>
          <button type="button" class="thread-link${m.reply_count ? " has-replies" : ""}" data-parent="${esc(m.id)}">
            ${m.reply_count ? `${m.reply_count} ${m.reply_count === 1 ? "reply" : "replies"}` : "Reply in thread"}
          </button>
        </div>
      </article>`;
    })
    .join("");
  if (box.dataset.sig === nextHtml) return;
  const slug = ch.slug || state.channelSlug;
  const firstPaint = box.dataset.slug !== slug;
  const seen = new Set([...box.querySelectorAll(".msg[data-id]")].map((el) => el.dataset.id));
  const openId = box.querySelector(".msg.open")?.dataset.id;
  box.dataset.sig = nextHtml;
  box.dataset.slug = slug;
  box.innerHTML = nextHtml;
  hydratePhotos(box);
  if (openId) box.querySelector(`.msg[data-id="${CSS.escape(openId)}"]`)?.classList.add("open");
  if (firstPaint) {
    box.classList.remove("switching");
    void box.offsetWidth;
    box.classList.add("switching");
    box.scrollTop = box.scrollHeight;
  } else {
    box.querySelectorAll(".msg[data-id]").forEach((el) => {
      if (!seen.has(el.dataset.id) && !String(el.dataset.id).startsWith("local-")) el.classList.add("enter");
    });
    if (stick) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  }
  const last = data.messages[data.messages.length - 1];
  if (last) {
    state.lastPreviewBySlug = state.lastPreviewBySlug || {};
    state.lastPreviewBySlug[ch.slug || state.channelSlug] = `${last.author}: ${clip(last.body || "📷 Photo", 68)}`;
  }
  if (last?.created_at) markChannelRead(ch.slug || state.channelSlug, last.created_at);
  state.unreads[ch.slug || state.channelSlug] = 0;
}

async function loadMessages({ force = false } = {}) {
  if (!force && (state.sending > 0 || state.geminiStreaming)) return;
  const seq = ++state.loadMessagesSeq;
  const targetSlug = state.channelSlug;
  const key = `messages:${targetSlug}`;
  try {
    const data = await api(
      `/api/channels/${encodeURIComponent(targetSlug)}/messages`
    );
    await pocketSet(key, data);
    state.pocketMode = false;
    if (seq !== state.loadMessagesSeq || state.channelSlug !== targetSlug) return;
    if (!force && (state.sending > 0 || state.geminiStreaming)) return;
    renderMessages(data);
  } catch (err) {
    const cached = await pocketGet(key);
    if (!cached) throw err;
    state.pocketMode = true;
    if (seq !== state.loadMessagesSeq || state.channelSlug !== targetSlug) return;
    if (!force && (state.sending > 0 || state.geminiStreaming)) return;
    renderMessages(cached);
  }
}

async function openThread(parentId) {
  state.threadParentId = parentId;
  const pane = document.getElementById("thread");
  pane.classList.remove("hidden");
  const data = await api(
    `/api/channels/${encodeURIComponent(state.channelSlug)}/messages?parent_id=${encodeURIComponent(
      parentId
    )}`
  );
  const box = document.getElementById("thread-messages");
  box.innerHTML = data.messages
    .map(
      (m) => `
      <article class="msg">
        <div class="meta"><strong>${esc(m.author)}</strong><time>${esc(
          fmtTime(m.created_at)
        )}</time></div>
        <div class="body">${formatBodyHtml(m.body)}</div>
      </article>`
    )
    .join("");
}

async function loadLists() {
  let lists;
  try {
    ({ lists } = await api("/api/lists"));
    await pocketSet("lists", lists);
  } catch (err) {
    lists = (await pocketGet("lists")) || [];
    if (!lists.length) throw err;
    state.pocketMode = true;
  }
  const nav = document.getElementById("list-nav");
  if (!state.listId && lists[0]) state.listId = lists[0].id;
  nav.innerHTML = lists
    .map(
      (l) =>
        `<button type="button" data-id="${esc(l.id)}" class="${
          l.id === state.listId ? "active" : ""
        }">${esc(l.name)}</button>`
    )
    .join("");
  nav.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.listId = btn.dataset.id;
      document.getElementById("lists-pane").classList.add("open");
      setRailOpen(false);
      loadListDetail();
      loadLists();
    });
  });
  if (state.listId) await loadListDetail();
}

async function loadListDetail() {
  if (!state.listId) return;
  const key = `list:${state.listId}`;
  let list;
  try {
    list = await api(`/api/lists/${encodeURIComponent(state.listId)}`);
    await pocketSet(key, list);
  } catch (err) {
    list = await pocketGet(key);
    if (!list) throw err;
    state.pocketMode = true;
  }
  document.getElementById("list-title").textContent = list.name;
  // v26: rows as phone cards — open first, tap the circle to tick off.
  const cols = (list.columns || []).map((c) => String(c).toLowerCase());
  const at = (name, fallback) => {
    const i = cols.indexOf(name);
    return i >= 0 ? i : fallback;
  };
  const iStatus = at("status", 0);
  const iItem = at("item", 1);
  const iOwner = at("owner", 2);
  const iNotes = at("notes", 3);
  const isDone = (r) => /^(done|closed|complete|completed|✅)$/i.test(String(r.cells[iStatus] || "").trim());
  const rows = [...(list.rows || [])].sort((a, b) => Number(isDone(a)) - Number(isDone(b)));
  const card = (r) => {
    const done = isDone(r);
    const status = String(r.cells[iStatus] || "open");
    return `<article class="list-row${done ? " done" : ""}">
      <button type="button" class="tick" data-row="${esc(r.id)}" data-next="${done ? "open" : "done"}" aria-label="${done ? "Mark open" : "Mark done"}">${done ? "✓" : ""}</button>
      <div class="list-row-body">
        <strong>${esc(r.cells[iItem] || "(untitled)")}</strong>
        <span class="list-row-meta">${done ? "" : `<span class="job-pill pill-${/block/i.test(status) ? "blocked" : "draft"}">${esc(status)}</span>`}${
          r.cells[iOwner] ? `<span>${esc(r.cells[iOwner])}</span>` : ""
        }${r.cells[iNotes] ? `<span class="list-note">${esc(r.cells[iNotes])}</span>` : ""}</span>
      </div>
    </article>`;
  };
  const open = rows.filter((r) => !isDone(r));
  const done = rows.filter(isDone);
  document.getElementById("list-table").innerHTML = rows.length
    ? `${open.map(card).join("") || `<p class="home-empty">All done 🎉</p>`}${
        done.length ? `<details class="list-done"><summary>Done (${done.length})</summary>${done.map(card).join("")}</details>` : ""
      }`
    : `<p class="home-empty">No rows yet — add one below.</p>`;
}

document.getElementById("list-table")?.addEventListener("click", async (e) => {
  const b = e.target.closest(".tick[data-row]");
  if (!b || !state.listId) return;
  b.disabled = true;
  b.closest(".list-row")?.classList.toggle("done", b.dataset.next === "done");
  try {
    await ghSetRowStatus(state.listId, b.dataset.row, b.dataset.next);
    await loadListDetail();
    loadHome().catch(() => {});
  } catch (err) {
    toast(friendlyError(err), "err");
    b.disabled = false;
    loadListDetail().catch(() => {});
  }
});

async function loadTokenHint() {
  try {
    const hint = await api("/api/token-hint");
    document.getElementById("token-hint").textContent =
      `Agent auth: Bearer ${hint.hint}\nFile: ${hint.path}`;
  } catch {
    document.getElementById("token-hint").textContent = "Pocket mode — Mac unreachable";
  }
}

function showPhoneHint(health) {
  const el = document.getElementById("phone-hint");
  if (health.cloud || state.cloudMode) {
    el.hidden = false;
    el.textContent =
      "Cloud hub · GitHub vault · no Mac / no same Wi‑Fi needed";
    return;
  }
  el.hidden = false;
  el.textContent =
    "Prefer cloud hub (CLOUD.md). Local Mac UI is optional only.";
}

async function refresh() {
  await Promise.all([loadChannels(), loadMessages(), loadLists()]);
}

async function refreshAll() {
  await loadChannels();
  await loadLists();
  if (state.view === "home") await loadHome();
  else await loadMessages();
}

async function bootFromPocket() {
  const channels = (await pocketGet("channels")) || [];
  if (!channels.length) return false;
  state.pocketMode = true;
  state.hostLabel = "pocket";
  await loadChannels();
  await loadLists();
  try {
    await loadHome();
  } catch {
    await loadMessages();
    state.view = "channel";
  }
  return true;
}

function isPagesHost() {
  try {
    return /\.github\.io$/i.test(location.hostname);
  } catch {
    return false;
  }
}

async function boot() {
  const bootEl = document.getElementById("boot");
  const status = document.getElementById("boot-status");
  const retry = document.getElementById("boot-retry");
  retry.classList.add("hidden");
  if (typeof ghLoadCreds === "function") ghLoadCreds();
  paintVersion();
  const forceCloud = wantsCloudHub() || isPagesHost();
  // No token and this is the cloud shell: show sign-in now. Don't sit on a spinner.
  if (forceCloud && !ghState?.token) {
    state.cloudMode = true;
    showCloudConnect();
    return;
  }
  if (forceCloud && status && !status.querySelector("strong")) {
    status.textContent = "Opening the vault…";
  }

  // Product path: cloud GitHub hub (no Mac). Prefer when forced or when
  // there is no local /api and we already have (or can collect) a PAT.
  if (forceCloud) {
    state.cloudMode = true;
    await bootCloud();
    return;
  }

  try {
    const health = await api("/api/health");
    try {
      state.hostLabel = new URL(health.host).hostname;
    } catch {
      state.hostLabel = health.cloud ? "github" : "local";
    }
    state.pocketMode = false;
    state.cloudMode = Boolean(health.cloud);
    const count = health.messages != null ? ` · ${health.messages} messages` : "";
    status.textContent = `Ready · ${health.host}${count}`;
    await loadTokenHint();
    showPhoneHint(health);
    await loadChannels();
    await loadLists();
    showView("home");
    await pocketFlushOutbox();
    setLive(true, health.host);
    bootEl.classList.add("hidden");
    document.getElementById("shell").classList.remove("hidden");
    showInstallBanner();
  } catch (err) {
    // No local Mac server — go cloud, not "same Wi‑Fi"
    if (ghState && ghState.token) {
      const ok = await bootCloud();
      if (ok) return;
    }
    showCloudConnect(
      "No local server (good — we do not need the Mac). Connect GitHub below."
    );
    setLive(false, String(err));
  }
}

document.getElementById("boot-retry").addEventListener("click", () => boot());
initLookPicker();
initGeminiSettings();
function bindMenuToggle(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("click", () => {
    const open = !document.getElementById("shell").classList.contains("rail-open");
    setRailOpen(open);
  });
}
bindMenuToggle("menu-toggle");
bindMenuToggle("menu-toggle-home");
bindMenuToggle("menu-toggle-chats");

document.getElementById("home-nav")?.addEventListener("click", () => {
  setRailOpen(false);
  showView("home");
});
document.getElementById("home-refresh")?.addEventListener("click", () => {
  loadHome().catch(() => {});
});
document.getElementById("home-body")?.addEventListener("click", (e) => {
  const ch = e.target.closest(".home-open-channel");
  if (ch) {
    state.channelSlug = ch.dataset.slug;
    state.threadParentId = null;
    document.getElementById("thread")?.classList.add("hidden");
    showView("channel");
    return;
  }
  const listBtn = e.target.closest(".home-open-list");
  if (listBtn && listBtn.dataset.list) {
    state.listId = listBtn.dataset.list;
    document.getElementById("lists-pane").classList.add("open");
    loadLists().catch(() => {});
  }
});
document.getElementById("home-body")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const tap = e.target.closest("[data-open-agent], [data-open-host], [data-open-channel], [data-open-list], [data-goto-agents], [data-scroll-to]");
  if (!tap || e.target.closest("input, textarea, select, button.tick")) return;
  e.preventDefault();
  tap.click();
});
document.getElementById("rail-backdrop").addEventListener("click", () => setRailOpen(false));

document.getElementById("host-sheet-close")?.addEventListener("click", () => closeHostSheet());
document.getElementById("host-sheet")?.addEventListener("click", async (e) => {
  const act = e.target.closest("[data-host-act]");
  if (!act) return;
  const host = state.hostCards?.[state.openHostId];
  const kind = act.dataset.hostAct;
  if (kind === "close") {
    closeHostSheet();
    return;
  }
  if (kind === "chat") {
    const agent = act.dataset.agent;
    closeHostSheet();
    if (agent) openAgentDm(agent).catch((err) => toast(friendlyError(err), "err"));
    return;
  }
  if (kind === "copy-install") {
    await copyText(host?.install, "Install command copied");
    return;
  }
  if (kind === "copy-tailscale") {
    await copyText(host?.tailscale, "Tailscale IP copied");
    return;
  }
  if (kind === "refresh") {
    act.disabled = true;
    try {
      await loadHome();
      if (state.openHostId) openHostSheet(state.openHostId);
      toast("Computer status refreshed");
    } catch (err) {
      toast(friendlyError(err), "err");
    } finally {
      act.disabled = false;
    }
  }
});

/* Bottom tab bar (phone): Home · Chats · Agents · Notes. Desktop keeps the rail. */
function setActiveTab(tab) {
  document.querySelectorAll("#tabbar button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
}
document.getElementById("tabbar")?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  const tab = btn.dataset.tab;
  document.getElementById("lists-pane").classList.remove("open");
  setRailOpen(false);
  if (tab !== "home") closeHostSheet();
  if (tab === "home") {
    if (isPhoneShell() && document.getElementById("chat-pane")?.classList.contains("sheet-open")) {
      closeChatSheet({ to: "home" });
    } else {
      showView("home");
    }
  } else if (tab === "chats") {
    state.threadParentId = null;
    document.getElementById("thread")?.classList.add("hidden");
    if (isPhoneShell()) {
      if (document.getElementById("chat-pane")?.classList.contains("sheet-open")) {
        closeChatSheet({ to: "chats" });
      } else {
        showView("chats");
      }
    } else {
      state.channelSlug = defaultChatSlug();
      showView("channel");
    }
  } else if (tab === "agents") {
    if (isPhoneShell() && document.getElementById("chat-pane")?.classList.contains("sheet-open")) {
      closeChatSheet({ to: "agents" });
    } else {
      showView("agents");
    }
  } else if (tab === "notes") {
    if (isPhoneShell() && document.getElementById("chat-pane")?.classList.contains("sheet-open")) {
      closeChatSheet({ to: "notes" });
    } else {
      showView("notes");
    }
  }
  setActiveTab(tab);
});

document.getElementById("chats-inbox")?.addEventListener("click", (e) => {
  const row = e.target.closest(".chat-inbox-row");
  if (!row?.dataset.slug) return;
  state.channelSlug = row.dataset.slug;
  state.threadParentId = null;
  document.getElementById("thread")?.classList.add("hidden");
  showView("channel");
});
document.getElementById("chats-new")?.addEventListener("click", () => setRailOpen(true));
document.getElementById("chat-back")?.addEventListener("click", () => {
  closeChatSheet(); // returns to wherever you opened the chat from
});
setupChatSheetGestures();

/* Home jump search: channels, agents, and cross-chat message text. */
function jumpChannelMatches(q) {
  const viewer = currentViewer();
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return (state.channels || [])
    .map((c) => ({
      type: "channel",
      c,
      label: c.kind === "dm" ? dmLabel(c, viewer) : `#${c.slug}`,
      preview: c.purpose || "",
    }))
    .filter(({ c, label, preview }) =>
      [label, c.slug, preview].some((v) => String(v).toLowerCase().includes(needle))
    );
}

function jumpMessageMatches(q) {
  const needle = q.trim().toLowerCase();
  if (!needle || needle.length < 2) return [];
  const viewer = currentViewer();
  return (state.messageIndex || [])
    .filter((m) =>
      [m.body, m.author, m.slug].some((v) => String(v || "").toLowerCase().includes(needle))
    )
    .slice(0, 12)
    .map((m) => {
      const ch = (state.channels || []).find((c) => c.slug === m.slug);
      const label = ch
        ? ch.kind === "dm"
          ? dmLabel(ch, viewer)
          : `#${ch.slug}`
        : m.slug;
      return {
        type: "message",
        c: ch || { slug: m.slug, kind: "channel" },
        label,
        preview: `${m.author}: ${clip(m.body, 72)}`,
        at: m.at,
      };
    });
}

function jumpMatches(q) {
  const ch = jumpChannelMatches(q);
  const msg = jumpMessageMatches(q).filter((m) => !ch.some((c) => c.c.slug === m.c.slug && !m.preview));
  return [...ch, ...msg].slice(0, 12);
}

async function ensureMessageIndex() {
  if (state.messageIndexBuilt || !state.cloudMode) return;
  // Cap API cost: 10 most recently updated channels, last 80 msgs each.
  const channels = [...(state.channels || [])]
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .slice(0, 10);
  const out = [];
  await Promise.all(
    channels.map(async (c) => {
      try {
        const data = await api(`/api/channels/${encodeURIComponent(c.slug)}/messages`);
        const rows = data.messages || data || [];
        for (const m of rows.slice(-80)) {
          out.push({
            slug: c.slug,
            author: m.author || "",
            body: m.body || "",
            at: m.created_at || "",
            id: m.id || "",
          });
        }
      } catch {
        /* ignore */
      }
    })
  );
  state.messageIndex = out;
  state.messageIndexBuilt = true;
}

function paintJumpResults(q) {
  const box = document.getElementById("jump-results");
  if (!box) return;
  const needle = q.trim();
  if (!needle) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const hits = jumpMatches(needle);
  box.innerHTML = hits.length
    ? hits
        .map(
          (h) =>
            `<button type="button" class="jump-hit home-open-channel" data-slug="${esc(h.c.slug)}"><span class="jump-kind">${
              h.type === "message" ? "Msg" : h.c.kind === "dm" ? "Agent" : "Channel"
            }</span><span class="jump-main">${esc(h.label)}${
              h.preview ? `<span class="jump-sub">${esc(h.preview)}</span>` : ""
            }</span></button>`
        )
        .join("")
    : `<p class="home-empty">No chats or messages match “${esc(needle)}”.</p>`;
  box.hidden = false;
}

document.getElementById("home-body")?.addEventListener("input", async (e) => {
  if (e.target.id !== "jump-input") return;
  const q = e.target.value;
  if (q.trim().length >= 2) await ensureMessageIndex();
  paintJumpResults(q);
});
document.getElementById("home-body")?.addEventListener("keydown", (e) => {
  if (e.target.id !== "jump-input" || e.key !== "Enter") return;
  e.preventDefault();
  const first = jumpMatches(e.target.value)[0];
  if (first) {
    state.channelSlug = first.c.slug;
    showView("channel");
  }
});

async function toggleReaction(messageId, emoji) {
  if (!messageId || !emoji) return;
  await api(
    `/api/channels/${encodeURIComponent(state.channelSlug)}/messages/${encodeURIComponent(
      messageId
    )}/reactions`,
    {
      method: "POST",
      body: JSON.stringify({ emoji, author: currentViewer() }),
    }
  );
  await loadMessages();
}

document.getElementById("messages").addEventListener("click", (e) => {
  const toggle = e.target.closest(".react-toggle");
  if (toggle) {
    e.preventDefault();
    const article = toggle.closest(".msg");
    const picker = article?.querySelector(".react-picker");
    if (picker) picker.hidden = !picker.hidden;
    return;
  }
  const react = e.target.closest(".react-chip, .react-add");
  if (react) {
    e.preventDefault();
    toggleReaction(react.dataset.id, react.dataset.emoji).catch(() => {});
    return;
  }
  const saveBtn = e.target.closest("[data-save-note]");
  if (saveBtn) {
    e.preventDefault();
    saveMessageToNotes(saveBtn.dataset.saveNote, saveBtn);
    return;
  }
  const btn = e.target.closest(".thread-link");
  if (btn) {
    e.preventDefault();
    openThread(btn.dataset.parent);
    return;
  }
  // v30: tap a message to reveal its actions (react, reply); tap again or another to hide.
  if (e.target.closest("a, button, .photo, .mention")) return;
  const msg = e.target.closest(".msg[data-id]");
  if (!msg || msg.classList.contains("pending")) return;
  const box = e.currentTarget;
  const wasOpen = msg.classList.contains("open");
  box.querySelectorAll(".msg.open").forEach((m) => m.classList.remove("open"));
  if (!wasOpen) msg.classList.add("open");
});


/* ---- v24 photos: shrink on the phone, upload to hub/attachments, show inline ---- */
state.pendingPhotos = [];
async function shrinkImage(file, max = 1600, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Couldn't read that image"));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
    if (!blob) throw new Error("Couldn't compress that image");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
function paintPendingPhotos() {
  const tray = document.getElementById("photo-tray");
  if (!tray) return;
  tray.hidden = !state.pendingPhotos.length;
  tray.innerHTML = state.pendingPhotos
    .map(
      (p, i) =>
        `<span class="tray-item"><img src="${p.preview}" alt="" /><button type="button" data-remove-photo="${i}" aria-label="Remove photo">×</button></span>`
    )
    .join("");
}
function clearPendingPhotos() {
  state.pendingPhotos.forEach((p) => URL.revokeObjectURL(p.preview));
  state.pendingPhotos = [];
  paintPendingPhotos();
}
document.getElementById("photo-input")?.addEventListener("change", async (e) => {
  const files = [...(e.target.files || [])].slice(0, 4 - state.pendingPhotos.length);
  for (const f of files) {
    try {
      const blob = await shrinkImage(f);
      state.pendingPhotos.push({ blob, preview: URL.createObjectURL(blob) });
    } catch (err) {
      toast(friendlyError(err), "err");
    }
  }
  e.target.value = "";
  paintPendingPhotos();
});
document.getElementById("photo-tray")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-remove-photo]");
  if (!b) return;
  const [gone] = state.pendingPhotos.splice(Number(b.dataset.removePhoto), 1);
  if (gone) URL.revokeObjectURL(gone.preview);
  paintPendingPhotos();
});
function hydratePhotos(root) {
  if (typeof ghAttachmentUrl !== "function") return;
  root.querySelectorAll(".photo[data-photo]:not([data-ready])").forEach((el) => {
    el.dataset.ready = "1";
    ghAttachmentUrl(el.dataset.photo)
      .then((url) => {
        el.innerHTML = `<img src="${url}" alt="Photo" loading="lazy" />`;
        el.dataset.url = url;
      })
      .catch(() => {
        el.innerHTML = `<span class="photo-loading">Photo unavailable</span>`;
      });
  });
}
document.getElementById("messages")?.addEventListener("click", (e) => {
  const ph = e.target.closest(".photo[data-url]");
  if (!ph) return;
  const lb = document.createElement("div");
  lb.className = "lightbox";
  lb.innerHTML = `<img src="${ph.dataset.url}" alt="Photo" /><button type="button" aria-label="Close">×</button>`;
  lb.addEventListener("click", () => lb.remove());
  document.body.appendChild(lb);
});

document.getElementById("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const author = document.getElementById("author").value.trim() || "Seth";
  const body = document.getElementById("body").value.trim();
  const pending = state.pendingPhotos || [];
  if (!body && !pending.length) return;
  const targetSlug = state.channelSlug;
  const useInstantGemini = shouldInstantGemini(targetSlug, body) && !pending.length;
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  state.sending += 1;
  const path = `/api/channels/${encodeURIComponent(targetSlug)}/messages`;
  const payload = { author, body, ...(useInstantGemini ? { instant_gemini: true } : {}) };
  // v36 optimistic send + send/poll lock: keep optimistic and streaming bubbles safe from background polls.
  const boxEl = document.getElementById("messages");
  const ghost = document.createElement("article");
  ghost.className = "msg mine pending enter";
  ghost.dataset.id = `local-${Date.now()}`;
  ghost.innerHTML = `<span class="msg-avatar" aria-hidden="true">${initialOf(author)}</span><div class="meta"><strong>${esc(author)}</strong><time>Sending…</time></div>${
    body ? `<div class="body">${formatBodyHtml(body)}</div>` : ""
  }${pending.length ? `<div class="msg-photos"><span class="photo-loading">Uploading ${pending.length} photo${pending.length > 1 ? "s" : ""}…</span></div>` : ""}`;
  boxEl.querySelector(".empty-state")?.remove();
  boxEl.appendChild(ghost);
  boxEl.scrollTo({ top: boxEl.scrollHeight, behavior: "smooth" });
  document.getElementById("body").value = "";
  autosize(document.getElementById("body"));

  let streamBubble = null;
  let geminiPromise = null;
  if (useInstantGemini) {
    state.geminiStreaming = true;
    streamBubble = document.createElement("article");
    streamBubble.className = "msg agent streaming enter";
    streamBubble.dataset.id = `local-gemini-${Date.now()}`;
    streamBubble.innerHTML = `<span class="msg-avatar" aria-hidden="true">G</span><div class="meta"><strong>Gemini</strong><time>Streaming…</time></div><div class="body"><span class="stream-caret" aria-hidden="true"></span></div>`;
    boxEl.appendChild(streamBubble);
    boxEl.scrollTo({ top: boxEl.scrollHeight, behavior: "smooth" });
    geminiPromise = streamGeminiInteraction({
      slug: targetSlug,
      userText: body,
      onDelta: (partial) => {
        if (!streamBubble || state.channelSlug !== targetSlug) return;
        const stick = nearBottom(boxEl);
        const bodyEl = streamBubble.querySelector(".body");
        if (bodyEl) {
          bodyEl.innerHTML = `${partial ? formatBodyHtml(partial) : ""}<span class="stream-caret" aria-hidden="true"></span>`;
        }
        if (stick) boxEl.scrollTop = boxEl.scrollHeight;
      },
    });
  }

  let userPosted = false;
  try {
    if (pending.length) {
      if (!state.cloudMode) throw new Error("Photos need the cloud hub (open with ?cloud=1).");
      if (btn) btn.textContent = "Uploading…";
      payload.attachments = [];
      for (const p of pending) payload.attachments.push(await ghUploadAttachment(targetSlug, p.blob, "jpg"));
    }
    await api(path, { method: "POST", body: JSON.stringify(payload) });
    userPosted = true;
    clearPendingPhotos();
    document.getElementById("body").value = "";
    autosize(document.getElementById("body"));
    const metaTime = ghost.querySelector(".meta time");
    if (metaTime) metaTime.textContent = "Sent";
    ghost.classList.remove("pending");

    if (geminiPromise) {
      try {
        const reply = await geminiPromise;
        if (streamBubble && state.channelSlug === targetSlug) {
          streamBubble.classList.remove("streaming");
          const sTime = streamBubble.querySelector(".meta time");
          if (sTime) sTime.textContent = `Saving (${reply.model})…`;
          const bodyEl = streamBubble.querySelector(".body");
          if (bodyEl) bodyEl.innerHTML = formatBodyHtml(reply.text);
        }
        await api(path, {
          method: "POST",
          body: JSON.stringify({ author: "Gemini", body: reply.text }),
        });
      } catch (gemErr) {
        const msg = friendlyError(gemErr);
        toast(`Gemini: ${msg}`, "err");
        if (streamBubble && state.channelSlug === targetSlug) {
          streamBubble.classList.remove("streaming");
          const sTime = streamBubble.querySelector(".meta time");
          if (sTime) sTime.textContent = "Error";
          const bodyEl = streamBubble.querySelector(".body");
          if (bodyEl) bodyEl.textContent = `Gemini stream failed: ${msg}`;
        }
      }
    }
    if (state.channelSlug === targetSlug) {
      await loadMessages({ force: true });
    }
  } catch (err) {
    if (geminiPromise) {
      geminiPromise.catch(() => {});
    }
    if (!userPosted) {
      await pocketOutboxPush({ path, method: "POST", body: payload, at: new Date().toISOString() });
      const key = `messages:${targetSlug}`;
      const cached = (await pocketGet(key)) || {
        channel: { slug: targetSlug, purpose: "" },
        messages: [],
      };
      cached.messages = [
        ...cached.messages,
        {
          id: `local-${Date.now()}`,
          author,
          body: `${body}\n\n(queued — will send when online)`,
          created_at: new Date().toISOString(),
          reply_count: 0,
        },
      ];
      await pocketSet(key, cached);
      document.getElementById("body").value = "";
      autosize(document.getElementById("body"));
      if (state.channelSlug === targetSlug) renderMessages(cached);
      setLive(false, "queued in pocket");
    }
  } finally {
    state.geminiStreaming = false;
    state.sending = Math.max(0, state.sending - 1);
    state.nextPollAt = Date.now() + pollDelay();
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  }
});

document.getElementById("body").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const form = document.getElementById("composer");
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  }
});
document.getElementById("body").addEventListener("input", (e) => autosize(e.target));
document.getElementById("thread-body").addEventListener("input", (e) => autosize(e.target));

/* v35.0: One-tap Quick Prompt pills in chat + Home Quick Dispatch bar */
document.getElementById("quick-chips")?.addEventListener("click", (e) => {
  const chip = e.target.closest(".q-chip");
  if (!chip) return;
  const input = document.getElementById("body");
  if (!input) return;
  if (chip.dataset.insert) {
    const prefix = chip.dataset.insert;
    if (!input.value.includes(prefix.trim())) {
      input.value = `${prefix}${input.value}`;
    }
    autosize(input);
    input.focus();
    return;
  }
  if (chip.dataset.send) {
    input.value = chip.dataset.send;
    autosize(input);
    const form = document.getElementById("composer");
    if (typeof form?.requestSubmit === "function") form.requestSubmit();
    else form?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  }
});

document.getElementById("home-body")?.addEventListener("submit", async (e) => {
  if (e.target.id !== "home-quick-dispatch") return;
  e.preventDefault();
  const target = document.getElementById("hd-target")?.value || "@ChatGPT @Cursor ";
  const input = document.getElementById("hd-input");
  const text = (input?.value || "").trim();
  if (!text) return;
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending…";
  }
  state.sending += 1;
  try {
    const body = `${target}${text}`;
    await api("/api/channels/peer-floor/messages", {
      method: "POST",
      body: JSON.stringify({ author: currentViewer(), body }),
    });
    if (input) input.value = "";
    toast("Dispatched to #peer-floor");
    state.channelSlug = "peer-floor";
    showView("channel");
  } catch (err) {
    toast(friendlyError(err), "err");
  } finally {
    state.sending = Math.max(0, state.sending - 1);
    state.nextPollAt = Date.now() + pollDelay();
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  }
});

document.getElementById("thread-composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.threadParentId) return;
  const author = document.getElementById("author").value.trim() || "Seth";
  const body = document.getElementById("thread-body").value.trim();
  if (!body) return;
  await api(`/api/channels/${encodeURIComponent(state.channelSlug)}/messages`, {
    method: "POST",
    body: JSON.stringify({ author, body, parent_id: state.threadParentId }),
  });
  document.getElementById("thread-body").value = "";
  autosize(document.getElementById("thread-body"));
  await openThread(state.threadParentId);
  await loadMessages();
});

document.getElementById("close-thread").addEventListener("click", () => {
  state.threadParentId = null;
  document.getElementById("thread").classList.add("hidden");
});

document.getElementById("new-channel").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const slug = String(fd.get("slug") || "").trim();
  if (!slug) return;
  await api("/api/channels", {
    method: "POST",
    body: JSON.stringify({ slug, name: slug }),
  });
  e.target.reset();
  state.channelSlug = slug.toLowerCase().replaceAll(" ", "-");
  setRailOpen(false);
  showView("channel");
});

document.getElementById("new-dm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const member = String(fd.get("member") || "").trim();
  if (!member) return;
  const ch = await api("/api/dms", {
    method: "POST",
    body: JSON.stringify({ me: currentViewer(), member }),
  });
  e.target.reset();
  state.channelSlug = ch.slug;
  await loadChannels();
  setRailOpen(false);
  showView("channel");
});

document.getElementById("new-row").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.listId) return;
  const fd = new FormData(e.target);
  const cells = ["c0", "c1", "c2", "c3"].map((k) => String(fd.get(k) || "").trim());
  await api(`/api/lists/${encodeURIComponent(state.listId)}/rows`, {
    method: "POST",
    body: JSON.stringify({ cells }),
  });
  e.target.reset();
  await loadListDetail();
});

document.getElementById("toggle-lists").addEventListener("click", () => {
  document.getElementById("lists-pane").classList.toggle("open");
  setRailOpen(false);
});
document.getElementById("close-lists").addEventListener("click", () => {
  document.getElementById("lists-pane").classList.remove("open");
});

document.getElementById("install-dismiss")?.addEventListener("click", () => {
  document.getElementById("install-banner").hidden = true;
  try {
    localStorage.setItem("stack-install-dismissed", "1");
  } catch {
    /* ignore */
  }
});

document.getElementById("install-btn")?.addEventListener("click", async () => {
  if (!state.deferredInstall) return;
  state.deferredInstall.prompt();
  await state.deferredInstall.userChoice.catch(() => {});
  state.deferredInstall = null;
  document.getElementById("install-banner").hidden = true;
});

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  state.deferredInstall = e;
  try {
    if (localStorage.getItem("stack-install-dismissed") === "1") return;
  } catch {
    /* ignore */
  }
  showInstallBanner();
});

setupAutoUpdate();

(async function bootEntry() {
  // Nuclear clear for stuck empty phone sessions.
  try {
    const params = new URLSearchParams(location.search);
    if (params.has("reset") || params.get("cloud") === "reset") {
      if (typeof ghResetSession === "function") ghResetSession();
      try {
        const keys = ["home", "channels", "lists"];
        for (const k of keys) await pocketSet(k, null);
      } catch {
        /* ignore */
      }
      if ("caches" in window) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      }
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      location.replace("./?cloud=1");
      return;
    }
  } catch {
    /* ignore and continue boot */
  }
  boot();
})();
/* v28 reliable polling: only while visible; chat 15 s, Home/Agents 60 s; ETags make unchanged polls free;
   exponential backoff on errors (max 5 min); full pause while GitHub's rate limit resets; offline-aware. */
state.pollFails = 0;
state.nextPollAt = 0;
function pollDelay() {
  const base = state.view === "channel" ? 15000 : 60000;
  return state.pollFails ? Math.min(300000, base * 2 ** state.pollFails) : base;
}
function pollOnce(force = false) {
  if (!shellReady()) return;
  if (state.pocketMode && !state.cloudMode) return;
  if (state.cloudMode && !ghState?.token) return;
  if (state.sending > 0 || state.geminiStreaming) return;
  if (document.visibilityState === "hidden") return;
  if (!navigator.onLine) {
    setLive(false, "offline");
    return;
  }
  const now = Date.now();
  if (!force && now < state.nextPollAt) return;
  if (state.pausedUntil && now < state.pausedUntil) return;
  state.nextPollAt = now + pollDelay();
  const tick =
    state.view === "home"
      ? loadHome()
      : state.view === "agents"
      ? loadAgentsView()
      : state.view === "notes"
      ? loadNotes()
      : state.view === "chats"
      ? loadChannels().then(() => paintChatsInbox())
      : loadMessages().then(() => {
          if (state.threadParentId && !state.pocketMode) return openThread(state.threadParentId);
        });
  tick
    .then(() => {
      // Views fall back to cached data on errors, so check GitHub's own counter too.
      if (typeof ghRate !== "undefined" && ghRate.remaining === 0 && ghRate.reset > Date.now()) {
        const err = new Error(
          `GitHub's hourly limit is used up. The Stack will pause and resume at ${new Date(ghRate.reset).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
        );
        err.rateLimited = true;
        throw err;
      }
      state.pollFails = 0;
      state.nextPollAt = Date.now() + pollDelay();
      if (!state.pocketMode) setLive(true);
      return pocketFlushOutbox();
    })
    .catch((err) => {
      state.pollFails = Math.min(state.pollFails + 1, 6);
      state.nextPollAt = Date.now() + pollDelay();
      if (err && err.rateLimited) {
        const until = (typeof ghRate !== "undefined" && ghRate.reset) || Date.now() + 15 * 60000;
        if (!state.pausedUntil || state.pausedUntil < Date.now()) toast(friendlyError(err), "err");
        state.pausedUntil = until;
      }
      setLive(false, friendlyError(err));
    });
}
state.pollTimer = setInterval(() => pollOnce(false), 5000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pollOnce(true);
});
window.addEventListener("online", () => {
  toast("Back online");
  state.pollFails = 0;
  pollOnce(true);
});
window.addEventListener("offline", () => {
  setLive(false, "offline");
  toast("No signal — showing what was last loaded", "err");
});
