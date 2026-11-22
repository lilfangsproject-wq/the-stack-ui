/* Route and connection copy for Stack Ops (Control Room runtime port). */
(function (root) {
  const VIEWS = ["overview", "agents", "tasks", "schedule", "content", "message"];

  function isLoopbackHost(hostname) {
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  }

  function parseRoute(search) {
    const raw = String(search || "");
    const params = new URLSearchParams(raw.charAt(0) === "?" ? raw.slice(1) : raw);
    let view = params.get("view") || "overview";
    if (VIEWS.indexOf(view) === -1) view = "overview";
    return {
      view: view,
      agent: params.get("agent") || "",
      path: params.get("path") || "",
      job: params.get("job") || "",
    };
  }

  function buildSearch(route) {
    const current = route || {};
    let view = current.view || "overview";
    if (VIEWS.indexOf(view) === -1) view = "overview";
    const params = new URLSearchParams();
    params.set("view", view);
    if (current.agent) params.set("agent", current.agent);
    if (current.path) params.set("path", current.path);
    if (current.job) params.set("job", current.job);
    return "?" + params.toString();
  }

  function connectionCopy(phase) {
    if (phase === "loading") {
      return {
        tone: "pending",
        title: "Reading the vault via Stack BFF",
        detail: "Unlock The Stack first (same PIN). Queue stays off. A successful read is still not a live agent session.",
        linkLocal: false,
      };
    }
    if (phase === "live") {
      return {
        tone: "live",
        title: "Live vault · Stack cloud",
        detail: "Source: /api/ops/snapshot on the Stack BFF (GitHub SoT). Inbox writes append to Dispatch/Inbox only — not a runtime ping.",
        linkLocal: false,
      };
    }
    if (phase === "stale") {
      return {
        tone: "stale",
        title: "Disconnected · last read only",
        detail: "The BFF did not answer. This is the last successful read in this tab, not a live vault. Writes are off.",
        linkLocal: false,
      };
    }
    return {
      tone: "offline",
      title: "Stack unlock required",
      detail: "Open The Stack, enter your PIN, then reopen Ops. Same credentials power this Control Room runtime.",
      linkLocal: false,
    };
  }

  function writesEnabled(phase) {
    return phase === "live";
  }

  function draftKey(agentId) {
    return "stack-ops-draft:" + (agentId || "none");
  }

  function lastReadKey() {
    return "stack-ops-last-read";
  }

  root.OpsShell = {
    VIEWS: VIEWS,
    isLoopbackHost: isLoopbackHost,
    parseRoute: parseRoute,
    buildSearch: buildSearch,
    connectionCopy: connectionCopy,
    writesEnabled: writesEnabled,
    draftKey: draftKey,
    lastReadKey: lastReadKey,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
