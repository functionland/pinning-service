/**
 * Buffer GraphQL proxy.
 *
 * Relays the user's PERSONAL Buffer API key (Buffer's new GraphQL API has no
 * third-party OAuth) to api.buffer.com. The token lives only in the request
 * scope — never persisted, never logged, never echoed back. Exact schema
 * field names were taken from developers.buffer.com examples (young API):
 * BUFFER_API_URL is overridable if Buffer moves things.
 */

import { config } from '../config/index.js';

const BUFFER_TIMEOUT_MS = 15_000;

export interface BufferChannel {
  id: string;
  name: string;
  service: string;
}

export interface BufferPostResult {
  channelId: string;
  ok: boolean;
  postId?: string;
  error?: string;
}

class BufferAuthError extends Error {}

async function bufferGraphql(
  bufferToken: string,
  query: string,
  variables: Record<string, unknown> | undefined,
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BUFFER_TIMEOUT_MS);
  try {
    const res = await fetch(config.bufferApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bufferToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new BufferAuthError('Buffer token invalid or expired');
    }
    if (!res.ok) {
      // Deliberately do NOT include the response body — upstream errors may
      // echo request details.
      throw new Error(`Buffer API error (HTTP ${res.status})`);
    }
    const json = (await res.json()) as { data?: any; errors?: Array<{ message?: string }> };
    if (json.errors?.length) {
      const msg = json.errors[0]?.message || 'Buffer API returned an error';
      throw new Error(msg.slice(0, 300));
    }
    return json.data;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Buffer API unreachable (timeout)');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchBufferChannels(bufferToken: string): Promise<BufferChannel[]> {
  // Buffer's schema exposes account.organizations (a list) — we post to the
  // first one, which is the personal API key's own organization.
  const orgData = await bufferGraphql(
    bufferToken,
    `query { account { organizations { id } } }`,
    undefined,
  );
  const orgs = orgData?.account?.organizations;
  const organizationId = Array.isArray(orgs) ? orgs[0]?.id : undefined;
  if (!organizationId) {
    throw new Error('Could not resolve your Buffer organization');
  }

  const chData = await bufferGraphql(
    bufferToken,
    `query Channels($input: ChannelsInput!) {
      channels(input: $input) { id name service }
    }`,
    { input: { organizationId } },
  );
  const channels = chData?.channels;
  if (!Array.isArray(channels)) {
    throw new Error('Buffer returned no channels');
  }
  return channels
    .filter((ch: any) => ch && typeof ch.id === 'string')
    .map((ch: any) => ({
      id: ch.id,
      name: typeof ch.name === 'string' ? ch.name : ch.id,
      service: typeof ch.service === 'string' ? ch.service : 'unknown',
    }));
}

/**
 * Create one queued post per channel, sequentially (bounded by the route's
 * channelIds cap). A failed or ambiguous channel never aborts the loop.
 * Timeouts are reported as UNKNOWN outcome (Buffer may have accepted the
 * post before the connection died) — never silently retried.
 */
export async function createBufferPosts(
  bufferToken: string,
  channelIds: string[],
  text: string,
  imageUrl: string,
): Promise<BufferPostResult[]> {
  const mutation = `mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess { post { id } }
      ... on MutationError { message }
    }
  }`;

  const results: BufferPostResult[] = [];
  for (const channelId of channelIds) {
    try {
      const data = await bufferGraphql(bufferToken, mutation, {
        input: {
          channelId,
          text,
          schedulingType: 'automatic',
          mode: 'addToQueue',
          assets: [{ image: { url: imageUrl } }],
        },
      });
      const result = data?.createPost;
      if (result?.post?.id) {
        results.push({ channelId, ok: true, postId: String(result.post.id) });
      } else if (result?.message) {
        results.push({ channelId, ok: false, error: String(result.message).slice(0, 300) });
      } else {
        results.push({ channelId, ok: false, error: 'Buffer returned an unexpected response' });
      }
    } catch (err) {
      if (err instanceof BufferAuthError) {
        // Token is dead — every remaining channel would fail identically.
        results.push({ channelId, ok: false, error: err.message });
        for (const remaining of channelIds.slice(channelIds.indexOf(channelId) + 1)) {
          results.push({ channelId: remaining, ok: false, error: err.message });
        }
        break;
      }
      const msg = err instanceof Error ? err.message : 'Buffer request failed';
      const ambiguous = msg.includes('unreachable');
      results.push({
        channelId,
        ok: false,
        error: ambiguous
          ? 'Result unknown — the request timed out; check your Buffer queue before retrying'
          : msg,
      });
    }
  }
  return results;
}

export { BufferAuthError };
