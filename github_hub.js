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

async function ghApi(path, options = {}) {
  let res;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${ghState.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    // Safari often surfaces offline/CORS blips as TypeError: Load failed.
    const wrapped = new Error(
      "Could not reach GitHub from this phone (network). Check signal/Wi‑Fi and try again."
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

async function ghAppendMessage(slug, { body, author, parent_id }) {
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
  const rowMatch = p.match(/^\/api\/lists\/([^/]+)\/rows$/);
  if (rowMatch && method === "POST") {
    return ghAddListRow(decodeURIComponent(rowMatch[1]), body.cells || []);
  }
  throw new Error(`unsupported in cloud mode: ${method} ${p}`);
}
