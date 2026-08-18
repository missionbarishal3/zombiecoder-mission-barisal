/**
 * identity-loader.js
 * Immutable Core Identity Loader — Digital DNA of ZombieCoder System
 *
 * This module loads identity.json and seals it as read-only.
 * No runtime modification is possible — any tamper attempt is detected.
 *
 * (c) 2026 Developer Zone — Sahon Srabon
 * Proprietary - Local Freedom Protocol
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IDENTITY_PATH = path.join(__dirname, 'identity.json');
const IDENTITY_HASH_ALGO = 'sha256';

// ─── Internal state (not exported) ─────────────────────────────────────
let _identity = null;
let _identityHash = null;
let _loaded = false;

// ─── Load & Seal ───────────────────────────────────────────────────────
function loadIdentity() {
  if (_loaded) return _identity;

  // Read raw file
  const raw = fs.readFileSync(IDENTITY_PATH, 'utf8');

  // Compute integrity hash
  _identityHash = crypto.createHash(IDENTITY_HASH_ALGO).update(raw).digest('hex');

  // Parse JSON
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Identity file corrupt: ${e.message}`);
  }

  // Deep freeze — truly immutable at runtime
  _identity = deepFreeze(parsed);
  _loaded = true;

  return _identity;
}

/**
 * deepFreeze — recursively freezes an object tree.
 * Prevents any runtime mutation of the identity object.
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  const propNames = Object.getOwnPropertyNames(obj);
  for (const name of propNames) {
    const val = obj[name];
    obj[name] = deepFreeze(val);
  }
  return Object.freeze(obj);
}

// ─── Public API (all read-only) ────────────────────────────────────────

/**
 * Returns the frozen identity object.
 * Loads on first call — subsequent calls return cached frozen object.
 */
function getIdentity() {
  if (!_loaded) loadIdentity();
  return _identity;
}

/**
 * Returns the SHA-256 hash of the raw identity.json file.
 * Useful for integrity verification headers (X-Identity-Hash).
 */
function getIdentityHash() {
  if (!_loaded) loadIdentity();
  return _identityHash;
}

/**
 * Verifies that the current identity.json on disk matches the loaded hash.
 * Returns { valid: boolean, hash: string }
 */
function verifyIntegrity() {
  try {
    const currentRaw = fs.readFileSync(IDENTITY_PATH, 'utf8');
    const currentHash = crypto.createHash(IDENTITY_HASH_ALGO).update(currentRaw).digest('hex');
    const valid = currentHash === _identityHash;
    return { valid, hash: currentHash, expectedHash: _identityHash };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

/**
 * Returns a minimal identity object suitable for API responses.
 */
function getPublicIdentity() {
  const id = getIdentity().system_identity;
  return {
    name: id.name,
    version: id.version,
    tagline: id.tagline,
    owner: id.branding.owner,
    organization: id.branding.organization,
    location: id.branding.location,
    website: id.branding.contact.website,
    license: id.license,
    identityHash: getIdentityHash()
  };
}

/**
 * Returns the X-Powered-By header value.
 */
function getPoweredByHeader() {
  const id = getIdentity().system_identity;
  return `${id.name}-by-${id.branding.owner.replace(/\s+/g, '')}`;
}

// ─── Auto-load on require ──────────────────────────────────────────────
loadIdentity();

// ─── Exports ───────────────────────────────────────────────────────────
module.exports = {
  getIdentity,
  getIdentityHash,
  verifyIntegrity,
  getPublicIdentity,
  getPoweredByHeader
};