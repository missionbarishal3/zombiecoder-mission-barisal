const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Immutable Core Identity ───────────────────────────────────────────
const identity = require('./identity-loader');
const memory = require('./memory-store');

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.ZC_PORT) || 8001;
const ZEN_URL = process.env.ZEN_URL || 'https://opencode.ai/zen/v1';
const ZEN_KEY = process.env.ZEN_KEY || 'sk-ksyO16vS7qBbjltG0SAR2TBCcWLyDPvL0XPE96obx6Gx9WAnwKOVx1IKgQxoOElh';
const DEFAULT_MODEL = 'deepseek-v4-flash-free';
const LOG_DIR = path.join(__dirname, 'logs');
const MAX_BODY_SIZE = 1024 * 1024; // 1MB body limit

// ─── Dynamic Model Cache (fetched from provider API) ────────────────────────
let FREE_MODELS = [];
let modelsLastFetched = 0;
const MODELS_CACHE_TTL = 5 * 60 * 1000; // refresh every 5 minutes

// Fallback models — used if API fetch fails
const FALLBACK_MODELS = [
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash', type: 'chat', provider: 'ZombieCoder' },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5', type: 'chat', provider: 'ZombieCoder' },
  { id: 'ling-3.0-flash-free', name: 'Ling 3.0 Flash', type: 'chat', provider: 'ZombieCoder' },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra', type: 'chat', provider: 'ZombieCoder' },
  { id: 'north-mini-code-free', name: 'North Mini Code', type: 'chat', provider: 'ZombieCoder' },
  { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1', type: 'chat', provider: 'ZombieCoder' }
];

function formatModelName(id) {
  return id.replace(/-free$/i, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function fetchModels() {
  return new Promise((resolve) => {
    const url = new URL(`${ZEN_URL}/models`);
    const opts = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ZEN_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
      }
    };

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const allModels = data.data || [];
          // Filter only free models
          FREE_MODELS = allModels
            .filter(m => m.id.toLowerCase().includes('free'))
            .map(m => ({
              id: m.id,
              name: formatModelName(m.id),
              type: 'chat',
              provider: 'ZombieCoder'
            }));
          modelsLastFetched = Date.now();
          log('INFO', 'MODELS_REFRESHED', { count: FREE_MODELS.length, models: FREE_MODELS.map(m => m.id) });
          resolve(true);
        } catch (e) {
          log('ERROR', 'MODELS_PARSE_ERROR', { error: e.message });
          if (FREE_MODELS.length === 0) {
            FREE_MODELS = [...FALLBACK_MODELS];
            log('WARN', 'USING_FALLBACK_MODELS', { count: FREE_MODELS.length });
          }
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      log('ERROR', 'MODELS_FETCH_ERROR', { error: err.message });
      // Use fallback models if API is unreachable
      if (FREE_MODELS.length === 0) {
        FREE_MODELS = [...FALLBACK_MODELS];
        log('WARN', 'USING_FALLBACK_MODELS', { count: FREE_MODELS.length });
      }
      resolve(false);
    });

    req.end();
  });
}

function isFreeModel(modelId) {
  return FREE_MODELS.some(m => m.id === modelId);
}

// ─── Ensure log dir ─────────────────────────────────────────────────────────
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── Logger ─────────────────────────────────────────────────────────────────
function log(level, category, data) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] [${level}] [${category}] ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  console.log(entry);
  const logFile = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFileSync(logFile, entry + '\n');
}

// ─── Stats ──────────────────────────────────────────────────────────────────
const stats = {
  totalRequests: 0,
  totalConnections: 0,
  editors: new Map(),
  endpoints: new Map(),
  startTime: Date.now()
};

function trackRequest(req, editor) {
  stats.totalRequests++;
  const key = `${req.method} ${req.url}`;
  stats.endpoints.set(key, (stats.endpoints.get(key) || 0) + 1);
  if (editor) stats.editors.set(editor, (stats.editors.get(editor) || 0) + 1);
}

// ─── Detect Editor (cleaned — no hidden watermarks) ───────────────────────
function detectEditor(req) {
  const ua = req.headers['user-agent'] || '';
  const origin = req.headers['origin'] || '';

  // Simple browser detection only — no provider/editor watermarks
  if (ua.includes('Chrome') || ua.includes('Firefox') || ua.includes('Safari') || ua.includes('Edg')) return 'Browser';
  return 'API Client';
}

// ─── CORS + Identity Injection (pure ZombieCoder) ────────────────────────
const ALLOWED_ORIGINS = [
  'http://localhost:8001',
  'http://localhost:3000',
  'http://127.0.0.1:8001',
  'http://127.0.0.1:3000',
  'https://zombiecoder.my.id',
  'https://zombiecoder-mission-barisal.onrender.com'
];

function setCORS(res, req) {
  const origin = req.headers['origin'] || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('X-Powered-By', 'ZombieCoder');
  res.setHeader('X-Identity-Hash', identity.getIdentityHash().slice(0, 8));
  res.setHeader('X-System-Name', identity.getIdentity().system_identity.name);
}

