const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const heicConvert = require('heic-convert');
const {
  createPostgresPool,
  validateSession: pgValidateSession,
  getUserPoolId: pgGetUserPoolId,
  closePool,
  normalizeCid,
  isBlockedCid,
} = require('./database/postgres.js');

let create, fileTypeFromBuffer;

// Configuration from environment variables
const config = {
  port: parseInt(process.env.PORT || '3300', 10),
  ipfsApiUrl: process.env.IPFS_API_URL || 'http://127.0.0.1:5001',
  uploadDir: process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'),
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || String(800 * 1024 * 1024), 10), // 800MB default
  ipfsTimeout: parseInt(process.env.IPFS_TIMEOUT || '60000', 10), // 60 second timeout
};

// Ensure upload directory exists
if (!fs.existsSync(config.uploadDir)) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
}

(async () => {
  // Dynamic imports for ESM modules
  const kuboRpcClient = await import('kubo-rpc-client');
  create = kuboRpcClient.create;
  
  const fileType = await import('file-type');
  fileTypeFromBuffer = fileType.fileTypeFromBuffer;

  // Initialize PostgreSQL connection pool
  const pool = createPostgresPool();
  console.log('PostgreSQL connection pool initialized');

  const app = express();
  
  // Security headers middleware (strict defaults for non-gateway routes)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0'); // Deprecated, can cause issues — disable
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Request logging middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
    next();
  });

  app.use(express.json({ limit: '10mb' })); // Smaller limit for JSON
  app.use(express.urlencoded({ limit: '10mb', extended: true }));
  
  // Configure multer with disk storage for large files
  const storage = multer.diskStorage({
    destination: config.uploadDir,
    filename: (req, file, cb) => {
      // Use timestamp + random string to avoid collisions
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, uniqueSuffix + path.extname(file.originalname));
    }
  });

  const upload = multer({ 
    storage,
    limits: {
      fileSize: config.maxFileSize
    }
  });

  // Create IPFS client
  const ipfs = create({
    url: config.ipfsApiUrl,
    timeout: config.ipfsTimeout,
    headers: {
      'User-Agent': 'ipfs-gateway/2.0.0'
    }
  });

  // Test IPFS connection on startup
  try {
    const version = await ipfs.version();
    console.log('IPFS connection successful, version:', version.version);
  } catch (error) {
    console.error('IPFS connection failed:', error.message);
    console.error(`Make sure IPFS daemon is running on ${config.ipfsApiUrl}`);
  }

  // Validate session token using PostgreSQL
  async function validateSession(token) {
    // Handle "Bearer " prefix
    const sessionToken = token.startsWith('Bearer ') ? token.slice(7) : token;

    const row = await pgValidateSession(sessionToken);
    if (!row) {
      return null;
    }
    // Prefer user_id (survives PII wipe); fall back to username for legacy
    return (row.user_id && row.user_id !== '') ? row.user_id : row.username;
  }

  // Get user's pool ID from PostgreSQL
  async function getUserPoolId(username) {
    const defaultPoolId = 1;

    const row = await pgGetUserPoolId(username);
    if (!row || row.pool_id === null || row.pool_id === undefined) {
      return defaultPoolId;
    }
    return row.pool_id;
  }

  // Authentication middleware (async)
  async function authenticate(req, res, next) {
    const authToken = req.headers['authorization'];
    if (!authToken) {
      return res.status(401).json({ error: 'No authentication token provided' });
    }

    try {
      const username = await validateSession(authToken);
      if (!username) {
        return res.status(401).json({ error: 'Invalid or expired session token' });
      }

      const poolId = await getUserPoolId(username);
      req.username = username;
      req.poolId = poolId;
      next();
    } catch (error) {
      console.error('Authentication error:', error);
      res.status(401).json({ error: 'Invalid or expired session token' });
    }
  }

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      ipfs: config.ipfsApiUrl,
      database: 'connected'
    });
  });

  // Blocked MIME types for upload
  const BLOCKED_MIMES = new Set([
    'application/x-msdownload',   // .exe
    'application/x-msdos-program', // .com
    'application/x-sh',           // .sh
    'application/x-bat',          // .bat
  ]);

  // Upload endpoint (requires authentication)
  app.post('/upload', authenticate, upload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;

    try {
      // Check file type against blocklist
      const headerBuf = Buffer.alloc(4100);
      const fileHandle = await fs.promises.open(filePath, 'r');
      try {
        await fileHandle.read(headerBuf, 0, 4100, 0);
      } finally {
        await fileHandle.close();
      }
      const detectedType = await fileTypeFromBuffer(headerBuf);
      if (detectedType && BLOCKED_MIMES.has(detectedType.mime)) {
        fs.unlinkSync(filePath);
        return res.status(400).json({ error: `File type ${detectedType.mime} not allowed` });
      }

      // Stream file to IPFS for better memory efficiency with large files
      const fileStream = fs.createReadStream(filePath);
      
      const result = await ipfs.add(fileStream, {
        cidVersion: 1,
        hashAlg: 'sha2-256',
        pin: false, // Don't pin - pinning service handles this
        wrapWithDirectory: false,
        chunker: 'size-262144',
        timeout: 1800000, // 30 minutes for multi-GB uploads
      });

      // Clean up temporary file
      fs.unlink(filePath, (err) => {
        if (err) console.error('Error removing temp file:', err);
      });

      res.json({
        cid: result.cid.toString(),
        poolId: req.poolId,
        size: req.file.size
      });

    } catch (error) {
      console.error('Upload error:', error.message);

      // Clean up temporary file on error
      fs.unlink(filePath, () => {});

      res.status(500).json({
        error: 'Error uploading file to IPFS'
      });
    }
  });

  // CORS preflight for gateway
  app.options('/gateway/:ipfs_cid', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours
    res.sendStatus(204);
  });

  // Return a 451 blocked response. Content-negotiation: HTML for browsers, JSON for API callers.
  // Sets no-store so neither browsers nor upstream caches retain the block (or a cached copy).
  function sendBlocked(req, res, cid) {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.removeHeader('X-Frame-Options');

    const accept = String(req.headers['accept'] || '');
    if (accept.includes('text/html')) {
      res.status(451).setHeader('Content-Type', 'text/html; charset=utf-8');
      const safeCid = String(cid).replace(/[<>&"']/g, c =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
      return res.send(
        `<!DOCTYPE html><html><head><meta charset="utf-8">` +
        `<title>Blocked</title>` +
        `<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:80px auto;padding:24px;color:#111}` +
        `h1{margin:0 0 12px;font-size:24px}code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}` +
        `p{color:#4b5563;line-height:1.5}</style></head><body>` +
        `<h1>Blocked due to security policy</h1>` +
        `<p>This content has been blocked by the site administrator and cannot be served.</p>` +
        `<p>CID: <code>${safeCid}</code></p>` +
        `</body></html>`
      );
    }
    return res.status(451).json({ error: 'Content blocked due to security policy', cid });
  }

  // IPFS Gateway endpoint (public, no authentication required)
  app.get('/gateway/:ipfs_cid', async (req, res) => {
    const rawCid = req.params.ipfs_cid;

    // CORS headers apply to every response path (success, 400, 451)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    // 1. Normalize — reject un-parseable CIDs
    let cid;
    try {
      cid = await normalizeCid(rawCid);
    } catch (_err) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(400).json({ error: 'Invalid CID' });
    }

    // 2. Blocklist check — cached in memory (60s TTL). Fails open on DB errors
    // so a Postgres blip does not take down the public gateway.
    try {
      if (await isBlockedCid(cid)) {
        return sendBlocked(req, res, rawCid);
      }
    } catch (err) {
      console.error('blocklist check failed, serving anyway:', err.message);
    }

    const isRawRequest = 'raw' in req.query;

    // Cache headers for gateway responses (only on the success path)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    try {
      if (isRawRequest) {
        // Handle raw block request
        const block = await ipfs.block.get(cid, { timeout: 600000 });
        res.removeHeader('X-Frame-Options');
        res.setHeader('Content-Type', 'application/vnd.ipld.raw');
        res.setHeader('Content-Length', block.length);
        res.send(Buffer.from(block));
      } else {
        // Stream content for better memory efficiency
        const chunks = [];
        let totalSize = 0;
        const maxSize = 100 * 1024 * 1024; // 100MB limit for gateway

        for await (const chunk of ipfs.cat(cid, { timeout: 600000 })) {
          totalSize += chunk.length;
          if (totalSize > maxSize) {
            return res.status(413).json({ error: 'Content too large for gateway' });
          }
          chunks.push(chunk);
        }
        
        let content = Buffer.concat(chunks);

        // Determine content type
        let contentType = 'application/octet-stream';
        
        try {
          const type = await fileTypeFromBuffer(content);
          if (type) {
            contentType = type.mime;
          } else {
            // Check if it's valid UTF-8 text
            const text = content.toString('utf8');
            if (Buffer.from(text, 'utf8').equals(content)) {
              // Sniff common text-based web formats that lack magic bytes
              const trimmed = text.trimStart().toLowerCase();
              if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') ||
                  trimmed.startsWith('<head') || trimmed.startsWith('<body')) {
                contentType = 'text/html; charset=utf-8';
              } else if (trimmed.startsWith('<?xml') || trimmed.startsWith('<svg')) {
                contentType = trimmed.includes('<svg') ? 'image/svg+xml' : 'application/xml; charset=utf-8';
              } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                try { JSON.parse(text); contentType = 'application/json; charset=utf-8'; } catch {}
              } else {
                contentType = 'text/plain; charset=utf-8';
              }
            }
          }
        } catch (typeError) {
          // Ignore type detection errors, use default
        }

        // Convert HEIC/HEIF to JPEG for browser compatibility
        const HEIC_MIMES = new Set([
          'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'
        ]);

        if (HEIC_MIMES.has(contentType) && !('original' in req.query)) {
          try {
            const converted = await heicConvert({
              buffer: content,
              format: 'JPEG',
              quality: 0.85,
            });
            content = Buffer.from(converted);
            contentType = 'image/jpeg';
          } catch (convErr) {
            console.error('HEIC conversion failed, serving original:', convErr.message);
          }
        }

        // Gateway-specific headers for hosted websites
        res.removeHeader('X-Frame-Options'); // Allow iframes within hosted websites
        if (contentType.startsWith('text/html')) {
          // Allow origin referrer so YouTube/Vimeo embeds work
          res.setHeader('Referrer-Policy', 'origin');
        }
        res.setHeader('Content-Security-Policy',
          "frame-ancestors 'self'; base-uri 'self'; form-action 'self' https:; object-src 'none'"
        );

        // Block dangerous executable types — force download instead of execution
        const GATEWAY_BLOCKED_MIMES = new Set([
          'application/x-msdownload',    // .exe
          'application/x-msdos-program', // .com executables
          'application/x-sh',            // .sh
          'application/x-bat',           // .bat
          'application/x-executable',    // Linux executables
        ]);
        if (GATEWAY_BLOCKED_MIMES.has(contentType)) {
          contentType = 'application/octet-stream';
          res.setHeader('Content-Disposition', 'attachment');
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', content.length);
        res.send(content);
      }
    } catch (error) {
      console.error('Gateway error:', error.message);
      
      if (error.message.includes('not found') || error.message.includes('no link')) {
        res.status(404).json({ error: 'Content not found' });
      } else {
        res.status(500).json({ error: 'Error fetching content from IPFS' });
      }
    }
  });

  // Serve ACME challenge files for SSL certificates
  app.use('/.well-known/acme-challenge', express.static(
    path.join(__dirname, '.well-known', 'acme-challenge'), 
    { dotfiles: 'deny' }
  ));

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Start server
  const server = app.listen(config.port, () => {
    console.log(`IPFS Gateway Server running on port ${config.port}`);
    console.log(`  - IPFS API: ${config.ipfsApiUrl}`);
    console.log(`  - Database: PostgreSQL (${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'})`);
    console.log(`  - Max file size: ${Math.round(config.maxFileSize / 1024 / 1024)}MB`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[ipfs-server] Shutting down...');
    server.close(() => {
      console.log('[ipfs-server] Server closed');
      process.exit(0);
    });
    // Force exit after 10s if connections don't close
    setTimeout(() => process.exit(1), 10000);
    await closePool();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

})().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
