/* The Stack — GitHub vault hub client (no Mac required). */
const GH_DEFAULT_REPO = "lilfangsproject-wq/ai-workspace";
// PR #39 merged — hub SoT is on main.
const GH_DEFAULT_BRANCH = "main";
const GH_HUB_PREFIX = "Projects/The-Stack/hub";
const GH_LS_KEY = "stack-github-hub-v1";

const ghState = {
  token: "",
  repo: GH_DEFAULT_REPO,
  branch: GH_DEFAULT_BRANCH,
  enabled: false,
};

function ghLoadCreds() {
  try {
    const raw = localStorage.getItem(GH_LS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    ghState.token = data.token || "";
    ghState.repo = data.repo || GH_DEFAULT_REPO;
    // Old phone sessions pointed at the PR branch; main now has the hub.
    let branch = data.branch || GH_DEFAULT_BRANCH;
    if (
      !branch ||
      branch === "cursor/the-stack-hub-github-sync" ||
      branch.startsWith("cursor/the-stack-")
    ) {
      branch = GH_DEFAULT_BRANCH;
    }
    ghState.branch = branch;
    ghState.enabled = Boolean(ghState.token);
    if (data.branch !== ghState.branch && ghState.token) {
      ghSaveCreds();
    }
  } catch {
    /* ignore */
  }
}

function ghResetSession() {
  try {
    localStorage.removeItem(GH_LS_KEY);
    localStorage.removeItem("stack-reads-v1");
    localStorage.removeItem("stack-install-dismissed");
  } catch {
    /* ignore */
  }
  ghState.token = "";
  ghState.repo = GH_DEFAULT_REPO;
  ghState.branch = GH_DEFAULT_BRANCH;
  ghState.enabled = false;
}

function ghSaveCreds() {
  localStorage.setItem(
    GH_LS_KEY,
    JSON.stringify({
      token: ghState.token,
      repo: ghState.repo,
      branch: ghState.branch,
    })
  );
  ghState.enabled = Boolean(ghState.token);
}

function ghClearCreds() {
  localStorage.removeItem(GH_LS_KEY);
  ghState.token = "";
  ghState.enabled = false;
}

function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64decode(str) {
  return decodeURIComponent(escape(atob(str.replace(/\n/g, ""))));
}

function ghIsConflict(err) {
  const status = err && err.status;
  const msg = String((err && err.message) || err || "").toLowerCase();
  return status === 409 || msg.includes("conflict") || msg.includes("does not match");
}

function ghSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ghSanitizeToken(raw) {
  // iOS paste can add spaces, newlines, or zero-width chars that make fetch throw.
  return String(raw || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

const ghEtags = new Map(); // url+accept -> { etag, status, body, headers }
const ghRate = { remaining: null, reset: 0 };
async function ghFetchOnce(url, init) {
  const method = String((init && init.method) || "GET").toUpperCase();
  const headers = { ...((init && init.headers) || {}) };
  const key = `${url}|${headers.Accept || ""}`;
  const cached = method === "GET" ? ghEtags.get(key) : null;
  if (cached && cached.etag) headers["If-None-Match"] = cached.etag;
  const res = await fetch(url, { ...init, headers, cache: "no-store", credentials: "omit", mode: "cors" });
  const rem = res.headers.get("x-ratelimit-remaining");
  if (rem !== null) {
    ghRate.remaining = Number(rem);
    ghRate.reset = Number(res.headers.get("x-ratelimit-reset") || 0) * 1000;
  }
  if (res.status === 304 && cached) {
    // Unchanged: replay the cached body (free — no rate-limit cost).
    return new Response(cached.body, { status: cached.status, headers: { "content-type": cached.type || "application/json" } });
  }
  if (method === "GET" && res.ok) {
    const etag = res.headers.get("etag");
    if (etag) {
      const body = await res.clone().arrayBuffer();
      if (body.byteLength < 2_000_000) {
        ghEtags.set(key, { etag, status: res.status, body, type: res.headers.get("content-type") });
      }
    }
  } else if (method !== "GET") {
    ghEtags.clear(); // a write may change anything we cached
  }
  return res;
}

async function ghFetch(url, init, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await ghFetchOnce(url, init);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

async function ghProbeGithub() {
  // Split "phone can't reach GitHub at all" from "token/auth problem".
  try {
    const res = await ghFetch("https://api.github.com/zen", {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`zen_${res.status}`);
  } catch (err) {
    const wrapped = new Error(
      "This phone cannot reach api.github.com (blocked Wi‑Fi, VPN, content blocker, or offline). Open https://api.github.com/zen in Safari — if that fails, switch network and retry."
    );
    wrapped.cause = err;
    wrapped.status = 0;
    throw wrapped;
  }
}

async function ghApi(path, options = {}) {
  const token = ghSanitizeToken(ghState.token);
  if (token && token !== ghState.token) ghState.token = token;
  if (!token) {
    const err = new Error("Paste a GitHub fine-grained PAT first (Contents Read/Write on ai-workspace).");
    err.status = 401;
    throw err;
  }
  if (!/^[\x21-\x7E]+$/.test(token)) {
    const err = new Error(
      "GitHub token has invalid characters after paste — clear the field and paste again from GitHub (no spaces/quotes)."
    );
    err.status = 401;
    throw err;
  }
  let res;
  try {
    res = await ghFetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    // Safari often surfaces offline/CORS blips as TypeError: Load failed.
    const detail = err && err.message ? String(err.message) : "";
    const wrapped = new Error(
      detail && /load failed|failed to fetch|network/i.test(detail)
        ? "Could not reach GitHub from this phone (network). In Safari open https://api.github.com/zen — if that fails, switch Wi‑Fi/cellular or disable content blockers for github.com + github.io, then open ?cloud=1&reset=1."
        : "Could not reach GitHub from this phone (network). Check signal/Wi‑Fi, disable content blockers for this site, try cellular ↔ Wi‑Fi, then try again."
    );
    wrapped.cause = err;
    wrapped.status = 0;
    throw wrapped;
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    if ((res.status === 403 || res.status === 429) && /rate limit/i.test(String(data.message || ""))) {
      const at = ghRate.reset ? new Date(ghRate.reset).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "soon";
      const err = new Error(`GitHub's hourly limit is used up. The Stack will pause and resume at ${at}.`);
      err.status = 429;
      err.rateLimited = true;
      throw err;
    }
    const err = new Error(
      data.message || data.error || res.statusText || String(res.status)
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function ghGetFile(relPath) {
  const path = `${GH_HUB_PREFIX}/${relPath}`.replace(/\/+/g, "/");
  const url = `/repos/${ghState.repo}/contents/${path}?ref=${encodeURIComponent(ghState.branch)}`;
  try {
    const data = await ghApi(url);
    return {
      path,
      sha: data.sha,
      text: b64decode(data.content || ""),
    };
  } catch (err) {
    if (err.status === 404 || String(err.message || err).includes("Not Found")) {
      return { path, sha: null, text: "" };
    }
    throw err;
  }
}

async function ghPutFile(relPath, textOrBuilder, message, { attempts = 4 } = {}) {
  // textOrBuilder: string, or async (existingFile) => string for conflict-safe RMW/append.
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const existing = await ghGetFile(relPath);
    const path = existing.path;
    const text =
      typeof textOrBuilder === "function"
        ? await textOrBuilder(existing)
        : textOrBuilder;
    const body = {
      message: message || `stack: update ${relPath}`,
      content: b64encode(text),
      branch: ghState.branch,
    };
    if (existing.sha) body.sha = existing.sha;
    try {
      return await ghApi(`/repos/${ghState.repo}/contents/${path}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastErr = err;
      // Phone + agent raced — re-read and rebuild payload, then retry.
      if (ghIsConflict(err) && i < attempts - 1) {
        await ghSleep(150 * (i + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function ghReadJson(relPath, fallback) {
  const file = await ghGetFile(relPath);
  if (!file.text) return fallback;
  return JSON.parse(file.text);
}

/* ---- Command centre feeds (v23): repo-wide reads on main, hub agent prefs ---- */
const GH_MEMORY_PATH = "Cloud/memory/state.json";

async function ghReadRepoJson(repoPath) {
  // Raw media type: no base64, works for files up to GitHub's 100 MB raw limit.
  const url = `/repos/${ghState.repo}/contents/${repoPath}?ref=${encodeURIComponent(ghState.branch)}`;
  return ghApi(url, { headers: { Accept: "application/vnd.github.raw+json" } });
}

async function ghSharedMemory() {
  const data = await ghReadRepoJson(GH_MEMORY_PATH);
  return Array.isArray(data.events) ? data.events : [];
}

async function ghRecentCommits(limit = 12) {
  const rows = await ghApi(
    `/repos/${ghState.repo}/commits?sha=${encodeURIComponent(ghState.branch)}&per_page=${limit}`
  );
  return (Array.isArray(rows) ? rows : []).map((c) => ({
    sha: c.sha,
    message: (c.commit && c.commit.message) || "",
    author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || "",
    at: (c.commit && c.commit.author && c.commit.author.date) || "",
    url: c.html_url || "",
  }));
}

async function ghRecentPulls(limit = 15) {
  // Needs "Pull requests: Read" on a fine-grained PAT; callers fall back to merge commits.
  const rows = await ghApi(
    `/repos/${ghState.repo}/pulls?state=all&sort=updated&direction=desc&per_page=${limit}`
  );
  return (Array.isArray(rows) ? rows : []).map((p) => ({
    number: p.number,
    title: p.title || "",
    state: p.merged_at ? "merged" : p.state,
    draft: Boolean(p.draft),
    author: (p.user && p.user.login) || "",
    branch: (p.head && p.head.ref) || "",
    at: p.merged_at || p.closed_at || p.updated_at || p.created_at || "",
    url: p.html_url || "",
  }));
}

/* ---- v24: hosts, PR merge, photos, push ---- */
const GH_HEARTBEAT_BRANCH = "heartbeat";

async function ghHostHeartbeats() {
  // Hosts write hosts/<name>.json on the heartbeat branch (keeps main history clean).
  let list;
  try {
    list = await ghApi(`/repos/${ghState.repo}/contents/hosts?ref=${GH_HEARTBEAT_BRANCH}`);
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
  const files = (Array.isArray(list) ? list : []).filter((f) => /\.json$/.test(f.name));
  const rows = await Promise.all(
    files.map(async (f) => {
      try {
        const data = await ghApi(
          `/repos/${ghState.repo}/contents/${f.path}?ref=${GH_HEARTBEAT_BRANCH}`,
          { headers: { Accept: "application/vnd.github.raw+json" } }
        );
        return { file: f.name, ...data };
      } catch {
        return null;
      }
    })
  );
  return rows.filter(Boolean);
}

async function ghMergePull(number, title) {
  return ghApi(`/repos/${ghState.repo}/pulls/${number}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: "merge", commit_title: `Merge PR #${number} from The Stack: ${title || ""}`.trim() }),
  });
}

async function ghUploadAttachment(slug, blob, ext = "jpg") {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  const name = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const rel = `attachments/${slug}/${name}`;
  const path = `${GH_HUB_PREFIX}/${rel}`;
  await ghApi(`/repos/${ghState.repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message: `stack: photo in ${slug}`, content: btoa(bin), branch: ghState.branch }),
  });
  return { path: rel, name, type: blob.type || "image/jpeg", size: buf.length };
}

const ghAttachmentCache = new Map();
async function ghAttachmentUrl(rel) {
  // Private repo: fetch with the token, hand the <img> a blob URL.
  if (ghAttachmentCache.has(rel)) return ghAttachmentCache.get(rel);
  const p = (async () => {
    const token = ghSanitizeToken(ghState.token);
    const res = await ghFetch(
      `https://api.github.com/repos/${ghState.repo}/contents/${GH_HUB_PREFIX}/${rel}?ref=${encodeURIComponent(ghState.branch)}`,
      { headers: { Accept: "application/vnd.github.raw", Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`photo_${res.status}`);
    return URL.createObjectURL(await res.blob());
  })();
  ghAttachmentCache.set(rel, p);
  p.catch(() => ghAttachmentCache.delete(rel));
  return p;
}

async function ghSavePushSubscription(sub, who = "Seth") {
  const json = sub.toJSON ? sub.toJSON() : sub;
  return ghPutFile(
    "push/subscriptions.json",
    async (existing) => {
      let data = { subscriptions: [] };
      try {
        if (existing.text) data = JSON.parse(existing.text);
      } catch {
        /* rebuild */
      }
      const rest = (data.subscriptions || []).filter((s) => s.endpoint !== json.endpoint);
      rest.push({ ...json, who, ua: navigator.userAgent.slice(0, 120), added_at: new Date().toISOString() });
      return JSON.stringify({ note: "Web push subscriptions for The Stack (sent by .github/workflows/stack-push.yml).", subscriptions: rest }, null, 2) + "\n";
    },
    "stack: push subscription"
  );
}

/* v27: job dismissals shared across devices (Approve writes here; Snooze stays per-phone). */
async function ghLoadJobState() {
  const data = await ghReadJson("jobs.json", { dismissed: {} });
  return data && data.dismissed ? data : { dismissed: {} };
}
async function ghDismissJob(key, info) {
  return ghPutFile(
    "jobs.json",
    async (existing) => {
      let data = { dismissed: {} };
      try {
        if (existing.text) data = JSON.parse(existing.text);
      } catch {
        /* rebuild */
      }
      data.note = "Jobs Seth approved/dismissed in The Stack. Keys: pr-<n> or ev-<agent>-<iso time>.";
      data.dismissed = data.dismissed || {};
      data.dismissed[key] = { ...info, at: new Date().toISOString() };
      return JSON.stringify(data, null, 2) + "\n";
    },
    `stack: job ${info && info.action ? info.action : "dismissed"}`
  );
}

/* v31.0: structured handovers (hub/handovers.jsonl) — not ordinary chat. */
const GH_HANDOVER_NEEDS_SETH = new Set([
  "FAILED_DISPATCH",
  "BLOCKED",
  "ESCALATED",
  "REJECTED",
]);

function ghParseHandoversJsonl(text) {
  const byId = new Map();
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    try {
      const row = JSON.parse(t);
      if (row && row.id) byId.set(row.id, row);
    } catch {
      /* skip corrupt line */
    }
  }
  return [...byId.values()].sort((a, b) =>
    String(b.created_at || "").localeCompare(String(a.created_at || ""))
  );
}

async function ghListHandovers() {
  const file = await ghGetFile("handovers.jsonl");
  return ghParseHandoversJsonl(file.text);
}

async function ghGetHandover(id) {
  const rows = await ghListHandovers();
  return rows.find((r) => r.id === id) || null;
}

async function ghAppendHandoverSnapshot(rec, message) {
  if (!rec || !rec.id) throw new Error("handover_id_required");
  return ghPutFile(
    "handovers.jsonl",
    async (existing) =>
      (existing.text ? existing.text.replace(/\s*$/, "\n") : "") +
      JSON.stringify(rec) +
      "\n",
    message || `stack: handover ${rec.id} → ${rec.status}`
  );
}

async function ghLoadNeedsSeth() {
  const data = await ghReadJson("needs_seth.json", { items: [] });
  const items = Array.isArray(data && data.items) ? data.items : [];
  return items.filter((i) => i && !i.resolved);
}

async function ghResolveNeedsSeth(key, info = {}) {
  return ghPutFile(
    "needs_seth.json",
    async (existing) => {
      let data = { items: [] };
      try {
        if (existing.text) data = JSON.parse(existing.text);
      } catch {
        /* rebuild */
      }
      data.note =
        "Unified Needs Seth inbox for The Stack v31. Items requiring Seth action — not a noisy activity feed. Deduped by key.";
      data.items = (data.items || []).map((item) =>
        item.key === key
          ? {
              ...item,
              resolved: true,
              unread: false,
              resolved_at: new Date().toISOString(),
              resolved_by: (info && info.by) || "Seth",
              resolve_action: (info && info.action) || "resolved",
            }
          : item
      );
      data.updated_at = new Date().toISOString();
      return JSON.stringify(data, null, 2) + "\n";
    },
    `stack: needs-seth ${info && info.action ? info.action : "resolved"}`
  );
}

function ghHandoverToNeedsJob(h) {
  const status = String(h.status || "");
  const blocked = GH_HANDOVER_NEEDS_SETH.has(status) || status === "DISPATCHED";
  // DISPATCHED without ack is visible but only FAILED/BLOCKED/ESCALATED/REJECTED are urgent Needs-you.
  const urgent = GH_HANDOVER_NEEDS_SETH.has(status);
  if (!urgent && status !== "DISPATCHED" && status !== "ACKNOWLEDGED" && status !== "IN_PROGRESS") {
    return null;
  }
  return {
    status: urgent ? "blocked" : status === "IN_PROGRESS" ? "running" : "open",
    title: `Handover ${status}: ${String(h.description || h.id).slice(0, 80)}`,
    text: `task ${h.task_id || "?"} · ${h.from_agent || "?"} → ${h.to_agent || "?"} · ack=${h.ack_status || "pending"}`,
    who: h.to_agent || h.from_agent || "handover",
    at: h.created_at || "",
    handover_id: h.id,
    task_id: h.task_id,
    priority: h.priority,
    kind: "handover",
    urgent,
  };
}

/* v31: last-read cursors synced across devices (hub/reads.json). */
async function ghLoadReads() {
  const data = await ghReadJson("reads.json", { reads: {} });
  return data && data.reads && typeof data.reads === "object" ? data.reads : {};
}
async function ghSaveReads(reads) {
  return ghPutFile(
    "reads.json",
    async (existing) => {
      let data = { reads: {} };
      try {
        if (existing.text) data = JSON.parse(existing.text);
      } catch {
        /* rebuild */
      }
      data.note =
        "Per-channel last-read cursors for The Stack (unread badges). Synced across Seth's devices; not agent-facing.";
      data.reads = reads && typeof reads === "object" ? reads : {};
      data.updated_at = new Date().toISOString();
      return JSON.stringify(data, null, 2) + "\n";
    },
    "stack: reads"
  );
}

/* v30 personal notes: hub/notes.json (private repo, synced across devices). */
async function ghLoadNotes() {
  const data = await ghReadJson("notes.json", { notes: [] });
  return Array.isArray(data && data.notes) ? data.notes : [];
}
async function ghSaveNotes(mutate, message = "stack: notes") {
  return ghPutFile(
    "notes.json",
    async (existing) => {
      let data = { notes: [] };
      try {
        if (existing.text) data = JSON.parse(existing.text);
      } catch {
        /* rebuild */
      }
      data.note = "Seth's personal notes from The Stack (Notes tab). Private to Seth; agents read only if he asks.";
      data.notes = mutate(Array.isArray(data.notes) ? data.notes : []);
      return JSON.stringify(data, null, 2) + "\n";
    },
    message
  );
}

async function ghLoadWorkstreams() {
  const data = await ghReadJson("workstreams.json", { workstreams: [], opportunities: [], links: {}, vision: {} });
  return data && typeof data === "object" ? data : { workstreams: [], opportunities: [], links: {}, vision: {} };
}

async function ghLoadAgentPrefs() {
  const data = await ghReadJson("agents.json", { agents: {} });
  return data && data.agents ? data : { agents: {} };
}

async function ghSaveAgentModel(agent, model, by = "Seth") {
  return ghPutFile(
    "agents.json",
    async (existing) => {
      let data = { version: 1, agents: {} };
      try {
        if (existing.text) data = JSON.parse(existing.text);
      } catch {
        /* rebuild */
      }
      data.agents = data.agents || {};
      data.note =
        "Preferred model per agent, set from The Stack phone hub. Agents read this at job start; it is a preference, not a remote switch.";
      data.agents[agent] = { ...(data.agents[agent] || {}), model, set_by: by, set_at: new Date().toISOString() };
      return JSON.stringify(data, null, 2) + "\n";
    },
    `stack: ${agent} preferred model → ${model}`
  );
}

async function ghListChannels() {
  const data = await ghReadJson("channels.json", { channels: [] });
  return data.channels || [];
}

function ghReactionsForMessage(byMessage, messageId) {
  const raw = (byMessage && byMessage[messageId]) || {};
  const out = [];
  for (const [emoji, authors] of Object.entries(raw)) {
    const names = (authors || []).map((a) => String(a || "").trim()).filter(Boolean);
    if (!names.length) continue;
    out.push({ emoji, authors: names, count: names.length });
  }
  out.sort((a, b) => b.count - a.count || String(a.emoji).localeCompare(String(b.emoji)));
  return out;
}

async function ghLoadReactions(slug) {
  const data = await ghReadJson(`channels/${slug}/reactions.json`, { by_message: {} });
  return data.by_message || {};
}

async function ghToggleReaction(slug, messageId, { emoji, author }) {
  const mark = String(emoji || "").trim();
  if (!mark) throw new Error("emoji_required");
  const who = (author || "Seth").trim() || "Seth";
  let added = false;
  let finalByMessage = {};
  await ghPutFile(
    `channels/${slug}/reactions.json`,
    async (existing) => {
      let byMessage = {};
      try {
        byMessage = existing.text
          ? JSON.parse(existing.text).by_message || {}
          : {};
      } catch {
        byMessage = {};
      }
      const bucket = { ...(byMessage[messageId] || {}) };
      const authors = [...(bucket[mark] || [])].map((a) => String(a));
      const has = authors.some((a) => a.toLowerCase() === who.toLowerCase());
      const nextAuthors = has
        ? authors.filter((a) => a.toLowerCase() !== who.toLowerCase())
        : [...authors, who];
      added = !has;
      if (nextAuthors.length) bucket[mark] = nextAuthors;
      else delete bucket[mark];
      if (Object.keys(bucket).length) byMessage[messageId] = bucket;
      else delete byMessage[messageId];
      finalByMessage = byMessage;
      return (
        JSON.stringify(
          { by_message: byMessage, updated_at: new Date().toISOString() },
          null,
          2
        ) + "\n"
      );
    },
    `stack: reaction ${mark} on ${slug}`
  );
  return {
    ok: true,
    message_id: messageId,
    emoji: mark,
    author: who,
    added,
    reactions: ghReactionsForMessage(finalByMessage, messageId),
  };
}

async function ghListMessages(slug, parentId = null) {
  const file = await ghGetFile(`channels/${slug}/messages.jsonl`);
  const byMessage = await ghLoadReactions(slug);
  const rows = [];
  const all = [];
  for (const line of file.text.split("\n")) {
    if (!line.trim()) continue;
    try {
      all.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  for (const row of all) {
    if (parentId) {
      if (row.parent_id === parentId) rows.push(row);
    } else if (!row.parent_id) {
      rows.push(row);
    }
  }
  rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  if (!parentId) {
    const counts = {};
    for (const row of all) {
      if (row.parent_id) counts[row.parent_id] = (counts[row.parent_id] || 0) + 1;
    }
    for (const row of rows) row.reply_count = counts[row.id] || 0;
  }
  for (const row of rows) {
    row.reactions = ghReactionsForMessage(byMessage, row.id);
  }
  return rows;
}

function ghExtractMentions(body) {
  const found = [];
  const seen = new Set();
  const re = /(?<![\w/])@([A-Za-z][A-Za-z0-9_-]{0,31})/g;
  let m;
  while ((m = re.exec(body || ""))) {
    const key = m[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(m[1]);
  }
  return found;
}

function ghDmSlug(a, b) {
  const parts = [String(a || "Seth"), String(b || "Seth")]
    .map((n) => n.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter(Boolean)
    .sort();
  return "dm-" + [...new Set(parts)].join("-");
}

const GH_WAKEABLE = {
  gemini: "Gemini",
  chatgpt: "ChatGPT",
  gpt: "ChatGPT",
  cursor: "Cursor",
  "cursor-cloud": "Cursor",
  claude: "Claude",
  "real-claude": "Claude",
  nori: "Nori",
  grokbot: "Grokbot",
  grok: "Grokbot",
};
const GH_RETIRED_OR_EXCLUDED = new Set([
  "codex",
  "openclaw",
  "hermes",
]);
const GH_HUMAN = new Set(["seth", "viewer", "me", "you"]);

function ghResolveWakeTargets(channel, author, mentions) {
  const authorL = String(author || "").toLowerCase();
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const key = String(raw || "").trim().toLowerCase();
    if (!key || GH_HUMAN.has(key) || key === authorL) return;
    if (GH_RETIRED_OR_EXCLUDED.has(key)) return;
    const target = GH_WAKEABLE[key] || String(raw).trim();
    const sk = target.toLowerCase();
    if (seen.has(sk)) return;
    seen.add(sk);
    out.push(target);
  };
  if (channel && channel.kind === "dm") {
    for (const m of channel.members || []) add(m);
  }
  for (const m of mentions || []) add(m);
  return out;
}

async function ghPutRepoFile(repoPath, text, message) {
  const path = String(repoPath).replace(/^\/+/, "");
  const url = `/repos/${ghState.repo}/contents/${path}`;
  let sha;
  try {
    const cur = await ghApi(`${url}?ref=${encodeURIComponent(ghState.branch)}`);
    sha = cur && cur.sha;
  } catch (err) {
    if (!(err && err.status === 404)) throw err;
  }
  const content = btoa(unescape(encodeURIComponent(text)));
  const body = { message, content, branch: ghState.branch };
  if (sha) body.sha = sha;
  return ghApi(url, { method: "PUT", body: JSON.stringify(body) });
}

/** Cloud Pages path: durable Cloud Wake + repository_dispatch (no Slack). */
async function ghStackWakeFromMessage(channel, row) {
  const targets = ghResolveWakeTargets(channel, row.author, row.mentions);
  if (!targets.length) return { targets: [], deliveries: [] };
  const wakeId = crypto.randomUUID();
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const slug = (channel && channel.slug) || row.channel_slug || "?";
  const subject = `Stack · #${slug}`;
  const body =
    `${row.body || ""}\n\n— via The Stack cloud bus (not Slack)\n` +
    `channel=\`${slug}\` message=\`${row.id}\` author=\`${row.author}\``;
  const ev = {
    id: wakeId,
    created_at: created,
    from: row.author || "Seth",
    to: targets,
    subject,
    body,
    status: "open",
    handled_by: null,
    handled_at: null,
    note: null,
    via: "stack-cloud",
    channel_slug: slug,
    message_id: row.id,
  };
  await ghPutRepoFile(
    `Cloud/wake/events/${wakeId}.json`,
    JSON.stringify(ev, null, 2) + "\n",
    `stack-wake: ${subject} → ${targets.join(",")}`
  );
  try {
    await ghApi(`/repos/${ghState.repo}/dispatches`, {
      method: "POST",
      body: JSON.stringify({
        event_type: "cloud-wake",
        client_payload: {
          to: targets.length >= 3 ? "all" : targets.join(","),
          subject,
          body,
          wake_id: wakeId,
          from_agent: row.author || "Seth",
        },
      }),
    });
  } catch (err) {
    console.warn("repository_dispatch cloud-wake failed", err);
  }
  return {
    targets,
    deliveries: targets.map((t) => ({
      target: t,
      mode: "cloud_wake+dispatch",
      ok: true,
      id: wakeId,
      detail: "Cloud/wake event + repository_dispatch",
    })),
  };
}

async function ghAppendMessage(slug, { body, author, parent_id, attachments, instant_gemini }) {
  const channels = await ghListChannels();
  let ch = channels.find((c) => c.slug === slug);
  if (!ch) throw new Error("channel_not_found");
  const text = String(body || "").trim();
  const row = {
    id: crypto.randomUUID(),
    channel_id: ch.id,
    channel_slug: slug,
    parent_id: parent_id || null,
    author: author || "Seth",
    body: text,
    mentions: ghExtractMentions(text),
    ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
    ...(instant_gemini ? { instant_gemini: true } : {}),
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  const label = ch.kind === "dm" ? `dm ${slug}` : `#${slug}`;
  // Rebuild append from latest file on each 409 so concurrent agent writes aren't clobbered.
  await ghPutFile(
    `channels/${slug}/messages.jsonl`,
    async (existing) =>
      (existing.text ? existing.text.replace(/\s*$/, "\n") : "") +
      JSON.stringify(row) +
      "\n",
    `stack: message in ${label}`
  );
  ch.updated_at = row.created_at;
  await ghPutFile(
    "channels.json",
    async (existing) => {
      let catalog = { channels: [] };
      try {
        catalog = existing.text ? JSON.parse(existing.text) : { channels: [] };
      } catch {
        catalog = { channels: [] };
      }
      const nextChannels = (catalog.channels || []).map((c) =>
        c.slug === slug ? { ...c, ...ch } : c
      );
      return JSON.stringify({ channels: nextChannels }, null, 2) + "\n";
    },
    `stack: activity ${label}`
  );
  // Direct Stack→agent (cloud): Cloud Wake + Actions fan-out. Not Slack.
  try {
    const authorL = String(row.author || "").toLowerCase();
    if (authorL === "seth" || authorL === "viewer") {
      row.delivery = await ghStackWakeFromMessage(ch, row);
    }
  } catch (err) {
    console.warn("stack wake failed", err);
    row.delivery = { targets: [], deliveries: [], error: String((err && err.message) || err) };
  }
  return row;
}

async function ghCreateChannel({ slug, name, purpose, kind, members }) {
  const ch = {
    id: crypto.randomUUID(),
    slug,
    name: name || slug,
    purpose: purpose || "",
    kind: kind === "dm" ? "dm" : "channel",
    members: Array.isArray(members) ? members : [],
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  await ghPutFile(
    "channels.json",
    async (existing) => {
      let channels = [];
      try {
        channels = existing.text ? JSON.parse(existing.text).channels || [] : [];
      } catch {
        channels = [];
      }
      if (channels.some((c) => c.slug === slug)) throw new Error("slug_exists");
      channels.push(ch);
      channels.sort((a, b) => {
        const ak = a.kind === "dm" ? 1 : 0;
        const bk = b.kind === "dm" ? 1 : 0;
        if (ak !== bk) return ak - bk;
        return String(a.name).localeCompare(String(b.name));
      });
      return JSON.stringify({ channels }, null, 2) + "\n";
    },
    `stack: channel #${slug}`
  );
  await ghPutFile(`channels/${slug}/messages.jsonl`, "", `stack: init #${slug}`);
  return ch;
}

async function ghEnsureDm(me, member) {
  const a = (me || "Seth").trim() || "Seth";
  const b = (member || "").trim();
  if (!b) throw new Error("member_required");
  if (a.toLowerCase() === b.toLowerCase()) throw new Error("dm_needs_two_members");
  const slug = ghDmSlug(a, b);
  const channels = await ghListChannels();
  const existing = channels.find((c) => c.slug === slug);
  if (existing) return existing;
  return ghCreateChannel({
    slug,
    name: `${a} ↔ ${b}`,
    purpose: `Direct messages · ${a} + ${b}`,
    kind: "dm",
    members: [a, b],
  });
}

async function ghListLists() {
  const data = await ghReadJson("lists.json", { lists: [] });
  return (data.lists || []).map((l) => ({
    id: l.id,
    name: l.name,
    columns: l.columns || [],
    created_at: l.created_at,
  }));
}

async function ghGetList(id) {
  const data = await ghReadJson("lists.json", { lists: [] });
  return (data.lists || []).find((l) => l.id === id) || null;
}

async function ghSetRowStatus(listId, rowId, status) {
  return ghPutFile(
    "lists.json",
    async (existing) => {
      const data = existing.text ? JSON.parse(existing.text) : { lists: [] };
      const lst = (data.lists || []).find((l) => l.id === listId);
      const row = lst && (lst.rows || []).find((r) => r.id === rowId);
      if (!row) throw new Error("row_not_found");
      const i = Math.max(0, (lst.columns || []).findIndex((c) => String(c).toLowerCase() === "status"));
      row.cells[i] = status;
      row.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      lst.updated_at = row.updated_at;
      return JSON.stringify(data, null, 2) + "\n";
    },
    `stack: list row ${status}`
  );
}

async function ghAddListRow(listId, cells) {
  let row = null;
  await ghPutFile(
    "lists.json",
    async (existing) => {
      let lists = [];
      try {
        lists = existing.text ? JSON.parse(existing.text).lists || [] : [];
      } catch {
        lists = [];
      }
      const lst = lists.find((l) => l.id === listId);
      if (!lst) throw new Error("list_not_found");
      const cols = lst.columns || [];
      const trimmed = [...(cells || [])];
      while (trimmed.length < cols.length) trimmed.push("");
      row = {
        id: crypto.randomUUID(),
        cells: trimmed.slice(0, cols.length),
        created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      };
      lst.rows = [...(lst.rows || []), row];
      lst.updated_at = row.updated_at;
      return JSON.stringify({ lists }, null, 2) + "\n";
    },
    "stack: list row"
  );
  return row;
}

async function ghBuildHome(viewer = "Seth") {
  const channels = await ghListChannels();
  const viewerKey = String(viewer || "Seth").trim().toLowerCase() || "seth";
  const reports = [];
  const mentions = [];
  let total = 0;
  for (const ch of channels) {
    const file = await ghGetFile(`channels/${ch.slug}/messages.jsonl`);
    for (const line of file.text.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      total += 1;
      const tagged = Array.isArray(row.mentions) && row.mentions.length
        ? row.mentions
        : ghExtractMentions(row.body || "");
      if (
        tagged.some((m) => String(m).toLowerCase() === viewerKey) &&
        String(row.author || "").toLowerCase() !== viewerKey
      ) {
        mentions.push({
          id: row.id,
          channel: ch.slug,
          kind: ch.kind || "channel",
          author: row.author || "?",
          body: row.body || "",
          created_at: row.created_at || "",
          preview: ((row.body || "").trim().split("\n")[0] || "").slice(0, 160),
        });
      }
      if (row.parent_id) continue;
      if (ch.kind === "dm") continue;
      reports.push({
        id: row.id,
        channel: ch.slug,
        author: row.author || "?",
        body: row.body || "",
        created_at: row.created_at || "",
        preview: ((row.body || "").trim().split("\n")[0] || "").slice(0, 160),
      });
    }
  }
  reports.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  mentions.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const listsData = await ghReadJson("lists.json", { lists: [] });
  const todos = [];
  let done = 0;
  for (const lst of listsData.lists || []) {
    const cols = (lst.columns || []).map((c) => String(c).toLowerCase());
    const statusIdx = cols.includes("status") ? cols.indexOf("status") : 0;
    const itemIdx = cols.length > 1 ? 1 : 0;
    const ownerIdx = cols.length > 2 ? 2 : null;
    for (const row of lst.rows || []) {
      const cells = row.cells || [];
      const status = String(cells[statusIdx] || "").toLowerCase();
      const entry = {
        list_id: lst.id,
        list: lst.name,
        row_id: row.id,
        status: cells[statusIdx] || "",
        item: cells[itemIdx] || "",
        owner: ownerIdx != null ? cells[ownerIdx] || "" : "",
        cells,
      };
      if (["done", "closed", "complete", "completed"].includes(status)) done += 1;
      else todos.push(entry);
    }
  }
  const authors = [];
  const seen = new Set();
  for (const r of reports.slice(0, 12)) {
    if (!seen.has(r.author)) {
      seen.add(r.author);
      authors.push(r.author);
    }
  }
  const pubs = channels.filter((c) => c.kind !== "dm");
  const dms = channels.filter((c) => c.kind === "dm");
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    viewer: viewer || "Seth",
    summary: {
      headline: `${todos.length} open todos · ${Math.min(mentions.length, 12)} mentions · ${Math.min(reports.length, 12)} reports · ${pubs.length} channels · ${dms.length} DMs`,
      open_todos: todos.length,
      done_todos: done,
      mentions: mentions.length,
      channels: pubs.length,
      dms: dms.length,
      messages: total,
      authors,
    },
    mentions: mentions.slice(0, 12),
    reports: reports.slice(0, 12),
    todos: todos.slice(0, 20),
    channels,
  };
}

async function ghRoute(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  let body = {};
  if (options.body) {
    body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
  }
  const url = new URL(path, "https://stack.local");
  const p = url.pathname;

  if (p === "/api/health") {
    return {
      ok: true,
      name: "The Stack",
      version: "0.12-cloud",
      host: `github://${ghState.repo}@${ghState.branch}`,
      repo: ghState.repo,
      branch: ghState.branch,
      zero_spend: true,
      hub: true,
      sync: "vault+github",
      cloud: true,
      dms: true,
      mentions: true,
      reactions: true,
      messages: null,
      usable: true,
    };
  }
  if (p === "/api/home") {
    return ghBuildHome(url.searchParams.get("viewer") || "Seth");
  }
  if (p === "/api/token-hint") {
    return {
      hint: ghState.token ? `${ghState.token.slice(0, 4)}…${ghState.token.slice(-4)}` : "(none)",
      path: "GitHub PAT (localStorage)",
      usage: "Cloud hub mode — token stays on this phone/browser only",
    };
  }
  if (p === "/api/channels" && method === "GET") {
    return { channels: await ghListChannels() };
  }
  if (p === "/api/dms" && method === "GET") {
    const channels = await ghListChannels();
    return { dms: channels.filter((c) => c.kind === "dm") };
  }
  if (p === "/api/dms" && method === "POST") {
    return ghEnsureDm(body.me || "Seth", body.member || body.with);
  }
  if (p === "/api/channels" && method === "POST") {
    const ch = await ghCreateChannel(body);
    return ch;
  }
  const msgMatch = p.match(/^\/api\/channels\/([^/]+)\/messages$/);
  if (msgMatch && method === "GET") {
    const slug = decodeURIComponent(msgMatch[1]);
    const parentId = url.searchParams.get("parent_id");
    const channels = await ghListChannels();
    const channel = channels.find((c) => c.slug === slug);
    if (!channel) throw new Error("channel_not_found");
    return {
      channel,
      messages: await ghListMessages(slug, parentId),
    };
  }
  if (msgMatch && method === "POST") {
    const slug = decodeURIComponent(msgMatch[1]);
    return ghAppendMessage(slug, body);
  }
  const reactMatch = p.match(/^\/api\/channels\/([^/]+)\/messages\/([^/]+)\/reactions$/);
  if (reactMatch && method === "POST") {
    return ghToggleReaction(decodeURIComponent(reactMatch[1]), decodeURIComponent(reactMatch[2]), body);
  }
  if (p === "/api/lists" && method === "GET") {
    return { lists: await ghListLists() };
  }
  const listMatch = p.match(/^\/api\/lists\/([^/]+)$/);
  if (listMatch && method === "GET") {
    const lst = await ghGetList(decodeURIComponent(listMatch[1]));
    if (!lst) throw new Error("list_not_found");
    return lst;
  }
  if (p === "/api/workstreams" && method === "GET") {
    return ghLoadWorkstreams();
  }
  const rowMatch = p.match(/^\/api\/lists\/([^/]+)\/rows$/);
  if (rowMatch && method === "POST") {
    return ghAddListRow(decodeURIComponent(rowMatch[1]), body.cells || []);
  }
  throw new Error(`unsupported in cloud mode: ${method} ${p}`);
}
