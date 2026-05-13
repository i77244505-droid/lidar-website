#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { decryptVault, encryptText, readPassword } = require('../config/envVault');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const VAULT_PATH = path.join(ROOT, '.env.enc');
const KEY_PATH = path.join(ROOT, '.env.key');

function usage() {
  console.log([
    'Usage:',
    '  npm run env:encrypt        Encrypt .env into .env.enc',
    '  npm run env:check          Verify .env.enc can be decrypted',
    '',
    'Secrets key:',
    '  Set ENV_VAULT_PASSWORD, or let this tool create a local .env.key file.',
  ].join('\n'));
}

function ensurePassword() {
  const existing = readPassword(KEY_PATH);
  if (existing) return existing;

  const generated = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(KEY_PATH, generated + '\n', { mode: 0o600 });
  console.log('Created local .env.key. Keep it private and do not commit it.');
  return generated;
}

function encryptEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error('.env was not found; create it from .env.example first');
  }

  const password = ensurePassword();
  const plaintext = fs.readFileSync(ENV_PATH, 'utf8');
  const vault = encryptText(plaintext, password);
  fs.writeFileSync(VAULT_PATH, JSON.stringify(vault, null, 2) + '\n', { mode: 0o600 });
  console.log('Encrypted .env into .env.enc.');
}

function checkVault() {
  if (!fs.existsSync(VAULT_PATH)) {
    throw new Error('.env.enc was not found');
  }

  const password = readPassword(KEY_PATH);
  const vault = JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8'));
  decryptVault(vault, password);
  console.log('.env.enc decrypted successfully.');
}

try {
  const command = process.argv[2] || 'help';
  if (command === 'encrypt') {
    encryptEnv();
  } else if (command === 'check') {
    checkVault();
  } else {
    usage();
    process.exit(command === 'help' ? 0 : 1);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
