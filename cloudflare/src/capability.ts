/**
 * FxFiles → Worker collaboration CONNECT flow + per-user-account custody.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * This REPLACES the bespoke per-user "AI workspace" capability (workspace_secret /
 * mcp_secret / gateway refresh) with the collaboration-group model (mirrors the
 * merged Rust `fula-mcp` rework). Two authenticated routes drive it:
 *
 *   GET  /collab/connection   → the Worker's X25519 PUBLIC key + FULA-id, so
 *                               FxFiles can wrap the group link secret TO this
 *                               connection. (loadOrGenerateMcpIdentity)
 *
 * ## ⚠️ KEYING IS PER FULA USER ACCOUNT (one group per user at a time)
 *
 * Custody is keyed solely by `user_id = SHA-256(verified email)` (the D1 PK), so
 * there is exactly ONE keypair + ONE bundle per Fula user. Consequences (no
 * cross-user breach — different emails ⇒ different rows — but flag for the owner):
 *   • Two MCP clients of the SAME Google account (e.g. Claude.ai AND ChatGPT)
 *     share the one keypair + bundle.
 *   • A second `POST /collab/bundle` SILENTLY OVERWRITES the first group's bundle
 *     (the connection now operates on the newer group).
 * If concurrent multi-client / multi-group per account is ever required, key the
 * custody by `(user_id, client_id)` or `(user_id, group_id)` instead — a schema +
 * plumbing change deliberately deferred for this proposed-contract PR.
 *   POST /collab/bundle        → store the delivered capability bundle
 *                               { webui_base, group_id, manifest_bucket,
 *                                 manifest_key, wrapped_link_secret,
 *                                 collab_write_token?, refresh_token?, refresh_url? }.
 *
 * Auth is UNCHANGED from the old `/capability` delegation: FxFiles holds a Worker
 * OAuth access token (the same provider the MCP exposes), and the Worker validates
 * it via `OAUTH_PROVIDER.unwrapToken` (rejects forged/expired, decrypts props),
 * requires the `mcp` scope, and derives the verified `user_id = SHA-256(email)`.
 *
 * ## Custody — KEPT (OpenBao envelope), simplified payload
 *
 * We REUSE the OpenBao-wrapped D1 envelope (custody.ts) — but the sealed payload is
 * now {@link CollabCustodyData} = the Worker's persistent X25519 SECRET key + the
 * latest delivered bundle. Keeping OpenBao still buys the at-rest guarantee: the
 * X25519 secret is what UNWRAPS the link secret, and the bundle (which also carries
 * the `wrapped_link_secret` + long-lived `refresh_token`) sits in the SAME sealed
 * row — so a D1 dump without a live OpenBao decrypts to nothing. (Owner sign-off
 * note in the PR: this is why OpenBao is retained rather than plaintext D1.)
 *
 * ## ⚠️ This is a PROPOSED delivery contract (no producer exists yet)
 *
 * As of this PR NO client wraps a collab link secret to an MCP pubkey on either end
 * (FxFiles still ships the old workspace model; the server has no collab-bundle
 * producer). So this connect flow + bundle shape is a PROPOSED seam, validated by
 * unit tests (auth, validation, seal/open round-trip) but NOT exercisable end to
 * end. See the PR notes. The link-secret unwrap itself needs a fula-client binding
 * for the real v5-ShareToken contract (see ./fula/collab/identity.ts).
 */

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { openBaoFromEnv } from "./openbao.js";
import { sealCapability, openCapability, type Capability, type D1Like } from "./custody.js";
import { emailToUserId } from "./userId.js";
import {
  encodeFulaId,
  publicKeyB64,
  publicKeyFromSecret,
  recoverLinkSecret,
} from "./fula/collab/identity.js";
import type { CollabSession } from "./fula/collab/tools.js";

/** The auth props the OAuth grant carries (set by the Google federation). */
interface FulaAuthProps {
  email?: string;
  name?: string;
  userId?: string;
  [k: string]: unknown;
}

