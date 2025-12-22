/**
 * Secure client-side storage for encryption keys
 * 
 * Uses IndexedDB for storage with session-based protection.
 * Keys are stored encrypted with a session-derived key to provide
 * an additional layer of protection against unauthorized access.
 * 
 * Security measures:
 * 1. Keys are stored in IndexedDB (not localStorage - harder to access via XSS)
 * 2. Data is encrypted with a session key derived from user email hash
 * 3. Storage is cleared on logout
 * 4. Keys auto-expire after 24 hours of inactivity
 */

const DB_NAME = 'fula-pinning-secure';
const DB_VERSION = 1;
const STORE_NAME = 'secure-keys';
const KEY_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

interface StoredKey {
  id: string;
  encryptedKey: string; // Base64 encoded
  iv: string; // Base64 encoded
  createdAt: number;
  lastAccessedAt: number;
}

let db: IDBDatabase | null = null;

/**
 * Open or create the IndexedDB database
 */
async function openDB(): Promise<IDBDatabase> {
  if (db) return db;
  
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(new Error('Failed to open secure storage'));
    
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
    
    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

/**
 * Derive a session protection key from user email
 * This adds a layer of protection - the stored key can only be decrypted
 * if the user is logged in with the same email
 */
async function deriveSessionKey(userEmail: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const salt = encoder.encode('fula-webui-session-v1');
  
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(userEmail),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 10000, // Lower iterations for session key (UX balance)
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Store the encryption key securely
 * 
 * @param keyId - Unique identifier for the key (e.g., user email)
 * @param encryptionKey - The raw key bytes to store
 * @param userEmail - User's email for session protection
 */
export async function storeEncryptionKey(
  keyId: string,
  encryptionKey: Uint8Array,
  userEmail: string
): Promise<void> {
  const database = await openDB();
  const sessionKey = await deriveSessionKey(userEmail);
  
  // Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(12));
  
  // Encrypt the key with session protection
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    sessionKey,
    encryptionKey.buffer as ArrayBuffer
  );
  
  const storedKey: StoredKey = {
    id: keyId,
    encryptedKey: uint8ArrayToBase64(new Uint8Array(encrypted)),
    iv: uint8ArrayToBase64(iv),
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  };
  
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(storedKey);
    
    request.onerror = () => reject(new Error('Failed to store key'));
    request.onsuccess = () => resolve();
  });
}

/**
 * Retrieve the encryption key
 * 
 * @param keyId - The key identifier
 * @param userEmail - User's email for session protection
 * @returns The decrypted key bytes, or null if not found/expired
 */
export async function retrieveEncryptionKey(
  keyId: string,
  userEmail: string
): Promise<Uint8Array | null> {
  const database = await openDB();
  
  return new Promise(async (resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(keyId);
    
    request.onerror = () => reject(new Error('Failed to retrieve key'));
    
    request.onsuccess = async () => {
      const storedKey = request.result as StoredKey | undefined;
      
      if (!storedKey) {
        resolve(null);
        return;
      }
      
      // Check expiry
      if (Date.now() - storedKey.lastAccessedAt > KEY_EXPIRY_MS) {
        // Key expired, delete it
        store.delete(keyId);
        resolve(null);
        return;
      }
      
      try {
        const sessionKey = await deriveSessionKey(userEmail);
        const iv = base64ToUint8Array(storedKey.iv);
        const encryptedKey = base64ToUint8Array(storedKey.encryptedKey);
        
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
          sessionKey,
          encryptedKey.buffer as ArrayBuffer
        );
        
        // Update last accessed time
        storedKey.lastAccessedAt = Date.now();
        store.put(storedKey);
        
        resolve(new Uint8Array(decrypted));
      } catch (error) {
        // Decryption failed - wrong session or corrupted
        resolve(null);
      }
    };
  });
}

/**
 * Delete a stored key
 */
export async function deleteEncryptionKey(keyId: string): Promise<void> {
  const database = await openDB();
  
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(keyId);
    
    request.onerror = () => reject(new Error('Failed to delete key'));
    request.onsuccess = () => resolve();
  });
}

/**
 * Clear all stored keys (call on logout)
 */
export async function clearAllKeys(): Promise<void> {
  const database = await openDB();
  
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();
    
    request.onerror = () => reject(new Error('Failed to clear keys'));
    request.onsuccess = () => resolve();
  });
}

/**
 * Check if a key exists and is valid
 */
export async function hasValidKey(keyId: string): Promise<boolean> {
  const database = await openDB();
  
  return new Promise((resolve) => {
    const transaction = database.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(keyId);
    
    request.onerror = () => resolve(false);
    
    request.onsuccess = () => {
      const storedKey = request.result as StoredKey | undefined;
      if (!storedKey) {
        resolve(false);
        return;
      }
      
      // Check expiry
      if (Date.now() - storedKey.lastAccessedAt > KEY_EXPIRY_MS) {
        resolve(false);
        return;
      }
      
      resolve(true);
    };
  });
}

// Utility functions
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
