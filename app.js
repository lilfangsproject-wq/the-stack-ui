/* The Stack — our installable team-chat app (desktop + phone + pocket). */
const state = {
  view: "home",
  channelSlug: "the-digest",
  listId: null,
  threadParentId: null,
  pollTimer: null,
  hostLabel: "local",
  pocketMode: false,
  cloudMode: false,
  deferredInstall: null,
  channels: [],
  unreads: {},
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
const LOOK_KEY = "stack-look-v1";
const QUICK_REACTIONS = ["👍", "👀", "✅", "❤️", "🔥"];

/** Phone-steerable accents on the dark Liquid Glass theme — tap Look in the menu. Lime is the default. */
const LOOKS = {
  lime: { label: "Lime", accent: "#d4f25c", strong: "#b8d93c", soft: "rgba(212, 242, 92, 0.16)", on: "#151a05" },
  violet: { label: "Violet", accent: "#b9a2ff", strong: "#9a7dff", soft: "rgba(185, 162, 255, 0.16)", on: "#1a1230" },
  amber: { label: "Amber", accent: "#ffc94a", strong: "#f0ae1c", soft: "rgba(255, 201, 74, 0.16)", on: "#2a1f00" },
  mint: { label: "Mint", accent: "#6ff0c4", strong: "#3fd6a5", soft: "rgba(111, 240, 196, 0.16)", on: "#04241a" },
  coral: { label: "Coral", accent: "#ff8a70", strong: "#f2674a", soft: "rgba(255, 138, 112, 0.16)", on: "#2b0d06" },
  white: { label: "White", accent: "#f4f5f2", strong: "#d9dbd5", soft: "rgba(244, 245, 242, 0.14)", on: "#111214" },
};
const LOOK_DEFAULT = "lime";

function applyLook(id) {
  const look = LOOKS[id] || LOOKS[LOOK_DEFAULT];
  const root = document.documentElement;
  root.style.setProperty("--accent", look.accent);
  root.style.setProperty("--accent-strong", look.strong);
  root.style.setProperty("--accent-soft", look.soft);
  root.style.setProperty("--on-accent", look.on || "#ffffff");
  root.style.setProperty("--accent-glow", look.soft.replace(/0\.1\d\)/, "0.35)"));
  root.dataset.look = LOOKS[id] ? id : LOOK_DEFAULT;
  try {
    localStorage.setItem(LOOK_KEY, root.dataset.look);
  } catch {
    /* ignore */
  }
  const theme = document.querySelector('meta[name="theme-color"]');
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
          `<button type="button" class="look-swatch" role="radio" data-look="${id}" aria-label="${look.label}" style="--swatch:${look.accent}" title="${look.label}"></button>`
      )
      .join("");
    host.addEventListener("click", (e) => {
      const btn = e.target.closest(".look-swatch");
      if (!btn) return;
      applyLook(btn.dataset.look);
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
      </details>
      <p class="cloud-help">Stays on this phone only. Needs Contents access on the vault repo.</p>
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
  if (!ghState.token) {
    showCloudConnect();
    return false;
  }
  status.textContent = "Connecting to GitHub hub…";
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

function markChannelRead(slug, iso) {
  if (!slug) return;
  const reads = loadReads();
  const prev = reads[slug] || "";
  if (!iso || String(iso) >= String(prev)) {
    reads[slug] = iso || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    saveReads(reads);
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
  return esc(String(name || "?").trim().charAt(0).toUpperCase() || "?");
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
    const ch = (state.channels || []).find((c) => c.slug === state.channelSlug);
    setActiveTab(state.view === "home" ? "home" : state.view === "agents" ? "agents" : "chats");
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
  const dms = state.channels.filter((c) => c.kind === "dm");
  const nav = document.getElementById("channel-list");
  const dmNav = document.getElementById("dm-list");
  refreshUnreadBadges();
  nav.innerHTML = pubs.map((c) => navButtonHtml(c, viewer)).join("");
  if (dmNav) dmNav.innerHTML = dms.map((c) => navButtonHtml(c, viewer)).join("");
  bindChannelNav(nav);
  bindChannelNav(dmNav);
  paintSessionStrip();
}

/* v26: session strip on the chat screen — agents first (Claude on top), then channels. */
const LAST_CHAT_KEY = "stack-last-chat-v1";
const AGENT_ORDER = ["claude", "cursor", "chatgpt", "nori", "hermes"];
function sessionList() {
  const viewer = currentViewer();
  const dms = (state.channels || []).filter((c) => c.kind === "dm");
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
  paintChannelNav();
}

function showView(view) {
  state.view = view;
  const agentsPane = document.getElementById("agents-pane");
  if (agentsPane) agentsPane.classList.toggle("hidden", view !== "agents");
  if (view === "agents") {
    document.getElementById("home-pane").classList.add("hidden");
    document.getElementById("chat-pane").classList.add("hidden");
    if (typeof setActiveTab === "function") setActiveTab("agents");
    loadAgentsView().catch((err) => {
      const b = document.getElementById("agents-body");
      if (b) b.innerHTML = `<p class="home-empty">${esc(friendlyError(err))}</p>`;
    });
    return;
  }
  if (typeof setActiveTab === "function") {
    const ch = (state.channels || []).find((c) => c.slug === state.channelSlug);
    setActiveTab(view === "home" ? "home" : view === "agents" ? "agents" : "chats");
  }
  const home = document.getElementById("home-pane");
  const chat = document.getElementById("chat-pane");
  const homeNav = document.getElementById("home-nav");
  if (view === "home") {
    home.classList.remove("hidden");
    chat.classList.add("hidden");
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
    try {
      localStorage.setItem(LAST_CHAT_KEY, state.channelSlug);
    } catch {
      /* ignore */
    }
    home.classList.add("hidden");
    chat.classList.remove("hidden");
    paintSessionStrip();
    if (homeNav) homeNav.classList.remove("active");
    refresh();
  }
}

/* ---- Command centre (v23): agents running, model pickers, git-main feed ---- */
const AGENT_ROSTER = [
  { name: "Claude", role: "Reviews, research, copy", aliases: ["claude"] },
  { name: "Cursor", role: "Builds on the Mac", aliases: ["cursor"] },
  { name: "Cursor-Cloud", role: "Cloud coordinator", aliases: ["cursor-cloud", "cursor cloud"] },
  { name: "ChatGPT", role: "Backup dispatch, research", aliases: ["chatgpt"] },
  { name: "Nori", role: "Primary dispatch (Grok)", aliases: ["nori"] },
  { name: "Hermes", role: "Windows host agent", aliases: ["hermes", "windows-migration"] },
];
const MODEL_OPTIONS = {
  Claude: ["Claude Opus 5.5", "Claude Sonnet 5.5", "Claude Haiku 5.5", "Claude Fable 5.2"],
  Cursor: ["Auto", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT (latest)", "Gemini (latest)"],
  "Cursor-Cloud": ["Auto", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT (latest)"],
  ChatGPT: ["Default", "Fast", "Deep reasoning"],
  Nori: ["Grok (latest)", "Grok fast"],
  Hermes: ["Local (Ollama)", "FreeLLM gateway", "Claude Sonnet 5.5"],
};
const AGENT_ACTIVE_MS = 2 * 3600 * 1000;
const AGENT_RECENT_MS = 24 * 3600 * 1000;

function canonicalAgent(raw) {
  const low = String(raw || "").trim().toLowerCase();
  const hit = AGENT_ROSTER.find((a) => a.aliases.includes(low));
  return hit ? hit.name : null;
}

function agentStatus(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(t)) return { key: "idle", label: "No activity logged" };
  const age = Date.now() - t;
  if (age < AGENT_ACTIVE_MS) return { key: "active", label: "Running" };
  if (age < AGENT_RECENT_MS) return { key: "recent", label: "Recent" };
  return { key: "idle", label: "Idle" };
}

function clip(text, n) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

function dmSlugFor(agent) {
  const viewer = currentViewer().toLowerCase();
  const ch = (state.channels || []).find(
    (c) =>
      c.kind === "dm" &&
      (c.members || []).some((m) => String(m).toLowerCase() === agent.toLowerCase()) &&
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
  if (cloud) {
    const [mem, com, pref, prs, hb, js] = await Promise.allSettled([
      ghSharedMemory(),
      ghRecentCommits(20),
      ghLoadAgentPrefs(),
      ghRecentPulls(15),
      typeof ghHostHeartbeats === "function" ? ghHostHeartbeats() : Promise.resolve([]),
      typeof ghLoadJobState === "function" ? ghLoadJobState() : Promise.resolve({ dismissed: {} }),
    ]);
    if (prs.status === "fulfilled") pulls = prs.value;
    if (hb.status === "fulfilled") heartbeats = hb.value;
    state.dismissedJobs = js.status === "fulfilled" ? js.value.dismissed || {} : {};
    out.pullsSource = prs.status === "fulfilled" ? "pull requests" : "merge commits";
    if (mem.status === "fulfilled") events = mem.value;
    if (com.status === "fulfilled") commits = com.value;
    if (pref.status === "fulfilled") prefs = pref.value;
    state.ccErrors = [mem, com].filter((r) => r.status === "rejected").map((r) => friendlyError(r.reason));
  }
  state.agentPrefs = prefs.agents || {};

  // Latest shared-memory event per agent = "what it's doing".
  const latest = {};
  for (const ev of events) {
    const name = canonicalAgent(ev.agent);
    if (!name) continue;
    if (!latest[name] || String(ev.at) > String(latest[name].at)) latest[name] = ev;
  }
  out.agents = AGENT_ROSTER.map((a) => {
    const ev = latest[a.name];
    return { ...a, ev, ...{ status: agentStatus(ev && ev.at).key, statusLabel: agentStatus(ev && ev.at).label } };
  }).sort((x, y) => {
    const rank = { active: 0, recent: 1, idle: 2 };
    return rank[x.status] - rank[y.status] || String((y.ev && y.ev.at) || "").localeCompare(String((x.ev && x.ev.at) || ""));
  });
  out.agentsSource = cloud ? `shared memory · ${ghState.branch}` : "connect cloud hub for live status";

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
      <article class="agent-window status-${a.status}" data-agent="${esc(a.name)}">
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
          <label class="model-pick">
            <span class="sr-only">Preferred model for ${esc(a.name)}</span>
            <select data-agent="${esc(a.name)}" ${cloud ? "" : "disabled"}>${optionHtml}</select>
          </label>
          <time title="${esc(a.ev ? fmtTimeFull(a.ev.at) : "")}">${a.ev ? esc(fmtTime(a.ev.at)) : ""}</time>
          ${
            dm
              ? `<button type="button" class="aw-open home-open-channel" data-slug="${esc(dm)}">Chat${
                  unread ? ` <span class="unread-badge">${unread}</span>` : ""
                }</button>`
              : ""
          }
        </div>
      </article>`;
    })
    .join("")}</div>`;

  ({ html: out.jobsHtml, needs: out.needsCount, needsList: out.needsList, doneList: out.doneList } = buildJobs({ events, commits, pulls, agents: out.agents, cloud }));
  out.hostsHtml = buildHosts(heartbeats, events, cloud);
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
        .map(
          (f) => `
      <li class="feed-item kind-${esc(f.kind.toLowerCase())}">
        <details>
          <summary>
            <span class="feed-kind">${esc(f.kind)}</span>
            <span class="feed-title">${esc(f.title || clip(f.text, 70))}</span>
            <span class="feed-meta">${esc(f.who)} · <time title="${esc(fmtTimeFull(f.at))}">${esc(fmtTime(f.at))}</time></span>
          </summary>
          ${f.text ? `<p>${esc(f.text)}</p>` : ""}
          ${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">Open on GitHub ↗</a>` : ""}
        </details>
      </li>`
        )
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
// Agents shout BLOCKED in caps for real blockers; the rest are explicit asks of Seth.
const NEEDS_SETH_RE = /\bBLOCKED\b|\b[Ss]eth (still )?needs\b|\bneeds [Ss]eth\b|\bwaiting on [Ss]eth\b|\b[Ss]eth must\b|\b[Ss]eth: (tap|type|open|paste|run|approve|add)/;

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

function buildJobs({ events, commits, pulls, agents, cloud }) {
  const now = Date.now();
  const within = (iso, ms) => iso && now - new Date(iso).getTime() < ms;
  const needs = [];
  const running = [];
  const done = [];
  // v27: an agent "needs you" only if its LATEST entry asks for Seth. Finished results count only
  // if they shout BLOCKED. Anything Seth approved (hub jobs.json) is gone on every device.
  const evs = [...(events || [])].sort((x, y) => String(y.at).localeCompare(String(x.at)));
  const latestByAgent = {};
  for (const ev of evs) {
    const who = canonicalAgent(ev.agent) || ev.agent;
    if (!latestByAgent[who]) latestByAgent[who] = ev;
  }
  const dismissed = state.dismissedJobs || {};
  for (const ev of evs) {
    const who = canonicalAgent(ev.agent) || ev.agent;
    const title = String(ev.id || "").replace(/-\d{8}$/, "").replace(/[-_]+/g, " ");
    const text = ev.text || "";
    const asks = NEEDS_SETH_RE.test(text) && (ev.kind !== "result" || /\bBLOCKED\b/.test(text));
    const key = `ev-${who}-${String(ev.at)}`;
    if (latestByAgent[who] === ev && asks && within(ev.at, 72 * 3600000) && !dismissed[key]) {
      needs.push({ status: "blocked", title, text, who, at: ev.at });
    } else if (ev.kind === "result" && within(ev.at, 24 * 3600000)) {
      done.push({ status: "done", title, text, who, at: ev.at });
    }
  }
  if (Array.isArray(pulls)) {
    for (const p of pulls) {
      const job = { status: p.draft ? "draft" : p.state, number: p.number, title: p.title, who: p.author, branch: p.branch, at: p.at, url: p.url };
      if (p.state === "open" && !dismissed[`pr-${p.number}`]) needs.unshift({ ...job, text: p.draft ? "Draft PR" : "Waiting for review / merge" });
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
    return `<div class="job-actions">
      <button type="button" class="act act-primary" data-act="approve" data-key="${esc(j.key)}">Approve</button>
      <button type="button" class="act" data-act="reply" data-key="${esc(j.key)}">Reply</button>
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
  const card = btn.closest(".job-card");
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
    if (act === "approve") {
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
      } catch {
        /* local snooze still hides it on this phone */
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
  const agentsHtml = `
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

/* Hosts: heartbeat branch first, shared memory as fallback. */
const HOSTS = [
  { name: "Windows PC", role: "Always-on host", ids: ["desktop-kg22uf0", "windows", "win"], match: /DESKTOP-KG22UF0|\bWindows (PC|host|DC|box|machine)\b/i },
  { name: "Mac", role: "MacBook (advisor)", ids: ["mac", "macbook", "seths-macbook"], match: /\bMacBook\b|\bMac (asleep|sleep|awake|wake|offline|online|not listed|DC|host)\b|\bwake Mac\b/i },
];
function hostClause(ev, re) {
  // Pull just the fragment about this PC out of a longer shared-memory line.
  const parts = String(ev.text || "").split(/[;.]\s+|\s—\s/);
  const hit = parts.find((p) => re.test(p)) || ev.text || "";
  const who = canonicalAgent(ev.agent) || ev.agent || "";
  return `${who ? who + ": " : ""}${clip(hit, 90)}`;
}
function buildHosts(heartbeats, events, cloud) {
  const now = Date.now();
  const rows = HOSTS.map((h) => {
    const hb = (heartbeats || []).find((b) =>
      h.ids.some((id) => String(b.host || b.file || "").toLowerCase().replace(/\.json$/, "").includes(id))
    );
    if (hb && hb.at) {
      const age = now - new Date(hb.at).getTime();
      const key = age < 15 * 60000 ? "online" : age < 2 * 3600000 ? "stale" : "offline";
      const label = { online: "Online", stale: "Quiet", offline: "Offline" }[key];
      const bits = [hb.tailscale ? `Tailscale ${hb.tailscale}` : "", hb.uptime ? `up ${hb.uptime}` : "", hb.battery || ""].filter(Boolean).join(" · ");
      return { ...h, key, label, at: hb.at, detail: bits || "Heartbeat received", source: "heartbeat" };
    }
    const ev = [...(events || [])]
      .filter((x) => h.match.test(x.text || ""))
      .sort((x, y) => String(y.at).localeCompare(String(x.at)))[0];
    return {
      ...h,
      key: "unknown",
      label: "No heartbeat",
      at: ev ? ev.at : "",
      detail: ev ? hostClause(ev, h.match) : "Nothing reported yet.",
      source: "memory",
    };
  });
  return `<div class="host-row">${rows
    .map(
      (h) => `
    <article class="host host-${h.key}">
      <div class="host-top">
        <span class="host-ico" aria-hidden="true">${h.name === "Mac" ? "⌘" : "⊞"}</span>
        <div class="host-id"><strong>${esc(h.name)}</strong><span>${esc(h.role)}</span></div>
        <span class="aw-pill"><span class="dot"></span>${esc(h.label)}</span>
      </div>
      <p class="host-detail">${esc(h.detail)}</p>
      ${h.at ? `<time title="${esc(fmtTimeFull(h.at))}">${h.source === "heartbeat" ? "Heartbeat" : "Seen"} ${esc(fmtTime(h.at))}</time>` : ""}
    </article>`
    )
    .join("")}</div>${
    cloud && !(heartbeats || []).length
      ? `<p class="home-empty small">Heartbeats start once each PC runs <code>Projects/The-Stack/heartbeat</code> (handed to Cursor).</p>`
      : ""
  }`;
}

/* Digest: what changed since the last time Seth tapped "Got it". */
function buildDigest({ events, pulls, needs, done }) {
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
  const after = (iso) => iso && String(new Date(iso).toISOString()) > since;
  const newEvents = (events || []).filter((e) => after(e.at));
  const finished = (done || []).filter((j) => after(j.at));
  const merged = (pulls || []).filter((p) => p.state === "merged" && after(p.at));
  const blocked = (needs || []).filter((j) => after(j.at));
  const who = [...new Set(newEvents.map((e) => canonicalAgent(e.agent) || e.agent))].filter(Boolean);
  if (!newEvents.length && !merged.length) return "";
  const parts = [];
  if (finished.length) parts.push(`<strong>${finished.length}</strong> finished`);
  if (merged.length) parts.push(`<strong>${merged.length}</strong> PR${merged.length > 1 ? "s" : ""} merged`);
  if (blocked.length) parts.push(`<strong class="warn">${blocked.length}</strong> need${blocked.length > 1 ? "" : "s"} you`);
  const top = finished.slice(0, 3).map((j) => clip(j.title, 40));
  return `<section class="digest" aria-label="Since you last looked">
    <div class="digest-head"><strong>Since you last looked</strong><span>${esc(fmtTime(since))}</span></div>
    <p>${parts.length ? parts.join(" · ") + ". " : ""}${who.length ? `${esc(who.join(", "))} logged ${newEvents.length} update${newEvents.length === 1 ? "" : "s"}.` : ""}${
      top.length ? ` Latest: ${top.map(esc).join("; ")}.` : ""
    }</p>
    <div class="digest-actions">
      ${blocked.length ? `<a class="act act-primary" href="#cc-jobs">See what needs you</a>` : ""}
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
  const branchLabel =
    state.cloudMode && typeof ghState !== "undefined"
      ? `${ghState.repo}@${ghState.branch}`
      : state.hostLabel;
  document.getElementById("home-headline").textContent = state.cloudMode
    ? `Live from ${typeof ghState !== "undefined" ? ghState.branch : "main"} · ${channelCount - dmCount} channels · ${dmCount} DMs`
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
      <div class="home-todo">
        <button type="button" class="tick" data-list="${esc(t.list_id || "")}" data-row="${esc(t.row_id || "")}" aria-label="Mark done: ${esc(t.item || "")}"></button>
        <div>
          <div>${esc(t.item || "(untitled)")}</div>
          <div class="owner">${esc(t.list || "")}${t.owner ? " · " + esc(t.owner) : ""}</div>
        </div>
        <button type="button" class="ghost home-open-list" data-list="${esc(t.list_id || "")}">List</button>
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
  const stats = [
    ["Needs you", cc.needsCount || 0, "jobs", (cc.needsCount || 0) > 0 ? "alert" : ""],
    ["Running now", running, "agents", running ? "live" : ""],
    ["To-dos", todos.length, "todos", ""],
  ]
    .map(([k, v, id, cls]) => `<a class="stat ${cls}" href="#cc-${id}"><strong>${v}</strong><span>${k}</span></a>`)
    .join("");
  const homeHtml = `
    ${emptyBanner}
    <label class="jump">
      <span class="jump-icon" aria-hidden="true">⌕</span>
      <input id="jump-input" type="search" placeholder="Search channels &amp; agents" autocomplete="off" enterkeyhint="go" />
    </label>
    <div id="jump-results" class="jump-results" hidden></div>
    ${cc.digestHtml || ""}
    ${state.cloudMode ? pushPromptHtml() : ""}
    <div class="stat-row">${stats}</div>
    <section class="home-section cc-panel" id="cc-jobs">
      <div class="cc-head"><h2>Jobs</h2><span class="cc-src">${esc(cc.pullsSource ? `shared memory + ${cc.pullsSource}` : "")}</span></div>
      ${cc.jobsHtml}
    </section>
    <section class="home-section cc-panel" id="cc-hosts">
      <div class="cc-head"><h2>Computers</h2><span class="cc-src">heartbeat · shared memory</span></div>
      ${cc.hostsHtml || ""}
    </section>
    <section class="home-section cc-panel" id="cc-agents">
      <div class="cc-head"><h2>Agents running</h2><span class="cc-src">${esc(cc.agentsSource)}</span></div>
      ${cc.agentsHtml}
    </section>
    <section class="home-section cc-panel" id="cc-todos">
      <div class="cc-head"><h2>To-dos</h2><span class="cc-src">${todos.length} open</span></div>
      <div class="home-cards">${todoHtml}</div>
    </section>
    <section class="home-section cc-panel" id="cc-feed">
      <div class="cc-head"><h2>What’s going on</h2><span class="cc-src">${esc(cc.feedSource)}</span></div>
      ${cc.feedHtml}
    </section>
    <section class="home-section" id="cc-mentions">
      <h2>Mentions</h2>
      ${mentionHtml}
    </section>
    <section class="home-section">
      <h2>Digest</h2>
      ${reportHtml}
    </section>`;
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
  const nextHtml = data.messages
    .map((m) => {
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
      return `
      <article class="msg${isMine ? " mine" : " agent"}" data-id="${esc(m.id)}">
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
          <button type="button" class="thread-link" data-parent="${esc(m.id)}">
            ${m.reply_count ? `${m.reply_count} replies` : "Reply in thread"}
          </button>
        </div>
      </article>`;
    })
    .join("");
  if (box.dataset.sig === nextHtml) return;
  box.dataset.sig = nextHtml;
  box.innerHTML = nextHtml;
  hydratePhotos(box);
  if (stick) box.scrollTop = box.scrollHeight;
  const last = data.messages[data.messages.length - 1];
  if (last?.created_at) markChannelRead(ch.slug || state.channelSlug, last.created_at);
  state.unreads[ch.slug || state.channelSlug] = 0;
}

async function loadMessages() {
  const key = `messages:${state.channelSlug}`;
  try {
    const data = await api(
      `/api/channels/${encodeURIComponent(state.channelSlug)}/messages`
    );
    await pocketSet(key, data);
    state.pocketMode = false;
    renderMessages(data);
  } catch (err) {
    const cached = await pocketGet(key);
    if (!cached) throw err;
    state.pocketMode = true;
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

async function boot() {
  const bootEl = document.getElementById("boot");
  const status = document.getElementById("boot-status");
  const retry = document.getElementById("boot-retry");
  retry.classList.add("hidden");
  const forceCloud = wantsCloudHub();

  if (typeof ghLoadCreds === "function") ghLoadCreds();

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
document.getElementById("rail-backdrop").addEventListener("click", () => setRailOpen(false));

/* Bottom tab bar (phone): Home · Chats · Agents · Lists. Desktop keeps the rail. */
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
  if (tab === "home") {
    setRailOpen(false);
    showView("home");
  } else if (tab === "chats") {
    setRailOpen(false);
    state.channelSlug = defaultChatSlug();
    state.threadParentId = null;
    document.getElementById("thread").classList.add("hidden");
    showView("channel");
  } else if (tab === "agents") {
    setRailOpen(false);
    showView("agents");
  } else if (tab === "lists") {
    setRailOpen(false);
    document.getElementById("lists-pane").classList.add("open");
    loadLists()
      .then(() => loadListDetail())
      .catch(() => {});
  }
  setActiveTab(tab);
});

/* Home jump search: filter channels + agent DMs, tap or Enter to open. */
function jumpMatches(q) {
  const viewer = currentViewer();
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return (state.channels || [])
    .map((c) => ({ c, label: c.kind === "dm" ? dmLabel(c, viewer) : `#${c.slug}` }))
    .filter(({ c, label }) =>
      [label, c.slug, c.purpose || ""].some((v) => String(v).toLowerCase().includes(needle))
    )
    .slice(0, 8);
}
document.getElementById("home-body")?.addEventListener("input", (e) => {
  if (e.target.id !== "jump-input") return;
  const box = document.getElementById("jump-results");
  const hits = jumpMatches(e.target.value);
  if (!e.target.value.trim()) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.innerHTML = hits.length
    ? hits
        .map(
          ({ c, label }) =>
            `<button type="button" class="jump-hit home-open-channel" data-slug="${esc(c.slug)}"><span class="jump-kind">${
              c.kind === "dm" ? "Agent" : "Channel"
            }</span>${esc(label)}</button>`
        )
        .join("")
    : `<p class="home-empty">No channel or agent matches “${esc(e.target.value.trim())}”.</p>`;
  box.hidden = false;
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
  const btn = e.target.closest(".thread-link");
  if (!btn) return;
  e.preventDefault();
  openThread(btn.dataset.parent);
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
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  const path = `/api/channels/${encodeURIComponent(state.channelSlug)}/messages`;
  const payload = { author, body };
  try {
    if (pending.length) {
      if (!state.cloudMode) throw new Error("Photos need the cloud hub (open with ?cloud=1).");
      if (btn) btn.textContent = "Uploading…";
      payload.attachments = [];
      for (const p of pending) payload.attachments.push(await ghUploadAttachment(state.channelSlug, p.blob, "jpg"));
    }
    await api(path, { method: "POST", body: JSON.stringify(payload) });
    clearPendingPhotos();
    document.getElementById("body").value = "";
    autosize(document.getElementById("body"));
    await loadMessages();
  } catch (err) {
    await pocketOutboxPush({ path, method: "POST", body: payload, at: new Date().toISOString() });
    const key = `messages:${state.channelSlug}`;
    const cached = (await pocketGet(key)) || {
      channel: { slug: state.channelSlug, purpose: "" },
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
    renderMessages(cached);
    setLive(false, "queued in pocket");
  } finally {
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

if ("serviceWorker" in navigator) {
  // Explicit relative scope so GitHub Pages /the-stack-ui/ is covered (not site root).
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
}

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
