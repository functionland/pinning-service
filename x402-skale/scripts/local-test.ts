/**
 * Local Test Server for x402 Gateway
 *
 * Runs a mock S3 backend and mock pinning-webui so you can test
 * the x402 payment flow locally with the testnet facilitator.
 *
 * Usage:
 *   npx ts-node scripts/local-test.ts
 *
 * Then test with:
 *   # Get pricing info
 *   curl http://localhost:4002/health/pricing
 *
 *   # Try upload without payment (should get 402)
 *   curl -X PUT http://localhost:4002/test-bucket/test-file.txt \
 *     -H "Authorization: Bearer test-jwt" \
 *     -H "Content-Type: text/plain" \
 *     -d "Hello World"
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

// ============================================
// Mock S3 Backend (simulates MinIO)
// ============================================
const mockS3 = new Hono();

// Store uploaded objects in memory
const s3Objects: Map<string, { body: string; contentType: string }> = new Map();

mockS3.put('/:bucket/:key{.+}', async (c) => {
  const bucket = c.req.param('bucket');
  const key = c.req.param('key');
  const body = await c.req.text();
  const contentType = c.req.header('Content-Type') || 'application/octet-stream';

  console.log(`[mock-s3] PUT /${bucket}/${key} (${body.length} bytes)`);
  console.log(`[mock-s3] Auth header: ${c.req.header('Authorization')}`);

  s3Objects.set(`${bucket}/${key}`, { body, contentType });

  return c.text('', 200);
});

mockS3.get('/:bucket/:key{.+}', (c) => {
  const bucket = c.req.param('bucket');
  const key = c.req.param('key');
  const obj = s3Objects.get(`${bucket}/${key}`);

  if (!obj) {
    return c.text('Not Found', 404);
  }

  console.log(`[mock-s3] GET /${bucket}/${key}`);
  return c.text(obj.body, 200, { 'Content-Type': obj.contentType });
});

mockS3.delete('/:bucket/:key{.+}', (c) => {
  const bucket = c.req.param('bucket');
  const key = c.req.param('key');

  console.log(`[mock-s3] DELETE /${bucket}/${key}`);
  s3Objects.delete(`${bucket}/${key}`);

  return c.text('', 204);
});

mockS3.on('HEAD', '/:bucket/:key{.+}', (c) => {
  const bucket = c.req.param('bucket');
  const key = c.req.param('key');
  const obj = s3Objects.get(`${bucket}/${key}`);

  if (!obj) {
    return c.text('', 404);
  }

  return c.text('', 200, {
    'Content-Length': String(obj.body.length),
    'Content-Type': obj.contentType,
  });
});

// ============================================
// Mock Pinning WebUI (credit adjustment)
// ============================================
const mockWebUI = new Hono();

// Track credit adjustments
const creditAdjustments: Array<{ email: string; amount: number; reason: string }> = [];

mockWebUI.post('/api/admin/adjust', async (c) => {
  const systemKey = c.req.header('X-System-Key');

  if (systemKey !== 'test-system-key') {
    console.log(`[mock-webui] Rejected - invalid system key: ${systemKey}`);
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json();
  const { email, amount, reason } = body;

  console.log(`[mock-webui] Credit adjustment:`);
  console.log(`  Email:  ${email}`);
  console.log(`  Amount: ${amount} FULA`);
  console.log(`  Reason: ${reason}`);

  creditAdjustments.push({ email, amount, reason });

  return c.json({
    success: true,
    newBalance: amount,
    isSuspended: false,
  });
});

// Track wallet users (for x402-only mode)
const walletUsers: Map<string, { email: string; apiKey: string }> = new Map();

// Ensure user + API key for x402 wallet authentication
mockWebUI.post('/api/admin/ensure-user-key', async (c) => {
  const systemKey = c.req.header('X-System-Key');

  if (systemKey !== 'test-system-key') {
    console.log(`[mock-webui] ensure-user-key rejected - invalid system key: ${systemKey}`);
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json();
  const { email } = body;

  if (!email) {
    return c.json({ error: 'Email required' }, 400);
  }

  // Check if user already exists
  let user = walletUsers.get(email);

  if (!user) {
    // Create new wallet user with mock API key
    const apiKey = `mock-api-key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    user = { email, apiKey };
    walletUsers.set(email, user);
    console.log(`[mock-webui] Created wallet user: ${email}`);
    console.log(`  API Key: ${apiKey}`);
  } else {
    console.log(`[mock-webui] Found existing wallet user: ${email}`);
  }

  return c.json({
    success: true,
    email: user.email,
    apiKey: user.apiKey,
  });
});

// Endpoint to view credit adjustments (for debugging)
mockWebUI.get('/api/admin/adjustments', (c) => {
  return c.json({ adjustments: creditAdjustments });
});

// ============================================
// Start Mock Servers
// ============================================
async function startMockServers() {
  // Start mock S3 on port 9000
  serve({
    fetch: mockS3.fetch,
    port: 9000,
  });
  console.log('[mock-s3] Running on http://localhost:9000');

  // Start mock WebUI on port 3001
  serve({
    fetch: mockWebUI.fetch,
    port: 3001,
  });
  console.log('[mock-webui] Running on http://localhost:3001');

  console.log('');
  console.log('='.repeat(50));
  console.log('Mock servers started!');
  console.log('='.repeat(50));
  console.log('');
  console.log('Now start the x402 gateway in another terminal:');
  console.log('');
  console.log('  cd x402-skale');
  console.log('  cp .env.test .env  # Use test environment');
  console.log('  npm run dev');
  console.log('');
  console.log('Then test with:');
  console.log('');
  console.log('  # Check health');
  console.log('  curl http://localhost:4002/health');
  console.log('');
  console.log('  # Check pricing');
  console.log('  curl http://localhost:4002/health/pricing');
  console.log('');
  console.log('  # Try upload without payment (should get 402)');
  console.log('  curl -v -X PUT http://localhost:4002/test-bucket/test.txt \\');
  console.log('    -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJ3YWxsZXQiOiIweDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTAifQ.test" \\');
  console.log('    -H "Content-Type: text/plain" \\');
  console.log('    -d "Hello World"');
  console.log('');
  console.log('  # View credit adjustments');
  console.log('  curl http://localhost:3001/api/admin/adjustments');
  console.log('');
}

startMockServers().catch(console.error);
