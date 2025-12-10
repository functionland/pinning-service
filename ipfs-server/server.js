const express = require('express');
const multer = require('multer');
const fs = require('fs');
const admin = require('firebase-admin');
const path = require('path');

let create, fileTypeFromBuffer;

(async () => {
  const kuboRpcClient = await import('kubo-rpc-client');
  create = kuboRpcClient.create;
  
  const fileType = await import('file-type');
  fileTypeFromBuffer = fileType.fileTypeFromBuffer;

  function initializeFirebase() {
    const firebasePath = path.join(process.cwd(), 'firebase.json');
    const serviceAccount = JSON.parse(fs.readFileSync(firebasePath, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    return admin.firestore();
  }

  const db = initializeFirebase();

  const app = express();
  app.use(express.json({ limit: '800mb' }));
  app.use(express.urlencoded({ limit: '800mb', extended: true }));
  const upload = multer({ 
    dest: 'uploads/',
    limits: {
      fileSize: 800 * 1024 * 1024  // 800MB in bytes
    }
  });

  // Create an IPFS client with aggressive timeout settings
  const ipfs = create({
    url: 'http://127.0.0.1:5001',
    timeout: 30000, // 30 second timeout
    headers: {
      'User-Agent': 'ipfs-gateway/1.0.0'
    }
  });

  // Test IPFS connection on startup
  try {
    const version = await ipfs.version();
    console.log('IPFS connection successful, version:', version.version);
  } catch (error) {
    console.error('IPFS connection failed:', error.message);
    console.error('Make sure IPFS daemon is running on http://127.0.0.1:5001');
  }

  // Authentication middleware
  async function authenticate(req, res, next) {
    const authToken = req.headers['authorization'];
    if (!authToken) {
      return res.status(401).json({ error: 'No authentication token provided' });
    }

    try {
      const poolId = await getUserPoolFromSession(authToken);
      req.poolId = poolId;
      next();
    } catch (error) {
      console.error('Authentication error:', error);
      res.status(401).json({ error: 'Invalid or expired session token' });
    }
  }

  async function getUserPoolFromSession(authToken) {
    const defaultPoolID = "1";

    try {
      // Query the sessions collection
      const sessionSnapshot = await db.collection('sessions')
        .where('session_token', '==', authToken)
        .get();

      if (sessionSnapshot.empty) {
        throw new Error('Invalid or expired session token');
      }

      const username = sessionSnapshot.docs[0].data().username;

      // Query the users collection
      const userSnapshot = await db.collection('users')
        .where('username', '==', username)
        .get();

      if (userSnapshot.empty) {
        return defaultPoolID;
      }

      const poolId = userSnapshot.docs[0].data().pool_id;
      console.log("pool_id="+poolId);

      if (poolId && typeof poolId === 'string') {
        return poolId;
      } else {
        throw new Error('pool_id is not found');
      }
    } catch (error) {
      console.error('Error in getUserPoolFromSession:', error);
      return defaultPoolID;
    }
  }

  app.post('/upload', authenticate, upload.single('file'), async (req, res) => {
    console.log('Upload request received, authenticated');

    if (!req.file) {
      console.log('No file in request');
      return res.status(400).send('No file uploaded.');
    }

    console.log('File received:', {
      originalname: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      path: req.file.path
    });

    try {
      // Read the file from the upload directory
      console.log('Reading file from disk...');
      const fileData = fs.readFileSync(req.file.path);
      console.log('File read successfully, size:', fileData.length);

      // Add the file to IPFS with minimal network interaction
      console.log('Adding file to IPFS...');
      console.log('File size:', fileData.length, 'bytes');

      const result = await ipfs.add(fileData, {
        cidVersion: 1,
        hashAlg: 'sha2-256',
        pin: false, // Don't pin to avoid network delays
        onlyHash: false, // We want to actually add it
        wrapWithDirectory: false,
        chunker: 'size-262144', // Use smaller chunks
        progress: (bytes) => {
          console.log(`Upload progress: ${bytes} bytes`);
        }
      });

      console.log('File added to IPFS successfully, CID:', result.cid.toString());

      // Remove the temporary file
      fs.unlinkSync(req.file.path);
      console.log('Temporary file removed');

      // Return the IPFS CID and the user's pool ID
      res.json({
        cid: result.cid.toString(),
        poolId: req.poolId
      });
      console.log('Response sent successfully');

    } catch (error) {
      console.error('Error during upload process:', error);
      console.error('Error stack:', error.stack);

      // Clean up temporary file if it exists
      try {
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
          console.log('Cleaned up temporary file after error');
        }
      } catch (cleanupError) {
        console.error('Error cleaning up temporary file:', cleanupError);
      }

      res.status(500).json({
        error: 'Error uploading file to IPFS',
        details: error.message
      });
    }
  });

  app.options('/gateway/:ipfs_cid', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.sendStatus(200);
  });

  app.get('/gateway/:ipfs_cid', async (req, res) => {
    const cid = req.params.ipfs_cid;
    const isRawRequest = 'raw' in req.query;
    
    try {
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
  
      if (isRawRequest) {
        // Handle raw block request
        try {
          const block = await ipfs.block.get(cid);
          res.setHeader('Content-Type', 'application/vnd.ipld.raw');
          res.setHeader('Content-Length', block.length);
          // Send the raw buffer directly
          res.send(Buffer.from(block));
          return;
        } catch (error) {
          console.error(error);
          throw error;
        }
      } else {
        // Original behavior for regular requests
        const chunks = [];
        for await (const chunk of ipfs.cat(cid)) {
          chunks.push(chunk);
        }
        const content = Buffer.concat(chunks);
  
        // Determine the content type
        let contentType = 'application/octet-stream'; // Default content type
        
        try {
          const type = await fileTypeFromBuffer(content);
          if (type) {
            contentType = type.mime;
          } else {
            // If file-type can't determine the type, check if it's text
            if (content.toString().trim().length === content.length) {
              contentType = 'text/plain';
            }
          }
        } catch (error) {
          console.error('Error determining content type:', error);
        }
  
        // Set the appropriate headers
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', content.length);
  
        // Send the content
        res.send(content);
      }
    } catch (error) {
      console.error('Error fetching from IPFS:', error);
      res.status(500).send('Error fetching content from IPFS');
    }
  });
  
  

  // Serve ACME challenge files
  app.use('/.well-known/acme-challenge', express.static(path.join(__dirname, '.well-known', 'acme-challenge'), { dotfiles: 'allow' }));

  const PORT = process.env.PORT || 3300;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

})().catch(console.error);
