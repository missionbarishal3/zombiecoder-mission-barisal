/**
 * memory-store.js
 * JSON-based conversation memory system — Zero external dependencies
 * Stores conversations as JSON files organized by session ID.
 *
 * (c) 2026 Developer Zone — Sahon Srabon
 * Proprietary - Local Freedom Protocol
 */

const fs = require('fs');
const path = require('path');

const MEMORY_DIR = path.join(__dirname, 'memory');
const MAX_MESSAGES_PER_SESSION = 200;
const MAX_SESSIONS = 1000;

// ─── Ensure memory directory exists ───────────────────────────────────
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

// ─── Session index file ───────────────────────────────────────────────
const INDEX_PATH = path.join(MEMORY_DIR, '_index.json');

function loadIndex() {
  try {
    if (fs.existsSync(INDEX_PATH)) {
      return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    }
  } catch (e) { /* ignore corrupt index */ }
  return { sessions: {}, total: 0 };
}

function saveIndex(index) {
  try {
    fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
  } catch (e) { /* ignore write errors */ }
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Save a message to a session.
 */
function saveMessage(sessionId, message) {
  // Sanitize sessionId — prevent path traversal
  const safeId = sessionId.replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 128);
  const sessionFile = path.join(MEMORY_DIR, `${safeId}.json`);
  let session = { id: safeId, messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

  if (fs.existsSync(sessionFile)) {
    try {
      session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    } catch (e) { /* start fresh if corrupt */ }
  }

  session.messages.push({
    ...message,
    timestamp: new Date().toISOString()
  });

  // Trim to max messages
  if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
    session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
  }

  session.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  } catch (e) { /* ignore write errors */ }

  // Update index
  const index = loadIndex();
  index.sessions[safeId] = {
    id: safeId,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    preview: message.content ? message.content.slice(0, 80) : ''
  };
  index.total = Object.keys(index.sessions).length;

  // Trim to max sessions
  const keys = Object.keys(index.sessions);
  if (keys.length > MAX_SESSIONS) {
    const toRemove = keys.slice(0, keys.length - MAX_SESSIONS);
    for (const k of toRemove) {
      delete index.sessions[k];
      try { fs.unlinkSync(path.join(MEMORY_DIR, `${k}.json`)); } catch (e) { /* ignore */ }
    }
  }

  saveIndex(index);
  return session;
}

/**
 * Get all messages for a session.
 */
function getSession(sessionId) {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 128);
  const sessionFile = path.join(MEMORY_DIR, `${safeId}.json`);
  if (!fs.existsSync(sessionFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * List all sessions (from index).
 */
function listSessions() {
  const index = loadIndex();
  const sessions = Object.values(index.sessions);
  // Sort by updatedAt descending
  sessions.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return sessions;
}

/**
 * Delete a session.
 */
function deleteSession(sessionId) {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 128);
  const sessionFile = path.join(MEMORY_DIR, `${safeId}.json`);
  try { fs.unlinkSync(sessionFile); } catch (e) { /* ignore */ }
  const index = loadIndex();
  delete index.sessions[safeId];
  index.total = Object.keys(index.sessions).length;
  saveIndex(index);
}

/**
 * Clear all sessions.
 */
function clearAllSessions() {
  try {
    const files = fs.readdirSync(MEMORY_DIR);
    for (const file of files) {
      if (file.endsWith('.json') && !file.startsWith('_')) {
        fs.unlinkSync(path.join(MEMORY_DIR, file));
      }
    }
  } catch (e) { /* ignore */ }
  saveIndex({ sessions: {}, total: 0 });
}

/**
 * Get memory stats.
 */
function getMemoryStats() {
  const index = loadIndex();
  let totalMessages = 0;
  for (const s of Object.values(index.sessions)) {
    totalMessages += s.messageCount || 0;
  }
  return {
    totalSessions: index.total,
    totalMessages,
    memoryPath: MEMORY_DIR
  };
}

module.exports = {
  saveMessage,
  getSession,
  listSessions,
  deleteSession,
  clearAllSessions,
  getMemoryStats
};