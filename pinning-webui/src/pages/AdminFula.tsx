import { useState } from 'react';

// Phase 3.2 admin tab: trigger fula-cli's users-index publisher tick
// and the mainnet-rewards anchor cron on demand. Removes the up-to-5-min
// (publisher) and up-to-12h (anchor) waits from the deploy runbook.
//
// Both buttons POST to /api/admin/fula/{publish-now,anchor-now} which
// the pinning-webui server proxies to the underlying services with a
// shared bearer token (FULA_USERS_INDEX_INTERNAL_TOKEN).
//
// Status semantics from the upstream services (proxied through):
//   200 → success — JSON outcome rendered as preformatted text
//   401 → bearer token mismatch (pinning-webui's env vs. master's)
//   409 → another tick in flight (only for anchor-now)
//   503 → service disabled (publisher OR anchor flag is off)
//   500 → internal error during tick
//   502 → upstream unreachable (network failure to fula-cli or rewards)

type FetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; httpStatus: number; body: unknown }
  | { status: 'error'; httpStatus: number; message: string };

interface ActionCardProps {
  title: string;
  description: string;
  buttonLabel: string;
  endpoint: '/api/admin/fula/publish-now' | '/api/admin/fula/anchor-now';
}

function ActionCard({ title, description, buttonLabel, endpoint }: ActionCardProps) {
  const [state, setState] = useState<FetchState>({ status: 'idle' });

  const onClick = async () => {
    setState({ status: 'loading' });
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      // Always try to parse JSON; the proxy guarantees JSON-or-{error}.
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = { error: 'invalid response from server' };
      }
      if (res.ok) {
        setState({ status: 'ok', httpStatus: res.status, body });
      } else {
        const message =
          (body && typeof body === 'object' && 'error' in body
            ? String((body as { error: unknown }).error)
            : null) || `HTTP ${res.status}`;
        setState({ status: 'error', httpStatus: res.status, message });
      }
    } catch (e) {
      setState({
        status: 'error',
        httpStatus: 0,
        message: e instanceof Error ? e.message : 'network error',
      });
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold mb-2">{title}</h2>
      <p className="text-sm text-gray-600 mb-4">{description}</p>
      <button
        type="button"
        onClick={onClick}
        disabled={state.status === 'loading'}
        className="px-4 py-2 bg-primary-600 text-white rounded font-medium text-sm hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {state.status === 'loading' ? 'Running...' : buttonLabel}
      </button>

      {state.status === 'ok' && (
        <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded text-sm">
          <div className="font-medium text-green-800 mb-2">
            HTTP {state.httpStatus} — success
          </div>
          <pre className="text-xs text-gray-800 whitespace-pre-wrap break-all overflow-x-auto">
            {JSON.stringify(state.body, null, 2)}
          </pre>
        </div>
      )}

      {state.status === 'error' && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-sm">
          <div className="font-medium text-red-800 mb-1">
            {state.httpStatus === 0
              ? 'Network error'
              : `HTTP ${state.httpStatus} — failed`}
          </div>
          <div className="text-red-700 break-words">{state.message}</div>
          {state.httpStatus === 401 && (
            <div className="text-xs text-red-700 mt-2">
              Bearer-token mismatch. Confirm{' '}
              <code className="font-mono">FULA_USERS_INDEX_INTERNAL_TOKEN</code>{' '}
              in pinning-webui's <code>.env</code> matches the value on the
              master's <code>/etc/fula/.env</code> (and{' '}
              <code>/opt/mainnet-rewards/.env</code> for the anchor button).
            </div>
          )}
          {state.httpStatus === 409 && (
            <div className="text-xs text-red-700 mt-2">
              Another tick is already running. Try again in a moment.
            </div>
          )}
          {state.httpStatus === 503 && (
            <div className="text-xs text-red-700 mt-2">
              {/*
                503 has two distinct sources:
                  (a) pinning-webui's own outbound check: when this
                      env doesn't have FULA_USERS_INDEX_INTERNAL_TOKEN
                      set, the proxy returns 503 BEFORE making the
                      outbound call.
                  (b) Upstream service: fula-cli or mainnet-rewards
                      returns 503 when the publisher/anchor flag is
                      off OR they don't have the token configured.

                Disambiguate by inspecting the error message body so
                the operator sees the right .env to fix instead of
                a generic "check both flags" hint.
              */}
              {state.message.includes('pinning-webui env') ? (
                <>
                  pinning-webui's own <code>.env</code> is missing{' '}
                  <code>FULA_USERS_INDEX_INTERNAL_TOKEN</code>. Add it (the
                  same value the master generated via the setup script and
                  wrote to <code>/etc/fula/.env</code> +{' '}
                  <code>/opt/mainnet-rewards/.env</code>) and restart
                  pinning-webui. The upstream services were not contacted.
                </>
              ) : (
                <>
                  The upstream service is disabled. Verify the relevant env
                  flag (
                  <code>FULA_USERS_INDEX_PUBLISHER_ENABLED</code> for
                  publisher,{' '}
                  <code>FULA_USERS_INDEX_ANCHOR_ENABLED</code> for anchor) is{' '}
                  <code>true</code> on the master and the service has been
                  restarted.
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AdminFula() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Fula Publisher</h1>
        <p className="text-sm text-gray-600 mt-1">
          Trigger an immediate users-index publisher tick on the master, or
          force an immediate chain-anchor submission. Use these after the
          relevant deploy step (per the runbook) to verify the channel is
          working without waiting for the periodic timer.
        </p>
      </div>

      <ActionCard
        title="Run users-index publisher now"
        description="Calls fula-cli /_internal/publish-now. The publisher pins per-user CBORs that changed since the last tick, builds a new global users-index CBOR, pins it, advances the sequence, and (if IPNS is enabled) publishes via kubo. Returns the new global CID + sequence + per-user counts."
        buttonLabel="Publish now"
        endpoint="/api/admin/fula/publish-now"
      />

      <ActionCard
        title="Submit anchor to chain now"
        description="Calls mainnet-rewards /admin/users-index-anchor/trigger. The anchor cron fetches fula-cli's current published state and submits to FulaUsersIndexAnchor on each configured network (Base / SKALE) if the CID changed since the last on-chain state. Returns per-network outcomes."
        buttonLabel="Submit to chain now"
        endpoint="/api/admin/fula/anchor-now"
      />
    </div>
  );
}
