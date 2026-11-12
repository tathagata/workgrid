import { CliError, EXIT } from "./errors.js";

export const DEFAULT_URL = "http://127.0.0.1:4173";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 4096;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validates the user-supplied origin and returns the only endpoint the CLI ever calls.
 * Rejects embedded credentials, non-HTTP schemes, and remote plaintext HTTP by default.
 */
export function normalizeApiUrl(input, allowHttp) {
  let url;
  try { url = new URL(input); } catch { throw new CliError("INVALID_URL", "--url must be a valid absolute HTTP or HTTPS URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CliError("INVALID_URL", "--url must use HTTP or HTTPS.");
  if (url.username || url.password) throw new CliError("INVALID_URL", "Do not put credentials in --url; use WORKGRID_TOKEN.");
  if (url.search || url.hash) throw new CliError("INVALID_URL", "--url must not include a query string or fragment.");
  if (url.protocol === "http:" && !isLoopback(url.hostname) && !allowHttp) {
    throw new CliError("INSECURE_URL", "Plaintext HTTP is allowed only for loopback hosts; use HTTPS or pass --allow-http explicitly.");
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path !== "/" && path !== "/api/board") throw new CliError("INVALID_URL", "--url must be a Workgrid origin or end with /api/board.");
  return new URL("/api/board", url.origin);
}

export function isLoopback(hostname) {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function normalizeToken(value) {
  if (!value) return undefined;
  // Header-injection guard: printable ASCII only, bounded length.
  if (value.length > MAX_TOKEN_LENGTH || !/^[\x21-\x7e]+$/.test(value)) throw new CliError("INVALID_TOKEN", "WORKGRID_TOKEN is invalid.", EXIT.AUTH);
  return value;
}

export class WorkgridClient {
  constructor({ apiUrl, timeoutMs, token, fetchImpl, userAgent }) {
    this.apiUrl = apiUrl;
    this.timeoutMs = timeoutMs;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
  }

  get(query) {
    const url = new URL(this.apiUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    return this.request(url, { method: "GET" });
  }

  post(action, payload) {
    return this.request(this.apiUrl, { method: "POST", body: JSON.stringify({ action, payload }) });
  }

  async request(url, init) {
    const headers = {
      accept: "application/json",
      "user-agent": this.userAgent,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
    let result;
    try {
      result = await this.fetchImpl(url, {
        ...init,
        headers,
        // A redirect could forward the bearer token or a mutation to another origin.
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error && typeof error === "object" && (error.name === "TimeoutError" || error.name === "AbortError");
      // Never echo the underlying error: it may contain the URL, headers, or token.
      throw new CliError(
        timedOut ? "REQUEST_TIMEOUT" : "REQUEST_FAILED",
        timedOut ? "The Workgrid request timed out." : `Could not reach Workgrid at ${this.apiUrl.origin}. Is the app running?`,
        EXIT.FAILURE,
      );
    }

    if (result.status === 401 || result.status === 403) {
      await result.body?.cancel().catch(() => {});
      throw new CliError("AUTH_FAILED", "Workgrid rejected the credentials. Check WORKGRID_TOKEN.", EXIT.AUTH);
    }
    const contentType = result.headers.get("content-type") ?? "";
    if (!/\bjson\b/i.test(contentType)) {
      await result.body?.cancel().catch(() => {});
      throw new CliError("INVALID_RESPONSE", `Workgrid returned a non-JSON response (HTTP ${result.status}).`, EXIT.FAILURE);
    }
    const text = await readBoundedText(result, MAX_RESPONSE_BYTES);
    let value;
    try { value = JSON.parse(text); } catch { throw new CliError("INVALID_RESPONSE", "Workgrid returned invalid JSON.", EXIT.FAILURE); }
    if (!result.ok) throw apiError(value, result.status);
    return value;
  }
}

async function readBoundedText(response, maximumBytes) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => {});
    throw new CliError("RESPONSE_TOO_LARGE", "Workgrid returned a response larger than the CLI limit.", EXIT.FAILURE);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => {});
      throw new CliError("RESPONSE_TOO_LARGE", "Workgrid returned a response larger than the CLI limit.", EXIT.FAILURE);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function apiError(value, status) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) && value.error && typeof value.error === "object" ? value.error : {};
  const code = typeof candidate.code === "string" && SAFE_ERROR_CODE.test(candidate.code) ? candidate.code : "REQUEST_REJECTED";
  const message = typeof candidate.message === "string" && candidate.message.length <= 500 ? candidate.message : `Workgrid rejected the request (HTTP ${status}).`;
  const extra = {};
  if (typeof candidate.field === "string" && candidate.field.length <= 200) extra.field = candidate.field;
  if (isSafeDetails(candidate.details)) extra.details = candidate.details;
  const exitCode = code === "NOT_FOUND" ? EXIT.NOT_FOUND : code === "CONFLICT" ? EXIT.CONFLICT : code === "INTERNAL" || status >= 500 ? EXIT.FAILURE : EXIT.USAGE;
  return new CliError(code, message, exitCode, extra);
}

function isSafeDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try { return JSON.stringify(value).length <= 4096; } catch { return false; }
}
