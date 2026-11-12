import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createRequire } from "node:module";

import {
  DEFAULT_TIMEOUT_MS, DEFAULT_URL, MAX_TIMEOUT_MS, WorkgridClient, normalizeApiUrl, normalizeToken,
} from "./client.js";
import { COMMANDS, bindCommand, findCommand, resources } from "./commands.js";
import { CliError, EXIT, usage } from "./errors.js";
import { colorEnabled, createStyle, formatError, formatters, sanitizeText, toJson } from "./output.js";
import { inspectSkill, readBundledSkill, resolveTargets } from "./skill.js";

const require = createRequire(import.meta.url);
const PACKAGE = require("../package.json");
export const CLI_VERSION = PACKAGE.version;
export const PACKAGE_NAME = PACKAGE.name;
const MIN_NODE = [22, 13, 0];
const MAX_STDIN_CHARACTERS = 256_000;

const GLOBAL_OPTIONS = {
  url: { type: "string", value: "URL", describe: `Workgrid origin (default: $WORKGRID_URL or ${DEFAULT_URL})` },
  timeout: { type: "string", value: "MS", describe: `Request timeout, 1–${MAX_TIMEOUT_MS} ms (default: ${DEFAULT_TIMEOUT_MS})` },
  output: { type: "string", values: ["auto", "json", "text"], describe: "auto = text on a terminal, JSON when piped (default: $WORKGRID_OUTPUT or auto)" },
  json: { type: "boolean", describe: "Shorthand for --output json (recommended for scripts and agents)" },
  pretty: { type: "boolean", describe: "Indent JSON output" },
  "allow-http": { type: "boolean", describe: "Permit plaintext HTTP to a non-loopback host (unsafe)" },
  "no-color": { type: "boolean", describe: "Disable ANSI colors (also: NO_COLOR=1)" },
  help: { type: "boolean", short: "h", describe: "Show help for any command" },
  version: { type: "boolean", short: "v", describe: "Print the CLI version" },
};
const SHORT_FLAGS = { "-h": "help", "-v": "version", "-V": "version" };
const BOOLEAN_OPTIONS = new Set([
  ...Object.entries(GLOBAL_OPTIONS).filter(([, spec]) => spec.type === "boolean").map(([name]) => name),
  ...COMMANDS.flatMap((command) => Object.entries(command.options ?? {}).filter(([, spec]) => spec.type === "boolean").map(([name]) => name)),
]);

/**
 * Runs the CLI and resolves to a process exit code. `io` and `dependencies` are injectable for tests.
 */
export async function runCli(argv, io = {}, dependencies = {}) {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let mode = "json";
  let pretty = false;
  let style = createStyle(false);
  try {
    const { positionals, options } = tokenize(argv);
    const global = takeGlobals(options);
    pretty = global.pretty;
    mode = resolveMode(global, env, stdout);
    style = createStyle(mode === "text" && !global.noColor && colorEnabled(stdout, env));
    const errStyle = createStyle(mode === "text" && !global.noColor && colorEnabled(stderr, env));
    style.err = errStyle;

    if (global.version) { stdout.write(`${CLI_VERSION}\n`); return EXIT.OK; }
    if (positionals[0] === "help") { stdout.write(renderHelp(positionals.slice(1), style)); return EXIT.OK; }
    if (positionals.length === 0) { stdout.write(renderHelp([], style)); return EXIT.OK; }

    const command = findCommand(positionals);
    if (global.help) { stdout.write(renderHelp(command ? command.path : positionals.slice(0, 1), style)); return EXIT.OK; }
    if (!command) throw unknownCommand(positionals);

    const bound = bindCommand(command, positionals, options);
    let kept;
    const context = {
      ...bound,
      paths: { home: dependencies.home ?? homedir(), cwd: dependencies.cwd ?? process.cwd() },
      keep: (value) => { kept = value; },
      readInput: (file) => readInput(file, io.stdin ?? readProcessStdin, dependencies.readFile ?? readBoundedFile),
      completion: (shell) => completionScript(shell),
      doctor: () => doctor(global, env, dependencies),
    };
    if (!command.local) context.client = createClient(global, env, dependencies);

    const data = await command.run(context);
    if (command.raw) { stdout.write(data.endsWith("\n") ? data : `${data}\n`); return EXIT.OK; }
    if (mode === "json") stdout.write(`${toJson({ ok: true, data }, pretty)}\n`);
    else stdout.write(`${renderText(command, data, kept, style)}\n`);
    return command.path[0] === "doctor" && data.checks.some((check) => check.status === "fail") ? EXIT.FAILURE : EXIT.OK;
  } catch (error) {
    const safe = error instanceof CliError ? error : new CliError("INTERNAL", "The CLI could not complete the command.", EXIT.FAILURE);
    const body = { code: safe.code, message: safe.message, ...safe.extra };
    if (mode === "json") stderr.write(`${toJson({ ok: false, error: body }, pretty)}\n`);
    else stderr.write(`${formatError(body, style.err ?? style)}\n`);
    if (!(error instanceof CliError) && env.WORKGRID_DEBUG) stderr.write(`${sanitizeText(error?.stack ?? error)}\n`);
    return safe.exitCode;
  }
}

