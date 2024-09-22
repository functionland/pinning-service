import express from 'express';
import multer from 'multer';
import { create } from 'kubo-rpc-client';
import fs from 'fs';
import admin from 'firebase-admin';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Firebase Admin SDK
import serviceAccount from '../firebase.json' assert { type: 'json' };
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

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

const PORT = process.env.PORT || 3300;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});