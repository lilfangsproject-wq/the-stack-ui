/* The Stack v50.5.6 Voice — Cloudflare Worker BFF, Zero-Spend · Opt-In Voice, Liquid Glass
 * Hard rules: no always-on mic/Jarvis; opt-in TTS (/api/tts Sarah + Workers AI Aura-2 + $0 Web Speech fallback); PIN → x-stack-pin; Git is source of truth.
 * No horizontal swipe. Colour only marks the explicit agent states. Connection pill is honest.
 */
(function () {
  "use strict";

  const VERSION = window.STACK_VERSION || "v50.5.6-voice";
  const SURFACE_KEY = "stack-surface-v1";
  const OUTBOX_KEY = "stack-rebirth-outbox-v1";
  const DRAFT_KEY = "stack-composer-drafts-v1";
  const READ_NOTIF_KEY = "stack-rebirth-read-notifs-v1";
  const PIN_KEY = "stack-access-pin-v1";
  const BFF_KEY = "stack-bff-url-v1";
  const ELEVEN_KEY_STORAGE = "stack-elevenlabs-key-v1";
  const ELEVEN_VOICE_STORAGE = "stack-elevenlabs-voice-v1";
  const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // Sarah (premade female, $0 Free tier)
  const VOICE_CONFIRM_KEY = "stack-voice-confirm-v1";
  const VOICE_CALL_STATES = {
    idle: "Idle",
    listening: "Listening",
    reviewing: "Review transcript",
    sending: "Sending",
    thinking: "Thinking",
    speaking: "Speaking",
    muted: "Muted",
    disconnected: "Disconnected",
    error: "Error"
  };
  const ZERO_SPEND = Number(window.ZERO_SPEND_CAP_USD || 0);

  const AGENT_STATES = {
    working: { label: "Working", tone: "green" },
    waiting: { label: "Waiting", tone: "amber" },
    blocked: { label: "Blocked", tone: "red" },
    unknown: { label: "Status unconfirmed", tone: "muted" },
    offline: { label: "Offline", tone: "muted" },
    completed: { label: "Completed", tone: "green" }
  };

  const DEFAULT_ROSTER = [
    { id: "peer-floor", name: "#peer-floor", role: "Shared Floor", model: "Multi-Agent Room", reset: "Git-native" },
    { id: "gemini", name: "Gemini", role: "Research & Workspace", model: "gemini-3.8-flash / 4-hydrogen", reset: "4h window" },
    { id: "claude", name: "Claude", role: "Architecture", model: "Claude Opus 5.5 / Sonnet 5.5", reset: "4h window" },
    { id: "cursor", name: "Cursor", role: "Engineering", model: "Cursor Composer / Auto", reset: "Daily" },
    { id: "chatgpt", name: "ChatGPT", role: "Ideation & Verify", model: "GPT-5 Thinking", reset: "Daily" },
    { id: "nori", name: "Nori", role: "Trends & Grok Bots", model: "Grok (latest)", reset: "Daily" }
    // grokbot is a retired alias of Nori (Seth, 22 Nov 2026). Not a live teammate.
  ];

  const creds = {
    pin: "",
    bff: ""
  };

  const state = {
    view: "today",
    assignmentMode: null,
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
  let composerDrafts = loadComposerDrafts();

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

  function loadComposerDrafts() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY));
      if (saved && typeof saved.bff === "string" && saved.channels &&
          typeof saved.channels === "object" && !Array.isArray(saved.channels)) return saved;
    } catch (e) {}
    return { bff: "", channels: {} };
  }

  function saveComposerDraft(input) {
    if (!input || !input.dataset || !input.dataset.draftChannel) return;
    if (composerDrafts.bff !== creds.bff) composerDrafts = { bff: creds.bff, channels: {} };
    const channel = input.dataset.draftChannel;
    if (input.value) composerDrafts.channels[channel] = input.value;
    else delete composerDrafts.channels[channel];
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(composerDrafts)); } catch (e) {}
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
    window.StackExplore?.reset();
    creds.pin = "";
    composerDrafts = { bff: "", channels: {} };
    try {
      localStorage.removeItem(PIN_KEY);
    } catch (e) {}
    try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) {}
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

  function agentMeta(st) { return AGENT_STATES[st] || AGENT_STATES.unknown; }

  function agentAgeText(agent) {
    const m = agentMeta(agent && agent.status);
    return agent && agent.lastSeen ? m.label + " · " + agent.lastSeen : m.label;
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

      let status = "unknown";
      let evidence = "No recent heartbeat";
      let lastSeen = "";

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
      } else if (hb && isRecentIso(hb.ts)) {
        const declared = String(hb.state || "").toLowerCase();
        const sha = String(hb.evidence_sha || hb.commit || "").toLowerCase();
        if (Object.hasOwn(AGENT_STATES, declared)) status = declared;
        if (status === "completed") {
          const qc = (state.qcReceipts || []).find(function (receipt) {
            if (!receipt || !receipt.reviewer || receipt.checks_passed !== true || !sha) return false;
            const builder = String(receipt.builder || "").trim().toLowerCase();
            const reviewer = String(receipt.reviewer).trim().toLowerCase();
            return (builder === base.id || builder === base.name.toLowerCase()) &&
              reviewer && reviewer !== builder && String(receipt.commit_sha || "").toLowerCase() === sha;
          });
          if (!qc) status = "unknown";
        }
        evidence = hb.evidence_path || hb.task || "heartbeat";
        if (sha) evidence += " · commit " + sha.slice(0, 8);
        lastSeen = "Heartbeat " + relTime(hb.ts);
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
            if (m.auto === true || !isRecentIso(m.created_at)) return false;
            const auth = String(m.author || "").toLowerCase();
            const body = String(m.body || "").toLowerCase();
            return auth.includes(base.id) || body.includes("@" + base.id);
          }).length + dmMsgs.filter(function (m) {
            return m.auto !== true && isRecentIso(m.created_at) && String(m.author || "").toLowerCase().includes(base.id);
          }).length;

      const hbActive24h = (hb && hb.ts && isRecentIso(hb.ts)) ? 1 : 0;
      const callsToday = prov && prov.calls_today != null ? Math.max(0, Number(prov.calls_today) || 0) : 0;
      const activity24h = callsToday + commits24h + floorMsgs24h + hbActive24h;

      const rawPct = prov ? (prov.pct_used ?? prov.pct ?? prov.used_pct ?? prov.usage_pct ?? prov.percent ?? (typeof prov.used === "number" && typeof prov.limit === "number" && prov.limit > 0 ? Math.round((prov.used / prov.limit) * 100) : null)) : null;
      const observedAt = Date.parse(prov && (prov.quota_observed_at || prov.updated_at) || "");
      const resetMs = Date.parse(prov && prov.reset_at || "");
      const hasLiveUsage = !!prov && (prov.quota_source || prov.source) === "manual-ui" &&
        Number.isFinite(observedAt) && observedAt <= nowMs && nowMs - observedAt <= 2 * 3600000 &&
        (!Number.isFinite(resetMs) || resetMs > nowMs) &&
        typeof rawPct === "number" && Number.isFinite(rawPct);
      const usagePct = hasLiveUsage ? Math.max(0, Math.min(100, Math.round(rawPct))) : 0;
      const pctEstimated = false;

      const lastCallAt = (prov && (prov.last_call_at || prov.updated_at)) || (hb && hb.ts) || (commit && (commit.date || commit.created_at)) || "";
      const usageNote = (prov && prov.note) || (hb && hb.task) || "";
      const activityParts = [];
      if (callsToday > 0) activityParts.push(callsToday + " recorded event" + (callsToday === 1 ? "" : "s"));
      if (commits24h > 0) activityParts.push(commits24h + " commit" + (commits24h === 1 ? "" : "s"));
      if (floorMsgs24h > 0) activityParts.push(floorMsgs24h + " msg" + (floorMsgs24h === 1 ? "" : "s"));
      if (hbActive24h > 0 && !activityParts.length) activityParts.push("1 beat");
      const activitySummary = activityParts.length
        ? (activityParts.join(" · ") + " (24h)")
        : (lastCallAt ? ("Seen " + relTime(lastCallAt)) : "0 events (24h)");

      const rawResetAt = (prov && prov.reset_at) || "";
      const windowLabel = (prov && (prov.window_label || prov.reset)) || base.reset;
      const resetDisplay = hasLiveUsage ? formatResetLabel(rawResetAt, windowLabel) : "Reset unconfirmed";

      return Object.assign({}, base, {
        status: status,
        evidence: evidence,
        lastSeen: lastSeen,
        usagePct: usagePct,
        usageObservedAt: hasLiveUsage ? (prov.quota_observed_at || prov.updated_at) : "",
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
        model: (prov && prov.model) || base.model
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
      state.assignmentMode = sync.assignment_mode || null;
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
    if (!creds.pin || !creds.bff) return;
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
        (state.messagesBySlug[slug] || []).forEach(function (m) {
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
  }

  async function loadActiveAgentMessages() {
    const active = state.agents.find(function (a) { return a.id === state.activeAgentId; });
    const slug = dmSlugForAgent(active ? active.id : "peer-floor");
    await loadMessagesForSlug(slug);
  }

  async function postMessage(slug, body, requestId) {
    const out = await bff("/api/ping", {
      method: "POST",
      body: JSON.stringify({ slug: slug, author: "Seth", body: body, request_id: requestId })
    });
    if (!out || out.ok !== true || !out.message || !out.message.id) {
      throw new Error("Backend acceptance could not be confirmed");
    }

    const messages = (state.messagesBySlug[slug] || []).filter(function (m) {
      return (!requestId || m.id !== requestId) && m.id !== out.message.id && (!out.reply || m.id !== out.reply.id);
    });
    // Older Workers confirm the write in the response but do not persist a receipt.
    messages.push(Object.assign({}, out.message, { _accepted: true }));
    if (out.reply) messages.push(out.reply);
    messages.sort(function (a, b) { return String(a.created_at || "").localeCompare(String(b.created_at || "")); });
    state.messagesBySlug[slug] = messages.slice(-60);
  }

  let flushingOutbox = false;
  async function flushOutbox() {
    if (flushingOutbox || !state.outbox.length) return;
    flushingOutbox = true;
    let sent = 0;
    try {
      for (const ev of state.outbox.slice()) {
        if (ev.type !== "message" && ev.type !== "quick") continue;
        try {
          await postMessage(ev.slug, ev.body, ev.requestId);
          state.outbox = state.outbox.filter(function (entry) { return entry !== ev; });
          saveOutbox();
          sent += 1;
        } catch (e) {
          // Keep the same request ID so a retry can recover an already saved message.
        }
      }
    } finally {
      flushingOutbox = false;
      render();
    }
    toast(sent ? "Backend accepted " + sent + " queued message(s)" : "Outbox still pending", sent ? "info" : "warning");
  }

  /* ===================== VOICE (OPT-IN) ===================== */

  let activeAudio = null;
  let activeAudioUrl = "";
  let activeBufferSource = null;
  let voiceAudioCtx = null;
  let activeSpeechBtn = null;
  let speakingNow = false;
  let speechRequest = null;
  let speechDoneResolve = null;
  let dictation = null;
  let voiceCall = null;
  let voiceCallSending = false;
  let voiceRestartTimer = null;
  let voiceAudioPrimed = false;
  let serverTtsStatus = null;

  function getSpeechRecognitionCtor() {
    return typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition || null) : null;
  }

  function ensureVoiceAudioCtx() {
    if (typeof window === "undefined") return null;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!voiceAudioCtx) {
      try { voiceAudioCtx = new Ctx(); } catch (e) { return null; }
    }
    return voiceAudioCtx;
  }

  function primeVoiceAudio() {
    // Must run synchronously inside tap/gesture so iOS Safari unlocks async fetch playback.
    const ctx = ensureVoiceAudioCtx();
    if (ctx) {
      try {
        if (ctx.state === "suspended" && typeof ctx.resume === "function") {
          const resP = ctx.resume();
          if (resP && typeof resP.catch === "function") resP.catch(function () {});
        }
        if (typeof ctx.createBuffer === "function" && typeof ctx.createBufferSource === "function") {
          const buf = ctx.createBuffer(1, 1, 22050);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          src.start(0);
        }
      } catch (e) {}
    }
    if (voiceAudioPrimed || typeof Audio === "undefined") return;
    voiceAudioPrimed = true;
    try {
      const silent = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA");
      silent.volume = 0;
      const p = silent.play();
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch (e) {}
    try {
      if (typeof window !== "undefined" && window.speechSynthesis && window.speechSynthesis.getVoices) {
        window.speechSynthesis.getVoices();
      }
    } catch (e) {}
  }

  function voiceConfirmEnabled() {
    try {
      const raw = localStorage.getItem(VOICE_CONFIRM_KEY);
      if (raw === null || raw === "") return true;
      return raw !== "0" && raw !== "false";
    } catch (e) { return true; }
  }

  function setVoiceConfirmEnabled(on) {
    try { localStorage.setItem(VOICE_CONFIRM_KEY, on ? "1" : "0"); } catch (e) {}
  }

  function voiceCallStatusLabel() {
    if (!voiceCall) return "";
    return VOICE_CALL_STATES[voiceCall.state] || voiceCall.state;
  }

  function setVoiceCallState(next, detail) {
    if (!voiceCall) return;
    voiceCall.state = next;
    voiceCall.detail = detail || "";
    voiceCall.updatedAt = Date.now();
    const bar = document.getElementById("voice-call-bar");
    if (bar) {
      const status = bar.querySelector("[data-voice-status]");
      if (status) status.textContent = voiceCallStatusLabel() + (voiceCall.detail ? " · " + voiceCall.detail : "");
      bar.dataset.state = next;
      const muteBtn = bar.querySelector("[data-voice-mute]");
      if (muteBtn) {
        muteBtn.setAttribute("aria-pressed", String(next === "muted" || voiceCall.muted === true));
        muteBtn.textContent = voiceCall.muted ? "Unmute" : "Mute";
      }
    }
  }

  function voiceCallBarHtml(slug) {
    if (!voiceCall || voiceCall.slug !== slug) return "";
    const reviewing = voiceCall.state === "reviewing" && voiceCall.pendingTranscript;
    const recoverable = voiceCall.state === "disconnected" || voiceCall.state === "error";
    return (
      '<div id="voice-call-bar" class="voice-call-bar" data-state="' + esc(voiceCall.state) + '" role="status" aria-live="polite">' +
        '<div class="voice-call-row">' +
          '<span class="voice-call-dot" aria-hidden="true"></span>' +
          '<span data-voice-status>' + esc(voiceCallStatusLabel()) + (voiceCall.detail ? " · " + esc(voiceCall.detail) : "") + "</span>" +
          '<div class="voice-call-actions">' +
            (recoverable
              ? '<button type="button" class="btn btn-pri btn-sm" data-voice-retry>Retry</button>'
              : '<button type="button" class="btn btn-sec btn-sm" data-voice-stop>Stop</button>' +
                '<button type="button" class="btn btn-sec btn-sm" data-voice-mute aria-pressed="' + (voiceCall.muted ? "true" : "false") + '">' + (voiceCall.muted ? "Unmute" : "Mute") + "</button>") +
            '<button type="button" class="btn btn-danger btn-sm" data-voice-hangup>Hang up</button>' +
          "</div>" +
        "</div>" +
        (reviewing
          ? '<div class="voice-call-review">' +
              '<div class="voice-call-transcript">' + esc(voiceCall.pendingTranscript) + "</div>" +
              '<div class="voice-call-actions">' +
                '<button type="button" class="btn btn-sec btn-sm" data-voice-discard>Discard</button>' +
                '<button type="button" class="btn btn-pri btn-sm" data-voice-send' + (voiceCallSending ? " disabled" : "") + ">Send</button>" +
              "</div>" +
            "</div>"
          : "") +
      "</div>"
    );
  }

  function stopVoiceRecognition() {
    if (voiceRestartTimer) {
      clearTimeout(voiceRestartTimer);
      voiceRestartTimer = null;
    }
    if (!voiceCall || !voiceCall.recognition) return;
    const rec = voiceCall.recognition;
    voiceCall.recognition = null;
    try { rec.onresult = null; rec.onerror = null; rec.onend = null; } catch (e) {}
    try { rec.abort(); } catch (e) {
      try { rec.stop(); } catch (e2) {}
    }
  }

  function stopVoiceTurn() {
    if (!voiceCall || !voiceCall.alive) return;
    voiceCall.muted = true;
    voiceCall.pendingTranscript = "";
    stopVoiceRecognition();
    stopSpeaking();
    setVoiceCallState("muted", "Stopped — tap Unmute to resume");
    render();
  }

  function hangUpVoiceCall(reason) {
    const session = voiceCall;
    if (!session) return;
    session.alive = false;
    stopVoiceRecognition();
    stopSpeaking();
    voiceCall = null;
    voiceCallSending = false;
    if (reason === "error") toast("Voice call ended with an error", "warning");
    else if (reason === "room") toast("Voice call ended — room changed", "info");
    else if (reason === "hidden") toast("Voice call ended — app backgrounded", "info");
    render();
  }

  function speakVoiceReplyText(message, agent) {
    if (!message || !message.body) return "";
    if (window.StackPolish && typeof window.StackPolish.buildVoiceReplySpeakText === "function") {
      return window.StackPolish.buildVoiceReplySpeakText(message, agent);
    }
    const author = message.author || (agent && agent.name) || "agent";
    const label = message.auto ? ("Automatic Stack reply for " + author) : ("Reply from " + author);
    return label + ": " + message.body;
  }

  async function speakAndResumeListening(text) {
    if (!voiceCall || !voiceCall.alive) return;
    setVoiceCallState("speaking");
    try {
      await speakText(text, null, {});
    } catch (e) {}
    if (!voiceCall || !voiceCall.alive) return;
    if (voiceCall.state === "disconnected" || voiceCall.state === "error") return;
    if (voiceCall.muted) {
      setVoiceCallState("muted");
      return;
    }
    beginVoiceListening();
  }

  async function sendVoiceTranscript(transcript) {
    if (!voiceCall || !voiceCall.alive || voiceCallSending) return;
    const text = String(transcript || "").trim();
    if (!text) return;
    const session = voiceCall;
    const slug = session.slug;
    const agentId = session.agentId;
    const turnId = session.turnId || 1;
    if (session.lastSentTurnId === turnId) return;
    session.lastSentTurnId = turnId;
    voiceCallSending = true;
    session.pendingTranscript = text;
    primeVoiceAudio();
    setVoiceCallState("sending", text.slice(0, 48));
    stopVoiceRecognition();
    render();
    try {
      const beforeIds = new Set((state.messagesBySlug[slug] || []).map(function (m) { return m && m.id; }));
      const sendRes = await sendToSlug(slug, text, agentId);
      if (!voiceCall || voiceCall !== session || !session.alive || session.turnId !== turnId) return;
      if (!sendRes || sendRes.accepted !== true) {
        session.pendingTranscript = "";
        setVoiceCallState("disconnected", "Offline · Saved to Outbox");
        render();
        return;
      }
      const input = document.getElementById("agent-chat-input");
      const inputSlug = input && input.dataset ? (input.dataset.draftChannel || input.dataset.slug) : "";
      if (input && inputSlug === slug) {
        input.value = "";
        saveComposerDraft(input);
      }
      setVoiceCallState("thinking");
      let reply = null;
      const msgs = state.messagesBySlug[slug] || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m || !m.body || beforeIds.has(m.id)) continue;
        if (/^seth$/i.test(m.author || "")) continue;
        reply = m;
        break;
      }
      if (!reply) {
        await loadMessagesForSlug(slug);
        if (!voiceCall || voiceCall !== session || !session.alive) return;
        const refreshed = state.messagesBySlug[slug] || [];
        for (let i = refreshed.length - 1; i >= 0; i--) {
          const m = refreshed[i];
          if (!m || !m.body || beforeIds.has(m.id)) continue;
          if (/^seth$/i.test(m.author || "")) continue;
          reply = m;
          break;
        }
      }
      session.pendingTranscript = "";
      if (!reply) {
        setVoiceCallState("listening", "No reply yet");
        render();
        beginVoiceListening();
        return;
      }
      const agent = state.agents.find(function (a) { return a.id === agentId; }) || { name: reply.author };
      const spoken = speakVoiceReplyText(reply, agent);
      render();
      await speakAndResumeListening(spoken);
    } catch (err) {
      if (!voiceCall || voiceCall !== session) return;
      setVoiceCallState("disconnected", (err && err.message) || "Send failed");
      render();
    } finally {
      voiceCallSending = false;
    }
  }

  function queueVoiceTranscript(transcript) {
    if (!voiceCall || !voiceCall.alive) return;
    const text = String(transcript || "").trim();
    if (!text) return;
    // Never send partials — only finals reach here.
    voiceCall.pendingTranscript = text;
    voiceCall.turnId = (voiceCall.turnId || 0) + 1;
    if (voiceConfirmEnabled()) {
      stopVoiceRecognition();
      setVoiceCallState("reviewing");
      render();
      return;
    }
    sendVoiceTranscript(text);
  }

  function beginVoiceListening() {
    if (!voiceCall || !voiceCall.alive) return;
    if (voiceCall.muted) {
      setVoiceCallState("muted");
      return;
    }
    const SR = getSpeechRecognitionCtor();
    if (!SR) {
      voiceCall.fatalError = true;
      setVoiceCallState("error", "Speech recognition unavailable");
      toast("Speech recognition unavailable on this browser. Use dictation into the draft instead.", "warning");
      render();
      return;
    }
    stopVoiceRecognition();
    stopSpeaking();
    const session = voiceCall;
    session.fatalError = false;
    const recognition = new SR();
    recognition.lang = "en-AU";
    recognition.continuous = true;
    recognition.interimResults = true;
    session.recognition = recognition;
    setVoiceCallState("listening");
    recognition.onresult = function (event) {
      if (!voiceCall || voiceCall !== session || !session.alive) return;
      if (session.muted || session.state === "reviewing" || session.state === "sending" || session.state === "thinking" || session.state === "speaking" || session.state === "disconnected") return;
      const parts = [];
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) parts.push(event.results[i][0].transcript.trim());
      }
      const transcript = parts.filter(Boolean).join(" ");
      if (!transcript) return;
      const active = state.agents.find(function (a) { return a.id === state.activeAgentId; });
      const liveSlug = dmSlugForAgent(active ? active.id : "peer-floor");
      if (liveSlug !== session.slug || state.view !== "agents") {
        hangUpVoiceCall("room");
        return;
      }
      queueVoiceTranscript(transcript);
    };
    recognition.onerror = function (event) {
      if (!voiceCall || voiceCall !== session || !session.alive) return;
      const code = event && event.error;
      if (code === "aborted" || code === "no-speech") return;
      if (code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture") {
        session.fatalError = true;
        stopVoiceRecognition();
        setVoiceCallState("error", "Microphone access denied");
        toast("Microphone permission denied — allow mic access and tap Retry.", "warning");
        render();
        return;
      }
      setVoiceCallState("error", code || "mic error");
      render();
    };
    recognition.onend = function () {
      if (!voiceCall || voiceCall !== session || !session.alive || session.fatalError) return;
      if (session.muted) {
        setVoiceCallState("muted");
        return;
      }
      if (session.state === "listening") {
        voiceRestartTimer = setTimeout(function () {
          voiceRestartTimer = null;
          if (voiceCall === session && session.alive && !session.muted && !session.fatalError && session.state === "listening") {
            try { beginVoiceListening(); } catch (e) {}
          }
        }, 180);
      }
    };
    try {
      recognition.start();
    } catch (error) {
      session.fatalError = true;
      setVoiceCallState("error", "Could not start microphone");
      toast("Couldn’t start voice call microphone", "warning");
      render();
    }
  }

  function startVoiceCall() {
    if (voiceCall && voiceCall.alive) {
      hangUpVoiceCall("stop");
      return;
    }
    if (!creds.pin || !creds.bff) {
      toast("Sign in to the Worker BFF before starting voice", "warning");
      return;
    }
    primeVoiceAudio();
    endDictation();
    stopSpeaking();
    const active = state.agents.find(function (a) { return a.id === state.activeAgentId; }) || state.agents[0];
    const agentId = active ? active.id : "peer-floor";
    const slug = dmSlugForAgent(agentId);
    voiceCall = {
      alive: true,
      muted: false,
      fatalError: false,
      state: "listening",
      slug: slug,
      agentId: agentId,
      pendingTranscript: "",
      turnId: 0,
      lastSentTurnId: 0,
      detail: "",
      recognition: null,
      startedAt: Date.now(),
      updatedAt: Date.now()
    };
    render();
    beginVoiceListening();
  }

  function toggleVoiceMute() {
    if (!voiceCall || !voiceCall.alive) return;
    primeVoiceAudio();
    voiceCall.muted = !voiceCall.muted;
    voiceCall.fatalError = false;
    if (voiceCall.muted) {
      stopVoiceRecognition();
      stopSpeaking();
      setVoiceCallState("muted");
    } else {
      beginVoiceListening();
    }
    render();
  }

  function dictationButton(inputId) {
    return '<button type="button" class="btn btn-sec btn-sm dictation-btn" data-dictate="' + inputId +
      '" aria-label="Dictate message" aria-pressed="false" title="Dictate message">🎙</button>';
  }

  function showDictationState(session, active) {
    const button = document.querySelector('[data-dictate="' + session.inputId + '"]');
    if (button) {
      button.classList.toggle("listening", active);
      button.textContent = active ? "■" : "🎙";
      button.title = active ? "Stop dictation" : "Dictate message";
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  function endDictation() {
    const session = dictation;
    if (!session) return;
    dictation = null;
    clearTimeout(session.timeout);
    showDictationState(session, false);
    try { session.recognition.abort(); } catch (error) {}
  }

  function toggleDictation(input) {
    if (!input) return;
    if (dictation) {
      if (!dictation.stopping) {
        dictation.stopping = true;
        try { dictation.recognition.stop(); } catch (e) { endDictation(); }
      }
      return;
    }
    const SR = getSpeechRecognitionCtor();
    if (!SR) {
      input.focus();
      toast("Use your keyboard’s microphone to dictate into this draft", "info");
      return;
    }
    primeVoiceAudio();
    stopSpeaking();
    const recognition = new SR();
    recognition.lang = "en-AU";
    const slug = (input.dataset && (input.dataset.draftChannel || input.dataset.slug)) || "";
    const session = { recognition: recognition, inputId: input.id, slug: slug };
    dictation = session;
    showDictationState(session, true);
    recognition.onresult = function (event) {
      const current = document.getElementById(session.inputId);
      const currentSlug = (current && current.dataset && (current.dataset.draftChannel || current.dataset.slug)) || "";
      if (dictation !== session || !current || currentSlug !== session.slug) return;
      const parts = [];
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) parts.push(event.results[i][0].transcript.trim());
      }
      const transcript = parts.filter(Boolean).join(" ");
      if (!transcript) return;
      current.value = [current.value.trimEnd(), transcript].filter(Boolean).join(" ");
      current.dispatchEvent(new Event("input", { bubbles: true }));
    };
    recognition.onend = function () {
      if (dictation !== session) return;
      dictation = null;
      clearTimeout(session.timeout);
      showDictationState(session, false);
    };
    recognition.onerror = function (event) {
      if (dictation !== session) return;
      endDictation();
      if (event && event.error !== "aborted") {
        toast(event.error === "no-speech" ? "No speech heard. Tap the mic to try again." :
          "Microphone dictation unavailable. Try your keyboard mic.", "warning");
      }
    };
    try {
      recognition.start();
      session.timeout = setTimeout(function () {
        endDictation();
        toast("Dictation timed out. You can tap the mic to try again.", "warning");
      }, 30000);
    } catch (error) {
      endDictation();
      toast("Couldn’t start dictation. Try your keyboard mic.", "warning");
    }
  }

  function getSavedElevenKey() {
    try { return localStorage.getItem(ELEVEN_KEY_STORAGE) || ""; } catch (e) { return ""; }
  }
  function getSavedVoiceId() {
    try {
      const saved = localStorage.getItem(ELEVEN_VOICE_STORAGE) || "";
      // Migrate legacy George / paywalled Shannon W defaults to Free-tier premade Sarah.
      if (!saved || saved === "JBFqnCBsd6RMkjVDRZzb" || saved === "vppqTjjplEh4CplGZuN2") {
        if (saved) localStorage.setItem(ELEVEN_VOICE_STORAGE, DEFAULT_VOICE_ID);
        return DEFAULT_VOICE_ID;
      }
      return saved;
    } catch (e) { return DEFAULT_VOICE_ID; }
  }

  function setSpeakingBtn(btn, isOn) {
    if (!btn) return;
    if (isOn) {
      if (!btn.dataset.idleContent) btn.dataset.idleContent = btn.innerHTML;
      btn.dataset.idleAriaLabel = btn.getAttribute("aria-label") || "";
      btn.classList.add("speaking");
      btn.textContent = "⏹ Stop";
      btn.setAttribute("aria-label", "Stop reading");
      btn.setAttribute("aria-pressed", "true");
      activeSpeechBtn = btn;
    } else {
      btn.classList.remove("speaking");
      if (btn.dataset.idleContent) btn.innerHTML = btn.dataset.idleContent;
      if (btn.dataset.idleAriaLabel) btn.setAttribute("aria-label", btn.dataset.idleAriaLabel);
      else btn.removeAttribute("aria-label");
      btn.removeAttribute("aria-pressed");
    }
  }

  function resolveSpeechWait() {
    if (speechDoneResolve) {
      const done = speechDoneResolve;
      speechDoneResolve = null;
      try { done(); } catch (e) {}
    }
  }

  function clearSpeechAudio() {
    if (activeBufferSource) {
      activeBufferSource.onended = null;
      try { activeBufferSource.stop(); } catch (e) {}
      try { activeBufferSource.disconnect(); } catch (e) {}
      activeBufferSource = null;
    }
    if (activeAudio) {
      activeAudio.onended = null;
      activeAudio.onerror = null;
      try { activeAudio.pause(); activeAudio.src = ""; } catch (e) {}
      activeAudio = null;
    }
    if (activeAudioUrl) {
      try { URL.revokeObjectURL(activeAudioUrl); } catch (e) {}
      activeAudioUrl = "";
    }
  }

  function stopSpeaking() {
    if (speechRequest) speechRequest.abort();
    speechRequest = null;
    clearSpeechAudio();
    if (typeof window !== "undefined" && window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    if (activeSpeechBtn) {
      setSpeakingBtn(activeSpeechBtn, false);
      activeSpeechBtn = null;
    }
    speakingNow = false;
    resolveSpeechWait();
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

  function fallbackWebSpeech(cleanText, request) {
    return new Promise(function (resolve) {
      if (speechRequest !== request) { resolve(); return; }
      if (typeof window === "undefined" || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
        stopSpeaking();
        toast("Speech synthesis unavailable in this browser", "warning");
        resolve();
        return;
      }
      speechDoneResolve = resolve;
      const utt = new SpeechSynthesisUtterance(cleanText);
      const voice = pickNeuralWebVoice();
      if (voice) utt.voice = voice;
      utt.rate = 0.9;
      utt.pitch = 1.0;
      utt.onend = function () {
        if (speechDoneResolve === resolve) speechDoneResolve = null;
        if (speechRequest === request) stopSpeaking();
        resolve();
      };
      utt.onerror = utt.onend;
      window.speechSynthesis.speak(utt);
    });
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
    primeVoiceAudio();
    stopSpeaking();
    endDictation();
    const request = new AbortController();
    speechRequest = request;
    speakingNow = true;
    setSpeakingBtn(btnEl, true);

    const options = opts || {};
    const elKey = typeof options.apiKey === "string" ? options.apiKey.trim() : getSavedElevenKey().trim();
    const voiceId = (typeof options.voiceId === "string" && options.voiceId.trim()) ? options.voiceId.trim() : getSavedVoiceId();

    let fallbackReason = (typeof navigator !== "undefined" && navigator.onLine === false) ? "offline" : "";
    if (creds.bff && creds.pin && (typeof navigator === "undefined" || navigator.onLine !== false)) {
      let audio = null;
      try {
        const headers = {
          "content-type": "application/json",
          "x-stack-pin": creds.pin
        };
        if (elKey && !(serverTtsStatus && serverTtsStatus.elevenlabs_configured)) headers["x-elevenlabs-key"] = elKey;
        const res = await fetch(creds.bff.replace(/\/$/, "") + "/api/tts", {
          method: "POST",
          headers: headers,
          signal: request.signal,
          body: JSON.stringify({
            text: cleanText,
            voiceId: voiceId || DEFAULT_VOICE_ID,
            modelId: "eleven_turbo_v2_5"
          })
        });
        const ct = String(res.headers.get("content-type") || "").toLowerCase();
        if (res.ok && ct.indexOf("audio/") !== -1) {
          const arrayBuf = await res.arrayBuffer();
          if (speechRequest !== request) return;
          const ctx = ensureVoiceAudioCtx();
          if (ctx && typeof ctx.decodeAudioData === "function" && arrayBuf && arrayBuf.byteLength > 64) {
            try {
              if (ctx.state === "suspended" && typeof ctx.resume === "function") await ctx.resume();
              const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
              if (speechRequest !== request) return;
              if (decoded && decoded.duration > 0.05) {
                const src = ctx.createBufferSource();
                src.buffer = decoded;
                src.playbackRate.value = 0.9;
                src.connect(ctx.destination);
                activeBufferSource = src;
                await new Promise(function (resolve) {
                  speechDoneResolve = resolve;
                  src.onended = function () {
                    if (speechDoneResolve === resolve) speechDoneResolve = null;
                    if (speechRequest === request) stopSpeaking();
                    resolve();
                  };
                  try {
                    src.start(0);
                  } catch (playErr) {
                    if (speechDoneResolve === resolve) speechDoneResolve = null;
                    clearSpeechAudio();
                    fallbackReason = (playErr && playErr.name) || "audio context start blocked";
                    toast("Neural voice unavailable (" + fallbackReason + ") — using browser voice", "warning");
                    fallbackWebSpeech(cleanText, request).then(resolve);
                  }
                });
                return;
              }
            } catch (decodeErr) {
              if (speechRequest !== request) return;
            }
          }
          const blob = new Blob([arrayBuf], { type: ct || "audio/mpeg" });
          const url = URL.createObjectURL(blob);
          activeAudioUrl = url;
          audio = new Audio(url);
          activeAudio = audio;
          activeAudio.defaultPlaybackRate = 0.9;
          activeAudio.playbackRate = 0.9;
          await new Promise(function (resolve) {
            speechDoneResolve = resolve;
            activeAudio.onended = function () {
              if (speechDoneResolve === resolve) speechDoneResolve = null;
              if (speechRequest === request) stopSpeaking();
              resolve();
            };
            activeAudio.onerror = function () {
              if (speechDoneResolve === resolve) speechDoneResolve = null;
              if (speechRequest !== request) { resolve(); return; }
              clearSpeechAudio();
              toast("Neural voice unavailable (audio playback error) — using browser voice", "warning");
              fallbackWebSpeech(cleanText, request).then(resolve);
            };
            const playRes = activeAudio.play();
            if (playRes && typeof playRes.catch === "function") {
              playRes.catch(function (playErr) {
                if (speechDoneResolve === resolve) speechDoneResolve = null;
                if (speechRequest !== request) { resolve(); return; }
                clearSpeechAudio();
                toast("Neural voice unavailable (" + ((playErr && playErr.name) || "autoplay blocked") + ") — using browser voice", "warning");
                fallbackWebSpeech(cleanText, request).then(resolve);
              });
            }
          });
          return;
        }
        fallbackReason = "HTTP " + res.status;
      } catch (e) {
        if (speechRequest !== request) return;
        if (audio && activeAudio !== audio) return;
        clearSpeechAudio();
        fallbackReason = (e && e.message) || "network error";
      }
      if (speechRequest !== request) return;
      toast("Neural voice unavailable (" + (fallbackReason || "server error") + ") — using browser voice", "warning");
    } else if (fallbackReason) {
      toast("Neural voice unavailable (" + fallbackReason + ") — using browser voice", "warning");
    }
    if (speechRequest !== request) return;
    await fallbackWebSpeech(cleanText, request);
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

  function renderMessageBubble(m, showFoot, slug) {
    if (!m) return "";
    const isMe = String(m.author || "").toLowerCase() === "seth";
    const canAssign = state.assignmentMode === "enabled" && showFoot && slug && m.id &&
      !m._submitting && !m._queued && !String(m.id).startsWith("local-");
    const isAutomated = m.auto === true;
    let receipt = "";
    if (showFoot && isMe) {
      if (m.backend_accepted_at || m._accepted) {
        receipt = '<details class="msg-foot msg-receipt"><summary class="git-chip">Backend accepted</summary>' +
          '<div>Saved to channel history' + (m.backend_accepted_at ? ' · <time datetime="' + esc(m.backend_accepted_at) + '">' + esc(m.backend_accepted_at) + '</time>' : '') +
          '<br>Agent delivery · Unconfirmed<br>Agent acknowledgement · Unconfirmed<br>Verified completion · Unconfirmed</div></details>';
      } else {
        const label = m._queued ? "Outbox · Acceptance unconfirmed" : m._submitting ? "Submitted · Awaiting backend" : "Receipt unavailable";
        receipt = '<div class="msg-foot"><span class="git-chip">' + label + '</span></div>';
      }
    }
    return (
      '<div class="msg ' + (isMe ? "me" : "") + '">' +
        '<div class="msg-head"><span class="msg-author">' + esc(isAutomated ? "Stack automation" : m.author || "Agent") + '</span><span class="msg-time">' + relTime(m.created_at) + "</span></div>" +
        '<div style="white-space:pre-wrap;">' + esc(m.body || "") + "</div>" +
        receipt +
        (canAssign ? '<div class="msg-foot"><button type="button" class="btn btn-sec btn-sm" data-assign-message="' +
          esc(m.id) + '" data-assign-channel="' + esc(slug) + '">Assign</button></div>' : "") +
      "</div>"
    );
  }

  function renderToday() {
    const topNeed = state.needsSeth[0] || null;
    const allFloorMsgs = state.messagesBySlug["peer-floor"] || [];
    const floorMsgs = allFloorMsgs.slice(-8);
    const floorHtml = floorMsgs.map(function (m) {
      return renderMessageBubble(m, false);
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
    const workstreams = new Map((state.workstreamsRaw.workstreams || []).map(function (w) { return [w.id, w]; }));
    const verified = (state.qcReceipts || []).filter(function (receipt) {
      if (!receipt || !receipt.workstream_id || !Number.isFinite(Date.parse(receipt.verified_at))) return false;
      const builder = String(receipt.builder || "").trim().toLowerCase();
      const reviewer = String(receipt.reviewer || "").trim().toLowerCase();
      return receipt.checks_passed === true && builder && reviewer && builder !== reviewer &&
        /^[0-9a-f]{7,40}$/i.test(String(receipt.commit_sha || "")) &&
        workstreams.has(receipt.workstream_id);
    }).sort(function (a, b) {
      return Date.parse(b.verified_at) - Date.parse(a.verified_at);
    }).slice(0, 3);
    const verifiedRows = verified.map(function (receipt) {
      const workstream = workstreams.get(receipt.workstream_id);
      const title = workstream.title || workstream.name || workstream.id;
      const commitUrl = "https://github.com/lilfangsproject-wq/ai-workspace/commit/" + receipt.commit_sha;
      return '<div class="row">' +
        '<div class="row-main"><div class="row-title">' + esc(title) + '</div>' +
        '<div class="row-sub">QC by ' + esc(receipt.reviewer) + ' · ' + relTime(receipt.verified_at) + '</div></div>' +
        '<a class="git-chip" href="' + commitUrl + '" target="_blank" rel="noopener noreferrer" aria-label="Open verified commit for ' + esc(title) + '">' + esc(String(receipt.commit_sha).slice(0, 8)) + '</a>' +
      '</div>';
    }).join("");
    const conflictCount = (state.conflicts || []).length;
    const commitCount = (state.commits || []).length;

    const composerHtml =
      '<div class="hero-composer">' +
        '<div class="chip-strip">' + mentionChips + "</div>" +
        '<div class="composer-wrap">' +
          '<div id="today-mention-pop" class="mention-pop hidden" role="listbox" aria-label="Mention suggestions"></div>' +
          '<form id="today-floor-form" class="composer">' +
            '<input id="today-floor-input" data-draft-channel="peer-floor" class="input" placeholder="Dispatch to #peer-floor… type @ to mention" autocomplete="off" enterkeyhint="send" required />' +
            dictationButton("today-floor-input") +
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
          (state.assignmentMode ? '<button type="button" class="row" data-open-assignments><span class="row-title">Assignments</span><span aria-hidden="true">›</span></button>' : "") +
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
          (verifiedRows ? '<div class="section-head"><span class="section-title">QC receipts</span></div>' + verifiedRows : "") +
          '<button type="button" class="row" id="btn-quick-inbox">' +
            '<div class="row-main"><div class="row-title">Quick-Action Inbox</div><div class="row-sub">Capture an idea or dictation to #peer-floor</div></div>' +
            '<div class="row-right"><span>Capture</span><span>›</span></div>' +
          "</button>" +
        "</div>" +
      "</div>";

    return heroHtml + '<div class="today-grid">' + streamCol + sheetsCol + "</div>";
  }

  async function copyCloudPrompt() {
    const prompt = [
      "Seth here. Open The Stack → Agents → #peer-floor using your existing authorized access. The shared room is Projects/The-Stack/hub/channels/peer-floor/messages.jsonl on main in https://github.com/lilfangsproject-wq/ai-workspace.",
      "Read my latest @all ping in that room. Under your own teammate name, reply once in #peer-floor with the ping ID, your current update and any blocker. If you already replied there to that ping, reuse your existing reply. If your report is in a DM, summarize only what is appropriate for the shared room.",
      "Read your reply back from #peer-floor on main and return its message ID in this cloud chat. If you cannot post or verify it, tell me exactly which step is blocked. Keep dispatch off and spending at $0."
    ].join("\n\n");
    try {
      await navigator.clipboard.writeText(prompt);
      toast("Copied. Paste into each teammate’s cloud chat.", "info");
    } catch (error) {
      openSheet('<div class="sheet-head"><h2 class="sheet-title">Peer-floor prompt</h2><button type="button" class="btn btn-sec" data-close-sheet>Close</button></div>' +
        '<label for="cloud-prompt-text">Copy into each teammate’s cloud chat</label>' +
        '<textarea class="input" id="cloud-prompt-text" rows="9" readonly>' + esc(prompt) + '</textarea>');
      const promptEl = document.getElementById("cloud-prompt-text");
      if (promptEl) promptEl.select();
    }
  }

  function renderAgents() {
    const agent = state.agents.find(function (a) { return a.id === state.activeAgentId; }) || state.agents[0];
    if (!agent) return '<div class="empty">Loading agents…</div>';
    const st = agentMeta(agent.status);
    const slug = dmSlugForAgent(agent.id);
    const msgs = state.messagesBySlug[slug] || [];
    const usageTone = agent.usagePct >= 85 ? "red" : agent.usagePct >= 70 ? "amber" : "";
    const pctText = agent.hasLiveUsage ? agent.usagePct + "% used · Manual · " + relTime(agent.usageObservedAt) : "Quota unavailable";
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
      return renderMessageBubble(m, true, slug);
    }).join("");

    return (
      '<div class="agent-strip" style="margin-bottom:10px;">' + switcher + "</div>" +
      '<section class="hero chat-hero">' +
        '<div class="hero-top">' +
          '<div style="min-width:0;"><span class="kicker">' + esc(agent.role) + " · " + esc(agent.model) + '</span><h2 class="hero-title">' + esc(agent.name) + "</h2></div>" +
          '<div class="hero-top-actions">' +
            '<span class="badge ' + st.tone + '"><span class="dot ' + st.tone + '"></span>' + esc(st.label) + "</span>" +
            '<button type="button" class="btn btn-sec btn-sm" id="btn-agent-memory" aria-label="Memory (' + memEntries.length + ')" title="Memory (' + memEntries.length + ')">🧠 <span class="hide-xs">Memory </span>(' + memEntries.length + ")</button>" +
            '<button type="button" class="btn btn-sec btn-sm voice-btn" id="btn-voice-agent" data-voice-slug="' + esc(slug) + '" aria-label="Read latest reply" title="Read latest reply">🔊<span class="hide-xs"> Read Reply</span></button>' +
            '<button type="button" class="btn btn-pri btn-sm" id="btn-start-voice" aria-pressed="' + (voiceCall && voiceCall.alive && voiceCall.slug === slug ? "true" : "false") + '" title="Start opt-in live voice call">' + (voiceCall && voiceCall.alive && voiceCall.slug === slug ? "Stop Voice" : "Start Voice") + "</button>" +
            '<button type="button" class="btn btn-sec btn-sm kb-done-btn" id="btn-chat-kb-done" aria-label="Hide keyboard">Done</button>' +
          "</div>" +
        "</div>" +
        '<div class="chat-subbar">' +
          '<div class="chat-subbar-top">' +
            (agent.id !== "peer-floor"
              ? '<span><strong>' + esc(pctText) + "</strong> · " + esc(agent.reset) + " · " + esc(agent.activitySummary) + "</span>" +
                '<span class="mono">' + esc(agent.lastSeen || agent.evidence) + "</span>"
              : '<span>channels/peer-floor/messages.jsonl</span><span class="mono">' + esc(agent.activitySummary) + "</span>") +
          "</div>" +
          (agent.id !== "peer-floor" ? '<div class="meter" style="margin-top:5px;height:4px;"><div class="meter-fill ' + usageTone + '" style="width:' + agent.usagePct + '%"></div></div>' : "") +
        "</div>" +
        '<div class="chat-log-wrap">' +
          '<div id="chat-log" class="chat-log">' + (msgHtml || '<div class="empty">No local messages yet — pings commit via BFF to ' + esc(slug) + ".</div>") + "</div>" +
          '<button type="button" id="chat-jump-bottom" class="chat-jump-pill hidden">↓ Latest</button>' +
        "</div>" +
        '<div class="chip-strip">' +
          (agent.id === "peer-floor" ? '<button type="button" class="ctx-chip" data-cloud-prompt>Copy peer-floor prompt</button>' : "") +
          (agent.id === "peer-floor" ? '<button type="button" class="ctx-chip" data-insert="@all">@all</button>' + state.agents.filter(function (a) { return a.id !== "peer-floor"; }).map(function (a) {
            return '<button type="button" class="ctx-chip" data-insert="@' + esc(a.name) + '">@' + esc(a.name) + "</button>";
          }).join("") : "") +
          '<button type="button" class="ctx-chip" data-insert="Ping: confirm active commit SHA, current blocker, and next gate.">Reliable Ping</button>' +
          '<button type="button" class="ctx-chip" data-insert="QC needed: reviewer !== builder, include commit SHA + checks.">QC Gate</button>' +
        "</div>" +
        voiceCallBarHtml(slug) +
        '<div class="composer-wrap">' +
          '<div id="agent-mention-pop" class="mention-pop hidden" role="listbox" aria-label="Mention suggestions"></div>' +
          '<form id="agent-chat-form" class="composer">' +
            '<input id="agent-chat-input" data-draft-channel="' + esc(slug) + '" data-slug="' + esc(slug) + '" class="input" placeholder="' + (agent.id === "peer-floor" ? "Message #peer-floor… type @ to mention" : "Message " + esc(agent.name) + "…") + '" autocomplete="off" enterkeyhint="send" required />' +
            dictationButton("agent-chat-input") +
            '<button type="submit" class="btn btn-pri btn-sm">' + (agent.id === "peer-floor" ? "Send" : "Ping") + "</button>" +
          "</form>" +
        "</div>" +
      "</section>"
    );
  }

  const assignmentLabels = {
    assigned: "Awaiting pickup", received: "Claimed · awaiting acknowledgement",
    scheduled: "Scheduled", waiting_dependency: "Waiting for dependency",
    running: "Acknowledged", interrupted: "Lease expired · ready to retry",
    retry_wait: "Retry scheduled", review_pending: "Needs review", verified: "Verified",
    failed: "Failed", cancelled: "Cancelled", timed_out: "Timed out"
  };
  const assignmentEvents = {
    assign: "Assigned", claim: "Claim recorded", acknowledge: "Acknowledged", progress: "Progress", submit: "Evidence submitted",
    review: "Review recorded", fail: "Attempt failed", cancel: "Cancelled"
  };
  const assignmentRequestPrefix = "stack-assignment-request-v1:";
  const assignmentRequests = new Map();
  let pendingAssignmentCancel = null;

  async function assignmentRequestKey(fields) {
    const payload = new TextEncoder().encode(JSON.stringify([creds.bff, fields]));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
    return assignmentRequestPrefix + Array.from(digest, function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
  }

  function assignmentRequestId(key) {
    let id = assignmentRequests.get(key);
    try { id = id || sessionStorage.getItem(key); } catch {}
    id = id || crypto.randomUUID();
    assignmentRequests.set(key, id);
    try { sessionStorage.setItem(key, id); } catch {}
    return id;
  }

  function clearAssignmentRequest(key) {
    assignmentRequests.delete(key);
    try { sessionStorage.removeItem(key); } catch {}
  }

  function assignmentName(id) {
    return id === "seth" ? "Seth" : DEFAULT_ROSTER.find(function (a) { return a.id === id; })?.name ||
      (id === "codex" ? "Codex" : id);
  }

  function assignmentSheet(title, body) {
    openSheet('<div class="sheet-head"><h2 class="sheet-title">' + esc(title) +
      '</h2><button type="button" class="orb-btn" data-close-sheet aria-label="Close">✕</button></div>' + body);
  }

  function bindAssignmentDiscussion(section, enabled) {
    const path = "/api/assignments/" + encodeURIComponent(section.dataset.assignmentDiscussion) + "/discussion";
    const messages = section.querySelector("[data-discussion-messages]");
    const status = section.querySelector("[role=status]");
    const earlier = section.querySelector("[data-discussion-earlier]");
    const refresh = section.querySelector("[data-discussion-refresh]");
    const form = section.querySelector("form");
    let cursor = null;
    let loaded = false;
    let loadVersion = 0;

    async function load(before) {
      const version = ++loadVersion;
      refresh.disabled = true;
      earlier.disabled = true;
      try {
        const data = await bff(path + (before ? "?before=" + encodeURIComponent(before) : ""));
        if (version !== loadVersion) return;
        const markup = data.messages.map(function (message) {
          return '<li><strong>' + esc(assignmentName(message.author)) + '</strong><small>' +
            esc(new Date(message.created_at).toLocaleString()) + '</small><p class="assignment-text">' +
            esc(message.body) + '</p></li>';
        }).join("");
        if (before) messages.insertAdjacentHTML("afterbegin", markup);
        else messages.innerHTML = markup;
        cursor = data.before;
        earlier.hidden = !cursor;
        status.textContent = data.messages.length ? "" : "No discussion yet.";
        loaded = true;
      } catch (error) {
        if (version === loadVersion) status.textContent = error.message;
      } finally {
        if (version === loadVersion) {
          refresh.disabled = false;
          earlier.disabled = false;
        }
      }
    }

    section.addEventListener("toggle", function () {
      if (section.open && !loaded && !refresh.disabled) load();
    });
    refresh.addEventListener("click", function () { load(); });
    earlier.addEventListener("click", function () { load(cursor); });
    if (!enabled || !form) return;

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      const input = form.querySelector("textarea");
      const button = form.querySelector("button");
      const body = input.value.trim();
      if (!body) {
        status.textContent = "Enter a message.";
        return;
      }
      button.disabled = true;
      try {
        const key = await assignmentRequestKey([path, body]);
        await bff(path, { method: "POST", body: JSON.stringify({ body: body, request_id: assignmentRequestId(key) }) });
        clearAssignmentRequest(key);
        if (input.value.trim() === body) input.value = "";
        await load();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  }

  const assignmentGroups = [
    ["Needs attention", ["review_pending", "interrupted", "failed", "timed_out"]],
    ["In progress", ["received", "running"]],
    ["Waiting", ["assigned", "scheduled", "waiting_dependency", "retry_wait"]],
    ["Closed", ["verified", "cancelled"]],
  ];

  async function openAssignmentInbox() {
    assignmentSheet("Assignments", '<p role="status">Loading assignments…</p>');
    const loading = document.querySelector("#sheet [role=status]");
    try {
      const data = await bff("/api/assignments");
      if (!loading.isConnected || !document.getElementById("overlay").classList.contains("open")) return;
      function renderAssignment(item) {
        const canCancel = !["verified", "failed", "cancelled", "timed_out"].includes(item.status);
        const history = item.history.map(function (event) {
          return '<li>' + esc(assignmentEvents[event.action]) + ' · ' + esc(assignmentName(event.actor)) +
            (event.session_id ? ' · ' + esc(event.session_id) : '') +
            ' · ' + esc(new Date(event.at).toLocaleString()) +
            (event.note ? ' · ' + esc(event.note) : '') + '</li>';
        }).join("");
        return '<details class="assignment-row"><summary><strong>' + esc(item.title) +
          '</strong><span>' + esc(assignmentName(item.recipient)) + ' · ' +
          esc(assignmentLabels[item.status] || item.status) + '</span></summary>' +
          '<p class="assignment-text">' + esc(item.instructions) + '</p>' +
          '<p>Reviewer ' + esc(assignmentName(item.reviewer)) + ' · Attempt ' + item.attempt + '</p>' +
          (item.channel ? '<details class="assignment-history" data-assignment-source="' + esc(item.message_id) + '" data-source-channel="' +
            esc(item.channel) + '"><summary>Source #' + esc(item.channel) + '</summary><p role="status"></p></details>' : '') +
          (item.dependency_id ? '<p>Dependency ' + esc(item.dependency_id) + ' · ' + esc(assignmentLabels[item.dependency_status] || item.dependency_status || "Unknown") + '</p>' : '') +
          (item.status === "scheduled" || item.status === "retry_wait" ? '<p>Available ' + esc(new Date(item.available_at).toLocaleString()) + '</p>' : '') +
          (item.lease_until ? '<p>Last lease ends ' + esc(new Date(item.lease_until).toLocaleString()) + '</p>' : '') +
          (item.evidence ? '<p class="assignment-text"><strong>Evidence</strong><br>' + esc(item.evidence) + '</p>' : '') +
          '<details class="assignment-history"><summary>Execution history</summary><ol>' + history + '</ol></details>' +
          '<details class="assignment-discussion" data-assignment-discussion="' + esc(item.id) + '"><summary>Discussion</summary>' +
          '<div class="hero-actions"><button type="button" class="btn btn-sec btn-sm" data-discussion-refresh>Refresh discussion</button>' +
          '<button type="button" class="btn btn-sec btn-sm" data-discussion-earlier hidden>Load earlier</button></div>' +
          '<p role="status"></p><ol class="assignment-messages" data-discussion-messages></ol>' +
          (data.enabled ? '<form><div class="field"><label for="discussion-' + esc(item.id) + '">Message for this assignment</label>' +
          '<textarea class="input" rows="2" maxlength="2000" id="discussion-' + esc(item.id) + '" required></textarea></div>' +
          '<button type="submit" class="btn btn-pri btn-sm">Post message</button></form>' : '') +
          '</details>' +
          (canCancel ? '<button type="button" class="btn btn-sec btn-sm" data-cancel-assignment="' + esc(item.id) + '">Cancel assignment</button>' : '') +
          '</details>';
      }
      const rows = assignmentGroups.map(function (group) {
        const items = data.assignments.filter(function (item) { return group[1].includes(item.status); });
        return items.length ? '<section class="assignment-group"><h3>' + esc(group[0]) + '</h3>' +
          items.map(renderAssignment).join("") + '</section>' : '';
      }).join("");
      const directory = (data.peers || []).map(function (peer) {
        const canEnroll = ["chatgpt", "cursor", "claude", "gemini", "nori"].includes(peer.id);
        const sessionControl = data.actor === "seth" && canEnroll && peer.d1_session_registered
          ? '<button type="button" class="btn btn-sec btn-sm" data-session-revoke="' + esc(peer.id) + '">Revoke D1 session</button>'
          : data.actor === "seth" && data.enabled && canEnroll && !peer.configured
            ? '<button type="button" class="btn btn-sec btn-sm" data-session-issue="' + esc(peer.id) + '">Issue session token</button>'
            : '';
        const managedNote = data.actor === "seth" && peer.credential_source === "worker_secret"
          ? '<small>' + (peer.d1_session_registered ? 'Worker secret active' : 'Managed by Worker secret') + '</small>' : '';
        return '<li>' + esc(assignmentName(peer.id)) + ' · ' +
          (peer.checked_in_at ? 'Checked in ' + esc(new Date(peer.checked_in_at).toLocaleString())
            : peer.configured ? 'Configured · no check-in' : 'No session configured') +
          sessionControl + managedNote + '<div data-session-result></div></li>';
      }).join("");
      assignmentSheet("Assignments",
        '<p class="sheet-sub">' + (data.enabled ? 'Agents pick up assigned work from their sessions.' : 'Assignment pickup is paused.') + '</p>' +
        '<div class="hero-actions"><button type="button" class="btn btn-sec btn-sm" id="refresh-assignments">Refresh</button>' +
        (data.enabled ? '<button type="button" class="btn btn-pri btn-sm" id="new-assignment">New assignment</button>' : '') +
        '</div><p id="assignment-status" role="status"></p>' + (rows || '<p>No assignments yet.</p>') +
        (directory ? '<details class="assignment-row"><summary>Teammate sessions</summary>' +
          '<p>Check-ins show when a session last reached The Stack.</p><ul>' + directory + '</ul></details>' : ''));
      document.querySelectorAll("[data-assignment-source]").forEach(function (section) {
        section.addEventListener("toggle", async function () {
          const status = section.querySelector("[role=status]");
          if (!section.open || status.dataset.loading || status.dataset.loaded) return;
          status.dataset.loading = "true";
          status.textContent = "Loading source…";
          try {
            const query = new URLSearchParams({
              slug: section.dataset.sourceChannel, message_id: section.dataset.assignmentSource
            });
            const data = await bff("/api/messages?" + query);
            if (!data.message) throw new Error("Source message unavailable.");
            status.textContent = "";
            status.insertAdjacentHTML("afterend", '<p><strong>' +
              esc(data.message.auto === true ? "Stack automation" : data.message.author || "Unknown author") + '</strong> · ' +
              esc(new Date(data.message.created_at).toLocaleString()) + '</p><blockquote class="assignment-text">' +
              esc(data.message.body || "") + '</blockquote>');
            status.dataset.loaded = "true";
          } catch (error) {
            status.textContent = error.message;
          } finally {
            delete status.dataset.loading;
          }
        });
      });
      document.querySelectorAll("[data-assignment-discussion]").forEach(function (section) {
        bindAssignmentDiscussion(section, data.enabled);
      });
      document.querySelectorAll("[data-session-issue]").forEach(function (button) {
        button.addEventListener("click", async function () {
          const peer = button.dataset.sessionIssue;
          const result = button.closest("li").querySelector("[data-session-result]");
          button.disabled = true;
          try {
            const issued = await bff("/api/assignments/sessions", {
              method: "POST", body: JSON.stringify({ peer: peer })
            });
            result.replaceChildren();
            const note = document.createElement("p");
            note.textContent = "Shown once. Copy this token into " + assignmentName(peer) + "’s runtime secret store now. If it is lost, revoke and issue a replacement. Do not paste it into a chat or commit it.";
            const token = document.createElement("textarea");
            token.className = "input mono";
            token.setAttribute("aria-label", assignmentName(peer) + " assignment access token");
            token.readOnly = true;
            token.rows = 2;
            token.value = issued.token;
            const copy = document.createElement("button");
            copy.type = "button";
            copy.className = "btn btn-sec btn-sm";
            copy.textContent = "Copy token";
            const status = document.createElement("span");
            status.setAttribute("role", "status");
            copy.addEventListener("click", async function () {
              try {
                await navigator.clipboard.writeText(issued.token);
                status.textContent = "Copied. Store it in the agent runtime now.";
              } catch {
                token.focus();
                token.select();
                status.textContent = "Clipboard unavailable. Copy the selected token into the agent runtime.";
              }
            });
            result.append(note, token, copy, status);
            button.disabled = true;
            button.textContent = "Session issued · Refresh list";
          } catch (error) {
            result.textContent = error.message;
            button.disabled = false;
          }
        });
      });
      document.querySelectorAll("[data-session-revoke]").forEach(function (button) {
        button.addEventListener("click", async function () {
          const peer = button.dataset.sessionRevoke;
          button.disabled = true;
          try {
            await bff("/api/assignments/sessions/" + encodeURIComponent(peer) + "/revoke", {
              method: "POST", body: "{}"
            });
            await openAssignmentInbox();
          } catch (error) {
            const result = button.closest("li").querySelector("[data-session-result]");
            if (result) result.textContent = error.message;
            button.disabled = false;
          }
        });
      });
      document.getElementById("refresh-assignments").addEventListener("click", openAssignmentInbox);
      document.getElementById("new-assignment")?.addEventListener("click", function () { openAssignmentForm(null, data.assignments); });
      document.querySelectorAll("[data-cancel-assignment]").forEach(function (button) {
        button.addEventListener("click", async function () {
          const id = button.dataset.cancelAssignment;
          if (!pendingAssignmentCancel || pendingAssignmentCancel.id !== id) {
            pendingAssignmentCancel = { id: id, operation_id: crypto.randomUUID() };
          }
          button.disabled = true;
          try {
            await bff("/api/assignments/" + id + "/cancel", {
              method: "POST", body: JSON.stringify({ operation_id: pendingAssignmentCancel.operation_id })
            });
            pendingAssignmentCancel = null;
            if (button.isConnected) await openAssignmentInbox();
          } catch (error) {
            const status = document.getElementById("assignment-status");
            if (button.isConnected && status) status.textContent = error.message;
            button.disabled = false;
          }
        });
      });
    } catch (error) {
      if (loading.isConnected) loading.textContent = error.status === 404
        ? "This Worker version does not support assignments." : error.message;
    }
  }

  function openAssignmentForm(source, existing = []) {
    const ids = ["chatgpt", "codex", "cursor", "claude", "gemini", "nori"];
    const options = '<option value="">Choose a teammate</option>' + ids.map(function (id) {
      return '<option value="' + id + '">' + esc(assignmentName(id)) + '</option>';
    }).join("");
    const dependencyOptions = existing.filter(function (item) { return item.sender === "seth"; }).map(function (item) {
      return '<option value="' + esc(item.id) + '">' + esc(item.title) + '</option>';
    }).join("");
    assignmentSheet("New assignment",
      '<form id="assignment-form">' +
      '<div class="field"><label for="assignment-title">Task</label><input class="input" id="assignment-title" name="title" required maxlength="160"></div>' +
      '<div class="field"><label for="assignment-instructions">Instructions and expected result</label>' +
      '<textarea class="input" id="assignment-instructions" name="instructions" rows="4" required maxlength="4000"></textarea></div>' +
      '<div class="field"><label for="assignment-recipient">Assignee</label><select class="input" id="assignment-recipient" name="recipient" required>' + options + '</select></div>' +
      '<div class="field"><label for="assignment-reviewer">Independent reviewer</label><select class="input" id="assignment-reviewer" name="reviewer" required>' + options + '</select></div>' +
      '<details><summary>Schedule and dependency</summary>' +
      '<div class="field"><label for="assignment-schedule">Available after (local time)</label><input class="input" type="datetime-local" id="assignment-schedule"></div>' +
      (dependencyOptions ? '<div class="field"><label for="assignment-dependency">Wait for verified assignment</label><select class="input" id="assignment-dependency"><option value="">No dependency</option>' + dependencyOptions + '</select></div>' : '') +
      '</details>' +
      (source ? '<p class="sheet-sub">Linked to a message in #' + esc(source.channel) + '</p>' : '') +
      '<div class="hero-actions"><button type="submit" class="btn btn-pri">Save assignment</button></div><p id="assignment-error" role="status"></p></form>');
    const form = document.getElementById("assignment-form");
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      const status = form.querySelector("#assignment-error");
      status.textContent = "";
      const fields = Object.assign(Object.fromEntries(new FormData(form)), source);
      if (fields.recipient === fields.reviewer) {
        status.textContent = "Choose a different reviewer from the assignee.";
        return;
      }
      const schedule = form.querySelector("#assignment-schedule").value;
      const dependency = form.querySelector("#assignment-dependency")?.value;
      if (schedule) fields.scheduled_at = Date.parse(schedule);
      if (dependency) fields.dependency_id = dependency;
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        const key = await assignmentRequestKey(fields);
        const requestId = assignmentRequestId(key);
        await bff("/api/assignments", { method: "POST", body: JSON.stringify({ ...fields, request_id: requestId }) });
        clearAssignmentRequest(key);
        if (form.isConnected) await openAssignmentInbox();
      } catch (error) {
        status.textContent = error.message;
        button.disabled = false;
      }
    });
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
      (state.assignmentMode ? '<div class="section-head"><h2 class="section-title">Work</h2><button type="button" class="btn btn-sec btn-sm" data-open-assignments>Assignments</button></div>' : "") +
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
    const totalEvents = modelAgents.reduce(function (sum, a) { return sum + (a.activity24h || 0); }, 0);

    const usageRows = modelAgents.map(function (a) {
      const m = agentMeta(a.status);
      const tone = a.usagePct >= 85 ? "red" : a.usagePct >= 70 ? "amber" : "";
      const pctLabel = a.hasLiveUsage ? a.usagePct + "% · Manual · " + relTime(a.usageObservedAt) : "Quota unavailable";
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
          '<div class="meter" style="margin-top:0;"><div class="meter-fill ' + tone + '" style="width:' + (a.hasLiveUsage ? a.usagePct : 0) + '%"></div></div>' +
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
      : (anyLiveUsage ? "Manual quota readings" : (state.online ? "Live Git & floor activity" : "Offline — tap Sync Now"));

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
        '<p class="hero-copy">' + modelAgents.filter(function (a) { return a.hasLiveUsage; }).length + " of " + modelAgents.length + " manual quota readings available · " + totalEvents + " recorded activity events (24h)" + '<br/><span class="mono">' + esc(creds.bff) + "</span> · Last sync " + relTime(state.lastSyncIso) + " · " + state.outbox.length + " pending · Queue OFF · $" + ZERO_SPEND + " cap<br/>" + healthLine + "</p>" +
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
    const titles = { today: "Today", agents: "Agents", work: "Work", stats: "Usage & Git", explore: "Explore" };
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

    const activeEl = document.activeElement;
    const focusedComposer = (activeEl && activeEl.matches && activeEl.matches("[data-draft-channel]"))
      ? activeEl
      : null;

    if (state.view === "today") root.innerHTML = renderToday();
    else if (state.view === "agents") root.innerHTML = renderAgents();
    else if (state.view === "work") root.innerHTML = renderWork();
    else if (state.view === "explore") window.StackExplore.mount(root, bff);
    else root.innerHTML = renderStats();

    document.body.classList.toggle("view-agents", state.view === "agents");
    root.classList.toggle("view-agents", state.view === "agents");
    renderChrome();
    bindEvents();

    const ov = document.getElementById("overlay");
    const sheetOpen = Boolean(ov && ov.classList.contains("open"));
    const composer = root.querySelector("[data-draft-channel]");
    if (composer) {
      const channel = composer.dataset.draftChannel;
      const saved = composerDrafts.bff === creds.bff ? composerDrafts.channels[channel] : "";
      composer.value = typeof saved === "string" ? saved : "";
      composer.addEventListener("input", function () { saveComposerDraft(composer); });
      if (focusedComposer && focusedComposer.id === composer.id &&
          focusedComposer.dataset.draftChannel === channel && !sheetOpen) {
        try {
          composer.focus({ preventScroll: true });
          if (typeof focusedComposer.selectionStart === "number" && composer.setSelectionRange) {
            composer.setSelectionRange(focusedComposer.selectionStart, focusedComposer.selectionEnd);
          }
        } catch (e) {}
      }
    }

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
      closeSheet();
      await sendToSlug("peer-floor", "Quick Action: " + body);
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
          '<div class="row-right"><span>' + (a.hasLiveUsage ? a.usagePct + "% · Manual" : "Quota unavailable") + "</span><span>›</span></div>" +
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
            ? '<div class="usage-row-actions"><strong class="mono">' + esc(agent.hasLiveUsage ? agent.usagePct + "% · Manual" : "Quota unavailable") + '</strong><button type="button" class="btn btn-sec btn-sm" id="sheet-calibrate-btn" data-sheet-calibrate="' + esc(agent.id) + '">Calibrate</button></div>'
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
        '<input id="usage-pct" class="input mono" type="number" min="0" max="100" step="1" value="' + esc(agent.hasLiveUsage ? String(agent.usagePct) : "") + '" required /></div>' +
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
    const savedVoice = getSavedVoiceId();
    const confirmOn = voiceConfirmEnabled();
    const serverReady = Boolean(serverTtsStatus && serverTtsStatus.configured);
    openSheet(
      '<div class="sheet-head"><div><h2 class="sheet-title">Voice Settings</h2><p class="sheet-sub">Opt-in live voice · Server ElevenLabs at 0.9× speed · $0 Web Speech fallback</p></div><button type="button" class="orb-btn" style="width:32px;height:32px;" data-close-sheet>✕</button></div>' +
      '<form id="voice-settings-form">' +
        '<div class="field"><label for="voice-el-id">ElevenLabs Voice ID</label>' +
        '<input id="voice-el-id" class="input mono" type="text" value="' + esc(savedVoice) + '" placeholder="' + DEFAULT_VOICE_ID + '" autocomplete="off" /></div>' +
        '<p class="sheet-sub" id="voice-server-status">' + (serverReady ? "Worker ElevenLabs active · server-side secret configured." : "Checking Worker ElevenLabs…") + "</p>" +
        '<label class="field" style="display:flex;align-items:center;gap:8px;margin-top:8px;">' +
          '<input id="voice-confirm-toggle" type="checkbox" ' + (confirmOn ? "checked" : "") + ' />' +
          '<span>Review final transcript before sending (recommended)</span>' +
        '</label>' +
        '<div class="chip-strip">' +
          '<button type="button" class="ctx-chip" data-voice-preset="EXAVITQu4vr4xnSDxMaL">Sarah (Primary $0)</button>' +
          '<button type="button" class="ctx-chip" data-voice-preset="aura-2-thalia">Thalia (Neural $0)</button>' +
          '<button type="button" class="ctx-chip" data-voice-preset="aura-2-luna">Luna (Neural $0)</button>' +
          '<button type="button" class="ctx-chip" data-voice-preset="21m00Tcm4TlvDq8ikWAM">Rachel ($0)</button>' +
        "</div>" +
        (serverReady ? "" :
          '<details id="voice-browser-key-wrap" style="margin-top:10px;"><summary class="sheet-sub">Browser key fallback (server not configured)</summary>' +
            '<div class="field" style="margin-top:8px;"><label for="voice-el-key">Browser-local ElevenLabs key (fallback only)</label>' +
            '<input id="voice-el-key" class="input mono" type="password" value="" placeholder="Prefer Worker secret ELEVENLABS_API_KEY" autocomplete="off" /></div>' +
          "</details>") +
        '<div class="hero-actions" style="margin-top:8px;">' +
          '<button type="submit" class="btn btn-pri btn-sm">Save Settings</button>' +
          '<button type="button" class="btn btn-sec btn-sm voice-btn" id="btn-voice-test">🔊 Test Voice</button>' +
          (serverReady ? "" : '<button type="button" class="btn btn-danger btn-sm" id="btn-voice-clear">Clear Key ($0)</button>') +
        "</div>" +
      "</form>"
    );

    const idEl = document.getElementById("voice-el-id");
    const confirmEl = document.getElementById("voice-confirm-toggle");
    const statusEl = document.getElementById("voice-server-status");
    const initKeyEl = document.getElementById("voice-el-key");
    if (initKeyEl) initKeyEl.value = getSavedElevenKey();

    document.getElementById("sheet").querySelectorAll("[data-voice-preset]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (idEl) idEl.value = b.dataset.voicePreset;
      });
    });

    if (creds.bff && creds.pin) {
      fetch(creds.bff.replace(/\/$/, "") + "/api/tts/status", {
        headers: { "x-stack-pin": creds.pin }
      }).then(function (res) { return res.json().catch(function () { return {}; }); }).then(function (data) {
        serverTtsStatus = data || null;
        if (data && data.configured) {
          try { localStorage.removeItem(ELEVEN_KEY_STORAGE); } catch (e) {}
          const wrap = document.getElementById("voice-browser-key-wrap");
          if (wrap) wrap.remove();
          const clr = document.getElementById("btn-voice-clear");
          if (clr) clr.remove();
          if (statusEl) {
            const vid = data.default_voice_id || data.voiceId || DEFAULT_VOICE_ID;
            statusEl.textContent = "Server Neural Voice active · " + (data.mode || "server-elevenlabs-sarah") + " (" + vid + ", Workers AI Aura-2 fallback ready · 0.9×).";
          }
        } else if (statusEl) {
          statusEl.textContent = "Worker ElevenLabs not configured — using $0 Web Speech until ELEVENLABS_API_KEY is set on the Worker.";
        }
      }).catch(function () {
        if (statusEl) statusEl.textContent = "Could not reach /api/tts/status — Web Speech fallback remains available.";
      });
    } else if (statusEl) {
      statusEl.textContent = "Sign in to check Worker ElevenLabs status.";
    }

    document.getElementById("voice-settings-form").addEventListener("submit", function (e) {
      e.preventDefault();
      const keyEl = document.getElementById("voice-el-key");
      const k = keyEl ? keyEl.value.trim() : "";
      const v = (idEl && idEl.value.trim()) || DEFAULT_VOICE_ID;
      try {
        if (keyEl) {
          if (k) localStorage.setItem(ELEVEN_KEY_STORAGE, k);
          else localStorage.removeItem(ELEVEN_KEY_STORAGE);
        }
        localStorage.setItem(ELEVEN_VOICE_STORAGE, v);
      } catch (err) {}
      setVoiceConfirmEnabled(!(confirmEl && confirmEl.checked === false));
      toast("Saved voice settings", "info");
      closeSheet();
    });

    const testBtn = document.getElementById("btn-voice-test");
    if (testBtn) {
      testBtn.addEventListener("click", function () {
        const keyEl = document.getElementById("voice-el-key");
        speakText("This is how Stack messages will sound at point nine speed.", testBtn, {
          apiKey: keyEl ? keyEl.value.trim() : "",
          voiceId: (idEl && idEl.value.trim()) || DEFAULT_VOICE_ID,
          preferEleven: true
        });
      });
    }

    const clearBtn = document.getElementById("btn-voice-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        const keyEl = document.getElementById("voice-el-key");
        stopSpeaking();
        try { localStorage.removeItem(ELEVEN_KEY_STORAGE); } catch (err) {}
        if (keyEl) keyEl.value = "";
        toast("Cleared browser ElevenLabs override", "info");
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
    else if (row.action === "view:explore") { state.view = "explore"; render(); }
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
    endDictation();
    const match = state.agents.find(function (a) { return a.id === agentId; });
    const nextId = match ? match.id : "peer-floor";
    const nextSlug = dmSlugForAgent(nextId);
    if (voiceCall && voiceCall.alive && voiceCall.slug !== nextSlug) hangUpVoiceCall("room");
    state.activeAgentId = nextId;
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
    if (!body) return { accepted: false, empty: true };

    const requestId = crypto.randomUUID();
    const pending = { id: requestId, channel_slug: channel, author: "Seth", body: body, created_at: new Date().toISOString(), _submitting: true };
    state.messagesBySlug[channel] = (state.messagesBySlug[channel] || []).concat(pending);
    state.forceChatBottom = true;
    state.sendingPing += 1;
    render();

    try {
      await postMessage(channel, body, requestId);
      toast("Backend accepted message", "info");
      state.forceChatBottom = true;
      normalizeHubData();
      render();
      return { accepted: true, requestId: requestId };
    } catch (e) {
      // A sync may already have recovered a write whose response was lost.
      const recovered = (state.messagesBySlug[channel] || []).some(function (m) { return m.id === requestId && m.backend_accepted_at; });
      if (!recovered) {
        const evt = { id: requestId, requestId: requestId, type: "message", slug: channel, body: body };
        if (agentIdForOutbox) evt.agentId = agentIdForOutbox;
        state.outbox.unshift(evt);
        saveOutbox();
        pending._queued = true;
        pending._submitting = false;
        toast("Saved to Outbox · Acceptance unconfirmed", "warning");
      }
      state.link = (typeof navigator !== "undefined" && navigator.onLine === false) ? "offline" : state.link;
      state.forceChatBottom = true;
      render();
      return { accepted: recovered, queued: !recovered, requestId: requestId, error: e };
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
        const next = b.dataset.go;
        endDictation();
        if (voiceCall && voiceCall.alive && next !== "agents") hangUpVoiceCall("room");
        state.view = next;
        if (state.view === "agents") state.forceChatBottom = true;
        render();
      });
    });
    root.querySelectorAll("[data-open-assignments]").forEach(function (button) {
      button.addEventListener("click", openAssignmentInbox);
    });
    root.querySelectorAll("[data-assign-message]").forEach(function (button) {
      button.addEventListener("click", function () {
        openAssignmentForm({ channel: button.dataset.assignChannel, message_id: button.dataset.assignMessage });
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
    const startVoiceBtn = document.getElementById("btn-start-voice");
    if (startVoiceBtn) startVoiceBtn.addEventListener("click", startVoiceCall);
    const hangBtn = root.querySelector("[data-voice-hangup]");
    if (hangBtn) hangBtn.addEventListener("click", function () { hangUpVoiceCall("stop"); });
    const stopVoiceBtn = root.querySelector("[data-voice-stop]");
    if (stopVoiceBtn) stopVoiceBtn.addEventListener("click", stopVoiceTurn);
    const muteBtn = root.querySelector("[data-voice-mute]");
    if (muteBtn) muteBtn.addEventListener("click", toggleVoiceMute);
    const retryVoiceBtn = root.querySelector("[data-voice-retry]");
    if (retryVoiceBtn) retryVoiceBtn.addEventListener("click", function () {
      if (!voiceCall || !voiceCall.alive) return;
      primeVoiceAudio();
      voiceCall.fatalError = false;
      voiceCall.muted = false;
      beginVoiceListening();
      render();
    });
    const sendVoiceBtn = root.querySelector("[data-voice-send]");
    if (sendVoiceBtn) sendVoiceBtn.addEventListener("click", function () {
      if (!voiceCall || !voiceCall.pendingTranscript || voiceCallSending) return;
      sendVoiceBtn.disabled = true;
      sendVoiceTranscript(voiceCall.pendingTranscript);
    });
    const discardVoiceBtn = root.querySelector("[data-voice-discard]");
    if (discardVoiceBtn) discardVoiceBtn.addEventListener("click", function () {
      if (!voiceCall) return;
      voiceCall.pendingTranscript = "";
      beginVoiceListening();
      render();
    });
    root.querySelectorAll("[data-dictate]").forEach(function (button) {
      button.addEventListener("click", function () {
        toggleDictation(document.getElementById(button.dataset.dictate));
      });
    });
    const cloudPrompt = root.querySelector("[data-cloud-prompt]");
    if (cloudPrompt) cloudPrompt.addEventListener("click", copyCloudPrompt);
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
        saveComposerDraft(inputEl);
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
          saveComposerDraft(todayFloorInput);
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
        saveComposerDraft(todayFloorInput);
        await sendToSlug("peer-floor", body);
      });
    }

    const chatInput = document.getElementById("agent-chat-input");
    bindMentionPicker(chatInput, document.getElementById("agent-mention-pop"));
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
        saveComposerDraft(chatInput);
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
        saveComposerDraft(chatInput);
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
      const next = b.dataset.view;
      endDictation();
      if (voiceCall && voiceCall.alive && next !== "agents") hangUpVoiceCall("room");
      state.view = next;
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
      if (state.view === "agents" || state.view === "explore") { pulling = false; return; }
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
    if (voiceCall && voiceCall.alive) {
      stopVoiceRecognition();
      stopSpeaking();
      voiceCall.pendingTranscript = "";
      setVoiceCallState("disconnected", "Network offline");
      render();
    }
    renderChrome();
  });
  window.addEventListener("online", function () {
    state.online = true;
    state.link = "polling";
    if (voiceCall && voiceCall.alive && voiceCall.state === "disconnected") {
      setVoiceCallState("disconnected", "Back online · tap Retry");
      render();
    }
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
      if (document.hidden) {
        endDictation();
        stopSpeaking();
        if (voiceCall && voiceCall.alive) hangUpVoiceCall("hidden");
        return;
      }
      checkAppUpdate();
      if (creds.pin && creds.bff && !state.syncing) syncVault(true);
    });
    window.addEventListener("pagehide", function () {
      endDictation();
      stopSpeaking();
      if (voiceCall && voiceCall.alive) hangUpVoiceCall("hidden");
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