// ── argument parsing ─────────────────────────────────────────────────────────

/**
 * Splits argv into positionals and `--name[=value]` options. A string option consumes the
 * next token; values that themselves start with `--` must use `--name=value`. `--` ends options.
 */
export function tokenize(argv) {
  const positionals = [];
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") { positionals.push(...argv.slice(index + 1)); break; }
    if (SHORT_FLAGS[token]) { setOption(options, SHORT_FLAGS[token], true); continue; }
    if (!token.startsWith("--") || token === "-") { positionals.push(token); continue; }
    const separator = token.indexOf("=");
    const name = separator < 0 ? token.slice(2) : token.slice(2, separator);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw usage(`Invalid option ${JSON.stringify(token)}.`);
    if (separator >= 0) setOption(options, name, token.slice(separator + 1));
    else if (BOOLEAN_OPTIONS.has(name)) setOption(options, name, true);
    else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) setOption(options, name, argv[++index]);
    else setOption(options, name, true);
  }
  return { positionals, options };
}

function setOption(options, name, value) {
  if (Object.hasOwn(options, name)) throw usage(`Option --${name} may be specified only once.`);
  options[name] = value;
}

function takeGlobals(options) {
  const take = (name) => { const value = options[name]; delete options[name]; return value; };
  const flag = (name) => {
    const value = take(name);
    if (value !== undefined && value !== true) throw usage(`--${name} does not accept a value.`);
    return value === true;
  };
  const value = (name) => {
    const result = take(name);
    if (result === true) throw usage(`--${name} requires a value.`);
    return result;
  };
  const timeout = value("timeout");
  const output = value("output");
  if (output !== undefined && !GLOBAL_OPTIONS.output.values.includes(output)) throw usage(`--output must be one of: ${GLOBAL_OPTIONS.output.values.join(", ")}.`);
  return {
    url: value("url"),
    timeoutMs: timeout === undefined ? DEFAULT_TIMEOUT_MS : parseTimeout(timeout),
    output,
    json: flag("json"),
    pretty: flag("pretty"),
    allowHttp: flag("allow-http"),
    noColor: flag("no-color"),
    help: flag("help"),
    version: flag("version"),
  };
}

function parseTimeout(value) {
  const result = Number(value);
  if (!/^[0-9]+$/.test(value) || result < 1 || result > MAX_TIMEOUT_MS) throw usage(`--timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  return result;
}

function resolveMode(global, env, stdout) {
  if (global.json) return "json";
  const requested = global.output ?? (["auto", "json", "text"].includes(env.WORKGRID_OUTPUT) ? env.WORKGRID_OUTPUT : "auto");
  if (requested !== "auto") return requested;
  return stdout?.isTTY ? "text" : "json";
}

function createClient(global, env, dependencies) {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new CliError("UNSUPPORTED_RUNTIME", "This Node.js runtime does not provide fetch().", EXIT.FAILURE);
  return new WorkgridClient({
    apiUrl: normalizeApiUrl(global.url ?? (env.WORKGRID_URL || DEFAULT_URL), global.allowHttp),
    timeoutMs: global.timeoutMs,
    token: normalizeToken(env.WORKGRID_TOKEN),
    fetchImpl,
    userAgent: `workgrid-cli/${CLI_VERSION} node/${process.versions.node}`,
  });
}

function unknownCommand(positionals) {
  const known = resources();
  if (!known.includes(positionals[0])) {
    const suggestion = closest(positionals[0], known);
    return new CliError("UNKNOWN_COMMAND", `Unknown command ${JSON.stringify(positionals[0])}.`, EXIT.USAGE, { hint: suggestion ? `Did you mean \`workgrid ${suggestion}\`? Run workgrid --help.` : "Run workgrid --help." });
  }
  const subcommands = COMMANDS.filter((command) => command.path[0] === positionals[0]).map((command) => command.path[1]);
  const suggestion = positionals[1] && closest(positionals[1], subcommands);
  return new CliError("UNKNOWN_COMMAND", `Unknown command ${JSON.stringify(positionals.slice(0, 2).join(" "))}.`, EXIT.USAGE, {
    hint: suggestion ? `Did you mean \`workgrid ${positionals[0]} ${suggestion}\`?` : `Available: ${subcommands.map((name) => `${positionals[0]} ${name}`).join(", ")}.`,
  });
}