/** Env shape the collab connect endpoints + session loader need. */
export interface CapabilityEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  CUSTODY_DB: D1Like;
  OPENBAO_ADDR: string;
  OPENBAO_ROLE_ID: string;
  OPENBAO_SECRET_ID: string;
  OPENBAO_TRANSIT_KEY: string;
  /**
   * DEV-ONLY escape hatch (unset in production): when "1", the link-secret unwrap
   * accepts a bare HPKE envelope (the `testHpkeEncryptDek` format) in addition to
   * the real v5 ShareToken. Left UNSET so the live path is fail-closed v5-only
   * until a fula-client DEK binding lands (see ./fula/collab/identity.ts).
   */
  COLLAB_ALLOW_BARE_HPKE?: string;
}

/** Routes the collab connect endpoints are served at. */
export const COLLAB_CONNECTION_ROUTE = "/collab/connection";
export const COLLAB_BUNDLE_ROUTE = "/collab/bundle";

/**
 * The capability bundle delivered per AI connection (mirrors the Rust
 * `CapabilityBundleJson`). Every URL is HTTPS (or loopback for dev). The
 * `wrapped_link_secret` is a serialized fula ShareToken (the real contract) or a
 * bare HPKE envelope (interim) addressed to THIS connection's X25519 pubkey.
 */
export interface CollabBundleData {
  webui_base: string;
  group_id: string;
  manifest_bucket: string;
  manifest_key: string;
  wrapped_link_secret: string;
  collab_write_token?: string;
  refresh_token?: string;
  refresh_url?: string;
  user_id?: string;
  [k: string]: unknown;
}

/**
 * What the Worker seals per user (OpenBao-wrapped D1): the connection's persistent
 * X25519 SECRET key (base64) + the latest delivered bundle. The secret is generated
 * once at first `GET /collab/connection` and never leaves the Worker (only its
 * public key / FULA-id are exposed).
 */
export interface CollabCustodyData {
  mcp_secret_b64: string;
  bundle?: CollabBundleData;
  [k: string]: unknown;
}

// ── Connect endpoints ────────────────────────────────────────────────────────

/**
 * `GET /collab/connection` — return the Worker's per-connection X25519 public key
 * + FULA-id (generating + sealing the keypair on first call). FxFiles addresses
 * the wrapped link secret to this key.
 *
 * KNOWN LIMITATION (flagged): two concurrent FIRST requests for the same user can
 * each generate a keypair and race the D1 upsert (last-writer-wins) → a bundle
 * wrapped to the losing pubkey can't be unwrapped. The window is narrow (the
 * pubkey fetch precedes bundle delivery, and a single client serializes it).
 */
export async function handleCollabConnection(request: Request, env: CapabilityEnv): Promise<Response> {
  if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
  const auth = await authenticateUser(request, env);
  if (auth instanceof Response) return auth;

  let identity: { mcpPubB64: string; mcpFulaId: string };
  try {
    identity = await loadOrGenerateMcpIdentity(env, auth.userId);
  } catch {
    await recordAudit(env.CUSTODY_DB, auth.userId, "collab_identity_failed", {});
    return json(503, { error: "custody_unavailable" });
  }
  await recordAudit(env.CUSTODY_DB, auth.userId, "collab_connection", {});
  return json(200, { mcp_pub_b64: identity.mcpPubB64, mcp_fula_id: identity.mcpFulaId });
}

/**
 * `POST /collab/bundle` — store the delivered capability bundle for this user. The
 * connection keypair MUST already exist (the client fetched the pubkey first to
 * wrap the link secret), else 409 — we never generate a fresh keypair here, which
 * would not match the pubkey the bundle was wrapped to.
 */
export async function handleCollabBundle(request: Request, env: CapabilityEnv): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const auth = await authenticateUser(request, env);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const bundle = validateBundle(body);
  if (!bundle) return json(400, { error: "invalid_bundle" });

  try {
    await storeCollabBundle(env, auth.userId, bundle);
  } catch (e) {
    if (e instanceof NoConnectionIdentityError) {
      return json(409, { error: "no_connection_identity", detail: "GET /collab/connection first" });
    }
    await recordAudit(env.CUSTODY_DB, auth.userId, "collab_bundle_seal_failed", {});
    return json(503, { error: "custody_unavailable" });
  }
  await recordAudit(env.CUSTODY_DB, auth.userId, "collab_bundle_delivered", {
    group_id: bundle.group_id,
  });
  return new Response(null, { status: 204 });
}

// ── Identity + bundle custody ────────────────────────────────────────────────

