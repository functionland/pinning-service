/**
 * The FxFiles → Worker delegation endpoint (`POST /capability`) + audit (H2).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * DELEGATION AUTH — the design (advisor-reviewed: Codex GPT-5.5 + Cursor)
 * ──────────────────────────────────────────────────────────────────────
 * FxFiles (the mobile app that HOLDS the master KEK) must hand the Worker a
 * SCOPED capability — { workspace_secret (≠ KEK), mcp_secret, refresh_token,
 * refresh_url, endpoint } — authenticated as the SPECIFIC Fula user, WITHOUT the
 * Worker ever holding the pinning service's JWT_SECRET.
 *
 * How: FxFiles runs the Worker's OWN Google OAuth (it is just another OAuth
 * client of this Worker — the same provider H1 already exposes; reuse it) and so
 * obtains a Worker ACCESS TOKEN bound to the user's verified Google identity. It
 * then POSTs the capability JSON to `/capability` with `Authorization: Bearer
 * <that worker access token>`. The Worker validates the token via the OAuth
 * provider's own `unwrapToken` (which looks the opaque token up in KV, REJECTS a
 * forged/unknown token, ENFORCES expiry, and decrypts the grant props using a key
 * wrapped WITH the token — so a tampered token can't even decrypt props). The
 * verified `userId` (= SHA-256(lowercased email)) drives `sealCapability`.
 *
 * Why this is sound:
 *   • Authenticates as the specific user — the token's `userId`/`props` are the
 *     verified Google identity, cross-checked here against props.userId AND
 *     re-derived from props.email (defense in depth).
 *   • The Worker never holds the pinning JWT_SECRET — it validates ITS OWN tokens
 *     against ITS OWN KV; it never mints or verifies a pinning/gateway JWT.
 *   • Bearer-token app→API POST: CSRF is not in play (no ambient cookie auth on
 *     this route; the credential is an explicit Authorization header). The bearer
 *     is the only thing that authorizes the write.
 *   • Replay: the request is naturally IDEMPOTENT — `sealCapability` UPSERTs one
 *     row per user with a fresh DEK/record_id, so a replayed POST simply re-seals
 *     the same (or a newer) capability. Each call is audited (with the record_id),
 *     so a replay/anomaly is visible. (A stricter per-request nonce/jti is a
 *     possible future hardening; not required for correctness here.)
 *
 * Scope check: we require the token to carry the `mcp` scope (the only scope this
 * AS grants) — an over-broad or scopeless token is refused. Possession-proof of
 * the workspace_secret is deliberately NOT required: OAuth already authenticates
 * the user, and requiring extra secret material to "prove possession" would only
 * widen exposure. (Codex/Cursor agreed this is optional, not load-bearing.)
 */

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { openBaoFromEnv } from "./openbao.js";
import {
  sealCapability,
  openCapability,
  type Capability,
  type CapabilityData,
  type D1Like,
} from "./custody.js";
import { emailToUserId } from "./userId.js";

/** The auth props the OAuth grant carries (set by the Google federation). */
interface FulaAuthProps {
  email?: string;
  name?: string;
  userId?: string;
  [k: string]: unknown;
}

/** Env shape the capability endpoint needs. */
export interface CapabilityEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  CUSTODY_DB: D1Like;
  OPENBAO_ADDR: string;
  OPENBAO_ROLE_ID: string;
  OPENBAO_SECRET_ID: string;
  OPENBAO_TRANSIT_KEY: string;
}

/** The route the delegation endpoint is served at. */
export const CAPABILITY_ROUTE = "/capability";

/**
 * Handle `POST /capability`. Returns a Response. Never logs the capability body
 * or any secret. On success: 204 No Content (nothing to return — the capability
 * is now custodied). On any auth/validation failure: a terse 4xx, fail-closed.
 */