function closest(input, candidates) {
  let best = null;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = levenshtein(String(input), candidate);
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return best;
}

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

// ── input ────────────────────────────────────────────────────────────────────

async function readInput(file, stdin, readFileImpl) {
  const text = file === undefined || file === "-" ? await stdin() : await readFileImpl(file);
  if (typeof text !== "string") throw new CliError("INVALID_INPUT", "Input must be text.", EXIT.USAGE);
  if (text.length > MAX_STDIN_CHARACTERS) throw new CliError("PAYLOAD_TOO_LARGE", `Input exceeds ${MAX_STDIN_CHARACTERS} characters.`, EXIT.USAGE);
  return text;
}

async function readBoundedFile(path) {
  let stats;
  try { stats = await stat(path); } catch { throw new CliError("INVALID_INPUT", `Cannot read ${JSON.stringify(path)}.`, EXIT.USAGE, { field: "file" }); }
  if (!stats.isFile()) throw new CliError("INVALID_INPUT", "--file must be a regular file.", EXIT.USAGE, { field: "file" });
  if (stats.size > MAX_STDIN_CHARACTERS * 4) throw new CliError("PAYLOAD_TOO_LARGE", `Input exceeds ${MAX_STDIN_CHARACTERS} characters.`, EXIT.USAGE);
  return readFile(path, "utf8");
}

async function readProcessStdin() {
  if (process.stdin.isTTY) throw new CliError("INVALID_INPUT", "Pipe task lines into stdin or pass --file PATH.", EXIT.USAGE);
  let result = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    result += chunk;
    if (result.length > MAX_STDIN_CHARACTERS) throw new CliError("PAYLOAD_TOO_LARGE", `Input exceeds ${MAX_STDIN_CHARACTERS} characters.`, EXIT.USAGE);
  }
  return result;
}

// ── text rendering ───────────────────────────────────────────────────────────

function renderText(command, data, kept, style) {
  if (typeof command.format === "function") {
    const [name, value, extra] = command.format(data, kept);
    return formatters[name](value, style, extra);
  }
  const formatter = formatters[command.format ?? "json"];
  return formatter(data, style);
}

function usageLine(command) {
  const parts = ["workgrid", ...command.path, ...(command.args ?? [])];
  for (const [name, spec] of Object.entries(command.options ?? {})) {
    const value = spec.type === "boolean" ? `--${name}` : `--${name} ${spec.values ? spec.values.join("|") : spec.value ?? name.toUpperCase().replace(/-/g, "_")}`;
    parts.push(spec.required || (command.destructive && name === "yes") ? value : `[${value}]`);
  }
  return parts.join(" ");
}

function optionRows(specs, style) {
  const rows = Object.entries(specs).map(([name, spec]) => {
    const flag = `${spec.short ? `-${spec.short}, ` : "    "}--${name}${spec.type === "string" ? ` ${spec.value ?? (spec.values ? "VALUE" : name.toUpperCase().replace(/-/g, "_"))}` : ""}`;
    const extra = spec.values ? ` ${style.dim(`[${spec.values.join(", ")}]`)}` : "";
    return [flag, `${spec.describe ?? ""}${spec.required ? style.dim(" (required)") : ""}${extra}`];
  });
  const width = Math.max(...rows.map(([flag]) => flag.length));
  return rows.map(([flag, text]) => `  ${flag.padEnd(width)}  ${text}`).join("\n");
}

