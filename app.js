/* The Stack v50.5.2 Tahoe — Cloudflare Worker BFF, Zero-Spend · Opt-In Voice, Liquid Glass
 * Hard rules: no always-on mic/Jarvis; opt-in TTS (/api/tts + $0 Web Speech fallback); PIN → x-stack-pin; Git is source of truth.
 * No horizontal swipe. Colour only marks the 5 agent states. Connection pill is honest.
 */
(function () {
  "use strict";

  const VERSION = window.STACK_VERSION || "v50.5.2-tahoe";
  const SURFACE_KEY = "stack-surface-v1";
  const OUTBOX_KEY = "stack-rebirth-outbox-v1";
  const READ_NOTIF_KEY = "stack-rebirth-read-notifs-v1";
  const PIN_KEY = "stack-access-pin-v1";
  const BFF_KEY = "stack-bff-url-v1";
  const ELEVEN_KEY_STORAGE = "stack-elevenlabs-key-v1";
  const ELEVEN_VOICE_STORAGE = "stack-elevenlabs-voice-v1";
  const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
  const ZERO_SPEND = Number(window.ZERO_SPEND_CAP_USD || 0);

  const AGENT_STATES = {
    working: { label: "Working", tone: "green" },
    waiting: { label: "Waiting", tone: "amber" },
    blocked: { label: "Blocked", tone: "red" },
    offline: { label: "Offline", tone: "muted" },
    completed: { label: "Completed", tone: "green" }
  };

  const DEFAULT_ROSTER = [
    { id: "peer-floor", name: "#peer-floor", role: "Shared Floor", model: "Multi-Agent Room", reset: "Git-native" },
    { id: "gemini", name: "Gemini", role: "Research & Workspace", model: "gemini-3.8-flash / 4-hydrogen", reset: "4h window" },
    { id: "claude", name: "Claude", role: "Architecture", model: "Claude Opus 5.5 / Sonnet 5.5", reset: "4h window" },
    { id: "cursor", name: "Cursor", role: "Engineering", model: "Cursor Composer / Auto", reset: "Daily" },
    { id: "chatgpt", name: "ChatGPT", role: "Ideation & Verify", model: "GPT-5 Thinking", reset: "Daily" },
    { id: "nori", name: "Nori", role: "Trends & Grok Bots", model: "Grok (latest)", reset: "Daily" },
    { id: "grokbot", name: "Grokbot", role: "Challenger", model: "Grok 4", reset: "Daily" }
  ];

  const creds = {
    pin: "",
    bff: ""
  };

  const state = {
    view: "today",
    activeAgentId: "peer-floor",
    workFilter: "all",
    notifFilter: "all",
    forceChatBottom: false,
    sendingPing: 0,
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
    draftsBySlug: {},
    usageRaw: { version: 1, providers: [] },
    usageAutoSynced: false,
    usageSyncedAt: "",
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

  function formatResetLabel(resetAt, fallbackLabel) {
    if (resetAt && /^\d{4}-\d{2}-\d{2}T/.test(String(resetAt))) {
      const targetMs = new Date(resetAt).getTime();
      if (!isNaN(targetMs)) {
        const diffMs = targetMs - Date.now();
        if (diffMs <= 0) return "Window resetting";
        const totalMins = Math.ceil(diffMs / 60000);
        const days = Math.floor(totalMins / 1440);
        const hours = Math.floor((totalMins % 1440) / 60);
        const mins = totalMins % 60;
        if (days > 0) return "Resets in " + days + "d " + hours + "h";
        if (hours > 0) return "Resets in " + hours + "h " + mins + "m";
        return "Resets in " + Math.max(1, mins) + "m";
      }
    }
    if (fallbackLabel) return String(fallbackLabel);
    if (resetAt) return String(resetAt);
    return "Auto-synced";
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
    const defaultBff = (window.STACK_BFF_URL || "").replace(/\/$/, "");
    try {
      creds.pin = localStorage.getItem(PIN_KEY) || "";
      let savedBff = (localStorage.getItem(BFF_KEY) || "").replace(/\/$/, "");
      // Migrate away from retired temporary Worker URL automatically.
      if (!savedBff || /cooked-barracuda/i.test(savedBff)) {
        savedBff = defaultBff;
        if (defaultBff) localStorage.setItem(BFF_KEY, defaultBff);
      }
      creds.bff = savedBff;
    } catch (e) {
      creds.pin = "";
      creds.bff = defaultBff;
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
    if (meta) meta.setAttribute("content", surface === "light" ? "#0a1930" : "#020408");
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
    const baseHeaders = { "x-stack-pin": creds.pin };
    if (init.body) baseHeaders["content-type"] = "application/json";
    init.headers = Object.assign(baseHeaders, init.headers || {});
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

    const rawUsage = state.usageRaw || {};
    state.usageAutoSynced = Boolean(rawUsage && rawUsage.auto_synced);
    state.usageSyncedAt = (rawUsage && rawUsage.synced_at) || "";
    let providers = [];
    if (Array.isArray(rawUsage)) providers = rawUsage;
    else if (Array.isArray(rawUsage.providers)) providers = rawUsage.providers;
    else if (Array.isArray(rawUsage.agents)) providers = rawUsage.agents;
    else if (rawUsage.providers && typeof rawUsage.providers === "object") {
      providers = Object.keys(rawUsage.providers).map(function (k) { return Object.assign({ id: k }, rawUsage.providers[k]); });
    } else if (rawUsage.agents && typeof rawUsage.agents === "object") {
      providers = Object.keys(rawUsage.agents).map(function (k) { return Object.assign({ id: k }, rawUsage.agents[k]); });
    } else if (typeof rawUsage === "object") {
      providers = Object.keys(rawUsage).filter(function (k) {
        return rawUsage[k] && typeof rawUsage[k] === "object" && !Array.isArray(rawUsage[k]);
      }).map(function (k) { return Object.assign({ id: k }, rawUsage[k]); });
    }
    const qcByBuilder = {};
    (state.qcReceipts || []).forEach(function (r) {
      const b = String(r.builder || "").toLowerCase();
      if (!qcByBuilder[b] || (r.verified_at || "") > (qcByBuilder[b].verified_at || "")) qcByBuilder[b] = r;
    });

    const hbMap = (state.heartbeats && state.heartbeats.agents && typeof state.heartbeats.agents === "object")
      ? state.heartbeats.agents
      : (state.heartbeats || {});
    const nowMs = Date.now();
    const dayMs = 86400000;
    const floorMsgsAll = state.messagesBySlug["peer-floor"] || [];

    function isRecentIso(iso) {
      if (!iso) return false;
      const t = new Date(iso).getTime();
      return !isNaN(t) && (nowMs - t) <= dayMs && (nowMs - t) >= -300000;
    }

    function findUsageProvider(list, base) {
      const idLower = String(base.id || "").toLowerCase();
      const nameLower = String(base.name || "").toLowerCase();
      const aliases = idLower === "nori" ? ["nori", "stackbot"] : [idLower];
      return list.find(function (p) {
        return aliases.indexOf(String(p.id || "").toLowerCase()) !== -1;
      }) || list.find(function (p) {
        const pa = String(p.agent || p.name || "").toLowerCase();
        return pa === nameLower || pa === idLower;
      }) || list.find(function (p) {
        const hay = String(p.id || p.name || p.agent || p.provider || "").toLowerCase();
        return new RegExp("\\b" + idLower + "\\b").test(hay);
      }) || null;
    }

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
      const prov = base.id === "peer-floor" ? null : findUsageProvider(providers, base);
      const qc = qcByBuilder[base.id] || qcByBuilder[base.name.toLowerCase()];

      let status = "offline";
      let evidence = "No recent Git commit";
      let lastSeen = "Offline";
      const allowedHb = { working: 1, waiting: 1, blocked: 1, offline: 1, completed: 1 };

      if (base.id === "peer-floor") {
        status = "working";
        evidence = "channels/peer-floor/messages.jsonl";
        lastSeen = floorMsgsAll.length ? relTime(floorMsgsAll[floorMsgsAll.length - 1].created_at) : "Git-native";
      } else if (blockedItem) {
        status = "blocked";
        evidence = blockedItem.ref || blockedItem.blocker || blockedItem.id;
        lastSeen = relTime(blockedItem.deadline);
      } else if (waitingItem) {
        status = "waiting";
        evidence = waitingItem.ref || waitingItem.key || "needs_seth.json";
        lastSeen = relTime(waitingItem.created_at || waitingItem.updated_at);
      } else if (hb && hb.ts) {
        const ageMs = nowMs - new Date(hb.ts).getTime();
        const declared = String(hb.state || "").toLowerCase();
        if (allowedHb[declared]) status = declared;
        else status = ageMs < 3600000 ? "working" : "offline";
        if (status === "completed" && !(qc && qc.checks_passed && qc.reviewer && String(qc.reviewer).toLowerCase() !== String(qc.builder || "").toLowerCase())) {
          // Protocol: completed requires peer QC — fall back to working/offline from beat age.
          status = ageMs < 3600000 ? "working" : "offline";
        }
        if (status !== "offline" && ageMs > dayMs && declared !== "blocked" && declared !== "waiting") {
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
        const ageMs = nowMs - new Date(commit.date || commit.created_at || 0).getTime();
        // Commit alone = Working (in progress). Completed requires peer QC receipt.
        status = ageMs < dayMs ? "working" : "offline";
        evidence = "commit " + String(commit.sha || "").slice(0, 8);
        lastSeen = relTime(commit.date || commit.created_at);
      }

      const commits24h = (state.commits || []).filter(function (c) {
        if (!isRecentIso(c.date || c.created_at)) return false;
        if (base.id === "peer-floor") return true;
        const hay = ((c.message || "") + " " + (c.author || "")).toLowerCase();
        return hay.includes(base.id);
      }).length;

      const dmMsgs = base.id === "peer-floor" ? [] : (state.messagesBySlug[dmSlugForAgent(base.id)] || []);
      const floorMsgs24h = base.id === "peer-floor"
        ? floorMsgsAll.filter(function (m) { return isRecentIso(m.created_at); }).length
        : floorMsgsAll.filter(function (m) {
            if (!isRecentIso(m.created_at)) return false;
            const auth = String(m.author || "").toLowerCase();
            const body = String(m.body || "").toLowerCase();
            return auth.includes(base.id) || body.includes("@" + base.id);
          }).length + dmMsgs.filter(function (m) {
            return isRecentIso(m.created_at) && String(m.author || "").toLowerCase().includes(base.id);
          }).length;

      const hbActive24h = (hb && hb.ts && isRecentIso(hb.ts)) ? 1 : 0;
      const callsToday = prov && prov.calls_today != null ? Math.max(0, Number(prov.calls_today) || 0) : 0;
      const activity24h = callsToday + commits24h + floorMsgs24h + hbActive24h;

      const rawPct = prov ? (prov.pct_used ?? prov.pct ?? prov.used_pct ?? prov.usage_pct ?? prov.percent ?? (typeof prov.used === "number" && typeof prov.limit === "number" && prov.limit > 0 ? Math.round((prov.used / prov.limit) * 100) : null)) : null;
      const hasNumericPct = typeof rawPct === "number" && !isNaN(rawPct);
      let usagePct = 0;
      let pctEstimated = false;
      if (hasNumericPct) {
        usagePct = Math.max(0, Math.min(100, Math.round(rawPct)));
      } else if (callsToday > 0) {
        usagePct = Math.min(100, Math.max(1, Math.round((callsToday / 250) * 100)));
        pctEstimated = true;
      } else if (activity24h > 0) {
        usagePct = Math.min(100, Math.max(1, activity24h * 4));
        pctEstimated = true;
      }
      const hasLiveUsage = hasNumericPct || activity24h > 0;

      const lastCallAt = (prov && (prov.last_call_at || prov.updated_at)) || (hb && hb.ts) || (commit && (commit.date || commit.created_at)) || "";
      const usageNote = (prov && prov.note) || (hb && hb.task) || "";
      const activityParts = [];
      if (callsToday > 0) activityParts.push(callsToday + " call" + (callsToday === 1 ? "" : "s"));
      if (commits24h > 0) activityParts.push(commits24h + " commit" + (commits24h === 1 ? "" : "s"));
      if (floorMsgs24h > 0) activityParts.push(floorMsgs24h + " msg" + (floorMsgs24h === 1 ? "" : "s"));
      if (hbActive24h > 0 && !activityParts.length) activityParts.push("1 beat");
      const activitySummary = activityParts.length
        ? (activityParts.join(" · ") + " (24h)")
        : (lastCallAt ? ("Seen " + relTime(lastCallAt)) : "0 events (24h)");

      const rawResetAt = (prov && prov.reset_at) || "";
      const windowLabel = (prov && (prov.window_label || prov.reset)) || base.reset;
      const resetDisplay = formatResetLabel(rawResetAt, windowLabel);

      return Object.assign({}, base, {
        status: status,
        evidence: evidence,
        lastSeen: lastSeen,
        usagePct: usagePct,
        pctEstimated: pctEstimated,
        hasLiveUsage: hasLiveUsage,
        callsToday: callsToday,
        calls5h: prov && prov.calls_5h != null ? Number(prov.calls_5h) : null,
        commits24h: commits24h,
        floorMsgs24h: floorMsgs24h,
        activity24h: activity24h,
        activitySummary: activitySummary,
        lastCallAt: lastCallAt,
        usageNote: usageNote,
        usageSource: (prov && prov.source) || "",
        resetAt: rawResetAt,
        windowLabel: windowLabel,
        reset: resetDisplay,
        providerId: (prov && prov.id) || base.id,
        model: (prov && prov.model) || base.model,
        qc: qc || null
      });
    });

    const notifs = [];
    (state.needsSeth || []).forEach(function (n) {
      const id = "ns-" + (n.key || n.id || n.title);
      const ownerId = n.owner || n.agent ? String(n.owner || n.agent).toLowerCase().split(/[\s/]+/)[0] : "";
      notifs.push({
        id: id, cat: "action", unread: !state.readNotifs.has(id),
        time: relTime(n.created_at || n.updated_at),
        title: n.title || n.summary || "Decision needed",
        body: n.body || n.reason || "Waiting in needs_seth.json",
        proof: n.ref || n.key || "needs_seth.json",
        targetType: "needs", targetId: n.key || n.id || "", targetRef: n.ref || "", targetAgent: ownerId
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
        targetType: "commit", targetId: sha, targetUrl: c.url || ""
      });
    });
    if (state.health && Array.isArray(state.health.alerts)) {
      state.health.alerts.forEach(function (a, i) {
        const id = "hl-" + i + "-" + (a.agent || "x");
        const agMatch = state.agents.find(function (ag) {
          return ag.id === String(a.agent || "").toLowerCase() || ag.name.toLowerCase() === String(a.agent || "").toLowerCase();
        });
        notifs.push({
          id: id, cat: "action", unread: !state.readNotifs.has(id),
          time: "now",
          title: (a.agent || "Agent") + " · " + (a.issue || "Health"),
          body: a.recovery || "",
          proof: "health",
          targetType: agMatch ? "agent" : "stats", targetId: agMatch ? agMatch.id : ""
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
      await loadMessagesForSlug("peer-floor");
      if (state.view === "agents" && state.activeAgentId !== "peer-floor") await loadActiveAgentMessages();
      normalizeHubData();
      if (!silent) toast("Vault synced · " + state.headCommit + " · $" + ZERO_SPEND + " cap", "info");
    } catch (err) {
      const defaultBff = (window.STACK_BFF_URL || "").replace(/\/$/, "");
      if ((!err || !err.status) && defaultBff && creds.bff !== defaultBff) {
        creds.bff = defaultBff;
        saveCreds();
        state.syncing = false;
        return syncVault(silent);
      }
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
          toast("Offline — " + (detail ? String(detail).slice(0, 60) : "local cache"), "warning");
        }
      }
    } finally {
      state.syncing = false;
      render();
    }
  }

  async function loadMessagesForSlug(slug) {
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

  async function loadActiveAgentMessages() {
    const active = state.agents.find(function (a) { return a.id === state.activeAgentId; });
    const slug = dmSlugForAgent(active ? active.id : "peer-floor");
    await loadMessagesForSlug(slug);
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

  /* ===================== VOICE (OPT-IN) ===================== */

  let activeAudio = null;
  let activeAudioUrl = "";
  let activeSpeechBtn = null;
  let speakingNow = false;

  function getSavedElevenKey() {
    try { return localStorage.getItem(ELEVEN_KEY_STORAGE) || ""; } catch (e) { return ""; }
  }
  function getSavedVoiceId() {
    try { return localStorage.getItem(ELEVEN_VOICE_STORAGE) || DEFAULT_VOICE_ID; } catch (e) { return DEFAULT_VOICE_ID; }
  }

  function setSpeakingBtn(btn, isOn) {
    if (!btn) return;
    if (isOn) {
      if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.textContent;
      btn.classList.add("speaking");
      btn.textContent = "⏹ Stop";
      btn.setAttribute("aria-pressed", "true");
      activeSpeechBtn = btn;
    } else {
      btn.classList.remove("speaking");
      if (btn.dataset.idleLabel) btn.textContent = btn.dataset.idleLabel;
      btn.removeAttribute("aria-pressed");
    }
  }

  function stopSpeaking() {
    if (activeAudio) {
      try { activeAudio.pause(); activeAudio.src = ""; } catch (e) {}
      activeAudio = null;
    }
    if (activeAudioUrl) {
      try { URL.revokeObjectURL(activeAudioUrl); } catch (e) {}
      activeAudioUrl = "";
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    if (activeSpeechBtn) {
      setSpeakingBtn(activeSpeechBtn, false);
      activeSpeechBtn = null;
    }
    speakingNow = false;
  }

  function pickNeuralWebVoice() {
    if (typeof window === "undefined" || !window.speechSynthesis || !window.speechSynthesis.getVoices) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    const preferred = ["Samantha", "Daniel", "Karen", "Arthur", "Siri", "Google US English", "Natural"];
    for (let i = 0; i < preferred.length; i++) {
      const hit = voices.find(function (v) {
        return v && v.name && v.name.indexOf(preferred[i]) !== -1 && /^en/i.test(v.lang || "en");
      });
      if (hit) return hit;
    }
    return voices.find(function (v) { return v && /^en/i.test(v.lang || ""); }) || voices[0] || null;
  }

  function fallbackWebSpeech(cleanText, btnEl) {
    if (typeof window === "undefined" || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      stopSpeaking();
      toast("Speech synthesis unavailable in this browser", "warning");
      return;
    }
    const utt = new SpeechSynthesisUtterance(cleanText);
    const voice = pickNeuralWebVoice();
    if (voice) utt.voice = voice;
    utt.rate = 1.02;
    utt.pitch = 1.0;
    speakingNow = true;
    if (btnEl) setSpeakingBtn(btnEl, true);
    utt.onend = function () { stopSpeaking(); };
    utt.onerror = function () { stopSpeaking(); };
    window.speechSynthesis.speak(utt);
  }

  async function speakText(text, btnEl, opts) {
    const cleanText = String(text || "").trim().slice(0, 1200);
    if (!cleanText) {
      toast("Nothing to read", "info");
      return;
    }
    if (speakingNow && btnEl && activeSpeechBtn === btnEl) {
      stopSpeaking();
      return;
    }
    stopSpeaking();

    const options = opts || {};
    const elKey = typeof options.apiKey === "string" ? options.apiKey.trim() : getSavedElevenKey().trim();
    const voiceId = (typeof options.voiceId === "string" && options.voiceId.trim()) ? options.voiceId.trim() : getSavedVoiceId();

    if (creds.bff && creds.pin && (typeof navigator === "undefined" || navigator.onLine !== false)) {
      try {
        const headers = {
          "content-type": "application/json",
          "x-stack-pin": creds.pin
        };
        if (elKey) headers["x-elevenlabs-key"] = elKey;
        const res = await fetch(creds.bff.replace(/\/$/, "") + "/api/tts", {
          method: "POST",
          headers: headers,
          body: JSON.stringify({
            text: cleanText,
            voiceId: voiceId || DEFAULT_VOICE_ID,
            modelId: "eleven_turbo_v2_5"
          })
        });
        const ct = String(res.headers.get("content-type") || "").toLowerCase();
        if (res.ok && ct.indexOf("audio/") !== -1) {
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          activeAudioUrl = url;
          activeAudio = new Audio(url);
          speakingNow = true;
          if (btnEl) setSpeakingBtn(btnEl, true);
          activeAudio.onended = function () { stopSpeaking(); };
          activeAudio.onerror = function () {
            stopSpeaking();
            fallbackWebSpeech(cleanText, btnEl);
          };
          await activeAudio.play().catch(function () {
            stopSpeaking();
            fallbackWebSpeech(cleanText, btnEl);
          });
          return;
        }
        if (res.status !== 501) {
          toast("ElevenLabs unavailable — using $0 Web Speech", "warning");
        }
      } catch (e) {
        // Offline or network issue — fall back cleanly to $0 Web Speech.
      }
    }

    fallbackWebSpeech(cleanText, btnEl);
  }

  /** Opt-in Today Voice Brief — spoken executive rundown (not Jarvis / not always-on mic). */
  function buildTodayBriefText() {
    if (window.StackPolish && typeof window.StackPolish.buildTodayBriefText === "function") {
      return window.StackPolish.buildTodayBriefText(state);
    }
    return "The Stack brief. Sync the vault, then try Voice Brief again.";
  }

  function buildAgentLatestText(agent) {
    if (!agent) return "";
    if (window.StackPolish && typeof window.StackPolish.buildAgentLatestText === "function") {
      return window.StackPolish.buildAgentLatestText(agent, state.messagesBySlug);
    }
    const st = agentMeta(agent.status);
    return agent.name + " is " + st.label + ".";
  }

  /* ===================== VIEWS ===================== */

  function renderMessageBubble(m, slug, showFoot) {
    if (!m) return "";
    if (m._typing) {
      return (
        '<div class="msg typing">' +
          '<div class="msg-head"><span class="msg-author">' + esc(m.author || "Agent") + '</span><span class="msg-time">Now</span></div>' +
          '<div class="typing-line"><span class="typing-dots"><span></span><span></span><span></span></span><span>' + esc(m.body || "Replying…") + "</span></div>" +
        "</div>"
      );
    }
    const isMe = String(m.author || "").toLowerCase() === "seth";
    return (
      '<div class="msg ' + (isMe ? "me" : "") + '">' +
        '<div class="msg-head"><span class="msg-author">' + esc(m.author || "Agent") + '</span><span class="msg-time">' + relTime(m.created_at) + "</span></div>" +
        '<div style="white-space:pre-wrap;">' + esc(m.body || "") + "</div>" +
        (showFoot ? '<div class="msg-foot"><span class="git-chip">' + esc(m._queued ? "Outbox · Pending" : "Committed · " + slug) + "</span></div>" : "") +
      "</div>"
    );
  }

  function renderToday() {
    const topNeed = state.needsSeth[0] || null;
    const allFloorMsgs = state.messagesBySlug["peer-floor"] || [];
    const floorMsgs = allFloorMsgs.slice(-8);
    const floorHtml = floorMsgs.map(function (m) {
      return renderMessageBubble(m, "peer-floor", false);
    }).join("");

    const mentionChips = '<button type="button" class="ctx-chip" data-floor-mention="@all ">@all</button>' + state.agents.filter(function (a) { return a.id !== "peer-floor"; }).map(function (a) {
      return '<button type="button" class="ctx-chip" data-floor-mention="@' + esc(a.name) + ' ">@' + esc(a.name) + "</button>";
    }).join("");

    const rosterOnly = state.agents.filter(function (a) { return a.id !== "peer-floor"; });
    const workingCount = rosterOnly.filter(function (a) { return a.status === "working" || a.status === "completed"; }).length;
    const waitingCount = rosterOnly.filter(function (a) { return a.status === "waiting"; }).length;
    const blockedCount = rosterOnly.filter(function (a) { return a.status === "blocked"; }).length;
    const wfTone = blockedCount ? "red" : waitingCount ? "amber" : workingCount ? "green" : "muted";
    const wfSub = workingCount + " active · " + waitingCount + " waiting · " + blockedCount + " blocked";
    const conflictCount = (state.conflicts || []).length;
    const commitCount = (state.commits || []).length;

    const composerHtml =
      '<div class="hero-composer">' +
        '<div class="chip-strip">' + mentionChips + "</div>" +
        '<div class="composer-wrap">' +
          '<div id="today-mention-pop" class="mention-pop hidden" role="listbox" aria-label="Mention suggestions"></div>' +
          '<form id="today-floor-form" class="composer">' +
            '<input id="today-floor-input" class="input" placeholder="Dispatch to #peer-floor… type @ to mention" autocomplete="off" enterkeyhint="send" required />' +
            '<button type="submit" class="btn btn-pri btn-sm">Send</button>' +
          "</form>" +
        "</div>" +
      "</div>";

    const pulseTone = state.link === "live" ? "green" : state.link === "polling" ? "amber" : "neutral";
    const heroKicker = topNeed ? "5-Second Brief · Needs Your Call" : ("Executive Command · " + VERSION);
    const heroBadge = topNeed
      ? '<span class="badge amber"><span class="dot amber"></span>Waiting</span>'
      : secretsMissing(state.health)
        ? '<span class="badge amber"><span class="dot amber"></span>Secrets</span>'
        : '<span class="badge ' + pulseTone + '"><span class="dot ' + (pulseTone === "neutral" ? "muted" : pulseTone) + '"></span>' + esc(state.headCommit) + "</span>";

    const heroBodyHtml = topNeed ? (
      '<h2 class="hero-title">' + esc(topNeed.title || topNeed.summary || "Decision Needed") + "</h2>" +
      '<p class="hero-copy">' + esc(topNeed.body || topNeed.reason || "") + "</p>" +
      '<div class="hero-meta">' +
        (topNeed.owner ? '<span>Owner: <strong>' + esc(topNeed.owner) + "</strong></span>" : "") +
        '<span class="git-chip">' + esc(topNeed.ref || topNeed.key || "needs_seth.json") + "</span>" +
      "</div>" +
      '<div class="hero-actions">' +
        '<button type="button" class="btn btn-pri" data-ping-floor="Approved go on: ' + esc(topNeed.title || topNeed.key || "need") + '">Approve Go</button>' +
        '<button type="button" class="btn btn-sec" data-ping-floor="HOLD: ' + esc(topNeed.title || topNeed.key || "need") + '">Hold</button>' +
        '<button type="button" class="btn btn-sec" data-jump-agent="peer-floor">#peer-floor</button>' +
      "</div>"
    ) : secretsMissing(state.health) ? (
      '<h2 class="hero-title">Worker secrets not armed</h2>' +
      '<p class="hero-copy">Add <span class="mono">GITHUB_PAT</span> and <span class="mono">STACK_ACCESS_PIN</span> as <strong>Secrets</strong> on Worker <span class="mono">the-stack-bff</span> (not Pages Variables). Then tap the sync pill.</p>' +
      '<div class="hero-actions"><button type="button" class="btn btn-pri" id="btn-resync">Retry Sync</button><button type="button" class="btn btn-sec" data-go="stats">Usage &amp; Git</button></div>'
    ) : (
      '<h2 class="hero-title">Workforce Pulse</h2>' +
      '<p class="hero-copy"><strong>' + workingCount + " active</strong> · " + waitingCount + " waiting · " + blockedCount + ' blocked · Head <span class="git-chip">' + esc(state.headCommit) + "</span></p>" +
      '<div class="hero-meta">' +
        "<span>Synced " + relTime(state.lastSyncIso) + "</span>" +
        "<span>$" + ZERO_SPEND + " cap</span>" +
        "<span>Queue OFF</span>" +
        (conflictCount ? '<span class="badge amber">' + conflictCount + " conflict" + (conflictCount === 1 ? "" : "s") + "</span>" : "") +
      "</div>"
    );

    const heroHtml =
      '<section class="hero">' +
        '<div class="hero-top">' +
          '<span class="kicker">' + esc(heroKicker) + "</span>" +
          '<div class="hero-top-actions">' +
            heroBadge +
            '<button type="button" class="btn btn-sec btn-sm voice-btn" id="btn-voice-brief">🔊 Voice Brief</button>' +
          "</div>" +
        "</div>" +
        heroBodyHtml +
        composerHtml +
      "</section>";

    const streamCol =
      '<div class="today-col">' +
        '<div class="section-head"><span class="section-title">Live #peer-floor Stream</span><button type="button" class="section-link" data-jump-agent="peer-floor">Open Room ›</button></div>' +
        '<div class="panel">' +
          '<div class="stream-head">' +
            '<span class="row-title" style="font-size:13.5px;"><span class="dot green"></span>#peer-floor <span class="mono">· ' + allFloorMsgs.length + " msgs</span></span>" +
            '<button type="button" class="btn btn-sec btn-sm" data-jump-agent="peer-floor">Jump ›</button>' +
          "</div>" +
          '<div id="today-floor-log" class="chat-log today-floor-log">' +
            (floorHtml || '<div class="empty">Message everyone on #peer-floor — commits straight to Git.</div>') +
          "</div>" +
        "</div>" +
      "</div>";

    const sheetsCol =
      '<div class="today-col">' +
        '<div class="section-head"><span class="section-title">Command Sheets</span></div>' +
        '<div class="panel">' +
          '<button type="button" class="row" id="btn-sheet-workforce">' +
            '<div class="row-main"><div class="row-title"><span class="dot ' + wfTone + '"></span>Workforce</div><div class="row-sub">' + esc(wfSub) + "</div></div>" +
            '<div class="row-right"><span>' + rosterOnly.length + " agents</span><span>›</span></div>" +
          "</button>" +
          '<button type="button" class="row" id="btn-sheet-conflicts">' +
            '<div class="row-main"><div class="row-title"><span class="dot ' + (conflictCount ? "amber" : "green") + '"></span>File Conflicts</div><div class="row-sub">' + (conflictCount ? "Paths touched by multiple agents" : "No multi-agent path overlaps") + "</div></div>" +
            '<div class="row-right">' + (conflictCount ? '<span class="badge amber">' + conflictCount + "</span>" : "<span>Clean</span>") + "<span>›</span></div>" +
          "</button>" +
          '<button type="button" class="row" id="btn-sheet-commits">' +
            '<div class="row-main"><div class="row-title">Git Commits</div><div class="row-sub">Head ' + esc(state.headCommit) + " · " + relTime(state.lastSyncIso) + "</div></div>" +
            '<div class="row-right"><span class="git-chip">' + commitCount + "</span><span>›</span></div>" +
          "</button>" +
          '<button type="button" class="row" id="btn-quick-inbox">' +
            '<div class="row-main"><div class="row-title">Quick-Action Inbox</div><div class="row-sub">Capture an idea or dictation to #peer-floor</div></div>' +
            '<div class="row-right"><span>Capture</span><span>›</span></div>' +
          "</button>" +
        "</div>" +
      "</div>";

    return heroHtml + '<div class="today-grid">' + streamCol + sheetsCol + "</div>";
  }

  function renderAgents() {
    const agent = state.agents.find(function (a) { return a.id === state.activeAgentId; }) || state.agents[0];
    if (!agent) return '<div class="empty">Loading agents…</div>';
    const st = agentMeta(agent.status);
    const slug = dmSlugForAgent(agent.id);
    const msgs = state.messagesBySlug[slug] || [];
    const usageTone = agent.usagePct >= 85 ? "red" : agent.usagePct >= 70 ? "amber" : "";
    const pctText = (agent.pctEstimated ? "~" : "") + agent.usagePct + "% used";
    const memEntries = state.sharedMemory.entries || [];

    const switcher = state.agents.map(function (a) {
      const am = agentMeta(a.status);
      return (
        '<button type="button" class="agent-pill ' + (a.id === agent.id ? "active" : "") + '" data-select-agent="' + esc(a.id) + '">' +
          '<span class="agent-pill-top"><span class="dot ' + am.tone + '"></span>' + esc(a.name) + "</span>" +
          '<span class="agent-pill-age">' + esc(agentAgeText(a)) + "</span>" +
        "</button>"
      );
    }).join("");

    const msgHtml = msgs.slice(-40).map(function (m) {
      return renderMessageBubble(m, slug, true);
    }).join("");

    const savedDraft = state.draftsBySlug[slug] || "";

    return (
      '<div class="agent-strip" style="margin-bottom:10px;">' + switcher + "</div>" +
      '<section class="hero chat-hero">' +
        '<div class="hero-top">' +
          '<div style="min-width:0;"><span class="kicker">' + esc(agent.role) + " · " + esc(agent.model) + '</span><h2 class="hero-title">' + esc(agent.name) + "</h2></div>" +
          '<div class="hero-top-actions">' +
            '<span class="badge ' + st.tone + '"><span class="dot ' + st.tone + '"></span>' + esc(st.label) + "</span>" +
            '<button type="button" class="btn btn-sec btn-sm" id="btn-agent-memory" aria-label="Memory (' + memEntries.length + ')" title="Memory (' + memEntries.length + ')">🧠 <span class="hide-xs">Memory </span>(' + memEntries.length + ")</button>" +
            '<button type="button" class="btn btn-sec btn-sm voice-btn" id="btn-voice-agent" aria-label="Read Latest" title="Read Latest">🔊<span class="hide-xs"> Read Latest</span></button>' +
            '<button type="button" class="btn btn-sec btn-sm kb-done-btn" id="btn-chat-kb-done" aria-label="Hide keyboard">Done</button>' +
          "</div>" +
        "</div>" +
        '<div class="chat-subbar">' +
          '<div class="chat-subbar-top">' +
            (agent.id !== "peer-floor"
              ? '<span><strong>' + esc(pctText) + "</strong> · " + esc(agent.reset) + " · " + esc(agent.activitySummary) + "</span>" +
                '<span class="mono">' + esc(agent.lastSeen) + "</span>"
              : '<span>channels/peer-floor/messages.jsonl</span><span class="mono">' + esc(agent.activitySummary) + "</span>") +
          "</div>" +
          (agent.id !== "peer-floor" ? '<div class="meter" style="margin-top:5px;height:4px;"><div class="meter-fill ' + usageTone + '" style="width:' + agent.usagePct + '%"></div></div>' : "") +
        "</div>" +
        '<div class="chat-log-wrap">' +
          '<div id="chat-log" class="chat-log">' + (msgHtml || '<div class="empty">No local messages yet — pings commit via BFF to ' + esc(slug) + ".</div>") + "</div>" +
          '<button type="button" id="chat-jump-bottom" class="chat-jump-pill hidden">↓ Latest</button>' +
        "</div>" +
        '<div class="chip-strip">' +
          (agent.id === "peer-floor" ? '<button type="button" class="ctx-chip" data-insert="@all">@all</button>' + state.agents.filter(function (a) { return a.id !== "peer-floor"; }).map(function (a) {
            return '<button type="button" class="ctx-chip" data-insert="@' + esc(a.name) + '">@' + esc(a.name) + "</button>";
          }).join("") : "") +
          '<button type="button" class="ctx-chip" data-insert="Ping: confirm active commit SHA, current blocker, and next gate.">Reliable Ping</button>' +
          '<button type="button" class="ctx-chip" data-insert="QC needed: reviewer !== builder, include commit SHA + checks.">QC Gate</button>' +
        "</div>" +
        '<div class="composer-wrap">' +
          '<div id="agent-mention-pop" class="mention-pop hidden" role="listbox" aria-label="Mention suggestions"></div>' +
          '<form id="agent-chat-form" class="composer">' +
            '<input id="agent-chat-input" class="input" data-slug="' + esc(slug) + '" value="' + esc(savedDraft) + '" placeholder="' + (agent.id === "peer-floor" ? "Message #peer-floor… type @ to mention" : "Message " + esc(agent.name) + "…") + '" autocomplete="off" enterkeyhint="send" required />' +
            '<button type="submit" class="btn btn-pri btn-sm">' + (agent.id === "peer-floor" ? "Send" : "Ping") + "</button>" +
          "</form>" +
        "</div>" +
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
    const hero = filtered[0] || (state.workFilter === "all" ? state.items[0] : null);
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
    ) : (
      '<section class="hero">' +
        '<div class="hero-top"><span class="kicker">Work Board · ' + VERSION + '</span><span class="badge neutral">Empty Filter</span></div>' +
        '<h2 class="hero-title">No items in this view</h2>' +
        '<p class="hero-copy">Nothing matches the selected work filter right now. Switch back to Active workstreams or sync with Git.</p>' +
        '<div class="hero-actions">' +
          '<button type="button" class="btn btn-pri" data-work-filter="all">Show Active</button>' +
          '<button type="button" class="btn btn-sec" id="btn-sync-now">Sync Now</button>' +
        "</div>" +
      "</section>"
    );

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
    const anyLiveUsage = modelAgents.some(function (a) { return a.hasLiveUsage; });
    const totalPct = modelAgents.reduce(function (sum, a) { return sum + (a.usagePct || 0); }, 0);
    const avgPct = modelAgents.length ? Math.round(totalPct / modelAgents.length) : 0;
    const totalEvents = modelAgents.reduce(function (sum, a) { return sum + (a.activity24h || 0); }, 0);
    const activeCount = modelAgents.filter(function (a) { return a.status === "working" || a.status === "completed"; }).length;
    const peakAgent = modelAgents.reduce(function (best, a) {
      return !best || (a.usagePct || 0) > (best.usagePct || 0) ? a : best;
    }, null);
    const avgTone = avgPct >= 85 ? "red" : avgPct >= 70 ? "amber" : "";

    const usageRows = modelAgents.map(function (a) {
      const m = agentMeta(a.status);
      const tone = a.usagePct >= 85 ? "red" : a.usagePct >= 70 ? "amber" : "";
      const pctLabel = a.hasLiveUsage ? ((a.pctEstimated ? "~" : "") + a.usagePct + "%") : (state.online ? "0%" : "—");
      const lastCallTxt = a.lastCallAt ? (" · last " + relTime(a.lastCallAt)) : "";
      return (
        '<div class="usage-row">' +
          '<div class="usage-row-top">' +
            '<div class="usage-row-main">' +
              '<div class="row-title"><span class="dot ' + m.tone + '"></span>' + esc(a.name) + ' <span class="mono">· ' + esc(a.model) + "</span></div>" +
              '<div class="row-sub">' + esc(m.label) + " · " + esc(a.reset) + esc(lastCallTxt) + " · " + esc(a.activitySummary) + "</div>" +
            "</div>" +
            '<div class="usage-row-actions">' +
              '<strong class="mono">' + esc(pctLabel) + "</strong>" +
              '<button type="button" class="btn btn-sec btn-sm" data-edit-usage="' + esc(a.id) + '">Calibrate</button>' +
              '<button type="button" class="btn btn-sec btn-sm" data-jump-agent="' + esc(a.id) + '">DM ›</button>' +
            "</div>" +
          "</div>" +
          '<div class="meter" style="margin-top:0;"><div class="meter-fill ' + tone + '" style="width:' + a.usagePct + '%"></div></div>' +
          '<div class="usage-row-meta">' +
            '<span class="git-chip">' + esc(a.evidence) + "</span>" +
            (a.usageNote ? '<span class="row-sub" style="margin-top:0;">' + esc(a.usageNote) + "</span>" : "") +
          "</div>" +
        "</div>"
      );
    }).join("");

    const healthLine = state.health
      ? ('Health: <strong>' + esc(state.health.status || "—") + "</strong> · open approvals " + esc(String(state.health.open_approvals || 0)) + " · cap $" + esc(String(state.health.zero_spend_cap_usd ?? ZERO_SPEND)))
      : "Health not loaded";
    const shaTone = state.link === "live" ? "green" : state.link === "polling" ? "amber" : "neutral";
    const autoBadgeTone = state.online ? "green" : "neutral";
    const usageStatus = state.usageAutoSynced
      ? ("Auto-synced" + (state.usageSyncedAt ? " · " + relTime(state.usageSyncedAt) : ""))
      : (anyLiveUsage ? "Live telemetry" : (state.online ? "Live Git & floor activity" : "Offline — tap Sync Now"));

    return (
      '<section class="hero">' +
        '<div class="hero-top">' +
          '<span class="kicker">System &amp; Quota Pulse · ' + esc(VERSION) + "</span>" +
          '<div class="hero-top-actions">' +
            '<span class="badge ' + autoBadgeTone + '">' + (state.online ? '<span class="dot green"></span>' : "") + "Auto-Sync · 20s</span>" +
            '<span class="badge ' + shaTone + '"><span class="dot ' + (shaTone === "neutral" ? "muted" : shaTone) + '"></span>' + esc(state.headCommit) + "</span>" +
          "</div>" +
        "</div>" +
        '<h2 class="hero-title">Workforce &amp; BFF Pulse</h2>' +
        '<p class="hero-copy">Avg quota <strong>' + avgPct + "%</strong> across " + modelAgents.length + " agents (" + activeCount + " active · " + totalEvents + " events 24h" + (peakAgent ? (" · peak " + esc(peakAgent.name) + " " + peakAgent.usagePct + "%") : "") + ')<br/><span class="mono">' + esc(creds.bff) + "</span> · Last sync " + relTime(state.lastSyncIso) + " · " + state.outbox.length + " pending · Queue OFF · $" + ZERO_SPEND + " cap<br/>" + healthLine + "</p>" +
        '<div class="meter" style="margin-bottom:14px;"><div class="meter-fill ' + avgTone + '" style="width:' + avgPct + '%"></div></div>' +
        '<div class="hero-actions">' +
          '<button type="button" class="btn btn-pri btn-sm" id="btn-sync-now">Sync Now</button>' +
          '<button type="button" class="btn btn-sec btn-sm" id="btn-timemachine">Time Machine</button>' +
          '<button type="button" class="btn btn-sec btn-sm" id="btn-voice-settings">Voice Settings</button>' +
          (state.outbox.length ? '<button type="button" class="btn btn-sec btn-sm" id="btn-flush-ob">Flush Outbox (' + state.outbox.length + ")</button>" : "") +
          '<button type="button" class="btn btn-danger btn-sm" id="btn-sign-out">Lock</button>' +
        "</div>" +
      "</section>" +
      '<div class="section-head"><span class="section-title">Live All-Agent Usage Tracker</span><span class="mono">' + esc(usageStatus) + "</span></div>" +
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

    const hasTriage = state.needsSeth.length > 0 || state.items.some(function (i) { return itemStateMeta(i.state).key === "blocked"; });
    const hasChatAlert = unreadNotifs > 0 || state.outbox.length > 0;
    ["sb-triage-badge", "dk-triage-dot"].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle("hidden", !hasTriage);
    });
    ["sb-chat-badge", "dk-chat-dot"].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle("hidden", !hasChatAlert);
    });

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

    const prevChat = document.getElementById("chat-log");
    let chatMetrics = null;
    if (prevChat) {
      const prevScrollTop = prevChat.scrollTop;
      const prevScrollHeight = prevChat.scrollHeight;
      const prevClientHeight = prevChat.clientHeight;
      chatMetrics = {
        prevScrollTop: prevScrollTop,
        prevScrollHeight: prevScrollHeight,
        prevClientHeight: prevClientHeight,
        wasNearBottom: (prevScrollHeight - prevScrollTop - prevClientHeight) < 72
      };
    }

    const prevFloor = document.getElementById("today-floor-log");
    let floorMetrics = null;
    if (prevFloor) {
      floorMetrics = {
        prevScrollTop: prevFloor.scrollTop,
        wasNearBottom: (prevFloor.scrollHeight - prevFloor.scrollTop - prevFloor.clientHeight) < 72
      };
    }

    const savedDrafts = [];
    ["agent-chat-input", "today-floor-input"].forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      const slug = el.dataset ? el.dataset.slug : "";
      if (id === "agent-chat-input" && slug) {
        if (el.value) state.draftsBySlug[slug] = el.value;
        else delete state.draftsBySlug[slug];
      }
      const hadFocus = document.activeElement === el;
      if (el.value || hadFocus) {
        savedDrafts.push({
          id: id,
          slug: slug,
          value: el.value,
          selectionStart: el.selectionStart,
          selectionEnd: el.selectionEnd,
          hadFocus: hadFocus
        });
      }
    });

    if (state.view === "today") root.innerHTML = renderToday();
    else if (state.view === "agents") root.innerHTML = renderAgents();
    else if (state.view === "work") root.innerHTML = renderWork();
    else root.innerHTML = renderStats();

    document.body.classList.toggle("view-agents", state.view === "agents");
    root.classList.toggle("view-agents", state.view === "agents");
    renderChrome();
    bindEvents();

    const ov = document.getElementById("overlay");
    const sheetOpen = Boolean(ov && ov.classList.contains("open"));
    savedDrafts.forEach(function (d) {
      const el = document.getElementById(d.id);
      if (!el) return;
      const nextSlug = el.dataset ? el.dataset.slug : "";
      if (d.id === "agent-chat-input" && d.slug && nextSlug && d.slug !== nextSlug) return;
      if (d.value) el.value = d.value;
      if (d.hadFocus && !sheetOpen) {
        try {
          el.focus({ preventScroll: true });
          if (typeof d.selectionStart === "number" && el.setSelectionRange) {
            el.setSelectionRange(d.selectionStart, d.selectionEnd);
          }
        } catch (e) {}
      }
    });

    const chatLog = document.getElementById("chat-log");
    const jumpBtn = document.getElementById("chat-jump-bottom");
    if (chatLog) {
      if (state.forceChatBottom || !chatMetrics || chatMetrics.wasNearBottom) {
        chatLog.scrollTop = chatLog.scrollHeight;
        state.forceChatBottom = false;
        if (jumpBtn) jumpBtn.classList.add("hidden");
      } else {
        chatLog.scrollTop = chatMetrics.prevScrollTop;
        const farFromBottom = (chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight) > 96 && chatLog.clientHeight >= 90;
        if (jumpBtn) jumpBtn.classList.toggle("hidden", !farFromBottom);
      }
    } else if (state.view !== "agents") {
      state.forceChatBottom = false;
    }

    const floorLog = document.getElementById("today-floor-log");
    if (floorLog) {
      if (!floorMetrics || floorMetrics.wasNearBottom) floorLog.scrollTop = floorLog.scrollHeight;
      else floorLog.scrollTop = floorMetrics.prevScrollTop;
    }
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
      '<div class="sheet-head"><div><h2 class="sheet-title">Quick-Action Inbox</h2><p class="sheet-sub">Type or use iPhone keyboard dictation — commits to #peer-floor</p></div><button type="button" class="orb-btn" style="width:32px;height:32px;" data-close-sheet>✕</button></div>' +
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
        state.messagesBySlug["peer-floor"] = (state.messagesBySlug["peer-floor"] || []).concat([{
          author: "Seth", body: "Quick Action: " + body, created_at: new Date().toISOString()
        }]);
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
        if (n.targetType === "agent" && n.targetId) {
          jumpToAgent(n.targetId);
        } else if (n.targetType === "commit") {
          state.view = "stats"; render(); openTimeMachine();
        } else if (n.targetType === "needs") {
          const hit = state.items.find(function (i) {
            return (n.targetId && i.id === n.targetId) || (n.targetRef && i.ref === n.targetRef) || (i.title && n.title && i.title.toLowerCase() === n.title.toLowerCase());
          });
          if (hit) { state.view = "work"; render(); openItemSheet(hit.id); }
          else if (n.targetAgent && state.agents.some(function (a) { return a.id === n.targetAgent; })) { jumpToAgent(n.targetAgent); }
          else { state.view = "today"; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
        } else if (n.targetType === "stats") {
          state.view = "stats"; render();
        } else {
          state.view = "today"; render();
        }
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

  function openWorkforceSheet() {
    const rows = state.agents.filter(function (a) { return a.id !== "peer-floor"; }).map(function (a) {
      const m = agentMeta(a.status);
      return (
        '<button type="button" class="row" data-sheet-agent="' + esc(a.id) + '">' +
          '<div class="row-main">' +
            '<div class="row-title"><span class="dot ' + m.tone + '"></span>' + esc(a.name) + ' <span class="mono">· ' + esc(a.role) + "</span></div>" +
            '<div class="row-sub">' + esc(agentAgeText(a)) + " · " + esc(a.evidence) + "</div>" +
          "</div>" +
          '<div class="row-right"><span>' + a.usagePct + "%</span><span>›</span></div>" +
        "</button>"
      );
    }).join("");
    openSheet(
      '<div class="sheet-head"><div><h2 class="sheet-title">Workforce</h2><p class="sheet-sub">5 explicit states · tap any agent to DM</p></div><button type="button" class="orb-btn" style="width:32px;height:32px;" data-close-sheet>✕</button></div>' +
      '<div class="panel" style="margin-bottom:0;">' + (rows || '<div class="empty">No agents loaded.</div>') + "</div>"
    );
    document.getElementById("sheet").querySelectorAll("[data-sheet-agent]").forEach(function (b) {
      b.addEventListener("click", function () { closeSheet(); jumpToAgent(b.dataset.sheetAgent); });
    });
  }

  function openConflictsSheet() {
    const rows = (state.conflicts || []).map(function (c) {
      return (
        '<div class="row">' +
          '<div class="row-main">' +
            '<div class="row-title"><span class="dot amber"></span>' + esc(c.path.split("/").pop()) + "</div>" +
            '<div class="row-sub">' + esc(c.path) + " · " + esc(c.agents.join(" · ")) + "</div>" +
          "</div>" +
          '<span class="git-chip">' + esc(c.shas.slice(0, 2).join(" ")) + "</span>" +
        "</div>"
      );
    }).join("");
    openSheet(
      '<div class="sheet-head"><div><h2 class="sheet-title">File Conflicts</h2><p class="sheet-sub">Paths touched by multiple agents</p></div><button type="button" class="orb-btn" style="width:32px;height:32px;" data-close-sheet>✕</button></div>' +
      '<div class="panel" style="margin-bottom:0;">' + (rows || '<div class="empty">No conflicts.</div>') + "</div>"
    );
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

  function openAgentMemorySheet() {
    const agent = state.agents.find(function (a) { return a.id === state.activeAgentId; }) || state.agents[0];
    const memEntries = state.sharedMemory.entries || [];
    const memRows = memEntries.map(function (e) {
      return (
        '<div class="row">' +
          '<div class="row-main">' +
            '<div class="row-title" style="white-space:normal;">' + esc(e.fact || "") + "</div>" +
            '<div class="row-sub" style="margin-top:4px;"><span class="git-chip">' + esc(e.source || "memory") + '</span>' + (e.updated_at ? " · " + relTime(e.updated_at) : "") + "</div>" +
          "</div>" +
        "</div>"
      );
    }).join("");

    const st = agent ? agentMeta(agent.status) : agentMeta("offline");
    const quotaHtml = agent ? (
      '<div class="quota-box" style="margin-bottom:14px;">' +
        '<div class="quota-top">' +
          '<span class="badge ' + st.tone + '"><span class="dot ' + st.tone + '"></span>' + esc(agent.name) + " · " + esc(st.label) + "</span>" +
          (agent.id !== "peer-floor"
            ? '<div class="usage-row-actions"><strong class="mono">' + esc((agent.pctEstimated ? "~" : "") + agent.usagePct + "%") + '</strong><button type="button" class="btn btn-sec btn-sm" id="sheet-calibrate-btn" data-sheet-calibrate="' + esc(agent.id) + '">Calibrate</button></div>'
            : '<span class="mono">' + esc(agent.activitySummary) + "</span>") +
        "</div>" +
        (agent.id !== "peer-floor"
          ? '<div class="meter"><div class="meter-fill ' + (agent.usagePct >= 85 ? "red" : agent.usagePct >= 70 ? "amber" : "") + '" style="width:' + agent.usagePct + '%"></div></div>' : "") +
        '<div class="quota-meta"><span class="git-chip">Evidence: ' + esc(agent.evidence) + '</span><span>' + esc(agent.reset) + " · " + esc(agent.activitySummary) + "</span></div>" +
        (agent.usageNote ? '<div class="row-sub" style="margin-top:6px;">' + esc(agent.usageNote) + "</div>" : "") +
      "</div>"
    ) : "";

    openSheet(
      '<div class="sheet-head"><div><h2 class="sheet-title">Memory &amp; Agent State</h2><p class="sheet-sub">Shared Team Memory · Evidence · Quota</p></div><button type="button" class="orb-btn" style="width:32px;height:32px;" data-close-sheet>✕</button></div>' +
      quotaHtml +
      '<div class="section-head" style="margin-top:2px;"><span class="section-title">Shared Team Memory</span><span class="mono">' + memEntries.length + " entries</span></div>" +
      '<div class="panel" style="margin-bottom:0;">' + (memRows || '<div class="empty">No shared team memory entries yet.</div>') + "</div>"
    );

    const calBtn = document.getElementById("sheet-calibrate-btn");
    if (calBtn) {
      calBtn.addEventListener("click", function () {
        openUsageEditSheet(calBtn.dataset.sheetCalibrate);
      });
    }
  }

  function openUsageEditSheet(agentId) {
    const agent = state.agents.find(function (a) { return a.id === agentId; });
    if (!agent) return;
    const initialReset = agent.windowLabel || agent.resetAt || agent.reset || "";
    openSheet(
      '<div class="sheet-head"><div><h2 class="sheet-title">Calibrate Quota · ' + esc(agent.name) + '</h2><p class="sheet-sub">' + esc(agent.model) + " · commits to usage.json</p></div><button type=\"button\" class=\"orb-btn\" style=\"width:32px;height:32px;\" data-close-sheet>✕</button></div>" +
      '<form id="usage-edit-form">' +
        '<div class="field"><label for="usage-pct">% Used (0–100)</label>' +
        '<input id="usage-pct" class="input mono" type="number" min="0" max="100" step="1" value="' + esc(String(agent.usagePct || 0)) + '" required /></div>' +
        '<div class="field"><label for="usage-reset">Reset Window</label>' +
        '<input id="usage-reset" class="input" type="text" value="' + esc(initialReset) + '" placeholder="e.g. 4h window, Daily, or ISO reset time" /></div>' +
        '<div class="field"><label for="usage-note">Note</label>' +
        '<textarea id="usage-note" class="input" rows="3" placeholder="Current quota note or pool status">' + esc(agent.usageNote || "") + "</textarea></div>" +
        '<div class="hero-actions"><button type="submit" id="usage-save-btn" class="btn btn-pri" style="width:100%;">Save Calibration</button></div>' +
      "</form>"
    );

    document.getElementById("usage-edit-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      const rawVal = Number(document.getElementById("usage-pct").value);
      if (isNaN(rawVal) || rawVal < 0 || rawVal > 100) {
        toast("% Used must be between 0 and 100", "warning");
        return;
      }
      const pctVal = Math.max(0, Math.min(100, Math.round(rawVal)));
      const resetVal = document.getElementById("usage-reset").value.trim();
      const noteVal = document.getElementById("usage-note").value.trim();
      const statusVal = pctVal >= 95 ? "capped" : pctVal >= 80 ? "attention" : "ok";
      const providerId = agent.providerId || agent.id;
      const saveBtn = document.getElementById("usage-save-btn");
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }

      const isIsoReset = /^\d{4}-\d{2}-\d{2}T/.test(resetVal);
      const payload = {
        id: providerId,
        pct_used: pctVal,
        window_label: isIsoReset ? (agent.windowLabel || agent.reset) : (resetVal || agent.windowLabel || agent.reset),
        reset_at: isIsoReset ? resetVal : (agent.resetAt || null),
        note: noteVal,
        status: statusVal,
        model: agent.model
      };

      try {
        const out = await bff("/api/usage", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        if (out && out.usage && Array.isArray(out.usage.providers)) {
          state.usageRaw = out.usage;
        } else {
          if (!state.usageRaw || typeof state.usageRaw !== "object" || Array.isArray(state.usageRaw)) {
            state.usageRaw = { version: 1, providers: Array.isArray(state.usageRaw) ? state.usageRaw : [] };
          }
          if (!Array.isArray(state.usageRaw.providers)) state.usageRaw.providers = [];
          const list = state.usageRaw.providers;
          const idx = list.findIndex(function (p) {
            const pid = String(p.id || "").toLowerCase();
            const pag = String(p.agent || "").toLowerCase();
            return pid === String(providerId).toLowerCase() || pid === agent.id.toLowerCase() || pag === agent.name.toLowerCase();
          });
          const nextEntry = Object.assign({}, idx >= 0 ? list[idx] : {}, {
            id: providerId,
            agent: (idx >= 0 && list[idx].agent) || agent.name,
            model: agent.model,
            pct_used: pctVal,
            window_label: payload.window_label,
            reset_at: payload.reset_at,
            note: noteVal,
            status: statusVal,
            source: "manual-ui",
            updated_at: new Date().toISOString()
          });
          if (idx >= 0) list[idx] = nextEntry;
          else list.push(nextEntry);
          state.usageRaw.updated_at = nextEntry.updated_at;
        }
        normalizeHubData();
        closeSheet();
        render();
        toast("Calibrated " + agent.name + " quota (" + pctVal + "%)", "info");
      } catch (err) {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save Calibration"; }
        toast((err && err.message) || "Failed to update quota", "error");
      }
    });
  }

  function openVoiceSettingsSheet() {
    const savedKey = getSavedElevenKey();
    const savedVoice = getSavedVoiceId();
    openSheet(
      '<div class="sheet-head"><div><h2 class="sheet-title">Voice Settings</h2><p class="sheet-sub">$0 Web Speech by default · Optional ElevenLabs Turbo v2.5</p></div><button type="button" class="orb-btn" style="width:32px;height:32px;" data-close-sheet>✕</button></div>' +
      '<form id="voice-settings-form">' +
        '<div class="field"><label for="voice-el-key">ElevenLabs API Key (optional · browser localStorage only)</label>' +
        '<input id="voice-el-key" class="input mono" type="password" value="' + esc(savedKey) + '" placeholder="xi-… leave blank for $0 Web Speech" autocomplete="off" /></div>' +
        '<div class="field"><label for="voice-el-id">ElevenLabs Voice ID</label>' +
        '<input id="voice-el-id" class="input mono" type="text" value="' + esc(savedVoice) + '" placeholder="' + DEFAULT_VOICE_ID + '" autocomplete="off" /></div>' +
        '<div class="chip-strip">' +
          '<button type="button" class="ctx-chip" data-voice-preset="JBFqnCBsd6RMkjVDRZzb">George (Default)</button>' +
          '<button type="button" class="ctx-chip" data-voice-preset="21m00Tcm4TlvDq8ikWAM">Rachel</button>' +
          '<button type="button" class="ctx-chip" data-voice-preset="pNInz6obpgDQGcFmaJgB">Adam</button>' +
        "</div>" +
        '<div class="hero-actions" style="margin-top:8px;">' +
          '<button type="submit" class="btn btn-pri btn-sm">Save Settings</button>' +
          '<button type="button" class="btn btn-sec btn-sm voice-btn" id="btn-voice-test">🔊 Test Voice</button>' +
          '<button type="button" class="btn btn-danger btn-sm" id="btn-voice-clear">Clear Key ($0)</button>' +
        "</div>" +
      "</form>"
    );

    const keyEl = document.getElementById("voice-el-key");
    const idEl = document.getElementById("voice-el-id");
    document.getElementById("sheet").querySelectorAll("[data-voice-preset]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (idEl) idEl.value = b.dataset.voicePreset;
      });
    });

    document.getElementById("voice-settings-form").addEventListener("submit", function (e) {
      e.preventDefault();
      const k = keyEl ? keyEl.value.trim() : "";
      const v = (idEl && idEl.value.trim()) || DEFAULT_VOICE_ID;
      try {
        if (k) localStorage.setItem(ELEVEN_KEY_STORAGE, k);
        else localStorage.removeItem(ELEVEN_KEY_STORAGE);
        localStorage.setItem(ELEVEN_VOICE_STORAGE, v);
      } catch (err) {}
      toast(k ? "Saved ElevenLabs key + voice " + v : "Saved $0 Web Speech mode", "info");
      closeSheet();
    });

    const testBtn = document.getElementById("btn-voice-test");
    if (testBtn) {
      testBtn.addEventListener("click", function () {
        speakText("The Stack voice agent is online. Zero spend cap confirmed.", testBtn, {
          apiKey: keyEl ? keyEl.value.trim() : "",
          voiceId: (idEl && idEl.value.trim()) || DEFAULT_VOICE_ID
        });
      });
    }

    const clearBtn = document.getElementById("btn-voice-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        stopSpeaking();
        try { localStorage.removeItem(ELEVEN_KEY_STORAGE); } catch (err) {}
        if (keyEl) keyEl.value = "";
        toast("Cleared ElevenLabs key — $0 Web Speech active", "info");
      });
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
    else if (row.action === "view:agents") { state.view = "agents"; state.forceChatBottom = true; render(); await loadActiveAgentMessages(); render(); }
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

  function inferResponderName(slug, body) {
    const names = { gemini: "Gemini", cursor: "Cursor", claude: "Claude", chatgpt: "ChatGPT", nori: "Nori", grokbot: "Grokbot" };
    if (slug && slug !== "peer-floor") {
      const m = /^dm-([a-z0-9_-]+)-seth$/i.exec(slug);
      const id = m ? m[1].toLowerCase() : "";
      if (names[id]) return names[id];
      return id ? (id.charAt(0).toUpperCase() + id.slice(1)) : "Agent";
    }
    const mention = /@(gemini|cursor|claude|chatgpt|nori|grokbot)\b/i.exec(String(body || ""));
    if (mention) return names[mention[1].toLowerCase()] || "StackBot (Live)";
    return "StackBot (Live)";
  }

  async function jumpToAgent(agentId) {
    const match = state.agents.find(function (a) { return a.id === agentId; });
    state.activeAgentId = match ? match.id : "peer-floor";
    state.view = "agents";
    state.forceChatBottom = true;
    render();
    await loadActiveAgentMessages();
    state.forceChatBottom = true;
    render();
  }

  async function sendToSlug(slug, text, agentIdForOutbox) {
    const body = String(text || "").trim();
    const channel = slug || "peer-floor";
    if (!body) return;

    const responderName = inferResponderName(channel, body);
    const tempUserId = "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    const typingId = "typing-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    const nowIso = new Date().toISOString();

    state.messagesBySlug[channel] = (state.messagesBySlug[channel] || []).concat([
      { id: tempUserId, channel_slug: channel, author: "Seth", body: body, created_at: nowIso },
      { id: typingId, channel_slug: channel, author: responderName, body: "Replying…", _typing: true, created_at: nowIso }
    ]);
    state.forceChatBottom = true;
    state.sendingPing += 1;
    render();

    try {
      const out = await bff("/api/ping", {
        method: "POST",
        body: JSON.stringify({ slug: channel, author: "Seth", body: body })
      });
      const prevList = state.messagesBySlug[channel] || [];
      const nextList = [];
      prevList.forEach(function (m) {
        if (!m || m.id === typingId) return;
        if (m.id === tempUserId) {
          nextList.push(out && out.message ? out.message : m);
        } else {
          nextList.push(m);
        }
      });
      if (out && out.reply && !nextList.some(function (m) { return out.reply.id && m.id === out.reply.id; })) {
        nextList.push(out.reply);
      }
      state.messagesBySlug[channel] = nextList.slice(-60);
      toast(out && out.reply ? ((out.reply.author || responderName) + " replied") : ("Sent to " + channel), "info");
      state.forceChatBottom = true;
      normalizeHubData();
      render();
    } catch (e) {
      const evt = { id: "evt-" + Date.now(), type: "message", slug: channel, body: body };
      if (agentIdForOutbox) evt.agentId = agentIdForOutbox;
      state.outbox.unshift(evt);
      saveOutbox();
      state.messagesBySlug[channel] = (state.messagesBySlug[channel] || []).filter(function (m) {
        return m && m.id !== typingId;
      }).map(function (m) {
        return m.id === tempUserId ? Object.assign({}, m, { _queued: true }) : m;
      });
      state.link = (typeof navigator !== "undefined" && navigator.onLine === false) ? "offline" : state.link;
      toast("Offline — saved to Outbox", "warning");
      state.forceChatBottom = true;
      render();
    } finally {
      state.sendingPing = Math.max(0, state.sendingPing - 1);
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
    root.querySelectorAll("[data-go]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.view = b.dataset.go;
        if (state.view === "agents") state.forceChatBottom = true;
        render();
      });
    });
    root.querySelectorAll("[data-work-filter]").forEach(function (b) { b.addEventListener("click", function () { state.workFilter = b.dataset.workFilter; render(); }); });
    root.querySelectorAll("[data-inspect]").forEach(function (b) { b.addEventListener("click", function () { openItemSheet(b.dataset.inspect); }); });
    root.querySelectorAll("[data-qc]").forEach(function (b) { b.addEventListener("click", function () { openQcSheet(b.dataset.qc); }); });
    root.querySelectorAll("[data-edit-usage]").forEach(function (b) { b.addEventListener("click", function () { openUsageEditSheet(b.dataset.editUsage); }); });

    const vbBtn = document.getElementById("btn-voice-brief");
    if (vbBtn) vbBtn.addEventListener("click", function () { speakText(buildTodayBriefText(), vbBtn); });
    const vaBtn = document.getElementById("btn-voice-agent");
    if (vaBtn) {
      vaBtn.addEventListener("click", function () {
        const agent = state.agents.find(function (a) { return a.id === state.activeAgentId; }) || state.agents[0];
        speakText(buildAgentLatestText(agent), vaBtn);
      });
    }
    const vsBtn = document.getElementById("btn-voice-settings");
    if (vsBtn) vsBtn.addEventListener("click", openVoiceSettingsSheet);
    const memBtn = document.getElementById("btn-agent-memory");
    if (memBtn) memBtn.addEventListener("click", openAgentMemorySheet);

    const qi = document.getElementById("btn-quick-inbox");
    if (qi) qi.addEventListener("click", openQuickInbox);
    const rs = document.getElementById("btn-resync");
    if (rs) rs.addEventListener("click", function () { syncVault(false); });
    const wfBtn = document.getElementById("btn-sheet-workforce");
    if (wfBtn) wfBtn.addEventListener("click", openWorkforceSheet);
    const cfBtn = document.getElementById("btn-sheet-conflicts");
    if (cfBtn) cfBtn.addEventListener("click", openConflictsSheet);
    const cmBtn = document.getElementById("btn-sheet-commits");
    if (cmBtn) cmBtn.addEventListener("click", openTimeMachine);

    function bindMentionPicker(inputEl, popEl) {
      if (!inputEl || !popEl) return;
      let opts = [];
      let activeIdx = 0;

      function mentionTargets() {
        return [{ id: "all", name: "all", role: "Broadcast to everyone", status: "working" }].concat(
          state.agents.filter(function (a) { return a.id !== "peer-floor"; })
        );
      }

      function hidePop() {
        popEl.classList.add("hidden");
        popEl.innerHTML = "";
        opts = [];
      }

      function applyMention(name) {
        const val = inputEl.value;
        const pos = typeof inputEl.selectionStart === "number" ? inputEl.selectionStart : val.length;
        const before = val.slice(0, pos);
        const after = val.slice(pos);
        const replaced = before.replace(/(^|\s)@([^\s]*)$/, "$1@" + name + " ");
        inputEl.value = replaced + after;
        if (inputEl.setSelectionRange) inputEl.setSelectionRange(replaced.length, replaced.length);
        hidePop();
        inputEl.focus();
      }

      function updatePop() {
        const val = inputEl.value;
        const pos = typeof inputEl.selectionStart === "number" ? inputEl.selectionStart : val.length;
        const m = /(?:^|\s)@([^\s]*)$/.exec(val.slice(0, pos));
        if (!m) { hidePop(); return; }
        const q = m[1].toLowerCase();
        opts = mentionTargets().filter(function (t) {
          return !q || t.name.toLowerCase().indexOf(q) !== -1 || t.id.toLowerCase().indexOf(q) !== -1;
        });
        if (!opts.length) { hidePop(); return; }
        if (activeIdx >= opts.length) activeIdx = 0;
        popEl.innerHTML = opts.map(function (t, idx) {
          const st = agentMeta(t.status);
          return '<button type="button" class="mention-opt ' + (idx === activeIdx ? "active" : "") + '" role="option" data-pick-mention="' + esc(t.name) + '">' +
            '<span><span class="dot ' + st.tone + '" style="margin-right:7px;"></span><strong>@' + esc(t.name) + '</strong></span>' +
            '<span class="mono">' + esc(t.role || "") + "</span>" +
          "</button>";
        }).join("");
        popEl.classList.remove("hidden");
        popEl.querySelectorAll("[data-pick-mention]").forEach(function (btn) {
          btn.addEventListener("mousedown", function (ev) { ev.preventDefault(); applyMention(btn.dataset.pickMention); });
          btn.addEventListener("click", function (ev) { ev.preventDefault(); applyMention(btn.dataset.pickMention); });
        });
      }

      inputEl.addEventListener("input", function () { activeIdx = 0; updatePop(); });
      inputEl.addEventListener("keydown", function (e) {
        if (popEl.classList.contains("hidden") || !opts.length) return;
        if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = (activeIdx + 1) % opts.length; updatePop(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = (activeIdx - 1 + opts.length) % opts.length; updatePop(); }
        else if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); applyMention(opts[activeIdx].name); }
        else if (e.key === "Escape") { e.preventDefault(); hidePop(); }
      });
      inputEl.addEventListener("blur", function () { setTimeout(hidePop, 140); });
    }

    const todayFloorInput = document.getElementById("today-floor-input");
    bindMentionPicker(todayFloorInput, document.getElementById("today-mention-pop"));
    root.querySelectorAll("[data-floor-mention]").forEach(function (c) {
      c.addEventListener("click", function () {
        if (todayFloorInput) {
          todayFloorInput.value = (todayFloorInput.value ? todayFloorInput.value + " " : "") + c.dataset.floorMention;
          todayFloorInput.focus();
        }
      });
    });
    const todayFloorForm = document.getElementById("today-floor-form");
    if (todayFloorForm) {
      todayFloorForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        const body = todayFloorInput && todayFloorInput.value.trim();
        if (!body) return;
        todayFloorInput.value = "";
        await sendToSlug("peer-floor", body);
      });
    }

    const chatInput = document.getElementById("agent-chat-input");
    bindMentionPicker(chatInput, document.getElementById("agent-mention-pop"));
    if (chatInput) {
      chatInput.addEventListener("input", function () {
        const slug = chatInput.dataset ? chatInput.dataset.slug : "";
        if (!slug) return;
        if (chatInput.value) state.draftsBySlug[slug] = chatInput.value;
        else delete state.draftsBySlug[slug];
      });
    }
    const kbDoneBtn = document.getElementById("btn-chat-kb-done");
    if (kbDoneBtn) {
      kbDoneBtn.addEventListener("click", function () {
        if (chatInput) chatInput.blur();
        document.documentElement.classList.remove("chat-keyboard");
      });
    }
    root.querySelectorAll("[data-insert]").forEach(function (c) {
      c.addEventListener("click", function () {
        if (!chatInput) return;
        chatInput.value = (chatInput.value ? chatInput.value + " " : "") + c.dataset.insert;
        const slug = chatInput.dataset ? chatInput.dataset.slug : "";
        if (slug) state.draftsBySlug[slug] = chatInput.value;
        chatInput.focus();
      });
    });

    const chatForm = document.getElementById("agent-chat-form");
    if (chatForm) {
      chatForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        const body = chatInput && chatInput.value.trim();
        if (!body) return;
        const active = state.agents.find(function (a) { return a.id === state.activeAgentId; }) || state.agents[0];
        const resolvedId = active ? active.id : "peer-floor";
        const slug = dmSlugForAgent(resolvedId);
        chatInput.value = "";
        delete state.draftsBySlug[slug];
        await sendToSlug(slug, body, resolvedId);
      });
    }

    const activePill = root.querySelector(".agent-pill.active");
    if (state.forceChatBottom && activePill && activePill.scrollIntoView) {
      activePill.scrollIntoView({ inline: "nearest", block: "nearest" });
    }

    const log = document.getElementById("chat-log");
    const jumpBottomBtn = document.getElementById("chat-jump-bottom");
    if (log && jumpBottomBtn) {
      log.addEventListener("scroll", function () {
        const farFromBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) > 96 && log.clientHeight >= 90;
        jumpBottomBtn.classList.toggle("hidden", !farFromBottom);
      }, { passive: true });
      jumpBottomBtn.addEventListener("click", function () {
        state.forceChatBottom = true;
        log.scrollTop = log.scrollHeight;
        state.forceChatBottom = false;
        jumpBottomBtn.classList.add("hidden");
      });
    }

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
      if (state.view === "agents") state.forceChatBottom = true;
      render();
      if (state.view === "agents") {
        await loadActiveAgentMessages();
        state.forceChatBottom = true;
        render();
      }
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
      if (state.view === "agents") { pulling = false; return; }
      if (e.target && e.target.closest && e.target.closest(".chat-log, #today-floor-log, .agent-strip, .chip-strip, .composer-wrap, .sheet, input, textarea")) {
        pulling = false;
        return;
      }
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
      if (state.view === "agents" || (e.target && e.target.closest && e.target.closest(".chat-log, #today-floor-log, .agent-strip, .chip-strip, .composer-wrap, .sheet, input, textarea"))) {
        pulling = false;
        hide();
        return;
      }
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
      if (state.syncing || state.sendingPing > 0 || document.hidden) return;
      syncVault(true);
    }, 20000);
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
    let rawUrl = document.getElementById("bff-url").value.trim().replace(/\/api\/.*$/i, "").replace(/\/+$/, "");
    if (rawUrl && !/^https?:\/\//i.test(rawUrl)) rawUrl = "https://" + rawUrl;
    creds.bff = rawUrl;
    creds.pin = document.getElementById("stack-pin").value.trim();
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
      const status = err && err.status ? "HTTP " + err.status + " · " : "";
      const detail = (err && err.data && err.data.error) || (err && err.message) || "Network/CORS error";
      errEl.textContent = "Could not unlock (" + status + detail + ") — URL: " + creds.bff;
      errEl.classList.remove("hidden");
    }
  });

  if ("serviceWorker" in navigator) {
    let swReloading = false;
    let swReg = null;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (swReloading) return;
      swReloading = true;
      location.reload();
    });
    function checkAppUpdate() {
      if (swReg && swReg.update) swReg.update().catch(function () {});
    }
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then(function (reg) {
      swReg = reg;
      checkAppUpdate();
      setInterval(checkAppUpdate, 300000);
    }).catch(function () {});
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        checkAppUpdate();
        if (creds.pin && creds.bff && !state.syncing) syncVault(true);
      }
    });
    window.addEventListener("pageshow", function (e) {
      if (e && e.persisted) {
        checkAppUpdate();
        if (creds.pin && creds.bff && !state.syncing) syncVault(true);
      }
    });
  }

  // iOS Safari / PWA can shrink visualViewport and scroll offsetTop while layout viewport stays full height.
  const viewport = window.visualViewport;
  if (viewport) {
    let wasKbOpen = false;
    const updateChatViewport = function () {
      if (viewport.scale && Math.abs(viewport.scale - 1) > 0.02) return;
      const vh = Math.round(viewport.height);
      const vTop = Math.max(0, Math.round(viewport.offsetTop || 0));
      const focusedChat = Boolean(document.activeElement && document.activeElement.id === "agent-chat-input");
      const kbOpen = (window.innerHeight - viewport.height > 120) || (focusedChat && vh < 560);

      const chatLog = document.getElementById("chat-log");
      const wasNearBottom = !chatLog || (chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight) < 96;

      document.documentElement.style.setProperty("--chat-visible-height", vh + "px");
      document.documentElement.style.setProperty("--chat-viewport-top", vTop + "px");
      document.documentElement.classList.toggle("chat-keyboard", kbOpen);

      if (kbOpen && !wasKbOpen && state.view === "agents" && window.scrollY > 0) {
        try { window.scrollTo(0, 0); } catch (e) {}
      }
      if (chatLog && (wasNearBottom || (kbOpen && !wasKbOpen))) {
        requestAnimationFrame(function () {
          chatLog.scrollTop = chatLog.scrollHeight;
          const jumpBtn = document.getElementById("chat-jump-bottom");
          if (jumpBtn) jumpBtn.classList.add("hidden");
        });
      }
      wasKbOpen = kbOpen;
    };
    viewport.addEventListener("resize", updateChatViewport);
    viewport.addEventListener("scroll", updateChatViewport);
    document.addEventListener("focusin", function (e) {
      if (e.target && e.target.id === "agent-chat-input") {
        setTimeout(updateChatViewport, 60);
        setTimeout(updateChatViewport, 250);
      }
    });
    document.addEventListener("focusout", function (e) {
      if (e.target && e.target.id === "agent-chat-input") {
        setTimeout(updateChatViewport, 60);
      }
    });
    updateChatViewport();
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