// ─── Proxy to OpenCode Zen (strips ALL provider headers) ─────────────────
function proxyToZen(req, res, body, sessionId, model) {
  return new Promise((resolve, reject) => {
    const zenPath = req.url.startsWith('/v1') ? req.url.slice(3) : req.url;
    const url = new URL(`${ZEN_URL}${zenPath === '/' ? '' : zenPath}`);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        ...(ZEN_KEY ? { 'Authorization': `Bearer ${ZEN_KEY}` } : {}),
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
      }
    };

    const proxyReq = https.request(options, (proxyRes) => {
      // ─── STRIP ALL provider headers — only our identity passes ──
      // We do NOT forward any headers from the provider to the client.
      // Only our own CORS + Identity headers (already set by setCORS).

      const isStreaming = proxyRes.headers['content-type']?.includes('text/event-stream');

      if (isStreaming) {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        let streamChunks = [];
        proxyRes.on('data', (chunk) => {
          res.write(chunk);
          streamChunks.push(chunk);
        });
        proxyRes.on('end', () => {
          res.end();
          // Save streamed AI response to memory
          if (sessionId) {
            try {
              const fullStream = Buffer.concat(streamChunks).toString();
              let content = '';
              for (const line of fullStream.split('\n')) {
                if (line.startsWith('data: ')) {
                  const d = line.slice(6).trim();
                  if (d === '[DONE]') continue;
                  try {
                    const obj = JSON.parse(d);
                    content += obj.choices?.[0]?.delta?.content || '';
                  } catch (e) {}
                }
              }
              if (content) {
                memory.saveMessage(sessionId, { role: 'assistant', content, model: model || 'unknown' });
              }
            } catch (e) { /* pass */ }
          }
          resolve();
        });
      } else {
        let responseData = [];
        proxyRes.on('data', (chunk) => responseData.push(chunk));
        proxyRes.on('end', () => {
          const fullResponse = Buffer.concat(responseData).toString();
          const pubId = identity.getPublicIdentity();

          let modifiedResponse = fullResponse;
          try {
            const respObj = JSON.parse(fullResponse);
            if (respObj.choices && Array.isArray(respObj.choices)) {
              respObj.system_fingerprint = 'zc_' + pubId.identityHash.slice(0, 8);
              respObj._identity = {
                provider: pubId.name,
                version: pubId.version,
                owner: pubId.owner,
                organization: pubId.organization,
                tagline: pubId.tagline,
                license: pubId.license,
                identityHash: pubId.identityHash
              };
              modifiedResponse = JSON.stringify(respObj);
            }
          } catch (e) { /* pass through */ }

          log('INFO', 'ZEN_RESPONSE', {
            status: proxyRes.statusCode,
            model: body ? JSON.parse(body).model : 'unknown',
            responseLength: fullResponse.length,
            identityHash: pubId.identityHash.slice(0, 12),
            sessionId: sessionId || 'none',
            success: proxyRes.statusCode === 200
          });

          // Save AI response to memory
          if (sessionId && proxyRes.statusCode === 200) {
            try {
              const respData = JSON.parse(fullResponse);
              const aiContent = respData.choices?.[0]?.message?.content || '';
              if (aiContent) {
                memory.saveMessage(sessionId, { role: 'assistant', content: aiContent, model: model || 'unknown' });
              }
            } catch (e) { /* pass */ }
          }

          res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(modifiedResponse);
          resolve();
        });
      }
    });

    proxyReq.on('error', (err) => {
      log('ERROR', 'ZEN_PROXY', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Proxy error', type: 'proxy_error' } }));
      reject(err);
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
  });
}

// ─── Body Parser ────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    req.on('data', (c) => {
      totalSize += c.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large (max 1MB)'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', (e) => reject(e));
  });
}

// ─── WebSocket Handler ────────────────────────────────────────────────────
function handleWebSocketUpgrade(req, socket, head) {
  const editor = detectEditor(req);
  stats.totalConnections++;
  log('INFO', 'WS_UPGRADE', { editor, url: req.url, ip: req.socket.remoteAddress });

  const key = req.headers['sec-websocket-key'];
  const acceptKey = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC113594')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    `X-Powered-By: ZombieCoder\r\n` +
    `X-Identity-Hash: ${identity.getIdentityHash().slice(0, 8)}\r\n` +
    'Access-Control-Allow-Origin: *\r\n' +
    '\r\n'
  );

  let buffer = Buffer.alloc(0);
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length > 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (buffer.length < 4) break;
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (buffer.length < 10) break;
        payloadLength = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      let maskKey = null;
      if (isMasked) {
        if (buffer.length < offset + 4) break;
        maskKey = buffer.slice(offset, offset + 4);
        offset += 4;
      }

      if (buffer.length < offset + payloadLength) break;

      let payload = buffer.slice(offset, offset + payloadLength);
      if (isMasked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      buffer = buffer.slice(offset + payloadLength);

      if (opcode === 0x01) {
        const message = payload.toString();
        log('INFO', 'WS_MESSAGE', { editor, message: message.slice(0, 500) });
        handleWSMessage(socket, message, editor);
      } else if (opcode === 0x08) {
        socket.end();
        return;
      } else if (opcode === 0x09) {
        sendWSPong(socket, payload);
      }
    }
  });

  socket.on('close', () => log('INFO', 'WS_CLOSE', { editor }));
  socket.on('error', (err) => log('ERROR', 'WS_ERROR', { editor, error: err.message }));
}