export function renderHelp(path, style = createStyle(false)) {
  const command = path.length ? findCommand(path) : null;
  if (command && command.path.length === path.length) {
    const lines = [
      style.bold(command.summary),
      "",
      `${style.bold("Usage:")} ${usageLine(command)}`,
    ];
    if (command.options) lines.push("", style.bold("Options:"), optionRows(command.options, style));
    if (command.destructive) lines.push("", style.yellow("This action is permanent. It requires --yes."));
    lines.push("", style.dim("Global options: --url, --json, --output, --pretty, --timeout. See `workgrid --help`."));
    return `${lines.join("\n")}\n`;
  }
  const group = path[0] && resources().includes(path[0]) ? path[0] : null;
  const visible = COMMANDS.filter((item) => !group || item.path[0] === group);
  const width = Math.max(...visible.map((item) => [...item.path, ...(item.args ?? [])].join(" ").length));
  const lines = [];
  if (!group) {
    lines.push(
      `${style.bold("workgrid")} ${style.dim(CLI_VERSION)} — command line client for a Workgrid board`,
      "",
      `${style.bold("Usage:")} workgrid <command> [arguments] [options]`,
    );
  } else {
    lines.push(`${style.bold("Usage:")} workgrid ${group} <command> [arguments] [options]`);
  }
  let previous = null;
  for (const item of visible) {
    if (item.path[0] !== previous) { lines.push("", style.bold(capitalize(item.path[0]))); previous = item.path[0]; }
    lines.push(`  ${[...item.path, ...(item.args ?? [])].join(" ").padEnd(width)}  ${item.summary}`);
  }
  if (!group) {
    lines.push(
      "", style.bold("Global options"), optionRows(GLOBAL_OPTIONS, style),
      "", style.bold("Environment"),
      "  WORKGRID_URL      Default Workgrid origin",
      "  WORKGRID_TOKEN    Bearer token, if your deployment requires one (never pass it as an argument)",
      "  WORKGRID_OUTPUT   Default output mode: auto, json, or text",
      "  NO_COLOR          Disable colors",
      "", style.bold("Output"),
      "  JSON mode writes {\"ok\":true,\"data\":…} to stdout or {\"ok\":false,\"error\":{code,message,…}} to stderr.",
      "  Exit codes: 0 ok · 1 transport/server · 2 usage/validation · 3 not found · 4 conflict · 5 auth",
      "", style.bold("Examples"),
      "  workgrid board get",
      "  workgrid tasks list --state focused --json",
      "  workgrid assignments set TASK_ID PERSON_ID --focus primary",
      "  workgrid skill install --agent all",
      "",
      `Run ${style.cyan("workgrid <command> --help")} for details on a command.`,
    );
  } else {
    lines.push("", `Run ${style.cyan(`workgrid ${group} <command> --help`)} for details.`);
  }
  return `${lines.join("\n")}\n`;
}

function capitalize(text) {
  return text[0].toUpperCase() + text.slice(1);
}

// ── completion ───────────────────────────────────────────────────────────────

