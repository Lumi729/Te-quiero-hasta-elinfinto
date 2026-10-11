import { formatWithOptions } from "node:util";

// Logs must never contain the NetEase cookie, Bridge tokens or OAuth bearer tokens.
// NeteaseCloudMusicApi prints whole responses (including Set-Cookie) on errors, so
// every console line is formatted and scrubbed before it reaches stdout / journald.
const HIDDEN = "<hidden>";
const COOKIE_PAIR = /\b((?:[A-Z_]*MUSIC[A-Z_]*|__csrf|NMTID|__remember_me|WEVNSM|WNMCID|ntes_[a-z_]+|_ntes_[a-z_]+)=)([^;\s'",\]}]+)/gi;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const QUERY_SECRET = /([?&](?:session|token|access_token|refresh_token|code)=)[^&\s'"]+/gi;

export function secretValues(env: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>();
  for (const part of (env.NETEASE_COOKIE ?? "").split(";")) {
    const value = part.slice(part.indexOf("=") + 1).trim();
    if (part.includes("=") && value.length >= 6) values.add(value);
  }
  const token = env.BRIDGE_INGEST_TOKEN?.trim();
  if (token && token.length >= 6) values.add(token);
  return [...values].sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(HIDDEN);
  return out.replace(COOKIE_PAIR, "$1" + HIDDEN).replace(BEARER, "$1" + HIDDEN).replace(QUERY_SECRET, "$1" + HIDDEN);
}

type Sink = Pick<Console, "log" | "info" | "warn" | "error" | "debug">;

export function installLogRedaction(env: NodeJS.ProcessEnv = process.env, target: Sink = console): void {
  const secrets = secretValues(env);
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(redact(formatWithOptions({ colors: false, depth: 6 }, ...args), secrets));
  }
}

if (process.env.NODE_ENV !== "test") installLogRedaction();
