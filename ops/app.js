/* Stack Ops — Control Room runtime ported into The Stack. No invented presence. */
(() => {
  const shell = window.OpsShell;
  const PIN_KEY = "stack-access-pin-v1";
  const BFF_KEY = "stack-bff-url-v1";
  const state = {
    snapshot: null,
    selectedAgentId: null,
    view: "overview",
    phase: "loading",
    route: shell.parseRoute(window.location.search),
    contentFilter: "ALL",
    selectedContentPath: null,
    csrf: "",
    bff: "",
    pin: "",
  };
  state.view = state.route.view;
  state.selectedAgentId = state.route.agent || null;

  const $ = (id) => document.getElementById(id);

  function loadStackCreds() {
    const defaultBff = (window.STACK_BFF_URL || "").replace(/\/$/, "");
    try {
      state.pin = localStorage.getItem(PIN_KEY) || "";
      let savedBff = (localStorage.getItem(BFF_KEY) || "").replace(/\/$/, "");
      if (!savedBff || /cooked-barracuda/i.test(savedBff)) savedBff = defaultBff;
      state.bff = savedBff || defaultBff;
    } catch {
      state.pin = "";
      state.bff = defaultBff;
    }
  }

  function errorText(value, fallback) {
    if (typeof value === "string" && value.trim() && value !== "[object Object]") return value;
    if (value && typeof value === "object") {
      if (typeof value.message === "string" && value.message.trim() && value.message !== "[object Object]") {
        return value.message;
      }
    }
    return fallback;
  }

  function safePct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  function safeColor(value) {
    const color = String(value || "").trim();
    return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : "#a855ff";
  }

  async function api(path, options = {}) {
    loadStackCreds();
    if (!state.bff || !state.pin) {
      const err = new Error("Unlock The Stack with your PIN first, then open Ops.");
      err.code = "stack_unlock_required";
      throw err;
    }
    // Map Control Room paths → Stack BFF /api/ops/*
    let opsPath = path;
    if (opsPath === "/api/session") opsPath = "/api/ops/session";
    else if (opsPath === "/api/snapshot") opsPath = "/api/ops/snapshot";
    else if (opsPath === "/api/agents") opsPath = "/api/ops/agents";
    else if (opsPath === "/api/activity" || opsPath.startsWith("/api/activity?")) {
      opsPath = opsPath.replace("/api/activity", "/api/ops/activity");
    } else if (opsPath.startsWith("/api/content")) {
      opsPath = opsPath.replace("/api/content", "/api/ops/content");
    } else if (opsPath.startsWith("/api/agents/")) {
      opsPath = opsPath.replace("/api/agents/", "/api/ops/agents/");
    }
    const headers = {
      Accept: "application/json",
      "x-stack-pin": state.pin,
      ...(options.headers || {}),
    };
    if (String(options.method || "GET").toUpperCase() === "POST") {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(state.bff + opsPath, { ...options, headers });
    const data = await res.json().catch(() => ({ ok: false, error: "bad_json" }));
    if (!res.ok || data.ok === false) {
      const err = new Error(errorText(data && data.error, errorText(res.statusText, "request_failed")));
      err.payload = data;
      throw err;
    }
    return data;
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    try {
      return (
        new Date(iso).toLocaleString("en-AU", {
          timeZone: "Australia/Perth",
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }) + " AWST"
      );
    } catch {
      return iso;
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function tickClock() {
    const clock = $("clock");
    if (!clock) return;
    clock.textContent = new Date().toLocaleTimeString("en-AU", {
      timeZone: "Australia/Perth",
      hour12: false,
    });
  }

  function syncRoute() {
    const search = shell.buildSearch(state.route);
    const url = new URL(window.location.href);
    const next = search.charAt(0) === "?" ? search.slice(1) : search;
    if (url.searchParams.toString() === next) return;
    url.search = next;
    window.history.replaceState({}, "", url);
  }

  function setView(view) {
    if (shell.VIEWS.indexOf(view) === -1) view = "overview";
    state.view = view;
    state.route.view = view;
    document.querySelectorAll(".pill-nav .pill, .bottom-nav .pill").forEach((btn) => {
      const on = btn.dataset.view === view;
      btn.classList.toggle("active", on);
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    document.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.classList.toggle("hidden", panel.dataset.panel !== view);
    });
    syncRoute();
  }

  function showBoot(show) {
    $("boot").classList.toggle("hidden", !show);
    $("app").classList.toggle("hidden", show);
    $("bottom-nav").classList.toggle("hidden", show);
  }

  function isFixture() {
    return !!(state.snapshot && state.snapshot.data_class === "illustrative_fixture");
  }

  function paintConnection() {
    const copy = shell.connectionCopy(state.phase, location.hostname);
    let title = copy.title;
    let tone = copy.tone;
    if (isFixture() && state.phase === "live") {
      title = "Fixture · loopback";
      tone = "fixture";
    }
    $("boot-title").textContent = title;
    $("boot-lede").textContent = copy.detail;
    $("boot-retry").classList.toggle("hidden", state.phase === "loading");
    $("boot-open-local").classList.toggle("hidden", !copy.linkLocal);
    const chip = $("link-chip");
    chip.className = "link-chip " + tone;
    const labels = {
      live: "LIVE VAULT",
      fixture: "FIXTURE",
      stale: "LAST READ",
      pending: "CHECKING",
      offline: "OFFLINE",
    };
    chip.textContent = labels[tone] || "OFFLINE";
    const banner = $("status-banner");
    banner.hidden = state.phase !== "stale";
    banner.className = "status-banner stale";
    banner.textContent = "";
    if (state.phase === "stale") {
      const text = document.createElement("span");
      text.textContent = copy.detail + " ";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "ghost";
      retry.id = "banner-retry";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        refresh();
      });
      const forget = document.createElement("button");
      forget.type = "button";
      forget.className = "ghost";
      forget.textContent = "Forget last read";
      forget.addEventListener("click", forgetLastRead);
      banner.append(text, retry, forget);
    }
    $("fixture-banner").classList.toggle("hidden", !isFixture());
    if (state.phase === "offline") {
      $("boot-status").textContent = copy.detail;
    }
  }

  function remember(snap) {
    try {
      sessionStorage.setItem(shell.lastReadKey(), JSON.stringify(snap));
    } catch {
      /* quota or blocked storage */
    }
  }

  function readRemembered() {
    try {
      const raw = sessionStorage.getItem(shell.lastReadKey());
      if (!raw) return null;
      const snap = JSON.parse(raw);
      return snap && Array.isArray(snap.agents) ? snap : null;
    } catch {
      return null;
    }
  }

  function forgetLastRead() {
    try {
      sessionStorage.removeItem(shell.lastReadKey());
    } catch {
      /* ignore */
    }
    state.snapshot = null;
    state.phase = "offline";
    showBoot(true);
    paintConnection();
  }

  function readDraft(agentId) {
    try {
      const raw = sessionStorage.getItem(shell.draftKey(agentId));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveDraft() {
    const agentId = $("msg-agent").value;
    const payload = {
      job: $("msg-job").value,
      task: $("msg-task").value,
      output: $("msg-output").value,
    };
    try {
      sessionStorage.setItem(shell.draftKey(agentId), JSON.stringify(payload));
    } catch {
      /* ignore */
    }
    state.route.agent = agentId || "";
    state.route.job = payload.job || "";
    state.selectedAgentId = agentId || null;
    syncRoute();
    showQuote();
  }

  function selectValue(select, value) {
    if (!value) return;
    const has = Array.from(select.options).some((option) => option.value === value);
    if (has) select.value = value;
  }

  function agentById(agentId) {
    return ((state.snapshot && state.snapshot.agents) || []).find((agent) => agent.id === agentId) || null;
  }

  function describeRecipient(agent) {
    if (!agent) return;
    $("delivery-note").textContent =
      agent.kind === "persona"
        ? "Hermes is a Control Room persona operated by Cursor. This appends a vault inbox handover. It does not reach the Mac Hermes runtime. Ack stays pending until a recipient writes it."
        : `Recipient: ${agent.name} · Delivery: vault inbox append · Ack: pending until ${agent.name} responds`;
  }

  function showQuote() {
    const el = $("handover-quote");
    const job = $("msg-job").value.trim();
    const agentId = $("msg-agent").value;
    const found = ((state.snapshot && state.snapshot.open_handovers) || []).find(
      (item) => item.agent_id === agentId && item.job === job
    );
    if (!found) {
      el.classList.add("hidden");
      el.textContent = "";
      return;
    }
    el.classList.remove("hidden");
    el.textContent = `Existing handover · ${found.job || ""} · ${found.status || "open"} · ${found.task || ""}`;
  }

  function lockComposer(locked) {
    const form = $("message-form");
    form.classList.toggle("is-locked", locked);
    form.querySelectorAll("input, textarea, select, button").forEach((el) => {
      el.disabled = locked;
    });
    if (locked) {
      $("delivery-note").textContent = "Writes are off until the loopback server answers. An inbox append is not a runtime ping.";
    }
  }

  function sparkHtml(values, accent) {
    const max = Math.max(1, ...values);
    const color = safeColor(accent);
    return values
      .map((v, i) => {
        const daysAgo = values.length - 1 - i;
        const label = daysAgo === 0 ? "today" : `${daysAgo}d ago`;
        const h = Math.max(4, Math.round((v / max) * 26));
        return `<i title="${escapeHtml(label)}: ${escapeHtml(v)}" style="height:${h}px;background:${color}"></i>`;
      })
      .join("");
  }

  function renderOverview(snap) {
    const ov = snap.overview || {};
    $("uplink-label").textContent = ov.uplink || "UPLINK —";
    const directive = ov.directive;
    const actions = $("directive-actions");
    actions.textContent = "";
    if (directive) {
      $("directive-title").textContent =
        [directive.agent, directive.job || directive.heading].filter(Boolean).join(" · ") || "Open handover";
      $("directive-body").textContent = directive.task || directive.status || "";
      if (directive.agent_id) {
        const follow = document.createElement("button");
        follow.type = "button";
        follow.className = "primary";
        follow.id = "open-followup";
        follow.textContent = "Compose inbox follow-up";
        follow.addEventListener("click", () => openHandover(directive.agent_id, directive.job || ""));
        const show = document.createElement("button");
        show.type = "button";
        show.className = "ghost";
        show.id = "show-task";
        show.textContent = "Show on task board";
        show.addEventListener("click", () => {
          state.route.job = directive.job || "";
          state.route.view = "tasks";
          setView("tasks");
          renderBoard(snap.board || { pending: [], in_progress: [], done: [], counts: {} });
        });
        actions.append(follow, show);
      }
    } else {
      $("directive-title").textContent = "No open handover";
      $("directive-body").textContent = "Vault inbox is quiet.";
    }

    $("vault-bars").innerHTML = (ov.vault_health || [])
      .map(
        (b) => `
      <div class="vault-bar">
        <div class="lbl"><span>${escapeHtml(b.label)}</span><span>${escapeHtml(String(b.value))} · ${escapeHtml(b.detail || "")}</span></div>
        <div class="track"><span style="width:${Math.max(4, safePct(b.pct))}%"></span></div>
      </div>`
      )
      .join("");

    const quick = ov.quick || {};
    const sourceLabel = snap.data_class === "illustrative_fixture" ? "fixture" : "vault";
    $("quick-row").innerHTML = [
      ["QUEUE", quick.queue],
      ["SESSIONS", quick.sessions],
      ["SOURCE", sourceLabel],
      ["TODAY", quick.today],
      ["WEEK", quick.week],
    ]
      .map(
        ([lbl, val]) => `
      <div class="quick-chip"><div class="lbl">${lbl}</div><div class="val">${escapeHtml(String(val ?? "—"))}</div></div>`
      )
      .join("");

    $("kpi-row").innerHTML = (ov.kpis || [])
      .map(
        (k) => `
      <div class="kpi-card tone-${escapeHtml(k.tone || "violet")}">
        <div class="lbl">${escapeHtml(k.label)}</div>
        <div class="val">${escapeHtml(k.value)}</div>
        <p class="detail">${escapeHtml(k.detail || "")}</p>
      </div>`
      )
      .join("");

    const thr = ov.throughput || { series: [], total: 0 };
    $("throughput-title").textContent = `${thr.total || 0} memory events · 7d`;
    const counts = (thr.series || []).map((item) => item.count || 0).join(", ");
    const peak = thr.peak ? `Most active day — ${thr.peak.day} — ${thr.peak.count} events. ` : "";
    $("throughput-peak").textContent = counts ? `${peak}14-day counts: ${counts}.` : thr.label || peak;
    drawThroughput(thr.series || []);

    renderFeed(
      $("overview-feed"),
      ov.feed || [],
      (ev) => `
        <div class="meta"><span>${escapeHtml(ev.agent || "?")}</span><span class="tag-done">${escapeHtml(ev.kind || "")}</span><span>${escapeHtml(fmtTime(ev.at))}</span></div>
        <p class="body">${escapeHtml(ev.text || "")}</p>
      `
    );
  }

  function drawThroughput(series) {
    const canvas = $("throughput-canvas");
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 640;
    const h = 160;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!series.length) return;
    const max = Math.max(1, ...series.map((s) => s.count || 0));
    const pad = 8;
    ctx.beginPath();
    series.forEach((s, i) => {
      const x = pad + (i / Math.max(1, series.length - 1)) * (w - pad * 2);
      const y = h - pad - ((s.count || 0) / max) * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(34,211,238,0.45)";
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineTo(pad + (w - pad * 2), h - pad);
    ctx.lineTo(pad, h - pad);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "rgba(34,211,238,0.25)");
    grad.addColorStop(1, "rgba(34,211,238,0)");
    ctx.fillStyle = grad;
    ctx.fill();
  }

  function renderAgents(agents) {
    const grid = $("agent-grid");
    grid.innerHTML = "";
    agents.forEach((agent, i) => {
      const accent = safeColor(agent.accent);
      const lastText =
        (agent.last_activity && agent.last_activity.text) ||
        agent.presence.evidence ||
        "No recent evidence";
      const rate =
        agent.done_jobs + agent.open_jobs > 0
          ? `${Math.round((100 * agent.done_jobs) / (agent.done_jobs + agent.open_jobs))}%`
          : "—";
      const card = document.createElement("article");
      card.className = "agent-card";
      card.style.setProperty("--accent-local", accent);
      card.style.animationDelay = `${i * 40}ms`;
      card.innerHTML = `
        <div class="card-top">
          <span class="abbr">${escapeHtml(agent.abbr || agent.name.slice(0, 4).toUpperCase())}</span>
          <span class="platform-chip">${escapeHtml(agent.platform || "vault")}</span>
        </div>
        <div class="card-top">
          <h3>${escapeHtml(agent.name)}</h3>
          <span class="presence-badge ${escapeHtml(agent.presence.state)}" title="${escapeHtml(agent.presence.evidence || "")}">${escapeHtml(agent.presence.label)}</span>
        </div>
        <p class="role">${escapeHtml(agent.role || "")}</p>
        ${
          agent.kind === "persona"
            ? `<p class="persona-line">${escapeHtml(agent.persona_label || "Control Room persona · operated by Cursor")}</p>`
            : ""
        }
        <p class="spark-label">7-day memory events</p>
        <div class="spark">${sparkHtml(agent.sparkline_7d || [0, 0, 0, 0, 0, 0, 0], accent)}</div>
        <div class="metrics">
          <div class="metric"><div class="lbl">Events 7d</div><div class="val">${escapeHtml(agent.memory_events_7d || 0)}</div></div>
          <div class="metric"><div class="lbl">Inbox done</div><div class="val ${rate !== "—" ? "ok" : ""}">${escapeHtml(rate)}</div></div>
          <div class="metric"><div class="lbl">Model</div><div class="val">${escapeHtml(agent.model || "—")}</div></div>
        </div>
        <div class="card-foot">
          <strong>${escapeHtml(lastText.slice(0, 90))}</strong>
          <span>${escapeHtml(agent.last_relative || "no recent memory")}</span>
        </div>
        <button type="button" class="card-action">Open conversation</button>
      `;
      const open = () => {
        state.route.agent = agent.id;
        state.route.job = "";
        state.selectedAgentId = agent.id;
        setView("message");
        applyRouteToForm();
      };
      card.querySelector(".card-action").addEventListener("click", (ev) => {
        ev.stopPropagation();
        open();
      });
      card.addEventListener("click", open);
      grid.appendChild(card);
    });
  }

  function renderCounts(stats) {
    const hint =
      stats.activity_basis || "Recent activity is shared-memory evidence, not a live connection.";
    const hintEl = $("presence-hint");
    if (hintEl) hintEl.textContent = hint;
    $("count-pills").innerHTML = `
      <span class="count-pill active" title="${escapeHtml(hint)}"><b>RECENT ACTIVITY</b> ${escapeHtml(stats.active ?? 0)}</span>
      <span class="count-pill idle"><b>NO RECENT ACTIVITY</b> ${escapeHtml(stats.idle ?? 0)}</span>
      <span class="count-pill dormant"><b>DORMANT</b> ${escapeHtml(stats.dormant ?? 0)}</span>
    `;
  }

  function renderStats(stats) {
    const tiles = [
      { lbl: "Memory events today", num: stats.tasks_today ?? 0, pct: Math.min(100, (stats.tasks_today || 0) * 4) },
      { lbl: "Memory events 7d", num: stats.tasks_week ?? 0, pct: Math.min(100, (stats.tasks_week || 0) * 2) },
      { lbl: "Most active (7d)", num: stats.most_active || "—", pct: stats.most_active ? 72 : 8 },
      {
        lbl: "Inbox entries marked done",
        num: stats.inbox_counted > 0 ? `${stats.inbox_done}/${stats.inbox_counted}` : "—",
        pct: stats.success_rate == null ? 8 : stats.success_rate,
      },
    ];
    $("stat-tiles").innerHTML = tiles
      .map(
        (t) => `
      <div class="stat-tile">
        <div class="lbl">${t.lbl}</div>
        <div class="num">${escapeHtml(String(t.num))}</div>
        <div class="bar"><span style="width:${safePct(t.pct)}%"></span></div>
      </div>`
      )
      .join("");
    $("stats-hint").textContent = stats.success_rate_basis
      ? `Memory events + ${stats.success_rate_basis}`
      : "Counts from shared memory events";
  }

  function drawDonut(distribution) {
    const canvas = $("dist-canvas");
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 180 * dpr;
    canvas.height = 180 * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, 180, 180);
    const total = distribution.reduce((s, d) => s + (d.count || 0), 0) || 1;
    let start = -Math.PI / 2;
    distribution.forEach((d) => {
      const slice = ((d.count || 0) / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(90, 90);
      ctx.arc(90, 90, 68, start, start + Math.max(slice, 0.02));
      ctx.closePath();
      ctx.fillStyle = safeColor(d.accent);
      ctx.globalAlpha = d.count ? 0.95 : 0.2;
      ctx.fill();
      start += Math.max(slice, 0.02);
    });
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.fillStyle = "#12121a";
    ctx.arc(90, 90, 42, 0, Math.PI * 2);
    ctx.fill();
    $("dist-legend").innerHTML = distribution
      .slice(0, 6)
      .map(
        (d) =>
          `<li><span><span class="swatch" style="background:${safeColor(d.accent)}"></span><span class="name">${escapeHtml(d.name)}</span></span><span>${escapeHtml(String(d.percent))}%</span></li>`
      )
      .join("");
  }

  function renderBoard(board) {
    const cols = [
      ["pending", "Pending", board.pending || []],
      ["in_progress", "In progress", board.in_progress || []],
      ["done", "Done", board.done || []],
    ];
    const kanban = $("kanban");
    kanban.innerHTML = "";
    cols.forEach(([key, label, items]) => {
      const col = document.createElement("div");
      col.className = "kanban-col glass";
      const heading = document.createElement("h3");
      heading.innerHTML = `${escapeHtml(label)} <b>${escapeHtml((board.counts && board.counts[key]) || items.length)}</b>`;
      col.appendChild(heading);
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "item";
        empty.innerHTML = `<p class="body">Nothing here.</p>`;
        col.appendChild(empty);
      }
      items.forEach((card) => {
        const active = state.route.job && card.job === state.route.job;
        const node = document.createElement(card.agent_id ? "button" : "article");
        node.className = "item" + (active ? " active" : "");
        if (card.agent_id) node.type = "button";
        node.innerHTML = `
          <div class="meta"><span>${escapeHtml(card.agent || "")}</span><span>${escapeHtml(card.status || "")}</span></div>
          <p class="title">${escapeHtml(card.job || card.heading || "")}</p>
          <p class="body">${escapeHtml((card.task || "").slice(0, 180))}</p>
          ${card.agent_id ? `<p class="hint">Compose follow-up</p>` : ""}
        `;
        if (card.agent_id) {
          node.addEventListener("click", () => openHandover(card.agent_id, card.job || ""));
        }
        col.appendChild(node);
      });
      kanban.appendChild(col);
    });
  }

  function renderSchedule(schedule) {
    $("schedule-note").textContent = schedule.note || "Queue stays disabled.";
    $("schedule-hint").textContent =
      schedule.enabled === false
        ? `${schedule.job_count || 0} historical jobs · queue OFF`
        : "Schedule status unknown";
    const groups = schedule.groups || [];
    $("schedule-groups").innerHTML = groups.length
      ? groups
          .map(
            (g) => `
        <div class="schedule-group glass">
          <h3>${escapeHtml(g.cadence)} · ${escapeHtml(g.count ?? 0)}</h3>
          ${(g.jobs || [])
            .map(
              (j) => `
            <div class="schedule-job">
              <div>
                <code>${escapeHtml(j.id || "")}</code>
                <div class="hint">${escapeHtml(j.assistant || "")} → ${escapeHtml(j.task || "")}</div>
              </div>
              <span>${escapeHtml(j.status || "")}</span>
            </div>`
            )
            .join("")}
        </div>`
          )
          .join("")
      : `<div class="schedule-group glass"><p class="body">No queue jobs found.</p></div>`;
  }

  function renderContent(list) {
    const agents = ["ALL", ...new Set(list.map((d) => d.agent).filter(Boolean))];
    $("content-filters").innerHTML = agents
      .map(
        (a) =>
          `<button type="button" class="pill ${state.contentFilter === a ? "active" : ""}" data-filter="${escapeHtml(a)}">${escapeHtml(a)}</button>`
      )
      .join("");
    $("content-filters").querySelectorAll("[data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.contentFilter = btn.dataset.filter;
        renderContent(list);
      });
    });
    const filtered = state.contentFilter === "ALL" ? list : list.filter((d) => d.agent === state.contentFilter);
    $("content-items").innerHTML = filtered
      .map(
        (d) => `
      <button type="button" class="content-item ${state.selectedContentPath === d.path ? "active" : ""}" data-path="${escapeHtml(d.path)}">
        <div class="meta">${escapeHtml(d.agent || "")} · ${escapeHtml(fmtTime(d.mtime))}</div>
        <strong>${escapeHtml(d.title || d.name)}</strong>
      </button>`
      )
      .join("");
    $("content-items").querySelectorAll("[data-path]").forEach((btn) => {
      btn.addEventListener("click", () => loadContent(btn.dataset.path));
    });
  }

  async function loadContent(path) {
    state.selectedContentPath = path;
    state.route.path = path;
    state.route.view = "content";
    syncRoute();
    $("content-retry").classList.add("hidden");
    $("content-meta").textContent = path;
    $("content-title").textContent = "Loading…";
    $("content-body").textContent = "";
    try {
      const data = await api(`/api/content?path=${encodeURIComponent(path)}`);
      const doc = data.document;
      $("content-title").textContent = doc.name;
      $("content-meta").textContent = `${doc.path} · ${fmtTime(doc.mtime)}${doc.truncated ? " · truncated" : ""}`;
      $("content-body").textContent = doc.text;
      if (state.snapshot) renderContent(state.snapshot.content || []);
    } catch (err) {
      $("content-title").textContent = "Failed to load";
      $("content-body").textContent = err.message || "error";
      $("content-retry").classList.remove("hidden");
    }
  }

  function renderFeed(el, items, mapper) {
    el.innerHTML = "";
    if (!items.length) {
      el.innerHTML = `<div class="item"><p class="body">Nothing here yet.</p></div>`;
      return;
    }
    items.forEach((item, i) => {
      const node = document.createElement("article");
      node.className = "item";
      node.style.animationDelay = `${i * 20}ms`;
      node.innerHTML = mapper(item);
      el.appendChild(node);
    });
  }

  function fillMessageAgents(agents) {
    const select = $("msg-agent");
    const current = select.value;
    select.innerHTML = "";
    agents
      .filter((a) => a.active)
      .forEach((a) => {
        const opt = document.createElement("option");
        opt.value = a.id;
        opt.textContent = a.name;
        select.appendChild(opt);
      });
    selectValue(select, state.selectedAgentId || current);
  }

  function renderChatThread(agent) {
    const entries = (agent && agent.recent_inbox) || [];
    renderFeed(
      $("chat-thread"),
      entries.slice().reverse(),
      (e) => `
        <div class="meta"><span>${escapeHtml(e.from || "inbox")}</span><span>${escapeHtml(e.status || "")}</span></div>
        <p class="title">${escapeHtml(e.job || e.heading || "")}</p>
        <p class="body">${escapeHtml(e.task || e.snippet || "")}</p>
      `
    );
  }

  function applyRouteToForm() {
    const agentId = state.route.agent || state.selectedAgentId || $("msg-agent").value;
    selectValue($("msg-agent"), agentId);
    state.selectedAgentId = $("msg-agent").value || null;
    const draft = readDraft(state.selectedAgentId);
    if (state.route.job) $("msg-job").value = state.route.job;
    else if (draft && draft.job) $("msg-job").value = draft.job;
    if (draft && draft.task && !$("msg-task").value) $("msg-task").value = draft.task;
    if (draft && draft.output && !$("msg-output").value) $("msg-output").value = draft.output;
    state.route.agent = state.selectedAgentId || "";
    const agent = agentById(state.selectedAgentId);
    describeRecipient(agent);
    if (agent) renderChatThread(agent);
    showQuote();
  }

  function openHandover(agentId, job) {
    state.route.agent = agentId || "";
    state.route.job = job || "";
    state.route.view = "message";
    state.selectedAgentId = agentId || null;
    setView("message");
    applyRouteToForm();
    $("msg-job").value = job || "";
    state.route.job = $("msg-job").value;
    saveDraft();
    if (! $("msg-task").disabled) $("msg-task").focus();
  }

  function updateChrome(snap) {
    const stats = snap.stats || {};
    const sys = $("sys-pill");
    $("sys-label").textContent = stats.systems_label || "STATUS UNKNOWN";
    sys.classList.toggle("warn", !stats.systems_ok);
    const fixture = snap.data_class === "illustrative_fixture";
    $("mode-chip").textContent =
      state.phase === "live" ? (fixture ? "mode fixture" : "mode live") : state.phase === "stale" ? "mode last read" : "mode offline";
    $("mem-chip").textContent = `memory r${snap.memory_revision ?? "—"}`;
    const prefix = state.phase === "stale" ? "Last read " : "Generated ";
    $("generated-at").textContent = prefix + fmtTime(snap.generated_at);
    if (snap.app_version) $("version-tag").textContent = "V" + snap.app_version;
  }

  function applySnapshot(snap) {
    state.snapshot = snap;
    updateChrome(snap);
    setView(state.route.view || "overview");
    renderOverview(snap);
    renderCounts(snap.stats || {});
    renderAgents(snap.agents || []);
    renderStats(snap.stats || {});
    drawDonut((snap.stats && snap.stats.distribution) || []);
    renderBoard(snap.board || { pending: [], in_progress: [], done: [], counts: {} });
    renderSchedule(snap.schedule || {});
    renderContent(snap.content || []);
    fillMessageAgents(snap.agents || []);
    applyRouteToForm();
    lockComposer(!shell.writesEnabled(state.phase));
    const openN = (snap.open_handovers || []).length;
    const countEl = $("tasks-count");
    if (countEl) countEl.textContent = openN ? String(openN) : "";
    $("tasks-hint").textContent = `${openN} open inbox items · kanban from vault statuses`;
    if (state.route.view === "content" && state.route.path && state.selectedContentPath !== state.route.path) {
      loadContent(state.route.path);
    }
    paintConnection();
  }

  async function ensureSession() {
    const data = await api("/api/session");
    state.csrf = data.csrf || "";
  }

  async function refresh() {
    const hadSnapshot = !!state.snapshot;
    $("refresh-btn").setAttribute("aria-busy", "true");
    try {
      await ensureSession();
      const data = await api("/api/snapshot");
      state.phase = "live";
      remember(data.snapshot);
      showBoot(false);
      applySnapshot(data.snapshot);
    } catch (err) {
      const cached = hadSnapshot ? state.snapshot : readRemembered();
      if (cached && Array.isArray(cached.agents)) {
        state.phase = "stale";
        showBoot(false);
        applySnapshot(cached);
      } else {
        state.phase = "offline";
        state.snapshot = null;
        showBoot(true);
        paintConnection();
        $("boot-status").textContent = errorText(err && err.message, shell.connectionCopy("offline").detail);
      }
    } finally {
      $("refresh-btn").setAttribute("aria-busy", "false");
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    const status = $("msg-status");
    status.className = "form-status";
    if (!shell.writesEnabled(state.phase)) {
      status.className = "form-status err";
      status.textContent = "Writes are off until the Stack BFF answers.";
      return;
    }
    status.textContent = "Sending…";
    const agentId = $("msg-agent").value;
    const job = $("msg-job").value.trim();
    const task = $("msg-task").value.trim();
    const output = $("msg-output").value.trim() || "ack in inbox / shared memory";
    try {
      const result = await api(`/api/agents/${encodeURIComponent(agentId)}/message`, {
        method: "POST",
        body: JSON.stringify({ job, task, output, from: "Seth-via-Stack-Ops" }),
      });
      status.className = "form-status ok";
      status.textContent = result.deduped
        ? `Already in ${result.path}. Vault append only. Ack pending.`
        : `Appended to ${result.path}. Vault append only — not a live runtime ping. Ack pending.`;
      $("msg-task").value = "";
      try {
        sessionStorage.removeItem(shell.draftKey(agentId));
      } catch {
        /* ignore */
      }
      await refresh();
      setView("message");
    } catch (err) {
      status.className = "form-status err";
      status.textContent = err.message || "Send failed";
    }
  }

  function bind() {
    document.querySelectorAll(".pill-nav .pill, .bottom-nav .pill").forEach((btn) => {
      btn.addEventListener("click", () => setView(btn.dataset.view));
    });
    $("refresh-btn").addEventListener("click", () => {
      refresh();
    });
    $("message-form").addEventListener("submit", sendMessage);
    ["msg-job", "msg-task", "msg-output"].forEach((id) => {
      $(id).addEventListener("input", saveDraft);
    });
    $("msg-agent").addEventListener("change", () => {
      const agentId = $("msg-agent").value;
      state.selectedAgentId = agentId;
      state.route.agent = agentId;
      const draft = readDraft(agentId);
      $("msg-job").value = (draft && draft.job) || "";
      $("msg-task").value = (draft && draft.task) || "";
      $("msg-output").value = (draft && draft.output) || "";
      state.route.job = $("msg-job").value;
      syncRoute();
      const agent = agentById(agentId);
      describeRecipient(agent);
      if (agent) renderChatThread(agent);
      showQuote();
    });
    $("content-retry").addEventListener("click", () => {
      if (state.route.path) loadContent(state.route.path);
    });
    const openStack = $("boot-open-local");
    if (openStack) {
      openStack.setAttribute("href", "../");
      openStack.textContent = "Open The Stack";
      openStack.classList.remove("hidden");
    }
    $("boot-retry").addEventListener("click", () => {
      $("boot-status").textContent = "Checking Stack BFF…";
      refresh();
    });
    const back = $("back-to-stack");
    if (back) {
      back.addEventListener("click", (e) => {
        e.preventDefault();
        window.location.href = "../";
      });
    }
    window.addEventListener("resize", () => {
      if (state.snapshot && state.snapshot.overview) {
        drawThroughput(state.snapshot.overview.throughput.series || []);
      }
    });
  }

  loadStackCreds();
  bind();
  tickClock();
  setInterval(tickClock, 1000);
  setView(state.view);
  paintConnection();
  refresh();
  // Do not register a separate service worker — Stack shell owns SW.
})();
