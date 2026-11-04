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

const READS_KEY = "stack-reads-v1";
const QUICK_REACTIONS = ["👍", "👀", "✅", "❤️", "🔥"];

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
    <strong>Cloud hub</strong> — no Mac, no same Wi‑Fi.<br/>
    Connect with a GitHub token that can read/write the vault hub files.
    ${errMsg ? `<br/><span class="boot-err">${esc(errMsg)}</span>` : ""}
  `;
  let form = document.getElementById("cloud-connect");
  if (!form) {
    form = document.createElement("form");
    form.id = "cloud-connect";
    form.className = "cloud-connect";
    form.innerHTML = `
      <label>Repo
        <input name="repo" value="lilfangsproject-wq/ai-workspace" autocomplete="off" required />
      </label>
      <label>Branch
        <input name="branch" value="cursor/the-stack-hub-github-sync" autocomplete="off" required />
      </label>
      <label>GitHub PAT (Contents R/W)
        <input name="token" type="password" autocomplete="off" required placeholder="github_pat_…" />
      </label>
      <button type="submit">Open cloud hub</button>
      <p class="cloud-help">Token stays in this browser only. Create a fine-grained PAT with Contents Read/Write on private ai-workspace only. Phone URL: GitHub Pages (see CLOUD.md) — no Mac required.</p>
    `;
    document.querySelector(".boot-card").appendChild(form);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      ghState.repo = String(fd.get("repo") || "").trim();
      ghState.branch = String(fd.get("branch") || "main").trim();
      ghState.token = String(fd.get("token") || "").trim();
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
  if (!ghState.token) {
    showCloudConnect();
    return false;
  }
  status.textContent = "Connecting to GitHub hub…";
  try {
    const health = await api("/api/health");
    // Prove hub readable
    await api("/api/channels");
    state.hostLabel = "github";
    status.textContent = `Cloud · ${health.host}`;
    if (form) form.classList.add("hidden");
    await loadTokenHint();
    const el = document.getElementById("phone-hint");
    el.hidden = false;
    el.textContent =
      "Cloud mode · vault SoT on GitHub · Mac not required · Add to Home Screen";
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
    showCloudConnect(String(err.message || err));
    setLive(false, String(err));
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
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
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
    copy.textContent = "Install The Stack: browser menu → Install app / Add to Home Screen";
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
}

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
  const home = document.getElementById("home-pane");
  const chat = document.getElementById("chat-pane");
  const homeNav = document.getElementById("home-nav");
  if (view === "home") {
    home.classList.remove("hidden");
    chat.classList.add("hidden");
    if (homeNav) homeNav.classList.add("active");
    document.querySelectorAll("#channel-list button").forEach((b) => b.classList.remove("active"));
    loadHome().catch(() => {});
  } else {
    home.classList.add("hidden");
    chat.classList.remove("hidden");
    if (homeNav) homeNav.classList.remove("active");
    refresh();
  }
}

async function loadHome() {
  let data;
  try {
    data = await api(`/api/home?viewer=${encodeURIComponent(currentViewer())}`);
    await pocketSet("home", data);
    state.pocketMode = false;
  } catch (err) {
    data = await pocketGet("home");
    if (!data) throw err;
    state.pocketMode = true;
  }
  document.getElementById("home-headline").textContent =
    data.summary?.headline || "Agent hub";
  const body = document.getElementById("home-body");
  const todos = data.todos || [];
  const reports = data.reports || [];
  const mentions = data.mentions || [];
  const todoHtml = todos.length
    ? todos
        .map(
          (t) => `
      <div class="home-todo">
        <span class="status">${esc(t.status || "open")}</span>
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
          <span class="ch">${r.kind === "dm" ? "DM" : "#"}${esc(r.channel)}</span>
          <time>${esc(fmtTime(r.created_at))}</time>
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
          <span class="ch">#${esc(r.channel)}</span>
          <time>${esc(fmtTime(r.created_at))}</time>
        </div>
        <div class="preview">${esc(r.preview || r.body || "")}</div>
      </button>`
        )
        .join("")}</div>`
    : `<p class="home-empty">No reports yet. Agents post into #the-digest.</p>`;
  body.innerHTML = `
    <section class="home-section">
      <h2>Mentions</h2>
      ${mentionHtml}
    </section>
    <section class="home-section">
      <h2>Open todos</h2>
      <div class="home-cards">${todoHtml}</div>
    </section>
    <section class="home-section">
      <h2>What’s going on</h2>
      ${reportHtml}
    </section>`;
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
      ? `Message ${dmLabel(ch, viewer)} · @Name to mention`
      : `Message #${ch.slug} · @Name to mention`;
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
      return `
      <article class="msg" data-id="${esc(m.id)}">
        <div class="meta"><strong>${esc(m.author)}</strong><time>${esc(
          fmtTime(m.created_at)
        )}</time></div>
        <div class="body">${formatBodyHtml(m.body)}</div>
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
  const head = list.columns.map((c) => `<th>${esc(c)}</th>`).join("");
  const rows = list.rows
    .map(
      (r) =>
        `<tr>${r.cells.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`
    )
    .join("");
  document.getElementById("list-table").innerHTML = `
    <table>
      <thead><tr>${head}</tr></thead>
      <tbody>${rows || `<tr><td colspan="${list.columns.length}">No rows yet</td></tr>`}</tbody>
    </table>`;
}

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

document.getElementById("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const author = document.getElementById("author").value.trim() || "Seth";
  const body = document.getElementById("body").value.trim();
  if (!body) return;
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  const path = `/api/channels/${encodeURIComponent(state.channelSlug)}/messages`;
  const payload = { author, body };
  try {
    await api(path, { method: "POST", body: JSON.stringify(payload) });
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
    if (btn) btn.disabled = false;
  }
});

document.getElementById("body").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("composer").requestSubmit();
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

boot();
state.pollTimer = setInterval(() => {
  // Do not poll while the boot/connect card is showing (Pages has no /api).
  if (!shellReady()) return;
  if (state.pocketMode && !state.cloudMode) return;
  if (state.cloudMode && !ghState?.token) return;
  // Cloud polls slower to respect GitHub API limits
  if (state.cloudMode && state._cloudTick && Date.now() - state._cloudTick < 18000) return;
  if (state.cloudMode) state._cloudTick = Date.now();
  const tick =
    state.view === "home"
      ? loadHome()
      : loadMessages().then(() => {
          if (state.threadParentId && !state.pocketMode) {
            return openThread(state.threadParentId);
          }
        });
  tick
    .then(() => {
      if (!state.pocketMode) setLive(true);
      return pocketFlushOutbox();
    })
    .catch(() => setLive(false));
}, 4000);
