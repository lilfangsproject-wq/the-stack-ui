/* Private inventory and GitHub changes are fetched through The Stack's signed-in Worker. */
(function () {
  "use strict";

  const categories = {
    project: "Projects", agent: "Agents", skill: "Skills", service: "Services",
    model: "AI models", pull: "Recent changes", code: "Code files", documentation: "Notes and guides"
  };
  const statuses = {
    deployed: "Live", verified: "Checked", experimental: "In testing",
    unverified: "Status unknown", parked: "On hold", indexed: "Listed"
  };
  const introductions = {
    "project:The-Stack": "Your home base for talking to your AI team and keeping track of their work.",
    "project:Unchained-Studio": "Experimental local-only lab for comparing AI models. Useful patterns stay here; do not merge its host runtime into The Stack cloud app.",
    "project:ZeroSpendTradingLab": "A research project that tests trading ideas against past market data. Keep as a separate lab surface via Explore — never mix trading scripts into the Stack BFF.",
    "project:AI-Ops-Control-Room": "Ported into The Stack as Ops (/ops/). Full Control Room UI + vault snapshot via Stack BFF — not a link, the runtime itself.",
    "project:AgentHandoffs-iOS": "Archived after unique-capability check. Stack PWA covers channels, DMs and assignments; local Wi-Fi/accessory discovery stays experimental/out of scope."
  };
  const statusMeaning = {
    deployed: "A published version was confirmed.",
    verified: "There is a record of a successful check.",
    experimental: "Still being tried out. Some parts may need a local setup.",
    unverified: "It’s listed in the workspace. We haven’t confirmed whether it’s running.",
    parked: "Set aside for now."
  };
  const dependencies = new Set(["contains", "uses", "calls", "runs on", "reads from", "requires", "invokes", "served by", "implemented by"]);
  const home = "everything";
  const categoryId = (kind) => "category:" + kind;
  const fileId = (path) => "file:" + path;
  const repo = "https://github.com/lilfangsproject-wq/ai-workspace";
  const pages = "https://github.com/lilfangsproject-wq/the-stack-ui";
  const safeSha = (sha) => /^[a-f0-9]{7,40}$/i.test(sha || "");
  const date = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const displayName = (name) => name.replace(/[-_]/g, " ");
  const visibleName = (node) => node.pr
    ? node.pr.title.replace(/^(?:feat|fix|docs|chore|test|refactor|build|ci|perf|style)(?:\([^)]*\))?!?:\s*/i, "")
    : node.label;
  const safePath = (path) => path.split("/").map(encodeURIComponent).join("/");

  function buildGraph(inventory) {
    const nodes = new Map();
    const links = new Map();
    function add(node) {
      nodes.set(node.id, node);
      links.set(node.id, []);
    }
    function link(source, relation, target, path) {
      if (!links.has(source) || !links.has(target) || source === target) return;
      const edge = { source, relation, target, path };
      links.get(source).push(edge);
      links.get(target).push(edge);
    }

    add({ id: home, kind: "overview", label: "Everything", summary: "Browse the workspace by type or search for a specific component." });
    add({ id: "repository", kind: "documentation", label: "AI Workspace repository", status: "indexed",
      summary: "Canonical Git history and source of the inventory.", href: repo + "/tree/" + inventory.revision });
    link(home, "indexes", "repository");
    for (const [kind, label] of Object.entries(categories)) {
      add({ id: categoryId(kind), kind: "category", category: kind, label });
      link(home, "includes", categoryId(kind));
    }

    for (const name of inventory.projects) {
      add({ id: "project:" + name, kind: "project", label: displayName(name), status: "unverified",
        summary: "Project folder indexed from the committed tree.", path: "Projects/" + name, directory: true });
    }
    for (const name of inventory.agentAreas) {
      add({ id: "agent:" + name, kind: "agent", label: displayName(name), status: "unverified",
        summary: "Repository agent record. Runtime availability is unconfirmed.",
        path: "Agents/" + name, directory: true });
    }
    const rosterPath = "Projects/The-Stack/hub/agents.json";
    for (const [name, agent] of Object.entries(inventory.agents)) {
      const id = "agent:" + name;
      add({ ...nodes.get(id), id, kind: "agent", label: name, status: agent.retired ? "parked" : "unverified",
        summary: agent.alias_of ? "Retired alias of " + agent.alias_of + "." : agent.retired
          ? "Parked in the Stack roster." : "Listed in the Stack roster. Runtime availability is unconfirmed.",
        sources: [{ path: rosterPath }] });
      if (agent.model && !agent.retired) {
        const modelId = "model:roster:" + agent.model;
        if (!nodes.has(modelId)) add({ id: modelId, kind: "model", label: agent.model, status: "unverified",
          summary: "Model or mode recorded in the roster.", sources: [{ path: rosterPath }] });
      }
    }
    for (const node of inventory.nodes) add({ ...nodes.get(node.id), ...node });
    for (const [kind, paths] of Object.entries(inventory.paths)) {
      for (const path of paths) {
        const parts = path.split("/");
        add({ id: fileId(path), kind, path, status: "indexed", label: kind === "skill" ? displayName(parts.at(-2)) : parts.at(-1) });
      }
    }
    for (const pr of inventory.pulls) {
      add({ id: "pull:" + pr.number, kind: "pull", label: "#" + pr.number + " " + pr.title,
        status: "indexed", pr, href: repo + "/pull/" + pr.number });
    }
    const prefixed = inventory.nodes.filter((node) => node.prefixes);
    for (const node of nodes.values()) {
      if (categories[node.kind]) link(categoryId(node.kind), "lists", node.id);
      if (node.path && !node.directory) {
        const [folder, name] = node.path.split("/");
        if (folder === "Projects") link("project:" + name, "contains", node.id, node.path);
        if (folder === "Agents") link("agent:" + name, "contains", node.id, node.path);
        for (const parent of prefixed) {
          if (parent.prefixes.some((prefix) => node.path.startsWith(prefix))) link(parent.id, "contains", node.id, node.path);
        }
      }
      for (const source of node.sources || []) {
        if (source.path) link(node.id, node.kind === "service" && /\.(?:m?js|py|toml|ya?ml)$/.test(source.path)
          ? "implemented by" : "documented in", fileId(source.path), source.path);
        if (source.pr) link("pull:" + source.pr, "records work on", node.id);
      }
    }
    for (const [name, agent] of Object.entries(inventory.agents)) {
      if (agent.alias_of) link("agent:" + name, "alias of", "agent:" + agent.alias_of, rosterPath);
      if (!agent.retired && agent.model) link("agent:" + name, "configured for", "model:roster:" + agent.model, rosterPath);
    }
    for (const edge of inventory.edges) link(edge.source, edge.relation, edge.target, edge.path);
    return { nodes, links };
  }

  function trace(graph, starts, selected) {
    const seen = new Set([...starts, selected]);
    const queue = starts.map((id) => ({ id, depth: 0 }));
    const result = [];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      for (const edge of graph.links.get(current.id) || []) {
        if (edge.target !== current.id || !dependencies.has(edge.relation) || seen.has(edge.source)) continue;
        seen.add(edge.source);
        const entry = { id: edge.source, via: current.id, depth: current.depth + 1, edge };
        queue.push(entry);
        result.push(entry);
      }
    }
    return result;
  }

  let mounted;
  window.StackExplore = {
    mount(root, request) {
      if (!mounted) mounted = createView(request);
      if (mounted.container.parentNode !== root) root.replaceChildren(mounted.container);
    },
    reset() {
      mounted?.dispose();
      mounted = null;
    }
  };

  function createView(request) {
    const container = document.createElement("section");
    container.className = "explore";
    container.innerHTML = `
      <div data-browse>
        <header class="explore-head">
          <div><h2>Everything in your workspace</h2><p>Find what you’re building, who’s helping, and what’s changed.</p></div>
        </header>
        <input class="input explore-search" type="search" aria-label="Search your workspace" placeholder="Search, e.g. Unchained Studio">
        <nav class="explore-choices" aria-label="Browse your workspace">
          <button type="button" class="btn btn-sec" data-kind="project" aria-pressed="true">Projects</button>
          <button type="button" class="btn btn-sec" data-kind="agent" aria-pressed="false">AI team</button>
          <button type="button" class="btn btn-sec" data-kind="pull" aria-pressed="false">Recent changes</button>
        </nav>
        <details class="explore-more">
          <summary>More categories and filters</summary>
          <div class="explore-filters">
            <select class="select" aria-label="Category"><option value="">All categories</option>
              ${Object.entries(categories).map(([key, value]) => `<option value="${key}">${key === "agent" ? "AI team" : value}</option>`).join("")}
            </select>
            <select class="select" aria-label="Status"><option value="">Any status</option>
              ${Object.entries(statuses).map(([key, value]) => `<option value="${key}">${value}</option>`).join("")}
            </select>
          </div>
        </details>
        <section data-search-results aria-label="Workspace items" hidden></section>
        <p data-load-status role="status">Loading your workspace…</p>
        <details class="explore-more explore-snapshot">
          <summary>About this list</summary>
          <p data-snapshot></p>
          <button type="button" class="btn btn-sec btn-sm" data-refresh>Reload list</button>
        </details>
      </div>
      <div data-open-item hidden>
        <div class="explore-item-tools">
          <button type="button" class="btn btn-sec btn-sm" data-back>← Back to browse</button>
          <button type="button" class="btn btn-sec btn-sm" data-toggle-map aria-expanded="false">Show connections map</button>
        </div>
        <div class="explore-workspace">
          <aside class="explore-inspector panel" aria-label="Item details" data-detail></aside>
          <div class="explore-map panel" hidden>
            <div class="explore-map-bar">
              <button type="button" class="btn btn-sec btn-sm" data-pick="everything">Overview</button>
              <div role="group" aria-label="Map zoom">
                <button type="button" class="btn btn-sec btn-sm" data-zoom="out" aria-label="Zoom out">−</button>
                <button type="button" class="btn btn-sec btn-sm" data-zoom="reset" aria-label="Fit map">Fit</button>
                <button type="button" class="btn btn-sec btn-sm" data-zoom="in" aria-label="Zoom in">+</button>
              </div>
            </div>
            <div class="explore-viewport" aria-label="Relationship map">
              <div class="explore-scene"><canvas aria-hidden="true"></canvas><div data-map-nodes></div></div>
            </div>
            <p class="explore-map-note" data-map-note>Choose an item to see what it connects to.</p>
          </div>
        </div>
      </div>`;

    const $ = (selector) => container.querySelector(selector);
    const snapshot = $("[data-snapshot]");
    const loadStatus = $("[data-load-status]");
    const browse = $("[data-browse]");
    const openItem = $("[data-open-item]");
    const map = $(".explore-map");
    const mapToggle = $("[data-toggle-map]");
    const results = $("[data-search-results]");
    const inspector = $("[data-detail]");
    const viewport = $(".explore-viewport");
    const scene = $(".explore-scene");
    const canvas = $("canvas");
    const canvasNodes = $("[data-map-nodes]");
    let disposed = false;
    const search = $('input[type="search"]');
    const type = $('select[aria-label="Category"]');
    const status = $('select[aria-label="Status"]');
    type.value = "project";

    let inventory, graph, selected = home, resultLimit = 15, fileLimit = 30;
    let mode = "details", connectionLimit = 24, activeDrag = null, zoom = 1, panX = 0, panY = 0;
    let browseFocus = null;

    function el(tag, content, className) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (content != null) element.textContent = content;
      return element;
    }

    function pick(id, text, className = "explore-pick") {
      const button = el("button", text, className);
      button.type = "button";
      button.dataset.pick = id;
      return button;
    }

    function anchor(href, text) {
      const link = el("a", text);
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return link;
    }

    function sourceLink(source) {
      if (source.path) return anchor(repo + "/blob/" + inventory.revision + "/" + safePath(source.path), source.label || source.path);
      if (Number.isSafeInteger(source.pr)) return anchor(repo + "/pull/" + source.pr, "Pull request #" + source.pr);
      if (safeSha(source.sha)) return anchor((source.type === "pages" ? pages : repo) + "/commit/" + source.sha, source.label || source.sha);
      return null;
    }

    function moveScene() {
      scene.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    }

    function fit() {
      zoom = 1;
      panX = 0;
      panY = 0;
      moveScene();
    }

    function related(id) {
      const edgesByNode = new Map();
      for (const edge of graph.links.get(id) || []) {
        const other = edge.source === id ? edge.target : edge.source;
        const list = edgesByNode.get(other) || [];
        list.push(edge);
        edgesByNode.set(other, list);
      }
      return [...edgesByNode].sort(([a, ae], [b, be]) => {
        const rank = (id, edges) => edges.some((e) => !["contains", "lists", "documented in"].includes(e.relation)) ? 0
          : graph.nodes.get(id).kind === "category" ? 2 : 1;
        return rank(a, ae) - rank(b, be);
      });
    }

    function renderMap() {
      if (map.hidden) return;
      canvasNodes.replaceChildren();
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      if (!width || !height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      const context = canvas.getContext("2d");
      context.scale(dpr, dpr);
      if (!graph) return;
      const compact = width < 470;
      const node = graph.nodes.get(selected);
      const traced = mode === "impact" ? getImpact(node) : null;
      const neighbors = traced
        ? [...new Map([
          ...traced.seeds.filter((id) => id !== selected).map((id) => [id, [{ relation: "changed in" }]]),
          ...traced.downstream.map((entry) => [entry.id, [entry.edge]])
        ])]
        : related(selected);
      const limit = compact ? 6 : 9;
      const edgesByNode = new Map(neighbors);
      const parents = new Map(traced?.downstream.map((entry) => [entry.id, entry.via]));
      const order = traced ? new Set([
        ...traced.downstream.flatMap((entry) => [entry.via, entry.id]).filter((id) => id !== selected),
        ...edgesByNode.keys()
      ]) : edgesByNode.keys();
      const shown = [...order].slice(0, limit);
      const center = [width / 2, height / 2];
      const radiusX = Math.min(width / 2 - (compact ? 57 : 82), 355);
      const radiusY = height / 2 - 44;
      const light = document.documentElement.dataset.surface === "light";
      context.lineWidth = 1.25;
      context.strokeStyle = mode === "impact" ? (light ? "#835000" : "#d6aa66") : (light ? "#647797" : "#59749c");

      const mapNode = (id, x, y) => {
        const node = graph.nodes.get(id);
        const label = node.kind === "pull" ? "#" + node.pr.number : node.label;
        const button = pick(id, label, "explore-node");
        button.title = node.label;
        button.setAttribute("aria-label", node.label);
        button.dataset.kind = node.kind;
        button.style.left = x + "px";
        button.style.top = y + "px";
        if (id === selected) button.setAttribute("aria-current", "true");
        canvasNodes.append(button);
      };
      const positions = new Map([[selected, center]]);
      for (const [index, id] of shown.entries()) {
        const angle = (2 * Math.PI * index / shown.length) - Math.PI / 2;
        const x = center[0] + radiusX * Math.cos(angle);
        const y = center[1] + radiusY * Math.sin(angle);
        positions.set(id, [x, y]);
      }
      for (const id of shown) {
        const [x, y] = positions.get(id);
        const parent = parents.get(id) || selected;
        if (positions.has(parent)) {
          context.setLineDash(edgesByNode.get(id).some((edge) => dependencies.has(edge.relation)) ? [] : [4, 5]);
          context.beginPath();
          context.moveTo(...positions.get(parent));
          context.lineTo(x, y);
          context.stroke();
        }
        mapNode(id, x, y);
      }
      mapNode(selected, ...center);
      const noun = mode === "impact" ? "impact results" : "connections";
      $("[data-map-note]").textContent = neighbors.length > shown.length
        ? `Showing ${shown.length} of ${neighbors.length} ${noun}. See the full list in the selection panel.`
        : mode === "impact" ? "Highlighted nodes show changed files or potential impact."
          : "Select a node to follow its connections. Drag to pan.";
    }

    function listRow(node, detail, label = node.label) {
      const item = el("li");
      item.append(pick(node.id, label));
      if (detail) item.append(el("span", detail, "explore-muted"));
      return item;
    }

    function renderSearch() {
      results.replaceChildren();
      const query = search.value.trim().toLowerCase();
      const terms = query.split(/\s+/);
      for (const choice of container.querySelectorAll("[data-kind]")) {
        choice.setAttribute("aria-pressed", String(choice.dataset.kind === type.value));
      }
      results.hidden = !graph;
      if (results.hidden) return;
      const matched = [...graph.nodes.values()].filter((node) => categories[node.kind] &&
        (!type.value || node.kind === type.value) && (!status.value || node.status === status.value) &&
        terms.every((term) => [node.label, node.path, introductions[node.id], node.summary, node.pr?.state, statuses[node.status]].join(" ").toLowerCase().includes(term)));
      if (query) {
        const rank = (node) => node.label.toLowerCase() === query ? 0
          : node.label.toLowerCase().startsWith(query) ? 1 : node.label.toLowerCase().includes(query) ? 2 : 3;
        matched.sort((a, b) => rank(a) - rank(b));
      } else if (type.value === "pull") {
        matched.sort((a, b) => b.pr.updated.localeCompare(a.pr.updated));
      } else if (type.value === "project") {
        const rank = (node) => node.status === "deployed" ? 0 : node.status === "experimental" ? 1 : 2;
        matched.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
      }
      const title = query ? "Search results" : type.value === "agent" ? "AI team" : (categories[type.value] || "All items");
      results.append(el("h3", title));
      if (!matched.length) {
        results.append(el("p", "Nothing matched. Try another word or clear your filters.", "explore-muted"));
        return;
      }
      const list = el("ul", null, "explore-list explore-browse-list");
      for (const node of matched.slice(0, resultLimit)) {
        const item = el("li");
        const button = pick(node.id, visibleName(node));
        const caption = [node.pr ? "#" + node.pr.number + " · " + node.pr.state : statuses[node.status], introductions[node.id]].filter(Boolean).join(" · ");
        if (caption) button.append(el("span", caption, "explore-muted"));
        item.append(button);
        list.append(item);
      }
      results.append(list);
      if (matched.length > resultLimit) {
        const more = el("button", "Show more results", "btn btn-sec btn-sm");
        more.type = "button";
        more.dataset.more = "";
        results.append(more);
      }
    }

    function disclosure(label) {
      const details = el("details", null, "explore-more");
      details.append(el("summary", label));
      return details;
    }

    function details(node) {
      const neighbors = related(node.id);
      const list = el("ul", null, "explore-list");
      if (node.id === home) {
        const summary = el("p", node.summary);
        inspector.append(summary);
      }
      if (node.id !== home && node.kind !== "category") {
        const description = introductions[node.id] || node.summary;
        if (description) inspector.append(el("p", description, "explore-description"));
        if (statusMeaning[node.status]) inspector.append(el("p", statusMeaning[node.status]));
        if (node.kind === "project" && node.directory && node.path) {
          const source = anchor(repo + "/tree/main/" + safePath(node.path), "");
          source.className = "row";
          source.append(el("span", "Open current project in GitHub", "row-title"));
          inspector.append(source, el("p", "This opens a private repository in a new tab. Use the GitHub account that has access."));
        }
        if (node.pr) {
          inspector.append(el("p", `GitHub change #${node.pr.number} · Updated ${date(node.pr.updated)}`));
        }
        if (node.href || node.path || node.sources?.length) {
          const sources = disclosure("Sources and technical notes");
          if (introductions[node.id] && node.summary) sources.append(el("p", node.summary));
          if (node.pr && safeSha(node.pr.head)) sources.append(anchor(repo + "/commit/" + node.pr.head, "Head commit " + node.pr.head.slice(0, 10)));
          if (node.pr && safeSha(node.pr.merge)) sources.append(anchor(repo + "/commit/" + node.pr.merge, "Merge commit " + node.pr.merge.slice(0, 10)));
          if (node.href) sources.append(anchor(node.href, node.pr ? "Open change in GitHub" : "Open source"));
          if (node.path) sources.append(node.directory
            ? anchor(repo + "/tree/" + inventory.revision + "/" + safePath(node.path), node.path)
            : sourceLink({ path: node.path }));
          for (const source of node.sources || []) {
            const link = sourceLink(source);
            if (link) sources.append(link);
          }
          inspector.append(sources);
        }
      }
      if (!neighbors.length) return;
      const connections = disclosure("Related items");
      connections.open = node.kind === "category" || node.id === home || connectionLimit > 24;
      for (const [id, edges] of neighbors.slice(0, connectionLimit)) {
        const other = graph.nodes.get(id);
        const detail = node.kind === "category" && other.path ? other.path : edges.map((edge) =>
          (edge.source === node.id ? "→ " : "← ") + edge.relation).join(" · ");
        const item = listRow(other, detail);
        if (node.kind !== "category") {
          const sources = new Set(edges.map((edge) => edge.path).filter(Boolean));
          for (const path of sources) item.append(sourceLink({ path, label: "Relation evidence" }));
        }
        list.append(item);
      }
      connections.append(list);
      if (neighbors.length > connectionLimit) connections.append(action(
        `Show more connections (${connectionLimit} of ${neighbors.length})`, "connections"
      ));
      inspector.append(connections);
    }

    function getImpact(node) {
      const seeds = node.pr ? [...new Set(node.pr.files
        .flatMap((change) => [change.path, change.previous])
        .filter(Boolean).map(fileId).filter((id) => graph.nodes.has(id)))] : [node.id];
      return { seeds, downstream: trace(graph, seeds, node.id) };
    }

    function impact(node) {
      const { seeds, downstream } = getImpact(node);
      inspector.append(el("h4", "Things that may be affected"));
      if (downstream.length) {
        inspector.append(el("p", "These items are linked to the change and may need a closer look."));
        const list = el("ul", null, "explore-list");
        for (const hit of downstream) {
          const item = listRow(graph.nodes.get(hit.id), `Linked through ${visibleName(graph.nodes.get(hit.via))}`);
          if (hit.edge.path) item.append(sourceLink({ path: hit.edge.path, label: "See the link in GitHub" }));
          list.append(item);
        }
        inspector.append(list);
      } else {
        inspector.append(el("p", "This list has no recorded links to other affected items."));
      }
      if (node.pr) {
        const outcome = node.pr;
        const files = disclosure("Files that changed");
        files.open = fileLimit > 30;
        files.append(anchor(node.href + "/files", "See file changes in GitHub"));
        const list = el("ul", null, "explore-list");
        for (const change of outcome.files.slice(0, fileLimit)) {
          const matching = [change.path, change.previous].filter(Boolean).map(fileId).filter((id) => graph.nodes.has(id));
          const label = [change.previous, change.path].filter(Boolean).join(" → ");
          if (matching.length) list.append(listRow({ id: matching[0], label }, change.change));
          else list.append(el("li", label + " · " + change.change));
        }
        if (outcome.files.length) files.append(list);
        else files.append(el("p", "This list has no files for this change."));
        if (outcome.files.length > fileLimit) files.append(action(
          `Show more changed files (${fileLimit} of ${outcome.files.length})`, "files"
        ));
        if (!outcome.complete || outcome.outsideInventory) files.append(el("p",
          (!outcome.complete ? "GitHub’s changed-file listing reached the page limit. " : "") +
          (outcome.outsideInventory ? `${outcome.outsideInventory} file changes fall outside the inventory’s path scope.` : ""), "explore-muted"));
        if (outcome.files.length && !seeds.length) files.append(el("p", "The files changed here are outside the scope of this list."));
        inspector.append(files);
      }
    }

    function action(label, name) {
      const button = el("button", label, "btn btn-sec btn-sm");
      button.type = "button";
      button.dataset.action = name;
      return button;
    }

    function renderInspector() {
      inspector.replaceChildren();
      if (!graph) return;
      const node = graph.nodes.get(selected);
      const heading = el("h3", visibleName(node));
      heading.tabIndex = -1;
      inspector.append(heading);
      if (node.status) inspector.append(el("span", node.pr?.state || statuses[node.status], "explore-status status-" + node.status));

      if (node.id !== home && node.kind !== "category") {
        const tabs = el("div", null, "explore-detail-actions");
        for (const [id, label] of [["details", "About this"], ["impact", "What could this affect?"]]) {
          const button = action(label, id);
          button.setAttribute("aria-pressed", String(id === mode));
          tabs.append(button);
        }
        inspector.append(tabs);
      }
      if (mode === "impact") impact(node);
      else details(node);
    }

    function select(id, focus) {
      if (!graph?.nodes.has(id)) return;
      selected = id;
      connectionLimit = 24;
      mode = "details";
      fileLimit = 30;
      fit();
      renderMap();
      renderInspector();
      if (focus) inspector.querySelector("h3")?.focus({ preventScroll: true });
    }

    async function refresh() {
      const refreshButton = $("[data-refresh]");
      refreshButton.disabled = true;
      loadStatus.textContent = "Loading your workspace…";
      try {
        const next = await request("/api/explore/inventory");
        if (disposed) return;
        if (next?.schema !== 1 || !safeSha(next.revision) || !Array.isArray(next.pulls)) throw new Error("Invalid inventory");
        const nextGraph = buildGraph(next);
        inventory = next;
        graph = nextGraph;
        select(graph.nodes.has(selected) ? selected : home, false);
        renderSearch();
        loadStatus.textContent = "";
        snapshot.replaceChildren(`GitHub checked ${date(inventory.pullCheckedAt)} · ${inventory.pulls.length} saved changes · `,
          anchor(repo + "/commit/" + inventory.revision, "Version of this list"));
      } catch (error) {
        if (disposed) return;
        if (error.status === 401) {
          inventory = graph = null;
          renderSearch();
          renderMap();
        }
        if (!graph) inspector.replaceChildren(el("p", "Inventory could not be loaded. Use Refresh to try again."));
        const retry = el("button", "Try again", "btn btn-sec btn-sm");
        retry.type = "button";
        retry.dataset.refresh = "";
        loadStatus.replaceChildren(graph ? "Couldn’t reload. Your last list is still here. " : "Couldn’t load your workspace. ", retry);
      } finally {
        refreshButton.disabled = false;
      }
    }

    container.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.kind) {
        type.value = button.dataset.kind;
        search.value = "";
        status.value = "";
        resultLimit = 15;
        renderSearch();
      }
      if ("back" in button.dataset) {
        openItem.hidden = true;
        browse.hidden = false;
        map.hidden = true;
        mapToggle.setAttribute("aria-expanded", "false");
        mapToggle.textContent = "Show connections map";
        (browseFocus?.isConnected ? browseFocus : search).focus();
      }
      if ("toggleMap" in button.dataset) {
        map.hidden = !map.hidden;
        mapToggle.setAttribute("aria-expanded", String(!map.hidden));
        mapToggle.textContent = map.hidden ? "Show connections map" : "Hide connections map";
        if (!map.hidden) {
          renderMap();
          map.scrollIntoView({ block: "nearest" });
        }
      }
      if (button.dataset.pick) {
        if (browse.contains(button)) {
          browseFocus = button;
          browse.hidden = true;
          openItem.hidden = false;
        }
        select(button.dataset.pick, true);
        if (browse.hidden) openItem.scrollIntoView({ block: "start" });
      }
      if ("refresh" in button.dataset) refresh();
      if ("more" in button.dataset) {
        resultLimit += 15;
        renderSearch();
        results.querySelectorAll("li button")[resultLimit - 15]?.focus();
      }
      if (button.dataset.zoom === "reset") fit();
      else if (button.dataset.zoom) {
        zoom = Math.min(2.8, Math.max(0.6, zoom * (button.dataset.zoom === "in" ? 1.25 : 0.8)));
        moveScene();
      }
      if (button.dataset.action && graph) {
        if (button.dataset.action === "files") {
          fileLimit += 30;
          renderInspector();
          inspector.querySelector('[data-action="files"]')?.focus({ preventScroll: true });
          return;
        }
        if (button.dataset.action === "connections") {
          const previous = connectionLimit;
          connectionLimit += 24;
          renderInspector();
          inspector.querySelectorAll("li button")[previous]?.focus();
          return;
        }
        mode = button.dataset.action === "details" ? "details" : "impact";
        renderMap();
        renderInspector();
        inspector.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
      }
    });

    search.addEventListener("input", () => {
      type.value = search.value.trim() ? "" : "project";
      resultLimit = 15;
      renderSearch();
    });
    for (const filter of [type, status]) filter.addEventListener("change", () => { resultLimit = 15; renderSearch(); });
    viewport.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0 || event.target.closest("button")) return;
      activeDrag = { x: event.clientX - panX, y: event.clientY - panY };
      viewport.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!activeDrag || !event.isPrimary) return;
      panX = event.clientX - activeDrag.x;
      panY = event.clientY - activeDrag.y;
      moveScene();
    });
    viewport.addEventListener("lostpointercapture", () => { activeDrag = null; });
    const resizeObserver = new ResizeObserver(renderMap);
    resizeObserver.observe(viewport);
    const themeObserver = new MutationObserver(renderMap);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-surface"] });
    refresh();
    return { container, dispose() {
      disposed = true;
      resizeObserver.disconnect();
      themeObserver.disconnect();
      container.remove();
    } };
  }
}());
