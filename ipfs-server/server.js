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
      // Fetch the content from IPFS
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
    } catch (error) {
      console.error('Error fetching from IPFS:', error);
      res.status(500).send('Error fetching content from IPFS');
    }
  });

  const PORT = process.env.PORT || 3300;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

})().catch(console.error);