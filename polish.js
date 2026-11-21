/* The Stack v50.1 — pure helpers (no voice, no network).
 * Loaded as a classic script; also readable from Node tests via vm.
 */
(function (root) {
  "use strict";

  var AGENT_IDS = ["gemini", "chatgpt", "cursor", "claude", "grokbot", "nori"];
  var STATUSES = { working: 1, waiting: 1, blocked: 1, offline: 1, completed: 1 };

  var VIEWS = [
    { id: "today", title: "Today", keywords: "today view home brief" },
    { id: "agents", title: "Agents", keywords: "agents chats roster" },
    { id: "work", title: "Work", keywords: "work workstreams opportunities board" },
    { id: "stats", title: "Usage & Git", keywords: "usage stats git models" }
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

  /* A chat row is not a delivery receipt. The BFF currently confirms only
   * acceptance of a write; it has no adapter, acknowledgement, or QC event
   * contract. Keep this conservative mapping pure and fixture-testable. */
  function messageReceipt(message) {
    if (!message || message._typing) return null;
    var local = message._receipt || {};
    var author = String(message.author || "Agent");
    if (message._queued || local.state === "queued") return {
      state: "queued", label: "Locally queued",
      detail: "Only this browser's outbox has the message. Backend acceptance, adapter delivery, agent acknowledgement, and QC are unknown."
    };
    if (local.state === "pending") return {
      state: "pending", label: "Composed locally",
      detail: "No backend receipt yet. Adapter delivery, agent acknowledgement, and QC are unknown."
    };
    if (local.state === "backend-accepted") {
      var write = local.commit_sha ? " GitHub write " + local.commit_sha + " is recorded, but a write is not delivery." : "";
      return {
        state: "accepted", label: "Backend accepted",
        detail: "This browser received a BFF acceptance response." + write + " Adapter delivery, agent acknowledgement, and QC are unavailable."
      };
    }
    if (message.auto || local.state === "automated") {
      var provider = message.provider ? " via " + String(message.provider) : "";
      return {
        state: "automated", label: "Automated reply",
        detail: "This reply was generated by the Worker" + provider + ". It is not evidence that " + author + " received or acknowledged the message."
      };
    }
    return {
      state: "unavailable", label: "Receipt unavailable",
      detail: "No backend receipt fields are present. Backend acceptance, adapter delivery, agent acknowledgement, and QC are unknown."
    };
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
    messageReceipt: messageReceipt,
    buildPalette: buildPalette,
    actorsForCommit: actorsForCommit
  };

  root.StackPolish = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
