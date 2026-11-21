/* The Stack v50.1 Rebirth — Cloudflare Worker BFF, Zero-Voice, Liquid Glass
 * Hard rules: no Jarvis/Aria/mic/TTS/STT; PIN → x-stack-pin; Git is source of truth.
 * No horizontal swipe. Colour only marks the 5 agent states. Connection pill is honest.
 */
(function () {
  "use strict";

  const VERSION = window.STACK_VERSION || "v50.0-rebirth";
  const SURFACE_KEY = "stack-surface-v1";
  const OUTBOX_KEY = "stack-rebirth-outbox-v1";
  const READ_NOTIF_KEY = "stack-rebirth-read-notifs-v1";
  const PIN_KEY = "stack-access-pin-v1";
  const BFF_KEY = "stack-bff-url-v1";
  const ZERO_SPEND = Number(window.ZERO_SPEND_CAP_USD || 0);

  const AGENT_STATES = {
    working: { label: "Working", tone: "green" },
    waiting: { label: "Waiting", tone: "amber" },
    blocked: { label: "Blocked", tone: "red" },
    offline: { label: "Offline", tone: "muted" },
    completed: { label: "Completed", tone: "green" }
  };

  const DEFAULT_ROSTER = [
    { id: "gemini", name: "Gemini", role: "Research & Workspace", model: "gemini-3.8-flash / 4-hydrogen", reset: "4h window" },
    { id: "claude", name: "Claude", role: "Architecture", model: "Claude Opus 5.5 / Sonnet 5.5", reset: "4h window" },
    { id: "cursor", name: "Cursor", role: "Engineering", model: "Cursor Composer / Auto", reset: "Daily" },
    { id: "chatgpt", name: "ChatGPT", role: "Ideation & Verify", model: "GPT-5 Thinking", reset: "Daily" },
    { id: "nori", name: "Nori", role: "Trends & Grok Bots", model: "Grok (latest)", reset: "Daily" },
    { id: "grokbot", name: "Grokbot", role: "Challenger", model: "Grok 4", reset: "Daily" },
    { id: "peer-floor", name: "#peer-floor", role: "Shared Floor", model: "Multi-Agent Room", reset: "Git-native" }
  ];

  const creds = {
    pin: "",
    bff: ""
  };

  const state = {
    view: "today",
    activeAgentId: "gemini",
    workFilter: "all",
    notifFilter: "all",
    syncing: false,
    online: false,
    link: "offline",
    conflicts: [],
    lastSyncIso: "",
    headCommit: "—",
    commits: [],
    heartbeats: {},
    needsSeth: [],
    workstreamsRaw: { workstreams: [], opportunities: [], links: {}, vision: {} },
    items: [],
    handoffs: [],
    channels: [],
    messagesBySlug: {},
    usageRaw: { version: 1, providers: [] },
    agents: [],
    notifications: [],
    sharedMemory: { entries: [] },
    qcReceipts: [],
    health: null,
    outbox: loadOutbox(),
    readNotifs: loadReadNotifs()
  };

  let toastTimer = null;
  let toastQueue = [];
  let toastShowing = false;
  let toastRankShowing = 0;
  let pollStarted = false;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function toast(msg, level) {
    const item = { msg: String(msg), level: level || "info" };
    if (toastShowing && window.StackPolish.toastRank(item.level) > toastRankShowing) {
      toastQueue = window.StackPolish.enqueueToast(toastQueue, item);
      clearTimeout(toastTimer);
      const live = document.getElementById("toast");
      if (live) live.classList.remove("show");
      toastShowing = false;
      toastRankShowing = 0;
      pumpToast();
      return;
    }
    toastQueue = window.StackPolish.enqueueToast(toastQueue, item);
    pumpToast();
  }

  function pumpToast() {
    if (toastShowing || !toastQueue.length) return;
    const item = toastQueue.shift();
    const t = document.getElementById("toast");
    if (!t) return;
    toastShowing = true;
    toastRankShowing = window.StackPolish.toastRank(item.level);
    t.classList.remove("toast-error", "toast-warning", "toast-info");
    t.classList.add("show", "toast-" + item.level);
    t.dataset.level = item.level;
    t.textContent = item.msg;
    const ms = item.level === "error" ? 4200 : item.level === "warning" ? 3200 : 2200;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove("show");
      toastShowing = false;
      toastRankShowing = 0;
      setTimeout(pumpToast, 160);
    }, ms);
  }

  function relTime(iso) {
    if (!iso) return "—";
    const diff = Math.max(0, Date.now() - new Date(iso).getTime());
    if (isNaN(diff)) return String(iso).slice(0, 10);
    const m = Math.floor(diff / 60000);
    if (m < 1) return "Just now";
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  function loadOutbox() {
    try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]") || []; } catch (e) { return []; }
  }
  function saveOutbox() {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(state.outbox)); } catch (e) {}
  }
  function loadReadNotifs() {
    try { return new Set(JSON.parse(localStorage.getItem(READ_NOTIF_KEY) || "[]")); } catch (e) { return new Set(); }
  }
  function saveReadNotifs() {
    try { localStorage.setItem(READ_NOTIF_KEY, JSON.stringify(Array.from(state.readNotifs))); } catch (e) {}
  }

  function loadCreds() {
    try {
      creds.pin = localStorage.getItem(PIN_KEY) || "";
      creds.bff = (localStorage.getItem(BFF_KEY) || window.STACK_BFF_URL || "").replace(/\/$/, "");
    } catch (e) {
      creds.pin = "";
      creds.bff = (window.STACK_BFF_URL || "").replace(/\/$/, "");
    }
  }
  function saveCreds() {
    try {
      localStorage.setItem(PIN_KEY, creds.pin);
      localStorage.setItem(BFF_KEY, creds.bff);
    } catch (e) {}
  }
  function clearCreds() {
    creds.pin = "";
    try {
      localStorage.removeItem(PIN_KEY);
    } catch (e) {}
  }

  function prefersLight() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  }

  function applySurface(mode) {
    const choice = mode === "light" || mode === "system" ? mode : "dark";
    const surface = window.StackPolish.resolveSurface(choice, prefersLight());
    document.documentElement.dataset.theme = choice;
    document.documentElement.dataset.surface = surface;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", surface === "light" ? "#cfd6e0" : "#0d1117");
    const btn = document.getElementById("surface-btn");
    if (btn) {
      const label = choice === "system" ? "System" : choice === "light" ? "Light" : "Dark";
      btn.title = "Theme: " + label + " (neutral glass)";
      btn.setAttribute("aria-label", "Theme " + label);
    }
    try { localStorage.setItem(SURFACE_KEY, choice); } catch (e) {}
  }

  function agentMeta(st) { return AGENT_STATES[st] || AGENT_STATES.offline; }

  function agentAgeText(agent) {
    const m = agentMeta(agent && agent.status);
    const seen = (agent && agent.lastSeen) || "Offline";
    if (m.label === "Offline" && seen === "Offline") return "Offline · No recent commit";
    return m.label + " · " + seen;
  }

  function itemStateMeta(st) {
    const s = String(st || "").toLowerCase();
    if (s.includes("block")) return { label: "Blocked", tone: "red", key: "blocked" };
    if (s.includes("need") || s.includes("wait")) return { label: "Waiting", tone: "amber", key: "waiting" };
    if (s.includes("done") || s.includes("complete")) return { label: "Completed", tone: "green", key: "completed" };
    if (s.includes("hold") || s.includes("park") || s.includes("no-go")) return { label: "On Hold", tone: "muted", key: "offline" };
    return { label: "Working", tone: "green", key: "working" };
  }

  function dmSlugForAgent(agentId) {
    if (agentId === "peer-floor") return "peer-floor";
    return "dm-" + agentId + "-seth";
  }

  /* ===================== BFF CLIENT ===================== */

  async function bff(path, opts) {
    if (!creds.bff) throw new Error("BFF URL not set");
    const init = Object.assign({ method: "GET" }, opts || {});
    init.headers = Object.assign({
      "content-type": "application/json",
      "x-stack-pin": creds.pin
    }, init.headers || {});
    const res = await fetch(creds.bff.replace(/\/$/, "") + path, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error((data && data.error) || ("BFF " + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function normalizeHubData() {
    const wsList = Array.isArray(state.workstreamsRaw.workstreams) ? state.workstreamsRaw.workstreams : [];
    const oppList = Array.isArray(state.workstreamsRaw.opportunities) ? state.workstreamsRaw.opportunities : [];

    const combined = [];
    wsList.forEach(function (w, i) {
      combined.push({
        id: w.id || "ws-" + i,
        rawKind: "workstream",
        title: w.title || w.name || "Untitled Workstream",
        summary: w.summary || w.goal || w.next_action || w.next_step || "",
        state: w.status || w.state || "active",
        owner: (Array.isArray(w.owners) ? w.owners[0] : w.owner) || "Gemini",
        ownerId: String((Array.isArray(w.owners) ? w.owners[0] : w.owner) || "gemini").toLowerCase().split(/[\s/]+/)[0],
        deadline: w.deadline || null,
        ref: w.ref || w.doc || w.doc_path || w.path || "",
        blocker: w.blocker || "",
        tasks: Array.isArray(w.checklist) ? w.checklist.map(function (c, idx) {
          return typeof c === "string"
            ? { id: "t-" + idx, text: c, done: false, proof: "" }
            : { id: c.id || "t-" + idx, text: c.text || c.title || c.label || "", done: Boolean(c.done), proof: c.proof || "" };
        }) : []
      });
    });
    oppList.forEach(function (o, i) {
      const hook = o.hook || "";
      const inferredState = o.status || o.state || (/on\s+hold/i.test(hook) ? "On hold" : "active");
      const ownerName = o.owner || "Team";
      combined.push({
        id: o.id || ("opp-" + (o.rank != null ? o.rank : i)),
        rawKind: "opportunity",
        title: o.title || o.name || "Untitled Opportunity",
        summary: o.summary || o.thesis || o.next_step || hook,
        state: inferredState,
        owner: ownerName,
        ownerId: o.owner ? String(o.owner).toLowerCase().split(/[\s/]+/)[0] : "peer-floor",
        deadline: o.deadline || null,
        ref: o.ref || o.doc || o.doc_path || o.path || "",
        blocker: o.blocker || "",
        tasks: []
      });
    });
    state.items = combined;

    const providers = Array.isArray(state.usageRaw.providers) ? state.usageRaw.providers : [];
    const qcByBuilder = {};
    (state.qcReceipts || []).forEach(function (r) {
      const b = String(r.builder || "").toLowerCase();
      if (!qcByBuilder[b] || (r.verified_at || "") > (qcByBuilder[b].verified_at || "")) qcByBuilder[b] = r;
    });

    const hbMap = (state.heartbeats && state.heartbeats.agents && typeof state.heartbeats.agents === "object")
      ? state.heartbeats.agents
      : (state.heartbeats || {});

    state.agents = DEFAULT_ROSTER.map(function (base) {
      const hb = hbMap[base.id] || hbMap[base.name] || hbMap[String(base.name || "").toLowerCase()];
      const commit = (state.commits || []).find(function (c) {
        const hay = ((c.message || "") + " " + (c.author || "")).toLowerCase();
        return hay.includes(base.id);
      });
      const waitingItem = (state.needsSeth || []).find(function (n) {
        return String(n.owner || n.agent || "").toLowerCase().includes(base.id);
      });
      const blockedItem = state.items.find(function (i) {
        return i.ownerId === base.id && itemStateMeta(i.state).key === "blocked";
      });
      const prov = providers.find(function (p) {
        return String(p.id || p.name || p.agent || p.provider || "").toLowerCase().includes(base.id);
      });
      const qc = qcByBuilder[base.id] || qcByBuilder[base.name.toLowerCase()];

      let status = "offline";
      let evidence = "No recent Git commit";
      let lastSeen = "Offline";
      const allowedHb = { working: 1, waiting: 1, blocked: 1, offline: 1, completed: 1 };

      if (base.id === "peer-floor") {
        status = "working";
        evidence = "channels/peer-floor/messages.jsonl";
        lastSeen = "Git-native";
      } else if (blockedItem) {
        status = "blocked";
        evidence = blockedItem.ref || blockedItem.blocker || blockedItem.id;
        lastSeen = relTime(blockedItem.deadline);
      } else if (waitingItem) {
        status = "waiting";
        evidence = waitingItem.ref || waitingItem.key || "needs_seth.json";
        lastSeen = relTime(waitingItem.created_at || waitingItem.updated_at);
      } else if (hb && hb.ts) {
        const ageMs = Date.now() - new Date(hb.ts).getTime();
        const declared = String(hb.state || "").toLowerCase();
        if (allowedHb[declared]) status = declared;
        else status = ageMs < 3600000 ? "working" : "offline";
        if (status === "completed" && !(qc && qc.checks_passed && qc.reviewer && String(qc.reviewer).toLowerCase() !== String(qc.builder || "").toLowerCase())) {
          // Protocol: completed requires peer QC — fall back to working/offline from beat age.
          status = ageMs < 3600000 ? "working" : "offline";
        }
        if (status !== "offline" && ageMs > 86400000 && declared !== "blocked" && declared !== "waiting") {
          status = "offline";
        }
        evidence = hb.evidence_path || hb.task || hb.commit || hb.evidence_sha || "heartbeat";
        if (hb.evidence_sha || hb.commit) {
          evidence = (hb.evidence_path ? hb.evidence_path + " · " : "") + "commit " + String(hb.evidence_sha || hb.commit).slice(0, 8);
        }
        lastSeen = relTime(hb.ts);
      } else if (qc && qc.checks_passed && qc.reviewer && String(qc.reviewer).toLowerCase() !== String(qc.builder || "").toLowerCase()) {
        status = "completed";
        evidence = "QC " + String(qc.commit_sha || "").slice(0, 8) + " · reviewer " + qc.reviewer;
        lastSeen = relTime(qc.verified_at);
      } else if (commit) {
        const ageMs = Date.now() - new Date(commit.date || commit.created_at || 0).getTime();
        // Commit alone = Working (in progress). Completed requires peer QC receipt.
        status = ageMs < 86400000 ? "working" : "offline";
        evidence = "commit " + String(commit.sha || "").slice(0, 8);
        lastSeen = relTime(commit.date || commit.created_at);
      }

      const usagePct = prov && typeof prov.pct === "number" ? prov.pct
        : (prov && typeof prov.pct_used === "number" ? prov.pct_used
          : (prov && typeof prov.used_pct === "number" ? prov.used_pct : 0));

      return Object.assign({}, base, {
        status: status,
        evidence: evidence,
        lastSeen: lastSeen,
        usagePct: usagePct,
        model: (prov && prov.model) || base.model,
        reset: (prov && (prov.reset || prov.reset_at)) || base.reset,
        qc: qc || null
      });
    });

    const notifs = [];
    (state.needsSeth || []).forEach(function (n) {
      const id = "ns-" + (n.key || n.id || n.title);
      notifs.push({
        id: id, cat: "action", unread: !state.readNotifs.has(id),
        time: relTime(n.created_at || n.updated_at),
        title: n.title || n.summary || "Decision needed",
        body: n.body || n.reason || "Waiting in needs_seth.json",
        proof: n.ref || n.key || "needs_seth.json",
        targetType: "needs", targetId: n.key || ""
      });
    });
    (state.commits || []).slice(0, 5).forEach(function (c) {
      const sha = String(c.sha || "").slice(0, 8);
      const id = "cm-" + sha;
      notifs.push({
        id: id, cat: "receipt", unread: !state.readNotifs.has(id),
        time: relTime(c.date),
        title: String(c.message || "Commit").split("\n")[0].slice(0, 72),
        body: "By " + (c.author || "Git"),
        proof: "commit " + sha,
        targetType: "stats", targetId: ""
      });
    });
    if (state.health && Array.isArray(state.health.alerts)) {
      state.health.alerts.forEach(function (a, i) {
        const id = "hl-" + i + "-" + (a.agent || "x");
        notifs.push({
          id: id, cat: "action", unread: !state.readNotifs.has(id),
          time: "now",
          title: (a.agent || "Agent") + " · " + (a.issue || "Health"),
          body: a.recovery || "",
          proof: "health",
          targetType: "stats", targetId: ""
        });
      });
    }
    state.notifications = notifs;
    state.conflicts = window.StackPolish.detectConflicts(state.commits || []);
  }

  function conflictsForRef(ref) {
    const needle = String(ref || "").trim();
    if (needle.length < 3) return [];
    return (state.conflicts || []).filter(function (c) {
      return c.path === needle || c.path.endsWith("/" + needle) || needle.endsWith("/" + c.path);
    });
  }

  function secretsMissing(health) {
    return !!(health && (health.status === "awaiting_secrets" ||
      (Array.isArray(health.alerts) && health.alerts.some(function (a) {
        return String(a.issue || "").indexOf("GITHUB_PAT") !== -1;
      }))));
  }

  async function syncVault(silent) {
    if (!creds.pin || !creds.bff) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      state.syncing = false;
      state.online = false;
      state.link = "offline";
      renderChrome();
      if (!silent) toast("Offline — no network", "warning");
      return;
    }
    state.syncing = true;
    state.link = "polling";
    renderChrome();
    try {
      const health = await bff("/api/health").catch(function () { return null; });
      state.health = health;
      if (secretsMissing(health)) {
        state.online = false;
        state.link = "offline";
        state.headCommit = "—";
        if (!silent) {
          toast("Worker secrets missing — set GITHUB_PAT + STACK_ACCESS_PIN on Worker the-stack-bff (Secret type)", "warning");
        }
        return;
      }
      const [sync, memory] = await Promise.all([
        bff("/api/sync"),
        bff("/api/memory").catch(function () { return { entries: [] }; })
      ]);
      state.workstreamsRaw = sync.workstreams || state.workstreamsRaw;
      state.needsSeth = sync.needs_seth || [];
      state.usageRaw = sync.usage || state.usageRaw;
      state.commits = sync.commits || [];
      state.headCommit = sync.head_commit || state.headCommit;
      state.heartbeats = sync.heartbeats || state.heartbeats || {};
      state.qcReceipts = Array.isArray(sync.qc_receipts) ? sync.qc_receipts : (state.qcReceipts || []);
      state.sharedMemory = memory || { entries: [] };
      state.online = true;
      state.link = "live";
      state.lastSyncIso = sync.synced_at || new Date().toISOString();
      normalizeHubData();
      if (state.view === "agents") await loadActiveAgentMessages();
      if (!silent) toast("Vault synced · " + state.headCommit + " · $" + ZERO_SPEND + " cap", "info");
    } catch (err) {
      state.online = false;
      state.link = "offline";
      if (err && err.status === 401) {
        clearCreds();
        showGate();
        toast("PIN rejected — unlock again", "error");
      } else {
        const detail = (err && err.data && err.data.error) || (err && err.message) || "";
        if (/GITHUB_PAT/i.test(detail)) {
          toast("Worker needs Secret GITHUB_PAT — Cloudflare → Workers → the-stack-bff → Secrets", "error");
        } else {
          toast("Offline — working from local cache" + (detail ? " (" + String(detail).slice(0, 80) + ")" : ""), "warning");
        }
      }
    } finally {
      state.syncing = false;
      render();
    }
  }

  async function loadActiveAgentMessages() {
    const slug = dmSlugForAgent(state.activeAgentId);
    const existing = state.messagesBySlug[slug] || [];
    if (!creds.pin || !creds.bff) {
      state.messagesBySlug[slug] = existing;
      return;
    }
    try {
      const data = await bff("/api/messages?slug=" + encodeURIComponent(slug) + "&limit=40");
      if (data && Array.isArray(data.messages)) {
        const seen = new Set();
        const merged = [];
        data.messages.forEach(function (m) {
          if (!m) return;
          const key = m.id || ((m.created_at || "") + "|" + (m.author || "") + "|" + (m.body || ""));
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(m);
          }
        });
        existing.forEach(function (m) {
          if (!m) return;
          const key = m.id || ((m.created_at || "") + "|" + (m.author || "") + "|" + (m.body || ""));
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(m);
          }
        });
        state.messagesBySlug[slug] = merged.slice(-60);
        return;
      }
    } catch (e) {
      // Graceful fallback when running against an older Worker deploy or offline cache.
    }
    state.messagesBySlug[slug] = existing;
  }

  async function flushOutbox() {
    if (!state.outbox.length) return;
    const remaining = [];
    let sent = 0;
    for (const ev of state.outbox) {
      try {
        if (ev.type === "message" || ev.type === "quick") {
          await bff("/api/ping", {
            method: "POST",
            body: JSON.stringify({ slug: ev.slug, body: ev.body, author: "Seth" })
          });
          sent += 1;
        }
      } catch (e) {
        remaining.push(ev);
      }
    }
    state.outbox = remaining;
    saveOutbox();
    render();
    toast(sent ? "Synced " + sent + " queued event(s) via BFF" : "Outbox still pending", sent ? "info" : "warning");
  }

  /* ===================== VIEWS ===================== */

  function renderToday() {
    const topNeed = state.needsSeth[0] || null;
    const heroHtml = topNeed ? (
      '<section class="hero">' +
        '<div class="hero-top"><span class="kicker">5-Second Brief · Needs Your Call</span><span class="badge amber"><span class="dot amber"></span>Waiting</span></div>' +
        '<h2 class="hero-title">' + esc(topNeed.title || topNeed.summary || "Decision Needed") + "</h2>" +
        '<p class="hero-copy">' + esc(topNeed.body || topNeed.reason || "") + "</p>" +
        '<div class="hero-meta">' +
          (topNeed.owner ? '<span>Owner: <strong>' + esc(topNeed.owner) + "</strong></span>" : "") +
          '<span class="git-chip">' + esc(topNeed.ref || topNeed.key || "needs_seth.json") + "</span>" +
        "</div>" +
        '<div class="hero-actions">' +
          '<button type="button" class="btn btn-pri" data-ping-floor="Approved go on: ' + esc(topNeed.title || topNeed.key || "need") + '">Approve Go</button>' +
          '<button type="button" class="btn btn-sec" data-ping-floor="HOLD: ' + esc(topNeed.title || topNeed.key || "need") + '">Hold</button>' +
          (topNeed.owner ? '<button type="button" class="btn btn-sec" data-jump-agent="' + esc(String(topNeed.owner).toLowerCase().split(/[\s/]+/)[0]) + '">Ping ' + esc(topNeed.owner) + "</button>" : "") +
        "</div>" +
      "</section>"
    ) : secretsMissing(state.health) ? (
      '<section class="hero">' +
        '<div class="hero-top"><span class="kicker">5-Second Brief · ' + VERSION + '</span><span class="badge amber"><span class="dot amber"></span>Secrets</span></div>' +
        '<h2 class="hero-title">Worker secrets not armed</h2>' +
        '<p class="hero-copy">Add <span class="mono">GITHUB_PAT</span> and <span class="mono">STACK_ACCESS_PIN</span> as <strong>Secrets</strong> on Worker <span class="mono">the-stack-bff</span> (not Pages Variables). Then tap the sync pill.</p>' +
        '<div class="hero-actions"><button type="button" class="btn btn-pri" id="btn-resync">Retry Sync</button><button type="button" class="btn btn-sec" data-go="stats">Usage &amp; Git</button></div>' +
      "</section>"
    ) : (
      '<section class="hero">' +
        '<div class="hero-top"><span class="kicker">5-Second Brief · ' + VERSION + '</span><span class="badge green"><span class="dot green"></span>All Clear</span></div>' +
        '<h2 class="hero-title">Zero decisions waiting</h2>' +
        '<p class="hero-copy">BFF head <span class="mono">' + esc(state.headCommit) + "</span>. Queue OFF · $" + ZERO_SPEND + " spend cap. Tap an agent or drop a Quick Action.</p>" +
        '<div class="hero-actions"><button type="button" class="btn btn-sec" data-go="work">Open Work</button><button type="button" class="btn btn-sec" data-go="stats">Usage &amp; Git</button><button type="button" class="btn btn-pri" id="btn-quick-inbox">Quick Action</button></div>' +
      "</section>"
    );

    const agentStrip = state.agents.filter(function (a) { return a.id !== "peer-floor"; }).map(function (a) {
      const m = agentMeta(a.status);
      return (
        '<button type="button" class="agent-pill" data-jump-agent="' + esc(a.id) + '">' +
          '<span class="agent-pill-top"><span class="dot ' + m.tone + '"></span>' + esc(a.name) + "</span>" +
          '<span class="agent-pill-age">' + esc(agentAgeText(a)) + "</span>" +
        "</button>"
      );
    }).join("");

    const conflictHtml = (state.conflicts || []).length ? (
      '<div class="section-head"><span class="section-title">File conflicts</span></div>' +
      '<div class="panel" aria-label="Paths touched by more than one agent">' +
        (state.conflicts || []).map(function (c) {
          return (
            '<div class="row">' +
              '<div class="row-main">' +
                '<div class="row-title"><span class="dot amber"></span>Conflict · ' + esc(c.path.split("/").pop()) + "</div>" +
                '<div class="row-sub">' + esc(c.agents.join(" · ")) + " · " + esc(c.shas.slice(0, 3).join(" ")) + "</div>" +
              "</div>" +
              '<span class="badge amber">Conflict</span>' +
            "</div>"
          );
        }).join("") +
      "</div>"
    ) : "";

    const commitRows = (state.commits || []).slice(0, 5).map(function (c) {
      const sha = String(c.sha || "").slice(0, 8);
      return (
        '<div class="row">' +
          '<div class="row-main">' +
            '<div class="row-title">' + esc(String(c.message || "").split("\n")[0]) + "</div>" +
            '<div class="row-sub">' + esc(c.author || "Git") + " · " + relTime(c.date) + "</div>" +
          "</div>" +
          '<span class="git-chip">' + esc(sha) + "</span>" +
        "</div>"
      );
    }).join("");

    return (
      heroHtml +
      conflictHtml +
      '<div class="section-head"><span class="section-title">Workforce State · 5 Explicit States</span><button type="button" class="section-link" data-go="agents">All Agents ›</button></div>' +
      '<div class="agent-strip">' + agentStrip + "</div>" +
      '<div class="section-head"><span class="section-title">Verified Git Commits</span><button type="button" class="section-link" data-go="stats">All ›</button></div>' +
      '<div class="panel">' + (commitRows || '<div class="empty">No commits loaded yet.</div>') + "</div>"
    );
  }

  function renderAgents() {
    const agent = state.agents.find(function (a) { return a.id === state.activeAgentId; }) || state.agents[0];
    if (!agent) return '<div class="empty">Loading agents…</div>';
    const st = agentMeta(agent.status);
    const slug = dmSlugForAgent(agent.id);
    const msgs = state.messagesBySlug[slug] || [];
    const usageTone = agent.usagePct >= 85 ? "red" : agent.usagePct >= 70 ? "amber" : "";
    const memBits = (state.sharedMemory.entries || []).slice(0, 3).map(function (e) {
      return '<div class="row-sub">• ' + esc(e.fact) + ' <span class="git-chip">' + esc(e.source || "memory") + "</span></div>";
    }).join("");

    const switcher = state.agents.map(function (a) {
      const am = agentMeta(a.status);
      return (
        '<button type="button" class="agent-pill ' + (a.id === agent.id ? "active" : "") + '" data-select-agent="' + esc(a.id) + '">' +
          '<span class="agent-pill-top"><span class="dot ' + am.tone + '"></span>' + esc(a.name) + "</span>" +
          '<span class="agent-pill-age">' + esc(agentAgeText(a)) + "</span>" +
        "</button>"
      );
    }).join("");

    const msgHtml = msgs.slice(-25).map(function (m) {
      const isMe = String(m.author || "").toLowerCase() === "seth";
      return (
        '<div class="msg ' + (isMe ? "me" : "") + '">' +
          '<div class="msg-head"><span class="msg-author">' + esc(m.author || "Agent") + '</span><span class="msg-time">' + relTime(m.created_at) + "</span></div>" +
          '<div style="white-space:pre-wrap;">' + esc(m.body || "") + "</div>" +
          '<div class="msg-foot"><span class="git-chip">' + esc(m._queued ? "Outbox · Pending" : "Committed · " + slug) + "</span></div>" +
        "</div>"
      );
    }).join("");

    return (
      '<div class="agent-strip" style="margin-bottom:14px;">' + switcher + "</div>" +
      '<section class="hero">' +
        '<div class="hero-top">' +
          '<div><span class="kicker">' + esc(agent.role) + " · " + esc(agent.model) + '</span><h2 class="hero-title" style="margin:3px 0 0;">' + esc(agent.name) + "</h2></div>" +
          '<span class="badge ' + st.tone + '"><span class="dot ' + st.tone + '"></span>' + esc(st.label) + "</span>" +
        "</div>" +
        '<div style="margin-bottom:12px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;">' +
            '<span class="git-chip">Evidence: ' + esc(agent.evidence) + "</span>" +
            (agent.id !== "peer-floor" ? '<span class="mono">' + agent.usagePct + "% used</span>" : "") +
          "</div>" +
          (agent.id !== "peer-floor" ? '<div class="meter"><div class="meter-fill ' + usageTone + '" style="width:' + agent.usagePct + '%"></div></div>' : "") +
        "</div>" +
        (memBits ? '<div class="panel" style="margin-bottom:12px;"><div class="section-title" style="margin-bottom:6px;">Shared Memory</div>' + memBits + "</div>" : "") +
        '<div id="chat-log" class="chat-log">' + (msgHtml || '<div class="empty">No local messages yet — pings commit via BFF to ' + esc(slug) + ".</div>") + "</div>" +
        '<div class="chip-strip">' +
          '<button type="button" class="ctx-chip" data-insert="Ping: confirm active commit SHA, current blocker, and next gate.">Reliable Ping</button>' +
          '<button type="button" class="ctx-chip" data-insert="QC needed: reviewer !== builder, include commit SHA + checks.">QC Gate</button>' +
        "</div>" +
        '<form id="agent-chat-form" class="composer">' +
          '<input id="agent-chat-input" class="input" placeholder="Type or use iPhone keyboard dictation…" autocomplete="off" enterkeyhint="send" required />' +
          '<button type="submit" class="btn btn-pri btn-sm">Ping</button>' +
        "</form>" +
      "</section>"
    );
  }

  function renderWork() {
    const filtered = state.items.filter(function (i) {
      const m = itemStateMeta(i.state);
      if (state.workFilter === "all") return m.label !== "On Hold";
      if (state.workFilter === "opportunities") return i.rawKind === "opportunity" && m.label !== "On Hold";
      if (state.workFilter === "workstreams") return i.rawKind === "workstream" && m.label !== "On Hold";
      if (state.workFilter === "hold") return m.label === "On Hold";
      return true;
    });
    const hero = filtered[0] || state.items[0];
    const rest = hero ? filtered.filter(function (i) { return i.id !== hero.id; }) : [];
    const st = hero ? itemStateMeta(hero.state) : { label: "Empty", tone: "muted" };
    const heroConflict = hero ? conflictsForRef(hero.ref) : [];

    const heroHtml = hero ? (
      '<section class="hero">' +
        '<div class="hero-top"><span class="kicker">' + (hero.rawKind === "opportunity" ? "Featured Opportunity" : "Core Workstream") + '</span><span class="badge ' + st.tone + '"><span class="dot ' + st.tone + '"></span>' + esc(st.label) + "</span>" + (heroConflict.length ? '<span class="badge amber">Conflict</span>' : "") + "</div>" +
        '<h2 class="hero-title">' + esc(hero.title) + "</h2>" +
        '<p class="hero-copy">' + esc(hero.summary) + (heroConflict.length ? " Shared path touched by " + esc(heroConflict[0].agents.join(" and ")) + "." : "") + "</p>" +
        '<div class="hero-meta"><span>Owner: <strong>' + esc(hero.owner) + "</strong></span>" + (hero.ref ? '<span class="git-chip">' + esc(hero.ref) + "</span>" : "") + "</div>" +
        '<div class="hero-actions">' +
          '<button type="button" class="btn btn-pri" data-inspect="' + esc(hero.id) + '">Open Details</button>' +
          '<button type="button" class="btn btn-sec" data-jump-agent="' + esc(hero.ownerId) + '">Chat ' + esc(hero.owner) + "</button>" +
          '<button type="button" class="btn btn-sec" data-qc="' + esc(hero.id) + '">File QC</button>' +
        "</div>" +
      "</section>"
    ) : '<div class="empty">No workstreams found.</div>';

    const rows = rest.map(function (i) {
      const info = itemStateMeta(i.state);
      const hit = conflictsForRef(i.ref);
      return (
        '<button type="button" class="row" data-inspect="' + esc(i.id) + '">' +
          '<div class="row-main"><div class="row-title">' + esc(i.title) + ' <span class="dot ' + info.tone + '"></span></div><div class="row-sub">' + esc(i.owner) + (i.deadline ? " · Due " + esc(i.deadline) : "") + (hit.length ? " · " + esc(hit[0].agents.join(" · ")) : "") + "</div></div>" +
          '<div class="row-right">' + (hit.length ? '<span class="badge amber">Conflict</span>' : "") + '<span>' + esc(info.label) + "</span><span>›</span></div>" +
        "</button>"
      );
    }).join("");

    return (
      '<div class="seg" role="tablist">' +
        [{ id: "all", label: "Active" }, { id: "opportunities", label: "Opportunities" }, { id: "workstreams", label: "Core" }, { id: "hold", label: "Parked" }].map(function (t) {
          return '<button type="button" class="seg-btn ' + (state.workFilter === t.id ? "active" : "") + '" data-work-filter="' + t.id + '">' + t.label + "</button>";
        }).join("") +
      "</div>" +
      heroHtml +
      '<div class="section-head"><span class="section-title">Connected Board</span></div>' +
      '<div class="panel">' + (rows || '<div class="empty">No other items here.</div>') + "</div>"
    );
  }

  function renderStats() {
    const modelAgents = state.agents.filter(function (a) { return a.id !== "peer-floor"; });
    const usageRows = modelAgents.map(function (a) {
      const m = agentMeta(a.status);
      const tone = a.usagePct >= 85 ? "red" : a.usagePct >= 70 ? "amber" : "";
      return (
        '<div class="row" style="flex-direction:column;align-items:stretch;gap:7px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">' +
            '<div class="row-main"><div class="row-title"><span class="dot ' + m.tone + '"></span>' + esc(a.name) + ' <span class="mono">· ' + esc(a.model) + '</span></div><div class="row-sub">' + esc(m.label) + " · " + esc(a.reset) + "</div></div>" +
            '<strong class="mono">' + a.usagePct + "%</strong>" +
          "</div>" +
          '<div class="meter" style="margin-top:0;"><div class="meter-fill ' + tone + '" style="width:' + a.usagePct + '%"></div></div>' +
          '<div><span class="git-chip">' + esc(a.evidence) + "</span></div>" +
        "</div>"
      );
    }).join("");

    const healthLine = state.health
      ? ('Health: <strong>' + esc(state.health.status || "—") + "</strong> · open approvals " + esc(String(state.health.open_approvals || 0)) + " · cap $" + esc(String(state.health.zero_spend_cap_usd ?? ZERO_SPEND)))
      : "Health not loaded";
    const shaTone = state.link === "live" ? "green" : state.link === "polling" ? "amber" : "neutral";

    return (
      '<section class="hero">' +
        '<div class="hero-top"><span class="kicker">Git Source of Truth · ' + VERSION + '</span><span class="badge ' + shaTone + '"><span class="dot ' + (shaTone === "neutral" ? "muted" : shaTone) + '"></span>' + esc(state.headCommit) + "</span></div>" +
        '<h2 class="hero-title">Worker BFF</h2>' +
        '<p class="hero-copy"><span class="mono">' + esc(creds.bff) + "</span><br/>Last sync " + relTime(state.lastSyncIso) + " · " + state.outbox.length + " pending · Queue OFF<br/>" + healthLine + "</p>" +
        '<div class="hero-actions">' +
          '<button type="button" class="btn btn-pri btn-sm" id="btn-sync-now">Sync Now</button>' +
          '<button type="button" class="btn btn-sec btn-sm" id="btn-timemachine">Time Machine</button>' +
          (state.outbox.length ? '<button type="button" class="btn btn-sec btn-sm" id="btn-flush-ob">Flush Outbox (' + state.outbox.length + ")</button>" : "") +
          '<button type="button" class="btn btn-danger btn-sm" id="btn-sign-out">Lock</button>' +
        "</div>" +
      "</section>" +
      '<div class="section-head"><span class="section-title">All-Agent Model &amp; Usage Tracker</span></div>' +
      '<div class="panel">' + usageRows + "</div>"
    );
  }

  function renderChrome() {
    const titles = { today: "Today", agents: "Agents", work: "Work", stats: "Usage & Git" };
    document.getElementById("page-heading").textContent = titles[state.view] || "The Stack";
    document.querySelectorAll("[data-view]").forEach(function (el) { el.classList.toggle("active", el.dataset.view === state.view); });

    const unreadNotifs = state.notifications.filter(function (n) { return n.unread; }).length;
    const nc = document.getElementById("notif-count");
    if (nc) { nc.textContent = String(unreadNotifs); nc.classList.toggle("hidden", unreadNotifs === 0); }

    const link = (typeof navigator !== "undefined" && navigator.onLine === false) ? "offline" : (state.syncing ? "polling" : state.link);
    const sDot = document.getElementById("sync-dot");
    const sTxt = document.getElementById("sync-text");
    const sPill = document.getElementById("sync-pill");
    if (sDot) sDot.className = "dot " + window.StackPolish.connectionDot(link);
    if (sTxt) sTxt.textContent = window.StackPolish.connectionLabel(link, state.outbox.length);
    if (sPill) {
      const detail = link === "live"
        ? ("Live · last sync " + (state.lastSyncIso || "—") + " · " + state.headCommit)
        : link === "polling"
          ? "Polling the Worker BFF"
          : secretsMissing(state.health)
            ? "Offline — Worker secrets missing"
            : "Offline — last sync failed or the network is down";
      sPill.title = detail + (state.outbox.length ? " · Outbox " + state.outbox.length : "");
    }
    const refreshDot = document.querySelector("#sb-refresh-btn .dot");
    if (refreshDot) refreshDot.className = "dot " + window.StackPolish.connectionDot(link);

    const obLbl = document.getElementById("sb-outbox-lbl");
    const obDot = document.getElementById("sb-outbox-dot");
    if (obLbl) obLbl.textContent = "Outbox · " + state.outbox.length;
    if (obDot) obDot.className = "dot " + (state.outbox.length ? "amber" : "muted");

    const sbAgents = document.getElementById("sb-agents-nav");
    if (sbAgents) {
      sbAgents.innerHTML = state.agents.map(function (a) {
        const am = agentMeta(a.status);
        const active = state.view === "agents" && state.activeAgentId === a.id ? "active" : "";
        return '<button type="button" class="sb-item ' + active + '" data-jump-agent="' + esc(a.id) + '"><span class="sb-item-left"><span class="dot ' + am.tone + '"></span>' + esc(a.name) + '</span><span class="mono">' + esc(am.label) + "</span></button>";
      }).join("");
      sbAgents.querySelectorAll("[data-jump-agent]").forEach(function (b) { b.addEventListener("click", function () { jumpToAgent(b.dataset.jumpAgent); }); });
    }
  }

  function render() {
    const root = document.getElementById("root");
    if (!root) return;
    if (state.view === "today") root.innerHTML = renderToday();
    else if (state.view === "agents") root.innerHTML = renderAgents();
    else if (state.view === "work") root.innerHTML = renderWork();
    else root.innerHTML = renderStats();
    renderChrome();
    bindEvents();
  }

  /* ===================== SHEETS ===================== */

  function openSheet(html) {
    const ov = document.getElementById("overlay"), sh = document.getElementById("sheet");
    if (!ov || !sh) return;
    sh.innerHTML = html; ov.classList.add("open"); ov.setAttribute("aria-hidden", "false");
  }
  function closeSheet() {
    const ov = document.getElementById("overlay");
    if (!ov) return;
    ov.classList.remove("open"); ov.setAttribute("aria-hidden", "true");
  }

  function openQuickInbox() {
    openSheet(
      '<div class="sheet-head"><div><h2 class="sheet-title">Quick-Action Inbox</h2><p class="sheet-sub">Type or use iPhone keyboard dictation — zero custom voice</p></div><button type="button" class="orb-btn" style="width:32px;height:32px;" data-close-sheet>✕</button></div>' +
      '<form id="quick-form">' +
        '<div class="field"><label for="quick-body">Idea / instruction</label>' +
        '<textarea id="quick-body" class="input" rows="5" placeholder="Dictate with the iPhone keyboard mic, then tap Capture…" required></textarea></div>' +
        '<div class="hero-actions"><button type="submit" class="btn btn-pri" style="width:100%;">Capture to #peer-floor</button></div>' +
      "</form>"
    );
    document.getElementById("quick-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      const body = document.getElementById("quick-body").value.trim();
      if (!body) return;
      try {
        await bff("/api/ping", {
          method: "POST",
          body: JSON.stringify({ slug: "peer-floor", author: "Seth", body: "Quick Action: " + body })
        });
        toast("Captured to #peer-floor", "info");
        closeSheet();
        await syncVault(true);
      } catch (err) {
        state.outbox.unshift({ id: "evt-" + Date.now(), type: "quick", slug: "peer-floor", body: "Quick Action: " + body });
        saveOutbox();
        toast("Offline — saved to Outbox", "warning");
        closeSheet();
        render();
      }
    });
  }

  function openQcSheet(workstreamId) {
    const item = state.items.find(function (i) { return i.id === workstreamId; }) || {};
    openSheet(
      '<div class="sheet-head"><div><h2 class="sheet-title">QC Receipt</h2><p class="sheet-sub">reviewer !== builder · commit SHA · checks</p></div><button type="button" class="orb-btn" style="width:32px;height:32px;" data-close-sheet>✕</button></div>' +
      '<form id="qc-form">' +
        '<div class="field"><label>Workstream</label><input class="input mono" value="' + esc(item.title || workstreamId || "") + '" disabled /></div>' +
        '<div class="field"><label for="qc-builder">Builder</label><input id="qc-builder" class="input" value="' + esc(item.ownerId || "cursor") + '" required /></div>' +
        '<div class="field"><label for="qc-reviewer">Reviewer (must differ)</label><input id="qc-reviewer" class="input" placeholder="claude" required /></div>' +
        '<div class="field"><label for="qc-sha">Commit SHA</label><input id="qc-sha" class="input mono" placeholder="abcdef12" required /></div>' +
        '<div class="field"><label for="qc-notes">Notes</label><textarea id="qc-notes" class="input" rows="3" placeholder="What was verified"></textarea></div>' +
        '<label class="check-row"><span class="check-left"><input id="qc-pass" type="checkbox" required /> <span class="check-txt">Checks passed (E2E / tests)</span></span></label>' +
        '<div class="hero-actions" style="margin-top:12px;"><button type="submit" class="btn btn-pri" style="width:100%;">Commit QC Receipt</button></div>' +
      "</form>"
    );
    document.getElementById("qc-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      const builder = document.getElementById("qc-builder").value.trim();
      const reviewer = document.getElementById("qc-reviewer").value.trim();
      const commitSha = document.getElementById("qc-sha").value.trim();
      const notes = document.getElementById("qc-notes").value.trim();
      const checksPassed = document.getElementById("qc-pass").checked;
      if (builder.toLowerCase() === reviewer.toLowerCase()) {
        toast("Reviewer must differ from builder", "warning");
        return;
      }
      try {
        const out = await bff("/api/qc", {
          method: "POST",
          body: JSON.stringify({
            workstreamId: workstreamId || item.id || "",
            builder: builder,
            reviewer: reviewer,
            commitSha: commitSha,
            checksPassed: checksPassed,
            notes: notes
          })
        });
        if (out && out.receipt) state.qcReceipts.unshift(out.receipt);
        toast("QC receipt committed · " + (out.commitSha || commitSha), "info");
        closeSheet();
        normalizeHubData();
        render();
      } catch (err) {
        toast((err && err.message) || "QC failed", "error");
      }
    });
  }

  function openNotificationCentre() {
    const list = state.notifications.filter(function (n) { return state.notifFilter === "all" || n.cat === state.notifFilter; });
    const rows = list.map(function (n) {
      return (
        '<button type="button" class="row" data-open-notif="' + esc(n.id) + '">' +
          '<div class="row-main"><div class="row-title"><span class="dot ' + (n.unread ? "amber" : "muted") + '"></span>' + esc(n.title) + '</div><div class="row-sub">' + esc(n.body) + '</div><div style="margin-top:4px;"><span class="git-chip">' + esc(n.proof) + '</span></div></div>' +
          '<div class="row-right"><span>' + esc(n.time) + "</span><span>›</span></div>" +
        "</button>"
      );
    }).join("");

    openSheet(
      '<div class="sheet-head"><div><h2 class="sheet-title">Notification Centre</h2><p class="sheet-sub">Gates, handoffs, commits</p></div><div style="display:flex;gap:6px;"><button type="button" class="btn btn-sec btn-sm" id="mark-all-read">Mark all read</button><button type="button" class="orb-btn" style="width:32px;height:32px;" data-close-sheet>✕</button></div></div>' +
      '<div class="seg">' +
        [{ id: "all", label: "All" }, { id: "action", label: "Needs Action" }, { id: "handoff", label: "Handoffs" }, { id: "receipt", label: "Commits" }].map(function (t) {
          return '<button type="button" class="seg-btn ' + (state.notifFilter === t.id ? "active" : "") + '" data-notif-filter="' + t.id + '">' + t.label + "</button>";
        }).join("") +
      "</div>" +
      '<div class="panel" style="margin-bottom:0;">' + (rows || '<div class="empty">No notifications here.</div>') + "</div>"
    );

    const sh = document.getElementById("sheet");
    sh.querySelectorAll("[data-notif-filter]").forEach(function (b) { b.addEventListener("click", function () { state.notifFilter = b.dataset.notifFilter; openNotificationCentre(); }); });
    document.getElementById("mark-all-read").addEventListener("click", function () {
      state.notifications.forEach(function (n) { n.unread = false; state.readNotifs.add(n.id); });
      saveReadNotifs(); render(); openNotificationCentre();
    });
    sh.querySelectorAll("[data-open-notif]").forEach(function (b) {
      b.addEventListener("click", function () {
        const n = state.notifications.find(function (x) { return x.id === b.dataset.openNotif; });
        if (!n) return;
        n.unread = false; state.readNotifs.add(n.id); saveReadNotifs(); render(); closeSheet();
        if (n.targetType === "agent") jumpToAgent(n.targetId);
        else if (n.targetType === "stats") { state.view = "stats"; render(); }
        else { state.view = "today"; render(); }
      });
    });
  }

  function openItemSheet(id) {
    const item = state.items.find(function (i) { return i.id === id; });
    if (!item) return;
    const info = itemStateMeta(item.state);
    const checks = (item.tasks || []).map(function (t) {
      return '<div class="check-row ' + (t.done ? "done" : "") + '"><span class="check-left"><span class="check-box">' + (t.done ? "✓" : "") + '</span><span class="check-txt">' + esc(t.text) + "</span></span>" + (t.proof ? '<span class="git-chip">' + esc(t.proof) + "</span>" : "") + "</div>";
    }).join("");

    openSheet(
      '<div class="sheet-head"><div><span class="badge ' + info.tone + '" style="margin-bottom:6px;"><span class="dot ' + info.tone + '"></span>' + esc(info.label) + '</span><h2 class="sheet-title">' + esc(item.title) + '</h2><p class="sheet-sub">Owner: ' + esc(item.owner) + '</p></div><button type="button" class="orb-btn" style="width:32px;height:32px;" data-close-sheet>✕</button></div>' +
      '<p class="hero-copy">' + esc(item.summary) + "</p>" +
      (item.ref ? '<div style="margin-bottom:12px;"><span class="git-chip">' + esc(item.ref) + "</span></div>" : "") +
      (checks || '<div class="empty">No checklist items.</div>') +
      '<div class="hero-actions" style="margin-top:14px;"><button type="button" class="btn btn-pri btn-sm" id="sheet-chat-owner">Chat ' + esc(item.owner) + '</button><button type="button" class="btn btn-sec btn-sm" id="sheet-qc">File QC</button></div>'
    );
    document.getElementById("sheet-chat-owner").addEventListener("click", function () { closeSheet(); jumpToAgent(item.ownerId); });
    document.getElementById("sheet-qc").addEventListener("click", function () { openQcSheet(item.id); });
  }

  async function openTimeMachine() {
    try {
      const data = await bff("/api/timemachine?days=7");
      const rows = (data.events || []).map(function (e) {
        return '<a class="row" href="' + esc(e.url || "#") + '" target="_blank" rel="noopener">' +
          '<div class="row-main"><div class="row-title">' + esc(e.message) + '</div><div class="row-sub">' + esc(e.author) + " · " + relTime(e.date) + "</div></div>" +
          '<span class="git-chip">' + esc(e.sha) + "</span></a>";
      }).join("");
      openSheet(
        '<div class="sheet-head"><div><h2 class="sheet-title">Time Machine</h2><p class="sheet-sub">Last ' + esc(String(data.days || 7)) + " days of commits</p></div><button type=\"button\" class=\"orb-btn\" style=\"width:32px;height:32px;\" data-close-sheet>✕</button></div>" +
        '<div class="panel">' + (rows || '<div class="empty">No events.</div>') + "</div>"
      );
    } catch (e) {
      toast("Time machine failed", "error");
    }
  }

  let paletteIndex = 0;

  function paletteRows(query) {
    return window.StackPolish.buildPalette({
      query: query,
      now: Date.now(),
      view: state.view,
      activeAgentId: state.activeAgentId,
      outboxCount: state.outbox.length,
      agents: state.agents.map(function (a) {
        return { id: a.id, name: a.name, status: a.status };
      }),
      items: state.items.map(function (i) {
        const meta = itemStateMeta(i.state);
        return {
          id: i.id, title: i.title, status: meta.key, agentId: i.ownerId,
          owner: i.owner, date: i.deadline || "", ref: i.ref || ""
        };
      }),
      commits: state.commits || []
    });
  }

  function renderPaletteList(rows) {
    const host = document.getElementById("cmdk-list");
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = '<div class="empty">Nothing matches. Add text to send it.</div>';
      return;
    }
    if (paletteIndex >= rows.length) paletteIndex = rows.length - 1;
    if (paletteIndex < 0) paletteIndex = 0;
    host.innerHTML = rows.map(function (row, i) {
      const layer = row.layer === 1 ? "Jump" : row.layer === 2 ? "Action" : "Send";
      return (
        '<button type="button" class="row cmdk-row" role="option" data-cmdk-index="' + i + '" aria-selected="' + (i === paletteIndex ? "true" : "false") + '">' +
          '<div class="row-main"><div class="row-title">' + esc(row.title) + '</div><div class="row-sub">' + esc(row.sub || "") + "</div></div>" +
          '<span class="git-chip">' + layer + "</span>" +
        "</button>"
      );
    }).join("");
    host.querySelectorAll("[data-cmdk-index]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        runPaletteRow(rows[Number(btn.dataset.cmdkIndex)]);
      });
    });
    const selected = host.querySelector('[aria-selected="true"]');
    if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: "nearest" });
  }

  async function runPaletteRow(row) {
    if (!row) return;
    closeSheet();
    if (row.action === "view:today") { state.view = "today"; render(); }
    else if (row.action === "view:agents") { state.view = "agents"; render(); }
    else if (row.action === "view:work") { state.view = "work"; render(); }
    else if (row.action === "view:stats") { state.view = "stats"; render(); }
    else if (row.action.indexOf("agent:") === 0) await jumpToAgent(row.action.slice(6));
    else if (row.action.indexOf("inspect:") === 0) openItemSheet(row.action.slice(8));
    else if (row.action === "new") openQuickInbox();
    else if (row.action === "sync") await syncVault(false);
    else if (row.action === "flush") await flushOutbox();
    else if (row.action === "notif") openNotificationCentre();
    else if (row.action === "send") await sendToSlug(row.slug, row.body);
  }

  function openCommandPalette() {
    paletteIndex = 0;
    const rows = paletteRows("");
    openSheet(
      '<div class="sheet-head"><div><h2 class="sheet-title">Command palette</h2><p class="sheet-sub">Jump · actions · send. Filters: agent: status: date:7d</p></div><button type="button" class="orb-btn" style="width:32px;height:32px;" data-close-sheet aria-label="Close">✕</button></div>' +
      '<input id="cmdk-input" class="input cmdk-input" placeholder="Jump, act, or send to the floor…" autocomplete="off" enterkeyhint="go" role="combobox" aria-expanded="true" aria-controls="cmdk-list" />' +
      '<div id="cmdk-list" class="panel cmdk-list" role="listbox"></div>'
    );
    const input = document.getElementById("cmdk-input");
    renderPaletteList(rows);
    input.addEventListener("input", function () {
      paletteIndex = 0;
      renderPaletteList(paletteRows(input.value));
    });
    input.addEventListener("keydown", function (e) {
      const list = paletteRows(input.value);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        paletteIndex = Math.min(list.length - 1, paletteIndex + 1);
        renderPaletteList(list);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        paletteIndex = Math.max(0, paletteIndex - 1);
        renderPaletteList(list);
      } else if (e.key === "Enter") {
        e.preventDefault();
        runPaletteRow(list[paletteIndex]);
      }
    });
    setTimeout(function () { input.focus(); }, 30);
  }

  async function jumpToAgent(agentId) {
    state.activeAgentId = agentId;
    state.view = "agents";
    render();
    await loadActiveAgentMessages();
    render();
  }

  async function sendToSlug(slug, text) {
    const body = String(text || "").trim();
    const channel = slug || "peer-floor";
    if (!body) return;
    try {
      await bff("/api/ping", {
        method: "POST",
        body: JSON.stringify({ slug: channel, author: "Seth", body: body })
      });
      toast("Sent to " + channel, "info");
      state.messagesBySlug[channel] = (state.messagesBySlug[channel] || []).concat([{
        author: "Seth", body: body, created_at: new Date().toISOString()
      }]);
      if (state.view === "agents") render();
    } catch (e) {
      state.outbox.unshift({ id: "evt-" + Date.now(), type: "message", slug: channel, body: body });
      saveOutbox();
      state.link = (typeof navigator !== "undefined" && navigator.onLine === false) ? "offline" : state.link;
      toast("Offline — saved to Outbox", "warning");
      render();
    }
  }

  async function pingFloor(text) {
    await sendToSlug("peer-floor", text);
  }

  function bindEvents() {
    const root = document.getElementById("root");
    if (!root) return;

    root.querySelectorAll("[data-ping-floor]").forEach(function (b) {
      b.addEventListener("click", function () { pingFloor(b.dataset.pingFloor); });
    });
    root.querySelectorAll("[data-jump-agent]").forEach(function (b) { b.addEventListener("click", function () { jumpToAgent(b.dataset.jumpAgent); }); });
    root.querySelectorAll("[data-select-agent]").forEach(function (b) { b.addEventListener("click", function () { jumpToAgent(b.dataset.selectAgent); }); });
    root.querySelectorAll("[data-go]").forEach(function (b) { b.addEventListener("click", function () { state.view = b.dataset.go; render(); }); });
    root.querySelectorAll("[data-work-filter]").forEach(function (b) { b.addEventListener("click", function () { state.workFilter = b.dataset.workFilter; render(); }); });
    root.querySelectorAll("[data-inspect]").forEach(function (b) { b.addEventListener("click", function () { openItemSheet(b.dataset.inspect); }); });
    root.querySelectorAll("[data-qc]").forEach(function (b) { b.addEventListener("click", function () { openQcSheet(b.dataset.qc); }); });

    const qi = document.getElementById("btn-quick-inbox");
    if (qi) qi.addEventListener("click", openQuickInbox);
    const rs = document.getElementById("btn-resync");
    if (rs) rs.addEventListener("click", function () { syncVault(false); });

    const chatInput = document.getElementById("agent-chat-input");
    root.querySelectorAll("[data-insert]").forEach(function (c) {
      c.addEventListener("click", function () { if (chatInput) { chatInput.value = (chatInput.value ? chatInput.value + " " : "") + c.dataset.insert; chatInput.focus(); } });
    });

    const chatForm = document.getElementById("agent-chat-form");
    if (chatForm) {
      chatForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        const body = chatInput && chatInput.value.trim();
        if (!body) return;
        const slug = dmSlugForAgent(state.activeAgentId);
        chatInput.value = "";
        try {
          await bff("/api/ping", {
            method: "POST",
            body: JSON.stringify({ slug: slug, body: body, author: "Seth" })
          });
          toast("Ping committed via BFF", "info");
          state.messagesBySlug[slug] = (state.messagesBySlug[slug] || []).concat([{ author: "Seth", body: body, created_at: new Date().toISOString() }]);
          render();
        } catch (err) {
          state.outbox.unshift({ id: "evt-" + Date.now(), type: "message", agentId: state.activeAgentId, slug: slug, body: body });
          saveOutbox();
          state.messagesBySlug[slug] = (state.messagesBySlug[slug] || []).concat([{ author: "Seth", body: body, created_at: new Date().toISOString(), _queued: true }]);
          toast("Offline — ping saved to Outbox", "warning");
          render();
        }
      });
    }

    const log = document.getElementById("chat-log");
    if (log) log.scrollTop = log.scrollHeight;

    const syncBtn = document.getElementById("btn-sync-now");
    if (syncBtn) syncBtn.addEventListener("click", function () { syncVault(false); });
    const flushBtn = document.getElementById("btn-flush-ob");
    if (flushBtn) flushBtn.addEventListener("click", flushOutbox);
    const tmBtn = document.getElementById("btn-timemachine");
    if (tmBtn) tmBtn.addEventListener("click", openTimeMachine);
    const signOutBtn = document.getElementById("btn-sign-out");
    if (signOutBtn) signOutBtn.addEventListener("click", function () { clearCreds(); location.reload(); });
  }

  /* ===================== BOOT ===================== */

  function showShell() {
    document.getElementById("boot-gate").classList.add("hidden");
    document.getElementById("app-shell").classList.remove("hidden");
    document.getElementById("mobile-dock-wrap").classList.remove("hidden");
  }

  function showGate() {
    document.getElementById("boot-gate").classList.remove("hidden");
    document.getElementById("app-shell").classList.add("hidden");
    document.getElementById("mobile-dock-wrap").classList.add("hidden");
    const urlInput = document.getElementById("bff-url");
    if (urlInput && creds.bff) urlInput.value = creds.bff;
  }

  document.querySelectorAll("[data-view]").forEach(function (b) {
    b.addEventListener("click", async function () {
      state.view = b.dataset.view;
      render();
      if (state.view === "agents") { await loadActiveAgentMessages(); render(); }
    });
  });

  document.getElementById("notif-btn").addEventListener("click", openNotificationCentre);
  document.getElementById("sync-pill").addEventListener("click", function () { state.outbox.length ? flushOutbox() : syncVault(false); });
  document.getElementById("sb-outbox-btn").addEventListener("click", flushOutbox);
  document.getElementById("sb-refresh-btn").addEventListener("click", function () { syncVault(false); });
  document.getElementById("surface-btn").addEventListener("click", function () {
    applySurface(window.StackPolish.nextTheme(document.documentElement.dataset.theme || "dark"));
  });
  document.getElementById("cmd-btn").addEventListener("click", openCommandPalette);
  document.getElementById("fab-new").addEventListener("click", openQuickInbox);
  document.getElementById("sb-new-btn").addEventListener("click", openQuickInbox);
  document.getElementById("overlay").addEventListener("click", function (e) { if (e.target.id === "overlay" || e.target.closest("[data-close-sheet]")) closeSheet(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeSheet();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      const ov = document.getElementById("overlay");
      const paletteOpen = ov && ov.classList.contains("open") && document.getElementById("cmdk-input");
      if (paletteOpen) closeSheet();
      else openCommandPalette();
    }
  });

  function bindPullToRefresh() {
    const stage = document.querySelector(".stage");
    const ind = document.getElementById("pull-ind");
    if (!stage || !ind) return;
    let startY = 0;
    let startX = 0;
    let pulling = false;
    let dy = 0;

    function hide() {
      dy = 0;
      ind.classList.remove("on");
      ind.textContent = "";
    }

    stage.addEventListener("touchstart", function (e) {
      if (window.innerWidth >= 860) return;
      if (window.scrollY > 2) return;
      if (!e.touches || e.touches.length !== 1) return;
      const ov = document.getElementById("overlay");
      if (ov && ov.classList.contains("open")) return;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      pulling = true;
      dy = 0;
    }, { passive: true });

    stage.addEventListener("touchmove", function (e) {
      if (!pulling || !e.touches || !e.touches.length) return;
      const rawY = e.touches[0].clientY - startY;
      const rawX = e.touches[0].clientX - startX;
      if (Math.abs(rawX) > Math.abs(rawY)) {
        pulling = false;
        hide();
        return;
      }
      if (rawY <= 0 || window.scrollY > 2) {
        dy = 0;
        hide();
        return;
      }
      dy = Math.min(rawY, 120);
      if (e.cancelable) e.preventDefault();
      ind.classList.add("on");
      ind.textContent = dy > 72 ? "Release to refresh" : "Pull to refresh";
    }, { passive: false });

    stage.addEventListener("touchend", function () {
      if (!pulling) return;
      const should = dy > 72;
      pulling = false;
      hide();
      if (should) syncVault(false);
    });
  }

  function startPoller() {
    if (pollStarted) return;
    pollStarted = true;
    setInterval(function () {
      const shell = document.getElementById("app-shell");
      if (!shell || shell.classList.contains("hidden")) return;
      if (state.syncing || document.hidden) return;
      syncVault(true);
    }, 60000);
  }

  window.addEventListener("offline", function () {
    state.online = false;
    state.link = "offline";
    renderChrome();
  });
  window.addEventListener("online", function () {
    state.link = "polling";
    renderChrome();
    syncVault(true);
  });
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", function () {
      if (document.documentElement.dataset.theme === "system") applySurface("system");
    });
  }

  bindPullToRefresh();
  applySurface(document.documentElement.dataset.theme || "dark");

  document.getElementById("pin-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    const errEl = document.getElementById("pin-error");
    errEl.classList.add("hidden");
    creds.bff = document.getElementById("bff-url").value.trim().replace(/\/$/, "");
    creds.pin = document.getElementById("stack-pin").value;
    saveCreds();
    try {
      const health = await bff("/api/health");
      state.health = health;
      showShell();
      state.link = "polling";
      normalizeHubData();
      render();
      startPoller();
      if (secretsMissing(health)) {
        toast("Unlocked, but Worker has no GITHUB_PAT yet — vault stays offline until Secrets are set", "warning");
      }
      await syncVault(false);
    } catch (err) {
      clearCreds();
      errEl.textContent = "Could not unlock — check Worker URL and PIN (secrets set in Cloudflare).";
      errEl.classList.remove("hidden");
    }
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(function () {});
  }

  loadCreds();
  if (creds.pin && creds.bff) {
    state.link = (typeof navigator !== "undefined" && navigator.onLine === false) ? "offline" : "polling";
    showShell();
    normalizeHubData();
    render();
    startPoller();
    syncVault(true);
  } else {
    showGate();
  }
})();
