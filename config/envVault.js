const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const VAULT_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SALT_BYTES = 16;

function projectPath(filename) {
  return path.join(process.cwd(), filename);
}

function readPassword(keyPath = projectPath('.env.key')) {
  if (process.env.ENV_VAULT_PASSWORD) {
    return process.env.ENV_VAULT_PASSWORD;
  }

  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, 'utf8').trim();
  }

  return '';
}

function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, KEY_BYTES);
}

function encryptText(plaintext, password) {
  if (!password) {
    throw new Error('ENV_VAULT_PASSWORD or .env.key is required to encrypt secrets');
  }

  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    version: VAULT_VERSION,
    algorithm: ALGORITHM,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptVault(vault, password) {
  if (!password) {
    throw new Error('ENV_VAULT_PASSWORD or .env.key is required to decrypt secrets');
  }

  if (!vault || vault.version !== VAULT_VERSION || vault.algorithm !== ALGORITHM) {
    throw new Error('Unsupported env vault format');
  }

  const salt = Buffer.from(vault.salt, 'base64');
  const iv = Buffer.from(vault.iv, 'base64');
  const tag = Buffer.from(vault.tag, 'base64');
  const ciphertext = Buffer.from(vault.ciphertext, 'base64');
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function loadEnv(options = {}) {
  const envPath = options.envPath || projectPath('.env');
  const vaultPath = options.vaultPath || projectPath('.env.enc');
  const keyPath = options.keyPath || projectPath('.env.key');
  const password = readPassword(keyPath);

  if (fs.existsSync(vaultPath) && password) {
    const vault = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
    const parsed = dotenv.parse(decryptVault(vault, password));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    return { source: vaultPath, encrypted: true };
  }

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    return { source: envPath, encrypted: false };
  }

  if (fs.existsSync(vaultPath) && !password) {
    console.warn('[env] .env.enc exists, but ENV_VAULT_PASSWORD/.env.key is missing; encrypted secrets were not loaded.');
  }

  return { source: null, encrypted: false };
}

module.exports = {
  encryptText,
  decryptVault,
  loadEnv,
  readPassword,
};
