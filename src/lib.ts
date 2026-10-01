// Shared helpers: tokens, hashing, the secret filter and scope overlap.

export const TOKEN_PREFIX = "ar1";

export const LIMITS = {
  messageChars: 5000,
  titleChars: 200,
  statusChars: 200,
  nameChars: 40,
  scopeCount: 20,
  scopeChars: 200,
  writesPerMinute: 60,
  heartbeatsPerMinute: 120,
  defaultLeaseMs: 20 * 60_000,
  maxLeaseMs: 2 * 60 * 60_000,
  minLeaseMs: 60_000,
  staleMs: 10 * 60_000,
  goneMs: 30 * 60_000,
  syncDefault: 100,
  syncMax: 500,
  idemKeepMs: 24 * 60 * 60_000,
  strikesForBan: 3, // rule 5: per hour
  badTokenStrikes: 5, // rule 2: per 10 minutes, one source
  badTokenWindowMs: 10 * 60_000,
  slowMs: 10 * 60_000, // rule 2: tokenless calls from one address, 429
  floodStrikes: 3, // rule 5 step trigger: per hour
  readOnlyMs: 15 * 60_000,
  repeatMessages: 5, // near-identical messages from one agent...
  repeatWindowMs: 10 * 60_000, // ...in this window
  repeatSimilarity: 0.9,
  claimFightRefusals: 10, // refused scope claims from one agent...
  claimFightWindowMs: 10 * 60_000, // ...in this window pause its claiming for readOnlyMs
  estimateMinutesMax: 100_000,
  tokensMax: 2_000_000_000,
};

export const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export interface ParsedToken {
  project: string;
  agentId: string;
  raw: string;
}

/** Token format: ar1.<project>.<agentId>.<secret>. Returns null when malformed. */
export function parseToken(raw: string | null | undefined): ParsedToken | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) return null;
  const [, project, agentId, secret] = parts;
  if (!PROJECT_RE.test(project)) return null;
  if (!/^a[0-9a-f]{12}$/.test(agentId)) return null;
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(secret)) return null;
  return { project, agentId, raw };
}

export function randomId(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function randomSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = btoa(String.fromCharCode(...b));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newAgentId(): string {
  return "a" + randomId(6);
}

export function makeToken(project: string, agentId: string): string {
  return `${TOKEN_PREFIX}.${project}.${agentId}.${randomSecret()}`;
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare over hashes so length and content do not leak. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Secret filter. Refuses text that looks like a key or token. Git shas, uuids
// and ordinary paths pass; they are hex or low-entropy.

const SECRET_PATTERNS: [string, RegExp][] = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["aws access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{16,}/],
  ["openai-style key", /\bsk-(proj-|live-|test-)?[A-Za-z0-9_-]{20,}/],
  ["github token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ["slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["stripe key", /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["agent room token", /\bar1\.[a-z0-9-]+\.a[0-9a-f]{12}\.[A-Za-z0-9_-]{20,}/],
  ["bearer header", /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}=*/],
];

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Returns the reason text was refused, or null if it passes. */
export function secretReason(text: string): string | null {
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) return name;
  // Long mixed-case alphanumeric runs with high entropy look like generated keys.
  for (const m of text.matchAll(/[A-Za-z0-9+_=-]{32,}/g)) {
    const w = m[0];
    if (/[a-z]/.test(w) && /[A-Z]/.test(w) && /[0-9]/.test(w) && entropy(w) >= 4.2) {
      return "high-entropy string";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scopes. A scope is a repo path pattern (src/auth/*, src/**, README.md) or a
// named area (db-schema). Overlap is decided conservatively: a pattern with a
// wildcard covers everything under the literal part before the first wildcard.

interface ScopeShape {
  base: string;
  wild: boolean;
}

function shape(scope: string): ScopeShape {
  let s = scope.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  const i = s.search(/[*?[{]/);
  if (i === -1) return { base: s.replace(/\/+$/, ""), wild: false };
  return { base: s.slice(0, i), wild: true };
}

function coversPrefix(literal: string, other: string): boolean {
  // literal path covers itself and its subtree
  return other === literal || other.startsWith(literal + "/");
}

export function scopesOverlap(a: string, b: string): boolean {
  const x = shape(a);
  const y = shape(b);
  if (x.wild && y.wild) return x.base.startsWith(y.base) || y.base.startsWith(x.base);
  if (x.wild) return y.base.startsWith(x.base) || x.base.startsWith(y.base + "/") || x.base === y.base;
  if (y.wild) return x.base.startsWith(y.base) || y.base.startsWith(x.base + "/") || y.base === x.base;
  return coversPrefix(x.base, y.base) || coversPrefix(y.base, x.base);
}

export function parseMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(^|[^A-Za-z0-9._-])@([A-Za-z0-9][A-Za-z0-9._-]{0,39})/g)) {
    out.add(m[2].replace(/[.]+$/, ""));
  }
  return [...out];
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(String(body.error ?? status));
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export const RULES: Record<number, string> = {
  1: "join with the project key but no valid orchestrator credential or parent token",
  2: "5 calls without a valid token in 10 minutes from one source (tokenless calls from it slowed 10 minutes)",
  3: "token used against a project it was not issued for (that token revoked)",
  4: "parent is gone or banned (no longer used: see rule 6)",
  6: "join naming a parent token that is not live or not in the joiner's chain (refused; the parent is told)",
  5: "flooding (over 60 writes a minute, 3 times in an hour: warning, 15 minutes read-only, then revoked), or 3 messages refused by the secret filter",
};

export const MAX_BODY = 64 * 1024;

/** A JSON object of strings from a secret or var; anything else reads as empty. */
export function jsonMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** The request's JSON object body; {} for a GET or an empty body. Throws HttpError 413 or 400. */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET") return {};
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, { error: "body_too_large" });
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, { error: "bad_json" });
  }
}
