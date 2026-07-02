/**
 * Post-sign-in FULA-id interstitial + the mint-on-continue completion
 * (google.ts). Pure / mock only — no Google, no OpenBao, no D1.
 *
 * The load-bearing property under test is the HARD RULE "login must never
 * break": a missing / corrupt / field-incomplete continue cookie, or a
 * completeAuthorization failure, must ALL yield a graceful, retryable reconnect
 * page (HTTP 200, no throw) — never a 500 and never a silently-broken grant.
 */
import { describe, it, expect, vi } from "vitest";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import {
  handleCallbackContinue,
  completeAndRedirect,
  renderIdentityInterstitial,
  renderReconnectPage,
  sealCookie,
  type FederationEnv,
} from "../src/google.js";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 64 hex
const CONTINUE_COOKIE = "__Host-fula_mcp_continue";
const REDIRECT_TO = "https://claude.ai/api/mcp/callback?code=abc123";

function mockEnv(completeImpl?: () => unknown): FederationEnv {
  return {
    COOKIE_ENCRYPTION_KEY: KEY,
    OAUTH_PROVIDER: {
      completeAuthorization: completeImpl
        ? vi.fn(completeImpl)
        : vi.fn().mockResolvedValue({ redirectTo: REDIRECT_TO }),
    },
  } as unknown as FederationEnv;
}

const AUTH_REQ = {
  clientId: "client-xyz",
  redirectUri: "https://claude.ai/api/mcp/callback",
  scope: ["mcp"],
  responseType: "code",
} as unknown as AuthRequest;

function continueRequest(cookieValue: string | null): Request {
  const headers: Record<string, string> = {};
  if (cookieValue !== null) headers["Cookie"] = `${CONTINUE_COOKIE}=${cookieValue}`;
  return new Request("https://mcp.cloud.fx.land/callback/continue", { method: "POST", headers });
}

describe("identity interstitial rendering", () => {
  it("shows the FULA-id, the ask-the-AI hint, the continue form, and the nonce", () => {
    const html = renderIdentityInterstitial("FULA-abc_DEF-123", "n0nc3hex");
    expect(html).toContain("FULA-abc_DEF-123");
    expect(html).toContain("What is my Fula id?");
    expect(html).toContain('action="/callback/continue"');
    expect(html).toContain('method="POST"');
    expect(html).toContain('nonce="n0nc3hex"');
    expect(html).toContain("Share with AI Agent");
    // The step-by-step instructions the user must follow.
    expect(html).toContain("Next steps");
    expect(html).toContain("New Collaborate");
    expect(html).toContain("files.fx.land");
    expect(html).toContain("Finish connecting");
  });

  it("HTML-escapes the id defensively (no raw markup injected)", () => {
    const html = renderIdentityInterstitial('FULA-<script>"x"', "n");
    expect(html).not.toContain('FULA-<script>');
    expect(html).toContain("&lt;script&gt;");
  });

  it("reconnect page is self-contained and tells the user to re-add the connector", () => {
    const html = renderReconnectPage();
    expect(html).toContain("<!doctype html>");
    expect(html.toLowerCase()).toContain("re-add");
  });
});

describe("completeAndRedirect", () => {
  it("mints via completeAuthorization, 302s to redirectTo, clears the given cookie", async () => {
    const env = mockEnv();
    const res = await completeAndRedirect(
      env,
      AUTH_REQ,
      "user-1",
      ["mcp"],
      { email: "e@x.com", name: "E", userId: "user-1", clientId: "client-xyz" },
      "__Host-fula_mcp_oauth_state",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(REDIRECT_TO);
    expect(env.OAUTH_PROVIDER.completeAuthorization).toHaveBeenCalledTimes(1);
    expect(env.OAUTH_PROVIDER.completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        request: AUTH_REQ,
        userId: "user-1",
        scope: ["mcp"],
        props: expect.objectContaining({ clientId: "client-xyz", userId: "user-1" }),
      }),
    );
    expect(res.headers.get("Set-Cookie") ?? "").toContain("__Host-fula_mcp_oauth_state=");
  });
});

describe("handleCallbackContinue — mint the code only on Finish", () => {
  it("completes login with a valid sealed cookie and clears the continue cookie", async () => {
    const env = mockEnv();
    const sealed = await sealCookie(
      JSON.stringify({ authRequest: AUTH_REQ, userId: "user-1", email: "e@x.com", name: "E", scope: ["mcp"] }),
      KEY,
    );
    const res = await handleCallbackContinue(continueRequest(sealed), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(REDIRECT_TO);
    expect(env.OAUTH_PROVIDER.completeAuthorization).toHaveBeenCalledTimes(1);
    expect(res.headers.get("Set-Cookie") ?? "").toContain(`${CONTINUE_COOKIE}=`);
  });

  it("NEVER breaks login: missing cookie → graceful reconnect page, no grant minted", async () => {
    const env = mockEnv();
    const res = await handleCallbackContinue(continueRequest(null), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<!doctype html>");
    expect(env.OAUTH_PROVIDER.completeAuthorization).not.toHaveBeenCalled();
  });

  it("NEVER breaks login: corrupt cookie → graceful reconnect page (no throw)", async () => {
    const env = mockEnv();
    const res = await handleCallbackContinue(continueRequest("not-a-valid-sealed-value"), env);
    expect(res.status).toBe(200);
    expect(env.OAUTH_PROVIDER.completeAuthorization).not.toHaveBeenCalled();
  });

  it("NEVER breaks login: completeAuthorization throws → graceful reconnect page", async () => {
    const env = mockEnv(() => {
      throw new Error("KV unavailable");
    });
    const sealed = await sealCookie(
      JSON.stringify({ authRequest: AUTH_REQ, userId: "user-1", email: "e@x.com", scope: ["mcp"] }),
      KEY,
    );
    const res = await handleCallbackContinue(continueRequest(sealed), env);
    expect(res.status).toBe(200);
    expect((await res.text()).toLowerCase()).toContain("timed out");
  });

  it("rejects a well-formed cookie that is missing required fields → reconnect", async () => {
    const env = mockEnv();
    const sealed = await sealCookie(JSON.stringify({ foo: "bar" }), KEY);
    const res = await handleCallbackContinue(continueRequest(sealed), env);
    expect(res.status).toBe(200);
    expect(env.OAUTH_PROVIDER.completeAuthorization).not.toHaveBeenCalled();
  });
});