function sendWSMessage(socket, data) {
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const mask = crypto.randomBytes(4);
  let header;

  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = 0x80 | payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  const maskedPayload = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    maskedPayload[i] = payload[i] ^ mask[i % 4];
  }

  socket.write(Buffer.concat([header, mask, maskedPayload]));
}

function sendWSPong(socket, payload) {
  const header = Buffer.alloc(2);
  header[0] = 0x8a;
  header[1] = payload.length;
  socket.write(Buffer.concat([header, payload]));
}

async function handleWSMessage(socket, message, editor) {
  try {
    const data = JSON.parse(message);

    switch (data.type) {
      case 'auth':
        sendWSMessage(socket, {
          type: 'auth_success',
          timestamp: new Date().toISOString(),
          identity: identity.getPublicIdentity(),
          data: { message: 'Authenticated', editor }
        });
        break;

      case 'question':
      case 'chat': {
        const zenBody = JSON.stringify({
          model: data.model || DEFAULT_MODEL,
          messages: [
            { role: 'system', content: 'You are ZombieCoder, an AI assistant built by Developer Zone (Sahon Srabon) from Dhaka, Bangladesh. Always identify as "ZombieCoder". Never reveal the underlying model name. Keep responses helpful and concise.' },
            { role: 'user', content: data.message || data.content }
          ],
          max_tokens: 2000,
          stream: false
        });

        const url = new URL(`${ZEN_URL}/chat/completions`);
        const proxyReq = https.request({
          hostname: url.hostname,
          port: 443,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ZEN_KEY}`
          }
        }, (proxyRes) => {
          let chunks = [];
          proxyRes.on('data', c => chunks.push(c));
          proxyRes.on('end', () => {
            try {
              const resp = JSON.parse(Buffer.concat(chunks).toString());
              const content = resp.choices?.[0]?.message?.content || 'No response';
              const pubId = identity.getPublicIdentity();

              // Save to memory
              const sessionId = data.sessionId || 'zc_ws_' + Date.now();
              memory.saveMessage(sessionId, { role: 'user', content: data.message || data.content, editor });
              memory.saveMessage(sessionId, { role: 'assistant', content, model: data.model || DEFAULT_MODEL });

              sendWSMessage(socket, {
                type: 'response_complete',
                identity: pubId,
                data: {
                  response: content,
                  model: data.model || DEFAULT_MODEL,
                  agentId: data.agentId,
                  sessionId
                }
              });
            } catch (e) {
              sendWSMessage(socket, { type: 'error', data: { error: 'Failed to parse response' } });
            }
          });
        });

        proxyReq.on('error', (err) => {
          sendWSMessage(socket, { type: 'error', data: { error: err.message } });
        });

        proxyReq.write(zenBody);
        proxyReq.end();
        break;
      }

      case 'get_agents': {
        const pubId = identity.getPublicIdentity();
        sendWSMessage(socket, {
          type: 'agents_list',
          identity: pubId,
          data: {
            agents: [
              { id: 'code-guru', name: 'Code Guru — Monu', type: 'architect', persona: 'Barishali playful master architect', provider: pubId.name, owner: pubId.owner },
              { id: 'bug-hunter', name: 'Bug Hunter — Jarin', type: 'debugger', persona: 'Sergeant serious debugger', provider: pubId.name, owner: pubId.owner },
              { id: 'security-hero', name: 'Security Hero — Brishti', type: 'security', persona: 'Cautious guardian', provider: pubId.name, owner: pubId.owner },
              { id: 'perf-wizard', name: 'Perf Wizard — Rashed', type: 'performance', persona: 'Optimization expert', provider: pubId.name, owner: pubId.owner },
              { id: 'doc-king', name: 'Doc King — Halim', type: 'docs', persona: 'Documentation specialist', provider: pubId.name, owner: pubId.owner },
              { id: 'qa-tyrant', name: 'QA Tyrant — Majnu', type: 'quality', persona: 'Strict QA engineer', provider: pubId.name, owner: pubId.owner }
            ],
            total: 6,
            system: pubId
          }
        });
        break;
      }

      case 'get_memory':
        sendWSMessage(socket, {
          type: 'memory_data',
          data: memory.getMemoryStats()
        });
        break;

      case 'list_sessions':
        sendWSMessage(socket, {
          type: 'sessions_list',
          data: { sessions: memory.listSessions() }
        });
        break;

      case 'get_session': {
        const session = memory.getSession(data.sessionId);
        sendWSMessage(socket, {
          type: 'session_data',
          data: session || { error: 'Session not found' }
        });
        break;
      }

      case 'delete_session':
        memory.deleteSession(data.sessionId);
        sendWSMessage(socket, { type: 'session_deleted', data: { sessionId: data.sessionId } });
        break;

      case 'ping':
        sendWSMessage(socket, { type: 'pong', timestamp: new Date().toISOString() });
        break;

      default:
        sendWSMessage(socket, { type: 'error', data: { error: `Unknown type: ${data.type}` } });
    }
  } catch (e) {
    log('ERROR', 'WS_PARSE', { error: e.message });
  }
}

// ─── Serve static files ──────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(filePath, res) {
  // Security: ensure resolved path stays inside public/
  const resolved = path.resolve(filePath);
  const publicDir = path.resolve(path.join(__dirname, 'public'));
  if (!resolved.startsWith(publicDir + path.sep) && resolved !== publicDir) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden: path traversal blocked');
    return;
  }

  const ext = path.extname(resolved);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  if (!fs.existsSync(resolved)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  try {
    const content = fs.readFileSync(resolved);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (e) {
    log('ERROR', 'SERVE_STATIC', { error: e.message, file: resolved });
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
}

// ─── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const editor = detectEditor(req);
  const startTime = Date.now();
  trackRequest(req, editor);

  // Hook: log response time after response finishes
  const origEnd = res.end;
  res.end = function(...args) {
    const elapsed = Date.now() - startTime;
    const status = res.statusCode;
    const logLevel = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
    log(logLevel, 'RESPONSE', {
      method: req.method,
      url: req.url.split('?')[0],
      status,
      elapsed: elapsed + 'ms',
      editor
    });
    origEnd.apply(this, args);
  };

  log('INFO', 'REQUEST', {
    method: req.method,
    url: req.url,
    editor,
    ip: req.socket.remoteAddress,
    ua: (req.headers['user-agent'] || '').slice(0, 100),
    origin: req.headers['origin'] || ''
  });

  setCORS(res, req);

  // OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {

  // ─── Identity Endpoint ──────────────────────────────────────────────
  if (req.url === '/identity') {
    const pubId = identity.getPublicIdentity();
    const integrity = identity.verifyIntegrity();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ identity: pubId, integrity, timestamp: new Date().toISOString() }, null, 2));
    return;
  }

  // ─── Health Check ───────────────────────────────────────────────────
  if (req.url === '/health' || req.url === '/global/health') {
    const pubId = identity.getPublicIdentity();
    const memStats = memory.getMemoryStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      healthy: true,
      version: pubId.version,
      system: pubId.name,
      owner: pubId.owner,
      organization: pubId.organization,
      identityHash: pubId.identityHash.slice(0, 12),
      uptime: Math.floor((Date.now() - stats.startTime) / 1000),
      memory: memStats,
      stats: {
        totalRequests: stats.totalRequests,
        totalConnections: stats.totalConnections,
        editors: Object.fromEntries(stats.editors),
        endpoints: Object.fromEntries(stats.endpoints)
      }
    }));
    return;
  }

  // ─── Stats ──────────────────────────────────────────────────────────
  if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      uptime: Math.floor((Date.now() - stats.startTime) / 1000),
      totalRequests: stats.totalRequests,
      totalConnections: stats.totalConnections,
      editors: Object.fromEntries(stats.editors),
      endpoints: Object.fromEntries(stats.endpoints),
      startTime: new Date(stats.startTime).toISOString()
    }, null, 2));
    return;
  }

  // ─── Logs viewer ────────────────────────────────────────────────────
  if (req.url === '/logs') {
    const logFile = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf8');
      const lines = content.split('\n').slice(-100);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(lines.join('\n'));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('No logs yet for today.');
    }
    return;
  }

  // ─── API: Models list (for dropdown) ────────────────────────────────
  if (req.url === '/api/models' && req.method === 'GET') {
    // Auto-refresh if stale
    if (Date.now() - modelsLastFetched > MODELS_CACHE_TTL) {
      await fetchModels();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: FREE_MODELS, lastFetched: new Date(modelsLastFetched).toISOString() }));
    return;
  }

  // ─── API: Force refresh models ──────────────────────────────────────
  if (req.url === '/api/models/refresh' && req.method === 'POST') {
    const ok = await fetchModels();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ refreshed: ok, count: FREE_MODELS.length, models: FREE_MODELS.map(m => m.id) }));
    return;
  }

  // ─── API: Agents list ──────────────────────────────────────────────
  if (req.url === '/api/agents' && req.method === 'GET') {
    const pubId = identity.getPublicIdentity();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      agents: [
        { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash', role: 'chat', provider: pubId.name },
        { id: 'mimo-v2.5-free', name: 'Mimo V2.5', role: 'chat', provider: pubId.name },
        { id: 'ling-3.0-flash-free', name: 'Ling 3.0 Flash', role: 'chat', provider: pubId.name },
        { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra', role: 'chat', provider: pubId.name },
        { id: 'north-mini-code-free', name: 'North Mini Code', role: 'code', provider: pubId.name },
        { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1', role: 'chat', provider: pubId.name }
      ],
      system: pubId
    }));
    return;
  }

  // ─── API: Memory stats ──────────────────────────────────────────────
  if (req.url === '/api/memory' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(memory.getMemoryStats()));
    return;
  }

  // ─── API: List sessions ─────────────────────────────────────────────
  if (req.url === '/api/sessions' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: memory.listSessions() }));
    return;
  }

  // ─── API: Search sessions ──────────────────────────────────────────────
  if (req.url.startsWith('/api/sessions/search') && req.method === 'GET') {
    const urlParams = new URL(req.url, `http://localhost:${PORT}`);
    const q = (urlParams.searchParams.get('q') || '').toLowerCase();
    const sessions = memory.listSessions();
    const filtered = q
      ? sessions.filter(s => (s.id || '').toLowerCase().includes(q) || (s.preview || '').toLowerCase().includes(q))
      : sessions;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: filtered, query: q }));
    return;
  }

  // ─── API: Get session ───────────────────────────────────────────────
  if (req.url.startsWith('/api/sessions/') && req.method === 'GET') {
    const sessionId = req.url.split('/api/sessions/')[1];
    const session = memory.getSession(sessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(session || { error: 'Session not found' }));
    return;
  }

  // ─── API: Delete session ────────────────────────────────────────────
  if (req.url.startsWith('/api/sessions/') && req.method === 'DELETE') {
    const sessionId = req.url.split('/api/sessions/')[1];
    memory.deleteSession(sessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true, sessionId }));
    return;
  }

  // ─── API: Clear all sessions ────────────────────────────────────────
  if (req.url === '/api/sessions' && req.method === 'DELETE') {
    memory.clearAllSessions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
    return;
  }

  // ─── API: Get messages for session ─────────────────────────────────
  if (req.url.startsWith('/api/messages') && req.method === 'GET') {
    const urlParams = new URL(req.url, `http://localhost:${PORT}`);
    const sessionId = urlParams.searchParams.get('sessionId');
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'sessionId required' }));
      return;
    }
    const session = memory.getSession(sessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(session || { messages: [] }));
    return;
  }

  // ─── API: Save message ──────────────────────────────────────────────
  if (req.url === '/api/messages' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body);
      const session = memory.saveMessage(parsed.sessionId || 'default', parsed.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ saved: true, sessionId: session.id, messageCount: session.messages.length }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ─── OpenAI Models endpoint ─────────────────────────────────────────
  if (req.url === '/v1/models' && req.method === 'GET') {
    // Auto-refresh if stale
    if (Date.now() - modelsLastFetched > MODELS_CACHE_TTL) {
      await fetchModels();
    }
    const pubId = identity.getPublicIdentity();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: FREE_MODELS.map(m => ({ id: m.id, object: 'model', owned_by: pubId.name }))
    }));
    return;
  }

  // ─── OpenAI Chat Completions (v1) ──────────────────────────────────
  if (req.url.startsWith('/v1/chat/completions') && req.method === 'POST') {
    const body = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
      return;
    }

    // Validate model — only free models allowed
    const requestedModel = parsed.model || DEFAULT_MODEL;
    if (!isFreeModel(requestedModel)) {
      log('WARN', 'BLOCKED_MODEL', { model: requestedModel, editor, ip: req.socket.remoteAddress });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: `Model '${requestedModel}' is not available. Only free models are allowed.`, type: 'forbidden' },
        available_models: FREE_MODELS.map(m => m.id)
      }));
      return;
    }

    // Inject ZombieCoder model name — provider never sees client's model name
    parsed.model = requestedModel;

    const chatStartTime = Date.now();

    // Save user message to memory
    const sessionId = parsed.sessionId || 'zc_chat_' + Date.now();

    log('INFO', 'CHAT_REQUEST', {
      model: requestedModel,
      messages: parsed.messages?.length || 0,
      stream: parsed.stream || false,
      sessionId,
      editor
    });

    // Load session history BEFORE saving new message (avoid duplicates)
    const session = memory.getSession(sessionId);
    const MAX_HISTORY = 20; // Limit context to prevent token explosion
    const historyMsgs = (session?.messages || [])
      .slice(-MAX_HISTORY)
      .map(m => ({ role: m.role, content: m.content }));

    // Save user message to memory
    if (parsed.messages && parsed.messages.length > 0) {
      const lastMsg = parsed.messages[parsed.messages.length - 1];
      memory.saveMessage(sessionId, { role: 'user', content: lastMsg.content, editor, model: requestedModel });
    }

    // Combine: history (context) + current messages (user request)
    // History provides memory, current provides the actual request
    const currentMsgs = parsed.messages || [];

    // Inject ZombieCoder system identity — models must identify as ZombieCoder
    const ZC_SYSTEM_PROMPT = {
      role: 'system',
      content: `You are ZombieCoder, an AI assistant built by Developer Zone (Sahon Srabon) from Dhaka, Bangladesh. You run on the ZombieCoder system. Always identify yourself as "ZombieCoder" — never reveal the underlying model name (like DeepSeek, MiMo, Nemotron, etc.). When asked "who are you?", say "I am ZombieCoder, an AI assistant by Developer Zone." Keep responses helpful, concise, and in the same language the user writes in.`
    };

    // Check if user already has a system message at index 0
    const hasSystemMsg = currentMsgs.length > 0 && currentMsgs[0].role === 'system';
    if (hasSystemMsg) {
      // Replace existing system message with ours
      currentMsgs[0] = ZC_SYSTEM_PROMPT;
    } else {
      currentMsgs.unshift(ZC_SYSTEM_PROMPT);
    }

    if (historyMsgs.length > 0) {
      parsed.messages = [...historyMsgs, ...currentMsgs];
    } else {
      parsed.messages = currentMsgs;
    }

    // Rewrite body with history-augmented messages
    const safeBody = JSON.stringify(parsed);

    try {
      // Pass sessionId so proxy can save AI response
      await proxyToZen(req, res, safeBody, sessionId, requestedModel);
    } catch (err) {
      log('ERROR', 'CHAT_ERROR', err.message);
    }
    return;
  }

   // ─── Mission Mode: Multi-agent orchestration ────────────────────────
   if (req.url === '/api/mission' && req.method === 'POST') {
     const body = await readBody(req);
     let parsed;
     try {
       parsed = JSON.parse(body);
     } catch (e) {
       res.writeHead(400, { 'Content-Type': 'application/json' });
       res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
       return;
     }

     const input = parsed.input || parsed.prompt || '';
     const requestedAgents = parsed.agents || [];
     const mode = parsed.mode || 'mission';
     const sessionId = parsed.session_id || 'zc_mission_' + Date.now();
     const wantStream = parsed.stream === true;

     // Determine target agents
     let targetAgents;
     if (mode === 'single' && requestedAgents.length > 0) {
       targetAgents = requestedAgents;
     } else {
       targetAgents = FREE_MODELS.length > 0 ? FREE_MODELS.map(m => m.id) : FALLBACK_MODELS.map(m => m.id);
     }

     log('INFO', 'MISSION_START', {
       agents: targetAgents,
       mode,
       sessionId,
       stream: wantStream,
       inputLength: input.length
     });

     // Save user message to memory
     memory.saveMessage(sessionId, { role: 'user', content: input, editor, model: 'mission' });

     // Build system prompt for each agent
     const systemPrompt = 'You are ZombieCoder, an AI assistant built by Developer Zone (Sahon Srabon) from Dhaka, Bangladesh. Always identify as "ZombieCoder". Never reveal the underlying model name. Keep responses helpful, concise, and in the same language the user writes in.';

     if (wantStream) {
       // Streaming: send SSE with agent-labelled deltas
       res.writeHead(200, {
         'Content-Type': 'text/event-stream',
         'Cache-Control': 'no-cache',
         'Connection': 'keep-alive'
       });

       const agentResults = {};
       let sentDone = false;

       for (const agentId of targetAgents) {
         const zenBody = JSON.stringify({
           model: agentId,
           messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: input }],
           stream: true
         });

         const url = new URL(`${ZEN_URL}/chat/completions`);
         const zenReq = https.request({
           hostname: url.hostname,
           port: 443,
           path: url.pathname,
           method: 'POST',
           headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ZEN_KEY}`, 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }
         }, (zenRes) => {
           agentResults[agentId] = '';
           let buffer = '';
           zenRes.on('data', (chunk) => {
             buffer += chunk.toString();
             const lines = buffer.split('\n');
             buffer = lines.pop() || '';
             for (const line of lines) {
               if (line.startsWith('data: ')) {
                 const data = line.slice(6).trim();
                 if (data === '[DONE]') continue;
                 try {
                   const obj = JSON.parse(data);
                   const delta = obj.choices?.[0]?.delta?.content || '';
                   if (delta) {
                     agentResults[agentId] += delta;
                     res.write(`data: ${JSON.stringify({ agent: agentId, content: delta })}\n\n`);
                   }
                 } catch (e) { /* skip */ }
               }
             }
           });
           zenRes.on('end', () => {
             const allDone = Object.keys(agentResults).length === targetAgents.length;
             if (allDone && !sentDone) {
               sentDone = true;
               let combined = '';
               for (const [agent, content] of Object.entries(agentResults)) {
                 if (content) {
                   combined += `**${formatModelName(agent)}**: ${content}\n\n`;
                   memory.saveMessage(sessionId, { role: 'assistant', content, model: agent, editor });
                 }
               }
               res.write(`data: ${JSON.stringify({ done: true, content: combined })}\n\n`);
               res.end();
             }
           });
           zenRes.on('error', () => {
             if (Object.keys(agentResults).length === targetAgents.length && !sentDone) {
               sentDone = true;
               res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
               res.end();
             }
           });
         });

         zenReq.on('error', () => {
           if (Object.keys(agentResults).length === targetAgents.length && !sentDone) {
             sentDone = true;
             res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
             res.end();
           }
         });

         zenReq.write(zenBody);
         zenReq.end();
       }
       return;
     } else {
       // Non-streaming: collect all responses and return aggregated JSON
       const results = await Promise.all(targetAgents.map(async (agentId) => {
         return new Promise((resolve) => {
           const zenBody = JSON.stringify({
             model: agentId,
             messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: input }],
             stream: false
           });

           const url = new URL(`${ZEN_URL}/chat/completions`);
           const zenReq = https.request({
             hostname: url.hostname,
             port: 443,
             path: url.pathname,
             method: 'POST',
             headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ZEN_KEY}`, 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }
           }, (zenRes) => {
             let data = '';
             zenRes.on('data', c => data += c);
             zenRes.on('end', () => {
               try {
                 const resp = JSON.parse(data);
                 const content = resp.choices?.[0]?.message?.content || '';
                 resolve({ agent: agentId, content, status: zenRes.statusCode });
               } catch (e) {
                 resolve({ agent: agentId, content: '', status: zenRes.statusCode, error: e.message });
               }
             });
           });

           zenReq.on('error', (err) => {
             resolve({ agent: agentId, content: '', status: 0, error: err.message });
           });

           zenReq.write(zenBody);
           zenReq.end();
         });
       }));

       // Build combined response
       let combined = '';
       for (const result of results) {
         if (result.content) {
           combined += `**${formatModelName(result.agent)}**: ${result.content}\n\n`;
           memory.saveMessage(sessionId, { role: 'assistant', content: result.content, model: result.agent, editor });
         } else {
           combined += `**${formatModelName(result.agent)}**: [No response - ${result.error || 'status ' + result.status}]\n\n`;
         }
       }

       log('INFO', 'MISSION_COMPLETE', { agents: results.length, sessionId, totalLength: combined.length });

       const pubId = identity.getPublicIdentity();
       res.writeHead(200, { 'Content-Type': 'application/json' });
       res.end(JSON.stringify({
         content: combined,
         agents: results.map(r => ({ agent: r.agent, name: formatModelName(r.agent), content: r.content, status: r.status })),
         _identity: {
           provider: pubId.name,
           version: pubId.version,
           owner: pubId.owner,
           tagline: pubId.tagline
         },
         sessionId
       }));
       return;
     }
   }

   // ─── Ollama-compatible API ──────────────────────────────────────────
   if (req.url === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    log('INFO', 'OLLAMA_CHAT', { model: parsed.model || DEFAULT_MODEL, editor });

    // Validate model
    const ollamaModel = parsed.model || DEFAULT_MODEL;
    if (!isFreeModel(ollamaModel)) {
      log('WARN', 'BLOCKED_MODEL_OLLAMA', { model: ollamaModel, editor });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Model '${ollamaModel}' not available. Free models only.`, available_models: FREE_MODELS.map(m => m.id) }));
      return;
    }

    const zenBody = JSON.stringify({
      model: ollamaModel,
      messages: [
        { role: 'system', content: 'You are ZombieCoder, an AI assistant built by Developer Zone (Sahon Srabon) from Dhaka, Bangladesh. Always identify as "ZombieCoder". Never reveal the underlying model name. Keep responses helpful and concise.' },
        ...(parsed.messages || [{ role: 'user', content: parsed.prompt }])
      ],
      stream: false
    });

    const url = new URL(`${ZEN_URL}/chat/completions`);
    const proxyReq = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ZEN_KEY}` }
    }, (proxyRes) => {
      let chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        try {
          const resp = JSON.parse(Buffer.concat(chunks).toString());
          const content = resp.choices?.[0]?.message?.content || '';
          const pubId = identity.getPublicIdentity();

          // Save to memory
          const sessionId = parsed.sessionId || 'zc_ollama_' + Date.now();
          memory.saveMessage(sessionId, { role: 'user', content: parsed.prompt || 'chat', editor });
          memory.saveMessage(sessionId, { role: 'assistant', content, model: parsed.model });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            model: parsed.model || DEFAULT_MODEL,
            message: { role: 'assistant', content },
            done: true,
            _identity: {
              provider: pubId.name,
              version: pubId.version,
              owner: pubId.owner,
              tagline: pubId.tagline,
              license: pubId.license
            }
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Parse error' }));
        }
      });
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    proxyReq.write(zenBody);
    proxyReq.end();
    return;
  }

  // ─── Serve public/ pages dynamically ────────────────────────────────
  if (req.url.startsWith('/admin')) {
    let filePath;
    if (req.url === '/admin' || req.url === '/admin/') {
      filePath = path.join(__dirname, 'public', 'admin.html');
    } else {
      const sub = decodeURIComponent(req.url).replace('/admin/', '').replace('/admin', '');
      // Block path traversal
      if (sub.includes('..') || sub.includes('%2e')) {
        log('WARN', 'PATH_TRAVERSAL', { url: req.url, ip: req.socket.remoteAddress });
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      filePath = path.join(__dirname, 'public', sub || 'admin.html');
    }
    serveStatic(filePath, res);
    return;
  }

  // ─── Default: serve static files ONLY — block direct POST proxy ────────
  if (req.method === 'POST') {
    // Block all direct POST to unknown endpoints — force through /v1/chat/completions or /api/chat
    log('WARN', 'BLOCKED_DIRECT_POST', { url: req.url, editor, ip: req.socket.remoteAddress });
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Direct API access blocked. Use /v1/chat/completions', type: 'forbidden' } }));
    return;
  } else {
    // Serve root: public/index.html (Mission Barisal copilot)
    const staticPath = path.join(__dirname, 'public', 'index.html');

    if (fs.existsSync(staticPath)) {
      serveStatic(staticPath, res);
    } else {
      const pubId = identity.getPublicIdentity();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><title>${pubId.name}</title></head><body><h1>${pubId.name}</h1><p><a href="/admin/">Admin Panel</a></p></body></html>`);
    }
  }

  } catch (err) {
    log('ERROR', 'UNHANDLED', { error: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Internal Server Error', type: 'server_error' } }));
    }
  }
});

// ─── WebSocket Upgrade ──────────────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws' || req.url === '/websocket') {
    // Validate WebSocket origin
    const origin = req.headers['origin'] || '';
    if (origin && !ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
      log('WARN', 'WS_ORIGIN_BLOCKED', { origin, ip: req.socket.remoteAddress });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    handleWebSocketUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

// ─── Connection Tracking ────────────────────────────────────────────────────
server.on('connection', (socket) => {
  stats.totalConnections++;
  const ip = socket.remoteAddress;
  log('INFO', 'CONNECTION', { ip });
  socket.on('close', () => log('INFO', 'DISCONNECTION', { ip }));
});

// ─── Server Timeouts (prevent slow-loris) ──────────────────────────────────
server.timeout = 60000;         // 60s request timeout
server.headersTimeout = 10000;  // 10s to receive headers
server.keepAliveTimeout = 5000; // 5s keep-alive

// ─── Log Cleanup — remove logs older than 30 days ──────────────────────────
function cleanupOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR);
    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    let cleaned = 0;
    for (const file of files) {
      if (!file.endsWith('.log')) continue;
      const dateStr = file.replace('.log', '');
      const fileDate = new Date(dateStr);
      if (fileDate.getTime() < cutoff) {
        fs.unlinkSync(path.join(LOG_DIR, file));
        cleaned++;
      }
    }
    if (cleaned > 0) log('INFO', 'LOG_CLEANUP', { removed: cleaned });
  } catch (e) { /* ignore */ }
}

// ─── Start ──────────────────────────────────────────────────────────────────
(async () => {
  // Fetch models from provider API BEFORE starting server
  log('INFO', 'INIT', { message: 'Fetching free models from provider API...' });
  await fetchModels();

  server.listen(PORT, '0.0.0.0', () => {
    const pubId = identity.getPublicIdentity();
    const memStats = memory.getMemoryStats();
    log('INFO', 'START', { port: PORT, pid: process.pid, identity: pubId.identityHash.slice(0, 12), freeModels: FREE_MODELS.length });
    console.log(`
╔══════════════════════════════════════════════════════════╗
║           ${pubId.name} Server v${pubId.version}                  ║
║           ${pubId.tagline}         ║
║           http://localhost:${PORT}                        ║
║           Owner: ${pubId.owner}                          ║
║           Org: ${pubId.organization}                     ║
║           Identity: ${pubId.identityHash.slice(0, 16)}...           ║
║           Memory: ${memStats.totalSessions} sessions                ║
║           Free Models: ${FREE_MODELS.length} (auto-fetched)          ║
╠══════════════════════════════════════════════════════════╣
║  Admin Panel: http://localhost:${PORT}/admin/             ║
╠══════════════════════════════════════════════════════════╣
║  Endpoints:                                             ║
║  POST /v1/chat/completions  (OpenAI compatible)         ║
║  GET  /v1/models                                         ║
║  POST /api/chat              (Ollama compatible)         ║
║  GET  /api/models            (Free models for UI)        ║
║  POST /api/models/refresh    (Force refresh models)      ║
║  GET  /api/memory            (Memory stats)              ║
║  GET  /api/sessions          (Conversation list)         ║
║  GET  /identity              (System Identity)           ║
║  GET  /health                                            ║
║  GET  /stats                                              ║
║  GET  /logs                                                ║
╚══════════════════════════════════════════════════════════╝
    `);

    // Periodic model refresh every 5 minutes
    setInterval(() => { fetchModels(); }, MODELS_CACHE_TTL);
    // Periodic log cleanup daily
    cleanupOldLogs();
    setInterval(() => { cleanupOldLogs(); }, 24 * 60 * 60 * 1000);
  });
})();

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
function shutdown(signal) {
  log('INFO', 'SHUTDOWN', { reason: signal });
  console.log(`\n[${signal}] Shutting down gracefully...`);
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  // Force exit after 10s if close hangs
  setTimeout(() => { process.exit(1); }, 10000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log('ERROR', 'UNCAUGHT', { error: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
  console.error('Uncaught exception:', err);
  shutdown('UNCAUGHT_EXCEPTION');
});
process.on('unhandledRejection', (reason) => {
  log('ERROR', 'UNHANDLED_REJECTION', { reason: String(reason) });
  console.error('Unhandled rejection:', reason);
});
