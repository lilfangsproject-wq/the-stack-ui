/* The Stack v50.1 — pure helpers (no mic / no network).
 * Includes opt-in Voice Brief text builders (speech is wired in app.js).
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

  function buildAgentLatestText(agent, messagesBySlug) {
    if (!agent) return "";
    var slug = dmSlug(agent.id);
    var msgs = (messagesBySlug && messagesBySlug[slug]) || [];
    var last = msgs[msgs.length - 1];
    var head = (agent.name || agent.id) + " is " + statusLabel(agent.status) + ".";
    var activity = clipSpoken(agent.activitySummary || "", 120);
    if (last && last.body) {
      return clipSpoken(
        head +
          (activity ? " " + activity + "." : "") +
          " Latest from " + (last.auto === true ? "Stack automation" : (last.author || agent.name || agent.id)) + ": " + last.body,
        1180
      );
    }
    return clipSpoken(
      head +
        (activity ? " " + activity + "." : "") +
        (agent.evidence ? " Evidence " + agent.evidence + "." : ""),
      1180
    );
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
    buildAgentLatestText: buildAgentLatestText
  };

  root.StackPolish = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
