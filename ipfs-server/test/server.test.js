/**
 * Tests for IPFS Gateway Server
 * 
 * Prerequisites:
 * 1. Run: npm run test:setup (creates test database)
 * 2. Have IPFS daemon running on localhost:5001
 * 
 * Run tests: npm test
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { setupTestDatabase, TEST_DB_PATH, TEST_TOKEN } = require('./setup-test-db.js');

// Test configuration
const PORT = 3399; // Use different port for tests
const BASE_URL = `http://localhost:${PORT}`;

let serverProcess;
let serverReady = false;

// Helper to make HTTP requests
function makeRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode, headers: res.headers, data: json, raw: data });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, data: null, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Helper to upload file via multipart form
function uploadFile(filePath, token) {
  return new Promise((resolve, reject) => {
    const boundary = '----TestBoundary' + Math.random().toString(36).substring(2);
    const fileName = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);
    
    const bodyParts = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
      'Content-Type: application/octet-stream',
      '',
      fileContent.toString('binary'),
      `--${boundary}--`,
      ''
    ];
    const body = bodyParts.join('\r\n');

    const options = {
      hostname: 'localhost',
      port: PORT,
      path: '/upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(body, 'binary'),
        'Authorization': `Bearer ${token}`
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: null, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(body, 'binary');
    req.end();
  });
}

// Wait for server to be ready
function waitForServer(maxAttempts = 30) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      makeRequest({ hostname: 'localhost', port: PORT, path: '/health', method: 'GET' })
        .then(res => {
          if (res.status === 200) {
            resolve();
          } else if (attempts < maxAttempts) {
            setTimeout(check, 500);
          } else {
            reject(new Error('Server did not become ready'));
          }
        })
        .catch(() => {
          if (attempts < maxAttempts) {
            setTimeout(check, 500);
          } else {
            reject(new Error('Server did not become ready'));
          }
        });
    };
    check();
  });
}

describe('IPFS Gateway Server Tests', () => {
  
  before(async () => {
    // Setup test database
    console.log('Setting up test database...');
    setupTestDatabase();
    
    // Start server with test config
    console.log('Starting test server...');
    const { spawn } = require('child_process');
    
    serverProcess = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: PORT.toString(),
        DATABASE_PATH: TEST_DB_PATH,
        IPFS_API_URL: 'http://127.0.0.1:5001',
        UPLOAD_DIR: path.join(__dirname, 'uploads'),
        NODE_ENV: 'test'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProcess.stdout.on('data', (data) => {
      console.log(`[server] ${data.toString().trim()}`);
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`[server error] ${data.toString().trim()}`);
    });

    // Wait for server to be ready
    await waitForServer();
    console.log('Test server ready!');
  });

  after(async () => {
    // Cleanup
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Remove test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    
    // Remove test uploads directory
    const uploadsDir = path.join(__dirname, 'uploads');
    if (fs.existsSync(uploadsDir)) {
      fs.rmSync(uploadsDir, { recursive: true, force: true });
    }
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/health',
        method: 'GET'
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, 'ok');
      assert.ok(res.data.timestamp);
      assert.strictEqual(res.data.database, 'connected');
    });
  });

  describe('Authentication', () => {
    it('should reject requests without token', async () => {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/upload',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      assert.strictEqual(res.status, 401);
      assert.ok(res.data.error.includes('authentication') || res.data.error.includes('token'));
    });

    it('should reject requests with invalid token', async () => {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/upload',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer invalid-token-12345'
        }
      });

      assert.strictEqual(res.status, 401);
      assert.ok(res.data.error.includes('Invalid') || res.data.error.includes('expired'));
    });
  });

  describe('File Upload', () => {
    it('should reject upload without file', async () => {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/upload',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_TOKEN}`
        }
      });

      assert.strictEqual(res.status, 400);
    });

    it('should upload a text file and return CID', async () => {
      // Create a temporary test file
      const testFilePath = path.join(__dirname, 'test-upload.txt');
      const testContent = 'Hello IPFS! Test content ' + Date.now();
      fs.writeFileSync(testFilePath, testContent);

      try {
        const res = await uploadFile(testFilePath, TEST_TOKEN);

        assert.strictEqual(res.status, 200);
        assert.ok(res.data.cid, 'Should return CID');
        assert.ok(res.data.cid.startsWith('bafkrei'), 'CID should be v1 format');
        assert.strictEqual(res.data.poolId, 42, 'Should return user pool ID');
        assert.ok(res.data.size > 0, 'Should return file size');

        console.log('Uploaded CID:', res.data.cid);
      } finally {
        // Cleanup
        if (fs.existsSync(testFilePath)) {
          fs.unlinkSync(testFilePath);
        }
      }
    });
  });

  describe('Gateway', () => {
    let uploadedCid;

    before(async () => {
      // Upload a file first to test gateway
      const testFilePath = path.join(__dirname, 'gateway-test.txt');
      const testContent = 'Gateway test content ' + Date.now();
      fs.writeFileSync(testFilePath, testContent);

      try {
        const res = await uploadFile(testFilePath, TEST_TOKEN);
        uploadedCid = res.data.cid;
        console.log('Test file uploaded with CID:', uploadedCid);
      } finally {
        if (fs.existsSync(testFilePath)) {
          fs.unlinkSync(testFilePath);
        }
      }
    });

    it('should retrieve content via gateway (no auth required)', async () => {
      assert.ok(uploadedCid, 'Need uploaded CID for this test');

      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: `/gateway/${uploadedCid}`,
        method: 'GET'
      });

      assert.strictEqual(res.status, 200);
      assert.ok(res.raw.includes('Gateway test content'));
      assert.ok(res.headers['content-type']);
      assert.ok(res.headers['cache-control'].includes('immutable'));
    });

    it('should return 404 for non-existent CID', async () => {
      const fakeCid = 'bafkreixxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: `/gateway/${fakeCid}`,
        method: 'GET'
      });

      // Should return 404 or 500 (depending on IPFS error)
      assert.ok(res.status >= 400);
    });

    it('should handle CORS preflight', async () => {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: `/gateway/${uploadedCid}`,
        method: 'OPTIONS'
      });

      assert.strictEqual(res.status, 204);
      assert.strictEqual(res.headers['access-control-allow-origin'], '*');
      assert.ok(res.headers['access-control-allow-methods'].includes('GET'));
    });
  });

  describe('404 Handler', () => {
    it('should return 404 for unknown routes', async () => {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/unknown/route',
        method: 'GET'
      });

      assert.strictEqual(res.status, 404);
      assert.ok(res.data.error);
    });
  });

  describe('Security Headers', () => {
    it('should include security headers', async () => {
      const res = await makeRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/health',
        method: 'GET'
      });

      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    });
  });
});