function completionScript(shell) {
  const globals = Object.keys(GLOBAL_OPTIONS).map((name) => `--${name}`).join(" ");
  const groups = resources();
  const subcommands = Object.fromEntries(groups.map((group) => [group, COMMANDS.filter((command) => command.path[0] === group && command.path[1]).map((command) => command.path[1])]));
  const optionsFor = (command) => Object.keys(command.options ?? {}).map((name) => `--${name}`).join(" ");

  if (shell === "fish") {
    const lines = ["# workgrid completion for fish. Install: workgrid completion fish > ~/.config/fish/completions/workgrid.fish", "complete -c workgrid -f"];
    for (const [name, spec] of Object.entries(GLOBAL_OPTIONS)) lines.push(`complete -c workgrid -l ${name}${spec.type === "string" ? " -r" : ""} -d ${fishQuote(spec.describe)}`);
    for (const group of groups) lines.push(`complete -c workgrid -n __fish_use_subcommand -a ${group}`);
    for (const command of COMMANDS.filter((item) => item.path.length === 2)) {
      lines.push(`complete -c workgrid -n "__fish_seen_subcommand_from ${command.path[0]}; and not __fish_seen_subcommand_from ${subcommands[command.path[0]].join(" ")}" -a ${command.path[1]} -d ${fishQuote(command.summary)}`);
      for (const [name, spec] of Object.entries(command.options ?? {})) {
        lines.push(`complete -c workgrid -n "__fish_seen_subcommand_from ${command.path[0]}; and __fish_seen_subcommand_from ${command.path[1]}" -l ${name}${spec.values ? ` -xa ${fishQuote(spec.values.join(" "))}` : spec.type === "string" ? " -r" : ""}`);
      }
    }
    lines.push(`complete -c workgrid -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"`);
    return `${lines.join("\n")}\n`;
  }

  const cases = COMMANDS.filter((command) => command.path.length === 2).map((command) => `    "${command.path.join(" ")}") opts="${optionsFor(command)}" ;;`).join("\n");
  // Only groups with subcommands get a generated case; `completion` has its own case below and must not be shadowed.
  const subs = groups.filter((group) => subcommands[group].length).map((group) => `    ${group}) words="${subcommands[group].join(" ")}" ;;`).join("\n");
  const bash = `_workgrid() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" words="" opts=""
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "${groups.join(" ")} help ${globals}" -- "$cur")); return
  fi
  if [[ $COMP_CWORD -eq 2 ]]; then
    case "\${COMP_WORDS[1]}" in
${subs}
    completion) words="bash zsh fish" ;;
    esac
    COMPREPLY=($(compgen -W "$words ${globals}" -- "$cur")); return
  fi
  case "\${COMP_WORDS[1]} \${COMP_WORDS[2]}" in
${cases}
  esac
  COMPREPLY=($(compgen -W "$opts ${globals}" -- "$cur"))
}
complete -o default -F _workgrid workgrid
`;
  if (shell === "bash") return `# workgrid completion for bash. Install: workgrid completion bash > ~/.local/share/bash-completion/completions/workgrid\n${bash}`;
  // Uses zsh's bash-completion bridge, so it must be sourced after compinit (not autoloaded from $fpath).
  return `# workgrid completion for zsh. Install: add  eval "$(workgrid completion zsh)"  to ~/.zshrc after compinit\nautoload -U +X bashcompinit && bashcompinit\n${bash}`;
}

function fishQuote(text) {
  return `'${String(text ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// ── doctor ───────────────────────────────────────────────────────────────────

async function doctor(global, env, dependencies) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const node = (dependencies.nodeVersion ?? process.versions.node).split(".").map(Number);
  const nodeOk = node[0] > MIN_NODE[0] || (node[0] === MIN_NODE[0] && (node[1] > MIN_NODE[1] || (node[1] === MIN_NODE[1] && node[2] >= MIN_NODE[2])));
  add("node", nodeOk ? "pass" : "fail", `Node.js ${node.join(".")}${nodeOk ? "" : ` (requires ${MIN_NODE.join(".")} or newer)`}`);
  add("cli", "pass", `${PACKAGE_NAME} ${CLI_VERSION}`);

  let client = null;
  try {
    client = createClient(global, env, dependencies);
    add("url", "pass", client.apiUrl.origin);
  } catch (error) {
    add("url", "fail", error instanceof CliError ? error.message : "Invalid configuration.");
  }
  add("token", "pass", env.WORKGRID_TOKEN ? "WORKGRID_TOKEN is set (value hidden)" : "not set (fine unless your deployment requires one)");

  if (client) {
    try {
      const board = await client.get();
      const supported = board?.apiVersion === 1;
      add("server", supported ? "pass" : "fail", supported ? `reachable · API v1 · ${sanitizeText(board.revision)}` : `unsupported API version ${JSON.stringify(board?.apiVersion)}`);
    } catch (error) {
      add("server", "fail", error instanceof CliError ? error.message : "Request failed.");
    }
  }

  try {
    const bundled = await readBundledSkill();
    const paths = { home: dependencies.home ?? homedir(), cwd: dependencies.cwd ?? process.cwd() };
    for (const scope of ["user", "project"]) {
      for (const target of resolveTargets("all", scope, paths)) {
        const state = await inspectSkill(target, bundled);
        if (state === "absent" && !(scope === "user" && target.agent === "agents")) continue;
        const status = state === "current" ? "pass" : "warn";
        const detail = { current: "current", outdated: "outdated — run `workgrid skill install`", foreign: "a different SKILL.md is installed here", unsafe: "the SKILL.md path is not a regular file", absent: "not installed — run `workgrid skill install`" }[state];
        add(`skill (${target.agent}, ${scope})`, status, `${detail} · ${target.path}`);
      }
    }
  } catch (error) {
    add("skill", "fail", error instanceof CliError ? error.message : "Could not inspect skills.");
  }
  return { checks };
}
