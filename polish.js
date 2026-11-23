/* The Stack v50.1 — pure helpers (no mic / no network).
 * Includes opt-in Voice Brief text builders (speech is wired in app.js).
 * Loaded as a classic script; also readable from Node tests via vm.
 */
(function (root) {
  "use strict";

  // grokbot remains here only so historical author/commit detection still matches; it is a retired alias of nori (Seth, 22 Nov 2026).
  var AGENT_IDS = ["gemini", "chatgpt", "cursor", "claude", "nori", "grokbot"];
  var STATUSES = { working: 1, waiting: 1, blocked: 1, offline: 1, completed: 1 };

  var VIEWS = [
    { id: "today", title: "Today", keywords: "today view home brief" },
    { id: "agents", title: "Agents", keywords: "agents chats roster" },
    { id: "work", title: "Work", keywords: "work workstreams opportunities board" },
    { id: "stats", title: "Usage & Git", keywords: "usage stats git models" },
    { id: "ops", title: "Ops", keywords: "ops control room hermes handovers" },
    { id: "explore", title: "Explore Everything", keywords: "graph inventory dependencies impact" }
  ];

  var ACTIONS = [
    { id: "new", title: "New item", keywords: "new item quick inbox capture create" },
    { id: "sync", title: "Sync now", keywords: "sync now refresh vault" },
    { id: "flush", title: "Flush outbox", keywords: "flush outbox queue pending" },
    { id: "notif", title: "Open Notification Centre", keywords: "open notification centre notifications alerts" }
  ];

  function parsePaletteQuery(raw) {
    var filters = { agent: "", status: "", date: "" };
    var words = [];
    String(raw || "").split(/\s+/).forEach(function (tok) {
      if (!tok) return;
      var m = /^(agent|status|date):(\S+)$/i.exec(tok);
      if (m) filters[m[1].toLowerCase()] = m[2].toLowerCase();
      else words.push(tok);
    });
    return { filters: filters, text: words.join(" ").trim() };
  }

  function dateWindowMs(token) {
    var m = /^(\d+)([dh])$/.exec(String(token || "").toLowerCase());
    if (!m) return null;
    var n = Number(m[1]);
    if (!n || n < 1) return null;
    return m[2] === "h" ? n * 3600000 : n * 86400000;
  }

  function withinDate(iso, windowMs, now) {
    if (!iso) return false;
    var t = new Date(iso).getTime();
    if (isNaN(t)) return false;
    var age = now - t;
    return age <= windowMs && age >= -120000;
  }

  function actorsForCommit(commit) {
    var hay = ((commit && commit.message) || "") + " " + ((commit && commit.author) || "");
    hay = hay.toLowerCase();
    var hits = AGENT_IDS.filter(function (id) { return hay.indexOf(id) !== -1; });
    if (hits.length) return hits;
    var author = String((commit && commit.author) || "git").trim().toLowerCase();
    return [author || "git"];
  }

  function detectConflicts(commits) {
    var byPath = Object.create(null);
    (commits || []).forEach(function (c) {
      var actors = actorsForCommit(c);
      var files = (c && c.files) || [];
      files.forEach(function (f) {
        var path = typeof f === "string" ? f : (f && f.filename) || "";
        if (!path) return;
        if (!byPath[path]) byPath[path] = { path: path, actors: Object.create(null), shas: [] };
        actors.forEach(function (a) { byPath[path].actors[a] = true; });
        if (c.sha) byPath[path].shas.push(String(c.sha).slice(0, 8));
      });
    });
    return Object.keys(byPath).map(function (p) { return byPath[p]; }).filter(function (row) {
      return Object.keys(row.actors).length >= 2;
    }).map(function (row) {
      return { path: row.path, agents: Object.keys(row.actors), shas: row.shas };
    });
  }

  function connectionLabel(link, outboxCount) {
    var word = link === "live" ? "Live" : link === "polling" ? "Polling" : "Offline";
    var n = Number(outboxCount) || 0;
    return n > 0 ? word + " · Outbox · " + n : word;
  }

  function connectionDot(link) {
    if (link === "live") return "green";
    if (link === "polling") return "amber";
    return "muted";
  }

  function resolveSurface(mode, prefersLight) {
    if (mode === "light") return "light";
    if (mode === "system") return prefersLight ? "light" : "dark";
    return "dark";
  }

  function nextTheme(mode) {
    if (mode === "light") return "system";
    if (mode === "system") return "dark";
    return "light";
  }

  function toastRank(level) {
    if (level === "error") return 3;
    if (level === "warning") return 2;
    return 1;
  }

  function enqueueToast(queue, item) {
    var level = item && (item.level === "error" || item.level === "warning") ? item.level : "info";
    var next = (queue || []).slice();
    var rank = toastRank(level);
    var i = 0;
    while (i < next.length && toastRank(next[i].level) >= rank) i += 1;
    next.splice(i, 0, { msg: String(item && item.msg || ""), level: level });
    return next;
  }

  function dmSlug(agentId) {
    if (!agentId || agentId === "peer-floor") return "peer-floor";
    return "dm-" + agentId + "-seth";
  }

  function haystack(row) {
    return ((row.title || "") + " " + (row.sub || "") + " " + (row.keywords || "")).toLowerCase();
  }

  function rowMatches(row, parsed, now) {
    var filters = parsed.filters;
    if (filters.agent) {
      var q = filters.agent;
      var id = String(row.agentId || "").toLowerCase();
      var title = String(row.title || "").toLowerCase();
      var agentHit = id.indexOf(q) !== -1 || (row.kind === "agent" && title.indexOf(q) !== -1);
      if (!agentHit) return false;
    }
    if (filters.status) {
      if (!STATUSES[filters.status] || row.status !== filters.status) return false;
    }
    if (filters.date) {
      var win = dateWindowMs(filters.date);
      if (!win || !withinDate(row.date, win, now)) return false;
    }
    if (parsed.text) {
      var words = parsed.text.toLowerCase().split(/\s+/).filter(Boolean);
      var hay = haystack(row);
      if (!words.every(function (w) { return hay.indexOf(w) !== -1; })) return false;
    }
    return true;
  }

  function sendTarget(parsed, opts) {
    var agents = opts.agents || [];
    if (parsed.filters.agent) {
      var q = parsed.filters.agent;
      var hit = agents.find(function (ag) {
        return String(ag.id || "").toLowerCase().indexOf(q) !== -1 ||
          String(ag.name || "").toLowerCase().indexOf(q) !== -1;
      });
      if (hit) return { slug: dmSlug(hit.id), label: hit.name || hit.id };
      return { slug: "peer-floor", label: "#peer-floor" };
    }
    if (opts.view === "agents" && opts.activeAgentId && opts.activeAgentId !== "peer-floor") {
      var selected = agents.find(function (ag) { return ag.id === opts.activeAgentId; });
      return {
        slug: dmSlug(opts.activeAgentId),
        label: (selected && selected.name) || opts.activeAgentId
      };
    }
    return { slug: "peer-floor", label: "#peer-floor" };
  }

  function buildPalette(opts) {
    opts = opts || {};
    var now = typeof opts.now === "number" ? opts.now : Date.now();
    var parsed = parsePaletteQuery(opts.query || "");
    var browse = !parsed.text && !parsed.filters.agent && !parsed.filters.status && !parsed.filters.date;
    var rows = [];

    VIEWS.forEach(function (v) {
      rows.push({
        layer: 1, kind: "view", id: "view:" + v.id, title: v.title, sub: "Jump",
        keywords: v.keywords, action: "view:" + v.id, status: "", agentId: "", date: ""
      });
    });

    (opts.agents || []).forEach(function (ag) {
      rows.push({
        layer: 1, kind: "agent", id: "agent:" + ag.id, title: ag.name || ag.id,
        sub: ag.status || "offline", keywords: (ag.name || "") + " " + (ag.id || "") + " chat dm",
        action: "agent:" + ag.id, status: ag.status || "offline", agentId: ag.id, date: ag.date || ""
      });
    });

    if (!browse) {
      (opts.items || []).forEach(function (item) {
        rows.push({
          layer: 1, kind: "work", id: "work:" + item.id, title: item.title || item.id,
          sub: item.owner || "", keywords: (item.title || "") + " " + (item.ref || ""),
          action: "inspect:" + item.id, status: item.status || "", agentId: item.agentId || "",
          date: item.date || ""
        });
      });
      (opts.commits || []).slice(0, 12).forEach(function (c) {
        rows.push({
          layer: 1, kind: "commit", id: "commit:" + String(c.sha || ""),
          title: String(c.message || "Commit").split("\n")[0],
          sub: c.author || "Git", keywords: (c.message || "") + " " + (c.author || "") + " " + (c.sha || ""),
          action: "view:stats", status: "", agentId: "", date: c.date || ""
        });
      });
    }

    ACTIONS.forEach(function (a) {
      var sub = a.id === "flush" ? ("Outbox · " + (Number(opts.outboxCount) || 0)) : "Action";
      rows.push({
        layer: 2, kind: "action", id: "act:" + a.id, title: a.title, sub: sub,
        keywords: a.keywords, action: a.id, status: "", agentId: "", date: ""
      });
    });

    var matched = rows.filter(function (row) { return rowMatches(row, parsed, now); });
    matched.sort(function (a, b) {
      if (a.layer !== b.layer) return a.layer - b.layer;
      return String(a.title).localeCompare(String(b.title));
    });

    if (parsed.text) {
      var target = sendTarget(parsed, opts);
      matched.push({
        layer: 3, kind: "send", id: "send", title: "Send to " + target.label,
        sub: parsed.text, keywords: "", action: "send", status: "", agentId: "",
        date: "", slug: target.slug, body: parsed.text
      });
    }
    return matched;
  }

  function clipSpoken(text, max) {
    var limit = max || 220;
    var clean = String(text || "").replace(/\s+/g, " ").trim();
    if (clean.length <= limit) return clean;
    return clean.slice(0, limit - 1).replace(/\s+\S*$/, "") + "…";
  }

  function nameList(agents, limit) {
    return (agents || []).slice(0, limit || 3).map(function (a) {
      return a && (a.name || a.id);
    }).filter(Boolean);
  }

  /** Spoken Today Voice Brief from sync state (opt-in TTS; not Jarvis). */
  function buildTodayBriefText(state) {
    state = state || {};
    var agents = Array.isArray(state.agents) ? state.agents : [];
    var rosterOnly = agents.filter(function (a) { return a && a.id !== "peer-floor"; });
    var workingAgents = rosterOnly.filter(function (a) {
      return a.status === "working" || a.status === "completed";
    });
    var waitingAgents = rosterOnly.filter(function (a) { return a.status === "waiting"; });
    var blockedAgents = rosterOnly.filter(function (a) { return a.status === "blocked"; });
    var parts = [];

    parts.push("The Stack brief.");

    var needs = Array.isArray(state.needsSeth) ? state.needsSeth.slice(0, 2) : [];
    if (needs.length) {
      parts.push(
        needs.length === 1
          ? "Needs your call: " + clipSpoken(needs[0].title || needs[0].summary || "Approval", 120) + "."
          : "Needs your call on " + needs.length + " items. First: " +
            clipSpoken(needs[0].title || needs[0].summary || "Approval", 100) + "."
      );
      var detail = needs[0].body || needs[0].reason || needs[0].summary || "";
      if (detail && detail !== needs[0].title) {
        var clippedDetail = clipSpoken(detail, 160);
        parts.push(/[.!?…]$/.test(clippedDetail) ? clippedDetail : clippedDetail + ".");
      }
      if (needs[0].owner) parts.push("Owner " + needs[0].owner + ".");
    } else {
      parts.push("No open Needs-Seth items.");
    }

    parts.push(
      workingAgents.length + " active, " +
      waitingAgents.length + " waiting, " +
      blockedAgents.length + " blocked."
    );

    if (blockedAgents.length) {
      parts.push("Blocked: " + nameList(blockedAgents, 4).join(", ") + ".");
    }
    if (waitingAgents.length) {
      parts.push("Waiting: " + nameList(waitingAgents, 4).join(", ") + ".");
    }
    if (workingAgents.length) {
      var bits = workingAgents.slice(0, 3).map(function (a) {
        var task = clipSpoken(a.activitySummary || a.task || "", 70);
        return task ? (a.name + " — " + task) : a.name;
      });
      parts.push("Active: " + bits.join("; ") + ".");
    }

    var conflicts = Array.isArray(state.conflicts) ? state.conflicts : [];
    if (conflicts.length) {
      parts.push(conflicts.length + " file conflict" + (conflicts.length === 1 ? "" : "s") + " on the board.");
    }

    var floorMsgs = (state.messagesBySlug && state.messagesBySlug["peer-floor"]) || [];
    var last = floorMsgs[floorMsgs.length - 1];
    if (last && last.body) {
      var floorBit = clipSpoken(last.body, 180);
      parts.push(
        "Peer floor: " + (last.auto === true ? "Stack automation" : (last.author || "Agent")) + " said " +
          (/[.!?…]$/.test(floorBit) ? floorBit : floorBit + ".")
      );
    }

    if (state.headCommit) {
      parts.push("Head " + String(state.headCommit).slice(0, 8) + ".");
    }

    return clipSpoken(parts.join(" "), 1180);
  }

  function statusLabel(status) {
    var key = String(status || "unknown").toLowerCase();
    if (key === "working") return "Working";
    if (key === "waiting") return "Waiting";
    if (key === "blocked") return "Blocked";
    if (key === "completed") return "Completed";
    if (key === "offline") return "Offline";
    if (key === "unknown") return "Status unconfirmed";
    return key;
  }

  function buildVoiceReplySpeakText(message, agent) {
    if (!message || !message.body) return "";
    var author = message.author || (agent && (agent.name || agent.id)) || "agent";
    var label = message.auto === true
      ? ("Automatic Stack reply for " + author)
      : ("Reply from " + author);
    return clipSpoken(label + ": " + message.body, 1180);
  }

  function voiceCallStateLabel(state) {
    var map = {
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
    return map[state] || String(state || "");
  }

  function buildAgentLatestText(agent, messagesBySlug) {
    if (!agent) return "";
    var slug = dmSlug(agent.id);
    var msgs = (messagesBySlug && messagesBySlug[slug]) || [];
    var last = msgs.filter(function (message) {
      return message && message.body && !message._typing && !/^seth$/i.test(message.author || "");
    }).pop();
    var head = (agent.name || agent.id) + " is " + statusLabel(agent.status) + ".";
    var activity = clipSpoken(agent.activitySummary || "", 120);
    var intro = head + (activity ? " " + activity + "." : "");
    if (!last) return clipSpoken(intro + (agent.evidence ? " Evidence " + agent.evidence + "." : ""), 1180);
    var author = last.author || agent.name || agent.id;
    var label = last.auto ? "Automatic Stack reply for " + author : "Latest from " + author;
    return clipSpoken(intro + " " + label + ": " + last.body, 1180);
  }

  function formatWaitDuration(iso, nowMs) {
    if (!iso) return "Unknown";
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return "Unknown";
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    var diff = Math.max(0, now - t);
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return mins + "m";
    var hrs = Math.floor(mins / 60);
    var remMins = mins % 60;
    if (hrs < 24) return remMins ? (hrs + "h " + remMins + "m") : (hrs + "h");
    var days = Math.floor(hrs / 24);
    var remHrs = hrs % 24;
    return remHrs ? (days + "d " + remHrs + "h") : (days + "d");
  }

  function classifyProviderUsage(prov, nowMs) {
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    if (!prov || typeof prov !== "object") {
      return {
        available: false,
        pct: null,
        stale: false,
        status: "unavailable",
        observedAt: "",
        resetAt: "",
        windowLabel: "",
        source: ""
      };
    }
    var rawPct = prov.pct_used !== undefined && prov.pct_used !== null ? prov.pct_used
      : (prov.pct !== undefined && prov.pct !== null ? prov.pct
      : (prov.used_pct !== undefined && prov.used_pct !== null ? prov.used_pct
      : (prov.usage_pct !== undefined && prov.usage_pct !== null ? prov.usage_pct
      : (prov.percent !== undefined && prov.percent !== null ? prov.percent
      : (typeof prov.used === "number" && typeof prov.limit === "number" && prov.limit > 0
        ? Math.round((prov.used / prov.limit) * 100) : null)))));
    var available = typeof rawPct === "number" && Number.isFinite(rawPct);
    var pct = available ? Math.max(0, Math.min(100, Math.round(rawPct))) : null;
    var observedAt = String(prov.quota_observed_at || prov.updated_at || "");
    var observedMs = Date.parse(observedAt);
    var resetAt = String(prov.reset_at || "");
    var resetMs = Date.parse(resetAt);
    var source = String(prov.quota_source || prov.source || "");
    var staleByFlag = prov.quota_stale === true;
    var staleByAge = !Number.isFinite(observedMs) || (now - observedMs > 2 * 3600000) || (observedMs - now > 300000);
    var staleByReset = Number.isFinite(resetMs) && resetMs <= now;
    var staleBySource = source !== "manual-ui" && source !== "live-api";
    var stale = available && (staleByFlag || staleByAge || staleByReset || staleBySource);
    return {
      available: available,
      pct: pct,
      stale: stale,
      status: !available ? "unavailable" : (stale ? "stale" : "fresh"),
      observedAt: observedAt,
      resetAt: resetAt,
      windowLabel: String(prov.window_label || prov.reset || ""),
      source: source
    };
  }

  function detectWakeDeliveryMode(wake, history, messages) {
    var hayParts = [];
    if (wake) {
      hayParts.push(wake.via, wake.delivery_mode, wake.note, wake.subject, wake.body);
      if (wake.manual_relay === true) return "manual_relay";
    }
    (history || []).forEach(function (ev) {
      if (ev && ev.note) hayParts.push(ev.note);
    });
    (messages || []).forEach(function (m) {
      if (m && m.body) hayParts.push(m.body);
    });
    var hay = hayParts.filter(Boolean).join(" ");
    if (/manual[\s_-]?relay|relayed manually/i.test(hay)) return "manual_relay";
    if (wake) {
      var via = String(wake.via || "").toLowerCase();
      if (via === "manual" || via === "manual_relay") return "manual_relay";
      if (via === "actions" || via === "peer_delivery" || (via === "local" && wake.status === "handled" && wake.handled_at)) {
        return "automatic_delivery";
      }
      if (wake.status === "open" || wake.status === "queued") return "queued";
    }
    return wake ? "queued" : "none";
  }

  function buildAssignmentTimeline(assignment, opts) {
    opts = opts || {};
    var a = assignment || {};
    var history = Array.isArray(a.history) ? a.history : [];
    var wakes = (Array.isArray(opts.wakes) ? opts.wakes : []).filter(function (w) {
      return w && w.assignment_id === a.id;
    });
    var messages = Array.isArray(opts.messages) ? opts.messages : [];
    var nameOf = typeof opts.nameOf === "function" ? opts.nameOf : function (id) { return id || "Unknown"; };

    var assignEv = history.find(function (e) { return e && e.action === "assign"; });
    var claimEv = history.find(function (e) { return e && e.action === "claim"; });
    var ackEv = history.find(function (e) { return e && e.action === "acknowledge"; });
    var submitEv = history.slice().reverse().find(function (e) { return e && e.action === "submit"; });
    var reviewEv = history.slice().reverse().find(function (e) { return e && e.action === "review"; });
    var failEv = history.slice().reverse().find(function (e) { return e && e.action === "fail"; });
    var cancelEv = history.slice().reverse().find(function (e) { return e && e.action === "cancel"; });

    var primaryWake = wakes[wakes.length - 1] || null;
    var deliveryMode = detectWakeDeliveryMode(primaryWake, history, messages);
    var wakeAt = (primaryWake && (primaryWake.created_at || primaryWake.updated_at)) || null;
    var isAcknowledged = Boolean(ackEv);

    var deliveryLabel = deliveryMode === "manual_relay" ? "Manual relay"
      : deliveryMode === "automatic_delivery" ? "Automatic delivery"
      : deliveryMode === "queued" ? "Wake queued (not proof of acknowledgement)"
      : "No wake recorded";

    var steps = [];
    steps.push({
      key: "assigned",
      label: "Assigned",
      state: assignEv || a.created_at ? "done" : "pending",
      at: (assignEv && assignEv.at) || a.created_at || null,
      detail: nameOf(a.sender) + " → " + nameOf(a.recipient) + (a.reviewer ? " · reviewer " + nameOf(a.reviewer) : ""),
      actor: a.sender || null
    });

    var wakeDetail = deliveryLabel;
    if (primaryWake && primaryWake.handled_by && primaryWake.handled_at) {
      wakeDetail += " · handled by " + primaryWake.handled_by;
    } else if (deliveryMode === "queued" && !isAcknowledged) {
      wakeDetail = "Wake queued — not proof " + nameOf(a.recipient) + " received or accepted the job";
    }
    steps.push({
      key: "wake",
      label: "Wake recorded",
      state: deliveryMode === "manual_relay" || deliveryMode === "automatic_delivery" ? "done"
        : deliveryMode === "queued" ? "queued" : "pending",
      deliveryMode: deliveryMode,
      at: wakeAt,
      detail: wakeDetail,
      actor: (primaryWake && (primaryWake.handled_by || primaryWake.from)) || null
    });

    var ackState = isAcknowledged ? "done" : (claimEv ? "waiting" : "pending");
    var ackDetail = isAcknowledged
      ? (nameOf(ackEv.actor || a.recipient) + " acknowledged" + (ackEv.session_id ? " (" + ackEv.session_id + ")" : ""))
      : claimEv
        ? (nameOf(claimEv.actor || a.recipient) + " picked up, but has not acknowledged yet")
        : "Not acknowledged yet";
    steps.push({
      key: "acknowledged",
      label: "Agent acknowledged",
      state: ackState,
      acknowledged: isAcknowledged,
      at: (ackEv && ackEv.at) || (claimEv && claimEv.at) || null,
      detail: ackDetail,
      actor: (ackEv && ackEv.actor) || (claimEv && claimEv.actor) || null
    });

    steps.push({
      key: "result",
      label: "Result arrived",
      state: submitEv ? "done" : (failEv ? "error" : "pending"),
      at: (submitEv && submitEv.at) || (failEv && failEv.at) || null,
      detail: submitEv
        ? (nameOf(submitEv.actor || a.recipient) + " submitted proof" + (a.evidence ? ": " + clipSpoken(a.evidence, 120) : ""))
        : failEv
          ? ("Attempt stopped" + (failEv.note ? ": " + failEv.note : ""))
          : "Waiting for result",
      actor: (submitEv && submitEv.actor) || (failEv && failEv.actor) || null
    });

    steps.push({
      key: "reviewed",
      label: "Reviewed",
      state: reviewEv ? "done" : (cancelEv ? "muted" : (a.status === "review_pending" ? "waiting" : "pending")),
      at: (reviewEv && reviewEv.at) || (cancelEv && cancelEv.at) || null,
      detail: reviewEv
        ? (nameOf(reviewEv.actor || a.reviewer) + (reviewEv.note ? " · " + reviewEv.note : " · review recorded"))
        : cancelEv
          ? ("Cancelled by " + nameOf(cancelEv.actor))
          : a.status === "review_pending"
            ? ("Awaiting independent review by " + nameOf(a.reviewer))
            : ("Pending review by " + nameOf(a.reviewer)),
      actor: (reviewEv && reviewEv.actor) || (cancelEv && cancelEv.actor) || null
    });

    var canRetry = ["failed", "interrupted", "timed_out", "retry_wait"].indexOf(a.status) !== -1;
    return {
      steps: steps,
      deliveryMode: deliveryMode,
      deliveryLabel: deliveryLabel,
      acknowledged: isAcknowledged,
      canRetry: canRetry,
      retrySummary: canRetry
        ? ("Re-issues \"" + (a.title || "Assignment") + "\" to " + nameOf(a.recipient) + " (reviewed by " + nameOf(a.reviewer) + ") using a deduplicated request key.")
        : ""
    };
  }

  function buildNeedsSethItems(appState, opts) {
    opts = opts || {};
    var now = typeof opts.nowMs === "number" ? opts.nowMs : Date.now();
    var nameOf = typeof opts.nameOf === "function" ? opts.nameOf : function (id) { return id || "Unknown"; };
    var overdueMs = typeof opts.overdueAckMs === "number" ? opts.overdueAckMs : 15 * 60000;
    var items = [];
    var seen = Object.create(null);

    function add(item) {
      if (!item || !item.id || seen[item.id]) return;
      seen[item.id] = true;
      items.push(item);
    }

    (appState && appState.needsSeth || []).forEach(function (n, idx) {
      if (!n || n.resolved) return;
      var id = "need-" + (n.key || n.id || idx);
      var since = n.created_at || n.updated_at || "";
      add({
        id: id,
        kind: "decision",
        title: n.title || n.summary || "Decision needed",
        whatHappened: n.body || n.reason || n.detail || "Waiting on your call in needs_seth.json",
        owner: n.owner || n.agent || "Team",
        ownerId: String(n.owner || n.agent || "peer-floor").toLowerCase().split(/[\s/]+/)[0],
        waitingSince: since,
        waitLabel: since ? formatWaitDuration(since, now) : "Waiting",
        nextAction: n.action || "Approve, hold, or reply in Team chat",
        severity: "amber",
        needPayload: n
      });
    });

    (appState && appState.assignments || []).forEach(function (a) {
      if (!a || !a.id) return;
      var ageMs = a.updated_at ? (now - Date.parse(a.updated_at)) : (a.created_at ? (now - Date.parse(a.created_at)) : 0);
      var since = a.updated_at || a.created_at || "";
      if (a.status === "review_pending") {
        add({
          id: "asg-" + a.id,
          kind: "assignment",
          assignmentId: a.id,
          assignmentStatus: a.status,
          title: a.title || "Assignment needs review",
          whatHappened: nameOf(a.recipient) + " submitted a result · awaiting " + nameOf(a.reviewer) + " review",
          owner: nameOf(a.reviewer) + " (from " + nameOf(a.recipient) + ")",
          ownerId: a.reviewer || a.recipient,
          waitingSince: since,
          waitLabel: since ? formatWaitDuration(since, now) : "Waiting",
          nextAction: "Open assignment to inspect proof & discussion",
          severity: "amber"
        });
      } else if (a.status === "failed" || a.status === "interrupted" || a.status === "timed_out") {
        add({
          id: "asg-" + a.id,
          kind: "assignment",
          assignmentId: a.id,
          assignmentStatus: a.status,
          title: a.title || "Blocked assignment",
          whatHappened: a.attention_reason || ("Job " + a.status.replace("_", " ") + " without a verified handoff"),
          owner: nameOf(a.recipient),
          ownerId: a.recipient,
          waitingSince: since,
          waitLabel: since ? formatWaitDuration(since, now) : "Waiting",
          nextAction: "Open to retry, reassign, or cancel",
          severity: "red"
        });
      } else if ((a.status === "assigned" || a.status === "received") && Number.isFinite(ageMs) && ageMs >= overdueMs) {
        add({
          id: "asg-" + a.id,
          kind: "assignment",
          assignmentId: a.id,
          assignmentStatus: a.status,
          title: a.title || "Overdue acknowledgement",
          whatHappened: a.status === "received"
            ? (nameOf(a.recipient) + " picked up the job, but has not acknowledged it")
            : ("Overdue acknowledgement · " + nameOf(a.recipient) + " has not picked this up yet"),
          owner: nameOf(a.recipient),
          ownerId: a.recipient,
          waitingSince: since,
          waitLabel: formatWaitDuration(since, now),
          nextAction: "Open assignment or reassign to another teammate",
          severity: "amber"
        });
      }
    });

    (appState && appState.items || []).forEach(function (w) {
      if (!w) return;
      var st = String(w.state || "").toLowerCase();
      if (w.blockedReason || st.indexOf("block") !== -1) {
        add({
          id: "work-" + w.id,
          kind: "blocked_work",
          workId: w.id,
          title: w.title || "Blocked work",
          whatHappened: w.blockedReason || w.blocker || "Blocked workstream needs unblock",
          owner: w.owner || "Team",
          ownerId: w.ownerId || "peer-floor",
          waitingSince: w.deadline || "",
          waitLabel: w.deadline ? ("Due " + w.deadline) : "Blocked",
          nextAction: "Open work item or chat owner",
          severity: "red"
        });
      }
    });

    var sevRank = { red: 0, amber: 1, green: 2, muted: 3 };
    return items.sort(function (a, b) {
      var sd = (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9);
      if (sd !== 0) return sd;
      return (Date.parse(a.waitingSince || "") || 0) - (Date.parse(b.waitingSince || "") || 0);
    });
  }

  var api = {
    AGENT_IDS: AGENT_IDS,
    parsePaletteQuery: parsePaletteQuery,
    dateWindowMs: dateWindowMs,
    detectConflicts: detectConflicts,
    connectionLabel: connectionLabel,
    connectionDot: connectionDot,
    resolveSurface: resolveSurface,
    nextTheme: nextTheme,
    toastRank: toastRank,
    enqueueToast: enqueueToast,
    dmSlug: dmSlug,
    buildPalette: buildPalette,
    actorsForCommit: actorsForCommit,
    clipSpoken: clipSpoken,
    buildTodayBriefText: buildTodayBriefText,
    buildAgentLatestText: buildAgentLatestText,
    buildVoiceReplySpeakText: buildVoiceReplySpeakText,
    voiceCallStateLabel: voiceCallStateLabel,
    formatWaitDuration: formatWaitDuration,
    classifyProviderUsage: classifyProviderUsage,
    detectWakeDeliveryMode: detectWakeDeliveryMode,
    buildAssignmentTimeline: buildAssignmentTimeline,
    buildNeedsSethItems: buildNeedsSethItems
  };

  root.StackPolish = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