/** Raised when a bundle is delivered before the connection keypair was created. */
export class NoConnectionIdentityError extends Error {
  constructor() {
    super("no_connection_identity");
    this.name = "NoConnectionIdentityError";
  }
}

/**
 * Load (or first-run generate + seal) the connection's persistent X25519 keypair.
 * Returns the public key (base64) + FULA-id. The SECRET never leaves the seal.
 */
export async function loadOrGenerateMcpIdentity(
  env: CapabilityEnv,
  userId: string,
): Promise<{ mcpPubB64: string; mcpFulaId: string }> {
  const bao = openBaoFromEnv(env);
  const existing = await openCapability<CollabCustodyData>(env.CUSTODY_DB, bao, userId);
  if (existing) {
    try {
      const secret = base64ToBytes(existing.get().mcp_secret_b64);
      const pub = publicKeyFromSecret(secret);
      secret.fill(0);
      return { mcpPubB64: publicKeyB64(pub), mcpFulaId: encodeFulaId(pub) };
    } finally {
      existing.dispose();
    }
  }
  // First run: generate a fresh X25519 secret, seal it (no bundle yet).
  const secret = crypto.getRandomValues(new Uint8Array(32));
  try {
    const pub = publicKeyFromSecret(secret);
    await sealCapability<CollabCustodyData>(env.CUSTODY_DB, bao, userId, { mcp_secret_b64: bytesToBase64(secret) });
    return { mcpPubB64: publicKeyB64(pub), mcpFulaId: encodeFulaId(pub) };
  } finally {
    secret.fill(0);
  }
}

/**
 * Re-seal the connection custody with the delivered bundle, PRESERVING the existing
 * X25519 secret (the bundle was wrapped to its pubkey). Throws
 * {@link NoConnectionIdentityError} if no keypair exists yet.
 */
export async function storeCollabBundle(
  env: CapabilityEnv,
  userId: string,
  bundle: CollabBundleData,
): Promise<void> {
  const bao = openBaoFromEnv(env);
  const existing = await openCapability<CollabCustodyData>(env.CUSTODY_DB, bao, userId);
  if (!existing) throw new NoConnectionIdentityError();
  try {
    const mcpSecretB64 = existing.get().mcp_secret_b64;
    await sealCapability<CollabCustodyData>(env.CUSTODY_DB, bao, userId, { mcp_secret_b64: mcpSecretB64, bundle });
  } finally {
    existing.dispose();
  }
}

/**
 * Open the raw sealed collab custody for a user (keypair + bundle). Returns null
 * when there is no row. The caller OWNS the {@link Capability} and MUST dispose it.
 * (Exposed for the keying-seam test + {@link loadCollabSession}.)
 */
export async function loadCollabCustody(
  env: CapabilityEnv,
  userId: string,
): Promise<Capability<CollabCustodyData> | null> {
  const bao = openBaoFromEnv(env);
  return openCapability<CollabCustodyData>(env.CUSTODY_DB, bao, userId);
}

/**
 * Build a {@link CollabSession} for a user: load the sealed keypair + bundle,
 * recover the link secret with the keypair, and wire the write-token refresh.
 * Returns null when there is no custody OR no delivered bundle (the AI has not
 * been connected to a group yet). THROWS on custody/unwrap failure (fail-closed).
 *
 * The recovered link secret + refreshed write token live ONLY for this request
 * (the session is per-tool-call; nothing secret is cached across isolates).
 */
export async function loadCollabSession(
  env: CapabilityEnv,
  userId: string,
  fetchImpl: typeof fetch,
): Promise<CollabSession | null> {
  const cap = await loadCollabCustody(env, userId);
  if (!cap) return null;
  try {
    const data = cap.get();
    if (!data.bundle) return null; // keypair exists but no group bundle yet
    const bundle = data.bundle;
    const secret = base64ToBytes(data.mcp_secret_b64);
    let linkSecret: Uint8Array;
    let mcpPubB64: string;
    try {
      mcpPubB64 = publicKeyB64(publicKeyFromSecret(secret));
      // Live path is fail-closed v5-only; the bare-envelope shape is enabled ONLY
      // by the dev escape hatch (unset in production — see CapabilityEnv).
      linkSecret = recoverLinkSecret(secret, bundle.wrapped_link_secret, {
        allowBareEnvelope: env.COLLAB_ALLOW_BARE_HPKE === "1",
      });
    } finally {
      secret.fill(0);
    }

    let writeToken: string | undefined = bundle.collab_write_token;
    const session: CollabSession = {
      fetchImpl,
      webuiBase: bundle.webui_base,
      groupId: bundle.group_id,
      manifestBucket: bundle.manifest_bucket,
      linkSecret,
      mcpPublicB64: mcpPubB64,
      collabWriteToken: () => writeToken,
      setCollabWriteToken: (t: string) => {
        writeToken = t;
      },
      refreshUrl: bundle.refresh_url,
      refreshToken: bundle.refresh_token,
    };
    return session;
  } finally {
    cap.dispose(); // best-effort zeroize the sealed plaintext (keypair + bundle)
  }
}

