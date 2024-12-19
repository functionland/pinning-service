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
  const upload = multer({ dest: 'uploads/' });

  // Create an IPFS client
  const ipfs = create({ url: 'http://127.0.0.1:5001' });

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
    console.log('request is authenticated');
    if (!req.file) {
      return res.status(400).send('No file uploaded.');
    }

    try {
      // Read the file from the upload directory
      const fileData = fs.readFileSync(req.file.path);

      // Add the file to IPFS with CIDv1
      const result = await ipfs.add(fileData, {
        cidVersion: 1,
        hashAlg: 'sha2-256'
      });

      // Remove the temporary file
      fs.unlinkSync(req.file.path);

      // Return the IPFS CID and the user's pool ID
      res.json({ 
        cid: result.cid.toString(),
        poolId: req.poolId
      });
    } catch (error) {
      console.error('Error uploading to IPFS:', error);
      res.status(500).send('Error uploading file to IPFS');
    }
  });

  app.get('/gateway/:ipfs_cid', async (req, res) => {
    const cid = req.params.ipfs_cid;
    
    try {
      let content;
      try {
        // First try to get content using cat
        const chunks = [];
        for await (const chunk of ipfs.cat(cid)) {
          chunks.push(chunk);
        }
        content = Buffer.concat(chunks);
      } catch (error) {
        if (error.message.includes('unknown node type')) {
          // If cat fails, try to get the raw block
          const block = await ipfs.block.get(cid);
          // Check if block exists and has data
          if (!block || !block.data) {
            throw new Error('No data in IPFS block');
          }
          // Handle block.data directly as it should already be a Buffer
          content = block.data;
        } else {
          throw error;
        }
      }
  
      if (!content) {
        throw new Error('No content retrieved from IPFS');
      }
  
      // Set basic headers for raw data download
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', content.length);
      res.setHeader('Content-Disposition', `attachment; filename="${cid}.bin"`);
      
      // Only attempt file type detection if content exists and is valid
      if (Buffer.isBuffer(content)) {
        try {
          const type = await fileTypeFromBuffer(content);
          if (type) {
            res.setHeader('Content-Type', type.mime);
            res.setHeader('Content-Disposition', `attachment; filename="${cid}.${type.ext}"`);
          }
        } catch (error) {
          // Silently continue with default content type
          console.log('Using default content type for', cid);
        }
      }
  
      res.send(content);
  
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