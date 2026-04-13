/**
 * One-time utility: encrypts sensitive config values using AES-GCM with the site password.
 * Run with: node encrypt-config.js
 *
 * The output is a JSON blob that gets embedded in index.html.
 * Without the correct password, the app literally cannot function —
 * the webhook URL and Google Client ID are scrambled gibberish.
 */

const crypto = require('crypto');

// ─── The password and sensitive data ───
const PASSWORD = '00265921';

const SENSITIVE_CONFIG = {
  n8nWebhookUrl: 'https://n8n-67295956827.africa-south1.run.app/webhook/student-tools',
  googleClientId: '730237345425-i08jvribm9k9rgm26ui0jq4gdvcjbplb.apps.googleusercontent.com',
  devEmail: 'jay-leigh.v@conversionscience.co.za',
};

// ─── Derive a 256-bit key from the password using PBKDF2 ───
const SALT = crypto.randomBytes(16);
const ITERATIONS = 100000;
const KEY_LENGTH = 32; // 256 bits
const DIGEST = 'sha256';

const key = crypto.pbkdf2Sync(PASSWORD, SALT, ITERATIONS, KEY_LENGTH, DIGEST);

// ─── Encrypt using AES-256-GCM ───
const iv = crypto.randomBytes(12); // 96-bit IV for GCM
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

const plaintext = JSON.stringify(SENSITIVE_CONFIG);
let encrypted = cipher.update(plaintext, 'utf8', 'base64');
encrypted += cipher.final('base64');
const authTag = cipher.getAuthTag();

// ─── Output the encrypted blob ───
const blob = {
  salt: SALT.toString('base64'),
  iv: iv.toString('base64'),
  authTag: authTag.toString('base64'),
  iterations: ITERATIONS,
  ciphertext: encrypted,
};

console.log('\n=== Encrypted Config Blob (embed in index.html) ===\n');
console.log(JSON.stringify(blob));
console.log('\n=== Done ===\n');