// ── Bundle validation ────────────────────────────────────────────────────────

/** Accept only the known fields; require the load-bearing ones; reject non-https URLs. */
function validateBundle(body: unknown): CollabBundleData | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const req = (k: string): string | null =>
    typeof b[k] === "string" && (b[k] as string).length > 0 ? (b[k] as string) : null;
  const webui_base = req("webui_base");
  const group_id = req("group_id");
  const manifest_bucket = req("manifest_bucket");
  const manifest_key = req("manifest_key");
  const wrapped_link_secret = req("wrapped_link_secret");
  if (!webui_base || !group_id || !manifest_bucket || !manifest_key || !wrapped_link_secret) return null;
  if (!isHttpsOrLoopback(webui_base)) return null;
  const refresh_url = typeof b.refresh_url === "string" && b.refresh_url ? b.refresh_url : undefined;
  if (refresh_url !== undefined && !isHttpsOrLoopback(refresh_url)) return null;

  const out: CollabBundleData = { webui_base, group_id, manifest_bucket, manifest_key, wrapped_link_secret };
  if (typeof b.collab_write_token === "string" && b.collab_write_token) out.collab_write_token = b.collab_write_token;
  if (typeof b.refresh_token === "string" && b.refresh_token) out.refresh_token = b.refresh_token;
  if (refresh_url) out.refresh_url = refresh_url;
  if (typeof b.user_id === "string" && b.user_id) out.user_id = b.user_id;
  return out;
}

/** https:// anywhere, or http:// only for an EXACT loopback host (dev). */
function isHttpsOrLoopback(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") {
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1";
  }
  return false;
}

// ── Shared auth (token unwrap + scope + verified user_id) ─────────────────────

/** Authenticate the caller as a specific Fula user, or return a 4xx Response. */
async function authenticateUser(
  request: Request,
  env: CapabilityEnv,
): Promise<{ userId: string } | Response> {
  const bearer = extractBearer(request);
  if (!bearer) return unauthorized("missing_bearer");
  const summary = await env.OAUTH_PROVIDER.unwrapToken<FulaAuthProps>(bearer);
  if (!summary) return unauthorized("invalid_token");
  const scopes = summary.scope ?? summary.grant?.scope ?? [];
  if (!scopes.includes("mcp")) return unauthorized("insufficient_scope");

  const props = summary.grant?.props ?? {};
  const tokenUserId = summary.userId;
  let userId = tokenUserId;
  if (typeof props.email === "string" && props.email) {
    const derived = await emailToUserId(props.email);
    if (derived !== tokenUserId) return unauthorized("identity_mismatch");
    userId = derived;
  } else if (typeof props.userId === "string" && props.userId !== tokenUserId) {
    return unauthorized("identity_mismatch");
  }
  if (!/^[0-9a-f]{64}$/.test(userId)) return unauthorized("invalid_subject");
  return { userId };
}

// ── Append-only audit ────────────────────────────────────────────────────────
/**
 * Insert an audit row. `detail` is a small JSON object of NON-SECRET context.
 * Best-effort: an audit write failure must not mask the primary outcome.
 */
export async function recordAudit(
  db: D1Like,
  userId: string,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await db
      .prepare(`INSERT INTO mcp_audit (user_id, action, ts, detail) VALUES (?1, ?2, ?3, ?4)`)
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
    headers: { "content-type": "application/json", "WWW-Authenticate": `Bearer error="${error}"` },
  });
}

function json(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}
