export const WORKGRID_BOARD_UI_URI = "ui://workgrid/board";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * Self-contained MCP App. It deliberately has no remote assets or network access,
 * so hosts can render it with the strictest useful sandbox policy.
 */
export const WORKGRID_BOARD_APP_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Work Grid board</title>
  <style>
    :root {
      color-scheme: light dark;
      --surface: #ffffff;
      --surface-muted: #f5f7fa;
      --border: #d9dee8;
      --text: #18202f;
      --muted: #667085;
      --accent: #3157d5;
      --low: #157f55;
      --balanced: #a15c00;
      --overloaded: #bb2929;
      font-family: var(--font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --surface: #151922;
        --surface-muted: #202631;
        --border: #343c4c;
        --text: #f2f4f7;
        --muted: #a8b0bf;
        --accent: #8ca3ff;
        --low: #55d6a0;
        --balanced: #ffc166;
        --overloaded: #ff8585;
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-width: 0; background: var(--surface); color: var(--text); }
    body { padding: 16px; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 18px; line-height: 1.25; }
    h2 { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 16px 0 8px; }
    .subtitle, .empty, #status { color: var(--muted); font-size: 12px; }
    .summary { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
    .pill { border: 1px solid var(--border); border-radius: 999px; padding: 4px 8px; background: var(--surface-muted); font-size: 12px; white-space: nowrap; }
    .people { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 8px; }
    .person, .task { border: 1px solid var(--border); border-radius: 10px; background: var(--surface-muted); }
    .person { padding: 10px; border-left: 4px solid var(--person-color, var(--accent)); }
    .person-line { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
    .person strong, .task strong { font-size: 13px; }
    .role, .category { color: var(--muted); font-size: 11px; margin-top: 3px; }
    .load { font-size: 11px; font-weight: 700; }
    .load.low { color: var(--low); }
    .load.balanced { color: var(--balanced); }
    .load.overloaded { color: var(--overloaded); }
    .columns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .column { min-width: 0; }
    .column-title { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; font-weight: 700; padding: 0 2px 6px; }
    .task-list { display: grid; gap: 6px; }
    .task { padding: 9px; border-top: 3px solid var(--task-color, var(--accent)); overflow-wrap: anywhere; }
    #status { padding: 18px 0; text-align: center; }
    .error { color: var(--overloaded) !important; }
    @media (max-width: 560px) {
      header { display: block; }
      .summary { justify-content: flex-start; margin-top: 10px; }
      .columns { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main aria-live="polite">
    <header>
      <div>
        <h1>Work Grid</h1>
        <p class="subtitle" id="revision">Live board snapshot</p>
      </div>
      <div class="summary" id="summary"></div>
    </header>
    <p id="status">Waiting for the board…</p>
    <section id="content" hidden>
      <h2>People</h2>
      <div class="people" id="people"></div>
      <h2>Tasks</h2>
      <div class="columns" id="columns"></div>
    </section>
  </main>
  <script>
    (function () {
      "use strict";
      var initializeId = 1;
      var initialized = false;

      function send(message) {
        window.parent.postMessage(message, "*");
      }

      function element(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = String(text);
        return node;
      }

      function renderBoard(board) {
        if (!board || !Array.isArray(board.people) || !Array.isArray(board.tasks)) {
          var status = document.getElementById("status");
          status.textContent = "The tool returned an unexpected board payload.";
          status.className = "error";
          return;
        }

        document.getElementById("status").hidden = true;
        document.getElementById("content").hidden = false;
        document.getElementById("revision").textContent = board.revision ? "Revision " + board.revision : "Live board snapshot";

        var activeTasks = board.tasks.filter(function (task) { return task.workflow && task.workflow.state !== "archived"; });
        var summary = document.getElementById("summary");
        summary.replaceChildren(
          element("span", "pill", board.people.length + " people"),
          element("span", "pill", activeTasks.length + " active tasks"),
          element("span", "pill", (board.assignments || []).length + " assignments")
        );

        var people = document.getElementById("people");
        people.replaceChildren();
        if (!board.people.length) people.append(element("p", "empty", "No people yet."));
        board.people.forEach(function (person) {
          var card = element("article", "person");
          card.style.setProperty("--person-color", person.color || "var(--accent)");
          var line = element("div", "person-line");
          line.append(element("strong", "", person.name));
          if (person.load) line.append(element("span", "load " + person.load.state, person.load.state + " · " + person.load.score));
          card.append(line, element("p", "role", person.role || "No role"));
          people.append(card);
        });

        var states = [
          { id: "unfocused", label: "Unfocused" },
          { id: "focused", label: "Focused" },
          { id: "archived", label: "Archived" }
        ];
        var columns = document.getElementById("columns");
        columns.replaceChildren();
        states.forEach(function (state) {
          var tasks = board.tasks.filter(function (task) { return task.workflow && task.workflow.state === state.id; });
          var column = element("section", "column");
          var title = element("div", "column-title");
          title.append(element("span", "", state.label), element("span", "", tasks.length));
          var list = element("div", "task-list");
          if (!tasks.length) list.append(element("p", "empty", "None"));
          tasks.forEach(function (task) {
            var card = element("article", "task");
            card.style.setProperty("--task-color", task.color || "var(--accent)");
            card.append(element("strong", "", task.title), element("p", "category", task.category || "General"));
            list.append(card);
          });
          column.append(title, list);
          columns.append(column);
        });
      }

      function applyHostContext(context) {
        if (!context) return;
        if (context.theme === "dark" || context.theme === "light") document.documentElement.style.colorScheme = context.theme;
        var variables = context.styles && context.styles.variables;
        if (variables) Object.keys(variables).forEach(function (name) {
          if (variables[name] !== undefined) document.documentElement.style.setProperty(name, variables[name]);
        });
      }

      window.addEventListener("message", function (event) {
        if (event.source !== window.parent) return;
        var message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.id === initializeId && message.result && !initialized) {
          initialized = true;
          applyHostContext(message.result.hostContext);
          send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
          return;
        }
        if (message.method === "ui/notifications/tool-result") {
          renderBoard(message.params && message.params.structuredContent);
        } else if (message.method === "ui/notifications/host-context-changed") {
          applyHostContext(message.params);
        } else if (message.method === "ui/resource-teardown" && message.id !== undefined) {
          send({ jsonrpc: "2.0", id: message.id, result: {} });
        }
      });

      if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(function () {
          send({
            jsonrpc: "2.0",
            method: "ui/notifications/size-changed",
            params: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }
          });
        }).observe(document.body);
      }

      send({
        jsonrpc: "2.0",
        id: initializeId,
        method: "ui/initialize",
        params: {
          appInfo: { name: "workgrid-board", version: "1.0.0" },
          appCapabilities: {},
          protocolVersion: "2026-01-26"
        }
      });
    })();
  </script>
</body>
</html>`;