export async function handleCapability(
  request: Request,
  env: CapabilityEnv,
): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  // ── 1. Authenticate the caller as the specific Fula user ──────────────────
  const bearer = extractBearer(request);
  if (!bearer) {
    return unauthorized("missing_bearer");
  }
  // unwrapToken: validates against KV, rejects forged/unknown tokens, enforces
  // expiry, and decrypts props with a key wrapped WITH the token. Returns null
  // on ANY of those failures. We never see the pinning JWT_SECRET.
  const summary = await env.OAUTH_PROVIDER.unwrapToken<FulaAuthProps>(bearer);
  if (!summary) {
    return unauthorized("invalid_token");
  }
  // Scope gate: the token MUST carry the `mcp` scope this AS grants. A scopeless
  // or differently-scoped token is refused (no scope escalation into custody).
  const scopes = summary.scope ?? summary.grant?.scope ?? [];
  if (!scopes.includes("mcp")) {
    return unauthorized("insufficient_scope");
  }

  // Resolve the authenticated user_id. The token's own `userId` is authoritative
  // (set at federation = SHA-256(lowercased email)); cross-check it against the
  // decrypted props and re-derive from the email as defense in depth.
  const props = summary.grant?.props ?? {};
  const tokenUserId = summary.userId;
  let userId = tokenUserId;
  if (typeof props.email === "string" && props.email) {
    const derived = await emailToUserId(props.email);
    if (derived !== tokenUserId) {
      // The verified identity and the token subject disagree — refuse.
      return unauthorized("identity_mismatch");
    }
    userId = derived;
  } else if (typeof props.userId === "string" && props.userId !== tokenUserId) {
    return unauthorized("identity_mismatch");
  }
  if (!/^[0-9a-f]{64}$/.test(userId)) {
    return unauthorized("invalid_subject");
  }

  // ── 2. Parse + validate the capability body ───────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const cap = validateCapability(body);
  if (!cap) {
    return json(400, { error: "invalid_capability" });
  }

  // ── 3. Seal it (in-memory only during sealing; then OpenBao-wrapped at rest) ─
  let recordId: string;
  try {
    const bao = openBaoFromEnv(env);
    recordId = await sealCapability(env.CUSTODY_DB, bao, userId, cap);
  } catch (e) {
    // TEMP diagnostic — surface the coarse seal-failure class (no secrets:
    // OpenBao errors carry only a `kind` + HTTP status). Revert after diagnosis.
    const detail =
      e && typeof e === "object" && "kind" in e
        ? `${(e as { kind: string }).kind}: ${(e as Error).message}`
        : e instanceof Error
          ? e.message
          : String(e);
    console.error("capability seal failed:", detail);
    // Fail closed. Audit the failure (no secret material in the detail).
    await recordAudit(env.CUSTODY_DB, userId, "capability_seal_failed", {});
    return json(503, { error: "custody_unavailable", detail });
  }

  // ── 4. Supplementary audit (non-secret context; best-effort) ──────────────
  // sealCapability already wrote an ATOMIC `capability_sealed` audit row in the
  // same D1 batch as the credential, so the seal is never unaudited. This extra
  // `capability_delegated` row adds delegation context (the client_id) and is
  // best-effort — its failure must not undo a successful seal.
  await recordAudit(env.CUSTODY_DB, userId, "capability_delegated", {
    record_id: recordId,
    client_id: summary.grant?.clientId,
  });

  return new Response(null, { status: 204 });
}

/**
 * Load + decrypt a user's custodied capability for a session (H3 entry point).
 * ════════════════════════════════════════════════════════════════════════════
 * H3 (the tools) will call this ONCE per authenticated MCP session to obtain the
 * in-memory Capability, use it to refresh the Layer-1 gateway token + dispatch
 * tools, then `dispose()` it. We expose ONLY the load+decrypt here (no tools yet).
 *
 * Returns null if the user has no custodied capability. THROWS (fail-closed) if
 * OpenBao is unreachable (no live KEK) or the row fails AEAD/identity verification
 * — H3 must treat a throw as "custody unavailable", never as "no capability".
 * The caller OWNS the returned Capability and MUST `dispose()` it after use.
 */
export async function loadCapabilityForSession(
  env: CapabilityEnv,
  userId: string,
): Promise<Capability | null> {
  const bao = openBaoFromEnv(env);
  return openCapability(env.CUSTODY_DB, bao, userId);
}

// ── Capability body validation ───────────────────────────────────────────────
// Accept ONLY the five known string fields; reject anything missing/mistyped.
// We do not store extra keys (avoids smuggling unexpected data into the blob).
function validateCapability(body: unknown): CapabilityData | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const need = (k: string): string | null =>
    typeof b[k] === "string" && (b[k] as string).length > 0 ? (b[k] as string) : null;
  const workspace_secret = need("workspace_secret");
  const mcp_secret = need("mcp_secret");
  const refresh_token = need("refresh_token");
  const refresh_url = need("refresh_url");
  const endpoint = need("endpoint");
  if (!workspace_secret || !mcp_secret || !refresh_token || !refresh_url || !endpoint) {
    return null;
  }
  // refresh_url / endpoint must be https URLs (no plaintext exfil targets).
  if (!isHttpsUrl(refresh_url) || !isHttpsUrl(endpoint)) return null;
  return { workspace_secret, mcp_secret, refresh_token, refresh_url, endpoint };
}

function isHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}

// ── Append-only audit ────────────────────────────────────────────────────────
/**
 * Insert an audit row. `detail` is a small JSON object of NON-SECRET context —
 * never the capability, the DEK, or any plaintext secret. Best-effort: an audit
 * write failure must not mask the primary outcome, but we surface nothing secret.
 */
export async function recordAudit(
  db: D1Like,
  userId: string,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO mcp_audit (user_id, action, ts, detail) VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(userId, action, Math.floor(Date.now() / 1000), JSON.stringify(detail))
      .run();
  } catch {
    // Swallow — auditing is best-effort and must not throw into the request path.
  }
}

// ── small helpers ────────────────────────────────────────────────────────────
function extractBearer(request: Request): string | null {
  const h = request.headers.get("Authorization") ?? request.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m && m[1] ? m[1].trim() : null;
}

function unauthorized(error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "WWW-Authenticate": `Bearer error="${error}"`,
    },
  });
}

function json(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
