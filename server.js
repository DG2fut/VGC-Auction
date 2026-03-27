const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

/* ═══════════════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════════════ */
function randomUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.randomBytes(1)[0] & 15 >> c / 4).toString(16));
}

const DATA_DIR = path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

/* ═══════════════════════════════════════════════════════════════════════════════
   GOOGLE SHEETS INTEGRATION (zero-dependency, uses raw HTTPS + JWT)
   ═══════════════════════════════════════════════════════════════════════════════ */
const SHEETS_CREDS_FILE = path.join(__dirname, 'credentials.json');
const SPREADSHEET_ID = '1sGE_AgiMiFWt_9wjpmLNjfr4rFfTuVibWZfKsPX3dKY';
const SHEET_NAME = 'Sheet1'; // default tab

let sheetsCreds = null;
let sheetsToken = null;
let sheetsTokenExpiry = 0;

try {
  if (fs.existsSync(SHEETS_CREDS_FILE)) {
    sheetsCreds = JSON.parse(fs.readFileSync(SHEETS_CREDS_FILE, 'utf8'));
    console.log('  Google Sheets credentials loaded');
  } else {
    console.log('  No credentials.json found — Google Sheets logging disabled');
  }
} catch (e) {
  console.log('  Failed to load credentials.json:', e.message);
}

// Base64url encoding for JWT
function b64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
    .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Create a signed JWT for Google Sheets API
function createJWT() {
  if (!sheetsCreds) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sheetsCreds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(sheetsCreds.private_key);
  return unsigned + '.' + b64url(signature);
}

// Get an access token (cached, refreshes every ~55 min)
async function getSheetsToken() {
  if (!sheetsCreds) return null;
  if (sheetsToken && Date.now() < sheetsTokenExpiry) return sheetsToken;
  const jwt = createJWT();
  if (!jwt) return null;
  return new Promise((resolve) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req = https.request({
      method: 'POST',
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          sheetsToken = parsed.access_token;
          sheetsTokenExpiry = Date.now() + 55 * 60 * 1000; // refresh a bit early
          resolve(sheetsToken);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// Append rows to Google Sheet (fire-and-forget, non-blocking)
function appendToSheet(rows) {
  if (!sheetsCreds || !rows.length) return;
  getSheetsToken().then(token => {
    if (!token) return;
    const body = JSON.stringify({ values: rows });
    const encodedRange = encodeURIComponent(`${SHEET_NAME}!A:J`);
    const apiPath = `/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodedRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const req = https.request({
      method: 'POST',
      hostname: 'sheets.googleapis.com',
      path: apiPath,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode >= 400) console.error('Sheets API error:', res.statusCode, data.slice(0, 200));
      });
    });
    req.on('error', e => console.error('Sheets request error:', e.message));
    req.write(body);
    req.end();
  }).catch(e => console.error('Sheets token error:', e.message));
}

// Helper: log a nomination start to the sheet
function sheetsLogNomination(roundNum, pokemonName, tier, nominatedBy) {
  appendToSheet([[
    'NOMINATION',
    roundNum,
    pokemonName,
    tier,
    '', // winner
    '', // final bid
    `Nominated by ${nominatedBy}`,
    '', // passed
    new Date().toISOString(),
  ]]);
}

// Helper: log a bid to the sheet
function sheetsLogBid(roundNum, pokemonName, bidderName, amount) {
  appendToSheet([[
    'BID',
    roundNum,
    pokemonName,
    '', // tier
    bidderName,
    amount,
    '', // all bids
    '', // passed
    new Date().toISOString(),
  ]]);
}

// Helper: log a round result (WON / UNSOLD / SKIPPED) to the sheet
function sheetsLogRoundEnd(roundNum, pokemonName, tier, winner, finalBid, allBids, passedNames) {
  const bidsSummary = allBids.map(b => `${b.player}: $${b.amount}`).join('; ');
  const passedSummary = passedNames.join(', ');
  appendToSheet([[
    winner === 'skipped' ? 'SKIPPED' : winner === 'unsold' ? 'UNSOLD' : 'WON',
    roundNum,
    pokemonName,
    tier,
    winner === 'skipped' || winner === 'unsold' ? winner : winner,
    finalBid || 0,
    bidsSummary,
    passedSummary,
    new Date().toISOString(),
  ]]);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ZERO-DEPENDENCY WEBSOCKET SERVER
   ═══════════════════════════════════════════════════════════════════════════════ */
function createWSServer(server) {
  const clients = new Map();

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const id = randomUUID();
    clients.set(id, { socket, playerId: null });

    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        if (buf.length < 2) break;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const total = off + (masked ? 4 : 0) + len;
        if (buf.length < total) break;
        let payload;
        if (masked) {
          const mask = buf.slice(off, off + 4);
          payload = Buffer.alloc(len);
          for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mask[i % 4];
        } else {
          payload = buf.slice(off, off + len);
        }
        buf = buf.slice(total);
        const opcode = buf.length > 0 ? undefined : undefined; // not needed, we read from original buf
        try { handleMessage(id, JSON.parse(payload.toString('utf8'))); } catch(e) {}
      }
    });

    socket.on('close', () => {
      const c = clients.get(id);
      if (c && c.playerId) {
        const p = state.players.get(c.playerId);
        if (p) {
          if (state.phase === 'lobby') {
            // In lobby: remove player entirely on disconnect
            if (p.isSpectator) {
              addLog(`👁️ Spectator ${p.name} left.`);
            } else {
              addLog(`🚪 ${p.name} left the lobby.`);
            }
            state.players.delete(c.playerId);
            // Remove session token mapping
            for (const [tok, pid] of sessionTokens) {
              if (pid === c.playerId) { sessionTokens.delete(tok); break; }
            }
            // Remove from hostIds if they were a host
            if (state.hostIds && state.hostIds.has(c.playerId)) {
              state.hostIds.delete(c.playerId);
            }
          } else {
            // Mid-auction: keep as offline
            if (p.isSpectator) {
              addLog(`👁️ Spectator ${p.name} left.`);
              state.players.delete(c.playerId);
              for (const [tok, pid] of sessionTokens) {
                if (pid === c.playerId) { sessionTokens.delete(tok); break; }
              }
            } else {
              addLog(`🚪 ${p.name} disconnected.`);
              p.online = false;
              p.clientId = null;
            }
          }
          broadcastState();
          persistState();
        }
      }
      clients.delete(id);
    });
    socket.on('error', () => clients.delete(id));
  });

  function encode(str) {
    const p = Buffer.from(str, 'utf8'), l = p.length;
    let h;
    if (l < 126) h = Buffer.from([0x81, l]);
    else if (l < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(l, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(l), 2); }
    return Buffer.concat([h, p]);
  }

  function send(id, obj) {
    const c = clients.get(id);
    if (!c) return;
    try { c.socket.write(encode(JSON.stringify(obj))); } catch(e) {}
  }
  function broadcastAll(obj) { for (const [id] of clients) send(id, obj); }

  return { send, broadcastAll, clients };
}

/* ═══════════════════════════════════════════════════════════════════════════════
   POKÉMON POOL — loaded from pokemon-pool.json (edit that file to customize)
   ═══════════════════════════════════════════════════════════════════════════════ */
const POOL_FILE = path.join(__dirname, 'pokemon-pool.json');
let POKEMON_POOL;
try {
  POKEMON_POOL = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
  console.log(`  Loaded ${POKEMON_POOL.length} Pokémon from pokemon-pool.json`);
} catch (e) {
  console.error('FATAL: Could not load pokemon-pool.json —', e.message);
  process.exit(1);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   PERSISTENCE
   ═══════════════════════════════════════════════════════════════════════════════ */
const ADMINS_FILE  = path.join(DATA_DIR, 'admins.json');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const HISTORY_FILE = path.join(DATA_DIR, 'auction-history.json');
const ROUND_LOG_FILE = path.join(DATA_DIR, 'auction-logs.json');

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) { console.error('Save error:', file, e.message); }
}

function loadAdmins() {
  const data = loadJSON(ADMINS_FILE, {});
  return new Map(Object.entries(data));
}
function saveAdmins() {
  saveJSON(ADMINS_FILE, Object.fromEntries(ADMIN_LIST));
}

function loadHistory() {
  return loadJSON(HISTORY_FILE, []);
}
function saveHistory() {
  saveJSON(HISTORY_FILE, auctionHistory);
}

function loadRoundLogs() {
  return loadJSON(ROUND_LOG_FILE, []);
}
let roundLogs = [];
let roundBids = []; // tracks bids for current round

function serializeState() {
  return {
    phase: state.phase,
    players: Object.fromEntries([...state.players.entries()].map(([id, p]) => [id, { ...p, roster: [...p.roster] }])),
    currentPokemon: state.currentPokemon,
    currentBid: state.currentBid,
    currentBidder: state.currentBidder,
    nominatedBy: state.nominatedBy,
    auctionedPokemon: [...state.auctionedPokemon],
    log: state.log,
    hostIds: [...(state.hostIds || (state.hostId ? [state.hostId] : []))],
    adminIds: [...state.adminIds],
    settings: { ...state.settings, basePriceTier: { ...state.settings.basePriceTier } },
    roundCount: state.roundCount,
    auctionName: state.auctionName,
    passedPlayers: [...state.passedPlayers],
    pausedRemaining: state.pausedRemaining,
    joinRequests: [...state.joinRequests],
    sessionTokens: Object.fromEntries(sessionTokens),
  };
}

function deserializeState(data) {
  const s = {
    phase: data.phase || 'lobby',
    players: new Map(Object.entries(data.players || {}).map(([id, p]) => [id, { ...p, roster: [...(p.roster || [])] }])),
    currentPokemon: data.currentPokemon || null,
    currentBid: data.currentBid || 0,
    currentBidder: data.currentBidder || null,
    nominatedBy: data.nominatedBy || null,
    auctionedPokemon: new Set(data.auctionedPokemon || []),
    log: data.log || [],
    hostIds: new Set(data.hostIds || (data.hostId ? [data.hostId] : [])),
    adminIds: new Set(data.adminIds || []),
    settings: {
      timerSecs: data.settings?.timerSecs || DEFAULT_TIMER,
      startingBudget: data.settings?.startingBudget || DEFAULT_BUDGET,
      maxPokemon: data.settings?.maxPokemon ?? 6,
      basePriceTier: data.settings?.basePriceTier || { S: 500, A: 250, B: 100, C: 50 },
      bidIncrement: data.settings?.bidIncrement || 25,
    },
    undoStack: [],
    redoStack: [],
    roundCount: data.roundCount || 0,
    auctionName: data.auctionName || 'Auction #1',
    passedPlayers: new Set(data.passedPlayers || []),
    timerEnd: null,
    pausedRemaining: data.pausedRemaining || null,
    joinRequests: new Set(data.joinRequests || []),
  };
  // If was in bidding, convert to paused
  if (s.phase === 'bidding') {
    s.phase = 'paused';
    s.pausedRemaining = s.pausedRemaining || s.settings.timerSecs * 1000;
  }
  // Mark all players offline on server restart
  for (const [, p] of s.players) {
    p.online = false;
    p.clientId = null;
  }
  return s;
}

function persistState() {
  saveJSON(SESSION_FILE, serializeState());
}

function loadSessionState() {
  const data = loadJSON(SESSION_FILE, null);
  if (!data) return null;
  if (data.sessionTokens) {
    sessionTokens = new Map(Object.entries(data.sessionTokens));
  }
  return deserializeState(data);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ADMIN CREDENTIALS — hardcoded, no dynamic registration
   ═══════════════════════════════════════════════════════════════════════════════ */
const ADMIN_SALT = 'vgcsalt';
function hashPass(p) { return crypto.createHash('sha256').update(p + ADMIN_SALT).digest('hex'); }

const HARDCODED_ADMINS = {
  benguins10: hashPass('random'),
  DG2fut: hashPass('randint'),
};

// Load from file and merge hardcoded on top (hardcoded always wins)
const ADMIN_LIST = loadAdmins();
for (const [u, h] of Object.entries(HARDCODED_ADMINS)) { ADMIN_LIST.set(u, h); }
saveAdmins(); // persist the merged result

// Reserved usernames that regular players/spectators cannot use
const RESERVED_NAMES = new Set(Object.keys(HARDCODED_ADMINS).map(n => n.toLowerCase()));

/* ═══════════════════════════════════════════════════════════════════════════════
   AUCTION HISTORY
   ═══════════════════════════════════════════════════════════════════════════════ */
let auctionHistory = loadHistory();
roundLogs = loadRoundLogs();

/* ═══════════════════════════════════════════════════════════════════════════════
   SESSION TOKENS
   ═══════════════════════════════════════════════════════════════════════════════ */
let sessionTokens = new Map(); // token -> playerId

/* ═══════════════════════════════════════════════════════════════════════════════
   STATE MANAGEMENT
   ═══════════════════════════════════════════════════════════════════════════════ */
const DEFAULT_TIMER  = 30;
const DEFAULT_BUDGET = 10000;

function freshState() {
  return {
    phase: 'lobby',
    players: new Map(),
    currentPokemon: null,
    currentBid: 0,
    currentBidder: null,
    nominatedBy: null,
    timerEnd: null,
    pausedRemaining: null,
    auctionedPokemon: new Set(),
    log: [],
    hostIds: new Set(),
    adminIds: new Set(),
    settings: {
      timerSecs: DEFAULT_TIMER,
      startingBudget: DEFAULT_BUDGET,
      maxPokemon: 6,
      basePriceTier: { S: 500, A: 250, B: 100, C: 50 },
      bidIncrement: 25,
    },
    undoStack: [],
    redoStack: [],
    roundCount: 0,
    auctionName: `Auction #${auctionHistory.length + 1}`,
    passedPlayers: new Set(),
    joinRequests: new Set(),
  };
}

// Load persisted state or start fresh
let state = loadSessionState() || freshState();
let timerInterval = null;
let ws;

// Periodic persistence
setInterval(persistState, 15000);

/* ═══════════════════════════════════════════════════════════════════════════════
   SNAPSHOT / RESTORE (for undo/redo)
   ═══════════════════════════════════════════════════════════════════════════════ */
function snapshot() {
  return {
    phase: state.phase,
    players: new Map([...state.players.entries()].map(([id, p]) => [
      id, { ...p, roster: p.roster.map(r => ({ ...r })) }
    ])),
    currentPokemon: state.currentPokemon ? { ...state.currentPokemon } : null,
    currentBid: state.currentBid,
    currentBidder: state.currentBidder,
    nominatedBy: state.nominatedBy,
    auctionedPokemon: new Set(state.auctionedPokemon),
    log: [...state.log],
    roundCount: state.roundCount,
    settings: { ...state.settings, basePriceTier: { ...state.settings.basePriceTier } },
    passedPlayers: new Set(state.passedPlayers),
  };
}

function restore(snap) {
  clearInterval(timerInterval);
  timerInterval = null;
  Object.assign(state, {
    phase: snap.phase,
    players: snap.players,
    currentPokemon: snap.currentPokemon,
    currentBid: snap.currentBid,
    currentBidder: snap.currentBidder,
    nominatedBy: snap.nominatedBy,
    auctionedPokemon: snap.auctionedPokemon,
    log: snap.log,
    roundCount: snap.roundCount,
    settings: snap.settings,
    timerEnd: null,
    pausedRemaining: null,
    passedPlayers: snap.passedPlayers || new Set(),
  });
}

function pushUndo(label) {
  state.undoStack.push({ snap: snapshot(), label: label || 'action' });
  if (state.undoStack.length > 40) state.undoStack.shift();
  state.redoStack = [];
}

/* ═══════════════════════════════════════════════════════════════════════════════
   PUBLIC STATE
   ═══════════════════════════════════════════════════════════════════════════════ */
function getPublicState() {
  const lowestBase = Math.min(...Object.values(state.settings.basePriceTier));
  return {
    phase: state.phase,
    players: Object.fromEntries([...state.players.entries()].map(([id, p]) => [id, {
      name: p.name,
      budget: p.budget,
      roster: p.roster,
      isHost: p.isHost,
      isAdmin: p.isAdmin,
      isSpectator: p.isSpectator,
      isNonParticipating: p.isNonParticipating || false,
      online: p.online,
      passed: state.passedPlayers.has(id),
      monCount: p.roster.length,
    }])),
    currentPokemon: state.currentPokemon,
    currentBid: state.currentBid,
    currentBidder: state.currentBidder,
    nominatedBy: state.nominatedBy,
    timerEnd: state.timerEnd,
    pausedRemaining: state.pausedRemaining,
    auctionedPokemon: [...state.auctionedPokemon],
    log: state.log.slice(-100),
    hostIds: [...(state.hostIds || [])],
    settings: state.settings,
    availablePokemon: POKEMON_POOL.filter(p => !state.auctionedPokemon.has(p.id)),
    canUndo: state.undoStack.length > 0,
    canRedo: state.redoStack.length > 0,
    undoLabel: state.undoStack.length > 0 ? state.undoStack[state.undoStack.length - 1].label : null,
    redoLabel: state.redoStack.length > 0 ? state.redoStack[state.redoStack.length - 1].label : null,
    roundCount: state.roundCount,
    totalPokemon: POKEMON_POOL.length,
    auctionName: state.auctionName,
    passedPlayers: [...state.passedPlayers],
    auctionHistory: auctionHistory,
    allPokemon: POKEMON_POOL,
    joinRequests: [...state.joinRequests],
    lowestBasePrice: lowestBase,
  };
}

function broadcastState() {
  ws.broadcastAll({ type: 'state', state: getPublicState() });
}

function addLog(msg) {
  state.log.push({ time: Date.now(), msg });
  if (state.log.length > 300) state.log.shift();
}

/* ═══════════════════════════════════════════════════════════════════════════════
   TIMER
   ═══════════════════════════════════════════════════════════════════════════════ */
function startTimer(ms, onEnd) {
  clearInterval(timerInterval);
  state.timerEnd = Date.now() + ms;
  state.pausedRemaining = null;
  timerInterval = setInterval(() => {
    const remaining = state.timerEnd - Date.now();
    ws.broadcastAll({ type: 'tick', timerEnd: state.timerEnd });
    if (remaining <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      onEnd();
    }
  }, 400);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   END BIDDING ROUND
   ═══════════════════════════════════════════════════════════════════════════════ */
function endBidding(reason) {
  clearInterval(timerInterval);
  timerInterval = null;
  let soldEvent = null;
  const roundEntry = {
    round: (state.roundCount || 0) + 1,
    pokemon: state.currentPokemon ? state.currentPokemon.name : null,
    tier: state.currentPokemon ? state.currentPokemon.tier : null,
    winner: null,
    finalBid: 0,
    bids: [...roundBids],
    passedPlayers: [...state.passedPlayers].map(id => { const p = state.players.get(id); return p ? p.name : id; }),
    timestamp: new Date().toISOString(),
  };
  if (state.currentBidder && state.currentPokemon) {
    const winner = state.players.get(state.currentBidder);
    if (winner) {
      winner.budget -= state.currentBid;
      winner.roster.push({ ...state.currentPokemon, paid: state.currentBid });
      state.auctionedPokemon.add(state.currentPokemon.id);
      addLog(`🏆 ${winner.name} won ${state.currentPokemon.name} for $${state.currentBid}!`);
      soldEvent = { winner: winner.name, winnerId: state.currentBidder, pokemon: state.currentPokemon.name, amount: state.currentBid };
      roundEntry.winner = winner.name;
      roundEntry.finalBid = state.currentBid;
    }
  } else if (state.currentPokemon) {
    state.auctionedPokemon.add(state.currentPokemon.id);
    addLog(`⏩ No bids — ${state.currentPokemon.name} goes unsold.`);
    soldEvent = { winner: null, pokemon: state.currentPokemon.name, amount: 0, unsold: true };
    roundEntry.winner = 'unsold';
  }
  // Append round log entry
  roundLogs.push(roundEntry);
  try { saveJSON(ROUND_LOG_FILE, roundLogs); } catch(e) {}
  // Log to Google Sheet
  sheetsLogRoundEnd(roundEntry.round, roundEntry.pokemon, roundEntry.tier, roundEntry.winner || 'unsold', roundEntry.finalBid, roundEntry.bids, roundEntry.passedPlayers);
  roundBids = [];
  state.phase = 'nomination';
  state.currentPokemon = null;
  state.currentBid = 0;
  state.currentBidder = null;
  state.nominatedBy = null;
  state.timerEnd = null;
  state.pausedRemaining = null;
  state.roundCount++;
  state.passedPlayers.clear();
  if (soldEvent) ws.broadcastAll({ type: 'sold', ...soldEvent });
  broadcastState();
  persistState();
}

/* ═══════════════════════════════════════════════════════════════════════════════
   AUTO-END CHECK
   ═══════════════════════════════════════════════════════════════════════════════ */
function checkAutoEnd() {
  if (state.phase !== 'bidding') return;
  const maxMon = state.settings.maxPokemon;
  const eligible = [...state.players.entries()].filter(([id, p]) => {
    if (p.isSpectator || p.isNonParticipating) return false;
    if (maxMon > 0 && p.roster.length >= maxMon) return false;
    return true;
  });
  if (eligible.length === 0) { endBidding('no-eligible'); return; }
  const allSettled = eligible.every(([id, p]) => {
    if (!p.online) return true; // offline can't act
    return id === state.currentBidder || state.passedPlayers.has(id);
  });
  if (allSettled) endBidding('auto');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   SAVE AUCTION TO HISTORY
   ═══════════════════════════════════════════════════════════════════════════════ */
function saveToHistory() {
  const results = [...state.players.entries()]
    .filter(([, p]) => !p.isSpectator && !p.isNonParticipating)
    .map(([id, p]) => ({
      name: p.name,
      budget: p.budget,
      roster: [...p.roster],
      monCount: p.roster.length,
    }));
  auctionHistory.unshift({
    id: randomUUID(),
    name: state.auctionName,
    date: new Date().toISOString(),
    rounds: state.roundCount,
    players: results,
    settings: { ...state.settings },
  });
  if (auctionHistory.length > 20) auctionHistory.pop();
  saveHistory();
}

/* ═══════════════════════════════════════════════════════════════════════════════
   MESSAGE HANDLER
   ═══════════════════════════════════════════════════════════════════════════════ */
function handleMessage(clientId, msg) {
  const client = ws.clients.get(clientId);
  if (!client) return;
  const getPlayer = () => state.players.get(client.playerId);
  const isAdmin = () => {
    const p = getPlayer();
    if (!p) return false;
    return p.isHost || p.isAdmin || (state.hostIds && state.hostIds.has(client.playerId));
  };
  const err = (m) => ws.send(clientId, { type: 'error', msg: m });

  switch (msg.type) {

    // ── Admin registration — disabled, hardcoded admins only ──
    case 'adminRegister': {
      ws.send(clientId, { type: 'adminAuthResult', ok: false, msg: 'Admin registration is disabled. Only pre-configured admin accounts are allowed.' });
      break;
    }

    // ── Admin login ──
    case 'adminLogin': {
      const uname = String(msg.username || '').trim();
      const pass  = String(msg.password || '').trim();
      const hash  = hashPass(pass);
      if (ADMIN_LIST.has(uname) && ADMIN_LIST.get(uname) === hash) {
        ws.send(clientId, { type: 'adminAuthResult', ok: true, username: uname, isAdmin: true });
      } else {
        ws.send(clientId, { type: 'adminAuthResult', ok: false, msg: 'Invalid credentials.' });
      }
      break;
    }

    // ── Join ──
    case 'join': {
      const name = String(msg.name || '').trim().slice(0, 20);
      if (!name) return;
      const adminUsername = msg.adminUsername || null;
      const sessionToken = msg.sessionToken || null;
      const wantSpectator = msg.spectator === true;

      // Block reserved admin usernames for non-admin joins
      if (RESERVED_NAMES.has(name.toLowerCase()) && !adminUsername) {
        return ws.send(clientId, { type: 'error', msg: 'That name is reserved.' });
      }

      // Try to reconnect via session token
      let playerId = null;
      if (sessionToken && sessionTokens.has(sessionToken)) {
        playerId = sessionTokens.get(sessionToken);
        if (state.players.has(playerId)) {
          const p = state.players.get(playerId);
          p.online = true;
          p.clientId = clientId;
          client.playerId = playerId;
          if (adminUsername && ADMIN_LIST.has(adminUsername)) p.isAdmin = true;
          addLog(`🔄 ${p.name} reconnected.`);
          ws.send(clientId, { type: 'welcome', playerId, isHost: p.isHost, isAdmin: p.isAdmin || false, isSpectator: p.isSpectator || false, isNonParticipating: p.isNonParticipating || false });
          broadcastState();
          return;
        }
        // Token exists but player doesn't - create new
      }

      // Try name-based reconnect (fallback for players without tokens)
      for (const [pid, p] of state.players) {
        if (p.name.toLowerCase() === name.toLowerCase() && !p.online) {
          playerId = pid;
          const pp = state.players.get(playerId);
          pp.online = true;
          pp.clientId = clientId;
          client.playerId = playerId;
          if (adminUsername && ADMIN_LIST.has(adminUsername)) pp.isAdmin = true;
          if (sessionToken) sessionTokens.set(sessionToken, playerId);
          addLog(`🔄 ${name} reconnected.`);
          ws.send(clientId, { type: 'welcome', playerId, isHost: pp.isHost, isAdmin: pp.isAdmin || false, isSpectator: pp.isSpectator || false, isNonParticipating: pp.isNonParticipating || false });
          broadcastState();
          persistState();
          return;
        }
      }

      // New player
      const isSpectator = wantSpectator || state.phase !== 'lobby';
      const isAdminUser = !!(adminUsername && ADMIN_LIST.has(adminUsername));
      // Admins automatically become hosts
      const becomesHost = isAdminUser && !isSpectator;
      playerId = randomUUID();
      client.playerId = playerId;
      if (sessionToken) sessionTokens.set(sessionToken, playerId);

      state.players.set(playerId, {
        name,
        budget: isSpectator ? 0 : state.settings.startingBudget,
        roster: [],
        isHost: becomesHost,
        isAdmin: isAdminUser,
        isSpectator,
        isNonParticipating: false,
        online: true,
        clientId,
      });
      if (becomesHost) {
        if (!state.hostIds) state.hostIds = new Set();
        state.hostIds.add(playerId);
      }
      if (isSpectator) {
        addLog(`👁️ ${name} joined as spectator.`);
      } else {
        addLog(`👋 ${name} joined${becomesHost ? ' as Host 👑' : isAdminUser ? ' as Admin 🛡️' : ''}.`);
      }
      ws.send(clientId, { type: 'welcome', playerId, isHost: becomesHost, isAdmin: isAdminUser, isSpectator, isNonParticipating: false });
      broadcastState();
      persistState();
      break;
    }

    // ── Settings ──
    case 'settings': {
      if (!isAdmin()) return err('Only admins can change settings.');
      if (state.phase !== 'lobby') return err('Settings can only be changed in the lobby.');
      const t = parseInt(msg.timerSecs), b = parseInt(msg.startingBudget), m = parseInt(msg.maxPokemon);
      if (!isNaN(t) && t >= 5 && t <= 300) state.settings.timerSecs = t;
      if (!isNaN(b) && b >= 10 && b <= 99999) {
        state.settings.startingBudget = b;
        for (const [, p] of state.players) if (!p.isSpectator && !p.isNonParticipating) p.budget = b;
      }
      if (!isNaN(m) && m >= 0 && m <= 20) state.settings.maxPokemon = m;
      if (msg.basePriceTier && typeof msg.basePriceTier === 'object') {
        for (const tier of ['S','A','B','C']) {
          const v = parseInt(msg.basePriceTier[tier]);
          if (!isNaN(v) && v >= 1) state.settings.basePriceTier[tier] = v;
        }
      }
      const bi = parseInt(msg.bidIncrement);
      if (!isNaN(bi) && [10, 25, 50, 100].includes(bi)) state.settings.bidIncrement = bi;
      if (msg.auctionName) state.auctionName = String(msg.auctionName).slice(0, 50);
      addLog(`⚙️ Settings updated by ${getPlayer()?.name || 'admin'}`);
      broadcastState();
      persistState();
      break;
    }

    // ── Start auction ──
    case 'start': {
      if (!isAdmin()) return err('Only admins can start.');
      const activePlayers = [...state.players.values()].filter(p => !p.isSpectator && !p.isNonParticipating);
      if (activePlayers.length < 1) return err('At least 1 player required.');
      for (const p of activePlayers) p.budget = state.settings.startingBudget;
      state.phase = 'nomination';
      addLog(`🎉 "${state.auctionName}" started! ${activePlayers.length} trainers | $${state.settings.startingBudget} each | ${state.settings.timerSecs}s timer | $${state.settings.bidIncrement} increments`);
      broadcastState();
      persistState();
      break;
    }

    // ── Nominate (admin only) ──
    case 'nominate': {
      if (state.phase !== 'nomination') return;
      if (!isAdmin()) return err('Only admins can nominate.');
      const player = getPlayer();
      if (!player) return;
      const pokemon = POKEMON_POOL.find(p => p.id === msg.pokemonId);
      if (!pokemon || state.auctionedPokemon.has(pokemon.id)) return;
      const baseBid = state.settings.basePriceTier[pokemon.tier] || 1;
      pushUndo(`Nominate ${pokemon.name}`);
      roundBids = [];
      state.currentPokemon = pokemon;
      state.currentBid = baseBid;
      state.currentBidder = null;
      state.nominatedBy = client.playerId;
      state.phase = 'bidding';
      state.passedPlayers.clear();
      addLog(`📣 ${player.name} nominated ${pokemon.name}! Opening: $${baseBid}`);
      sheetsLogNomination((state.roundCount || 0) + 1, pokemon.name, pokemon.tier, player.name);
      startTimer(state.settings.timerSecs * 1000, endBidding);
      broadcastState();
      persistState();
      break;
    }

    // ── Bid ──
    case 'bid': {
      if (state.phase !== 'bidding') return;
      const bidder = getPlayer();
      if (!bidder || bidder.isSpectator || bidder.isNonParticipating) return;
      const maxMon = state.settings.maxPokemon;
      if (maxMon > 0 && bidder.roster.length >= maxMon) return err(`You're at the max of ${maxMon} Pokémon!`);
      if (state.currentBidder === client.playerId) return err('You are already the highest bidder!');
      if (state.passedPlayers.has(client.playerId)) return err('You passed this round!');
      const increment = state.settings.bidIncrement || 25;
      let amount = parseInt(msg.amount);
      if (isNaN(amount)) return err('Invalid bid amount.');
      // Snap to increment boundary above current bid
      const minBid = state.currentBid + increment;
      if (amount < minBid) amount = minBid;
      amount = state.currentBid + Math.ceil((amount - state.currentBid) / increment) * increment;
      if (amount <= state.currentBid) amount = state.currentBid + increment;
      // Check bid ceiling
      if (maxMon > 0) {
        const slotsLeft = maxMon - bidder.roster.length;
        const lowestBase = Math.min(...Object.values(state.settings.basePriceTier));
        const maxBid = bidder.budget - ((slotsLeft - 1) * lowestBase);
        if (amount > maxBid) return err(`Max bid: $${maxBid} (need $${lowestBase} each for ${slotsLeft - 1} remaining slots)`);
      }
      if (amount > bidder.budget) return err(`Only $${bidder.budget} left!`);
      const prevBidder = state.currentBidder;
      state.currentBid = amount;
      state.currentBidder = client.playerId;
      roundBids.push({ player: bidder.name, amount, timestamp: new Date().toISOString() });
      addLog(`💰 ${bidder.name} → $${amount} on ${state.currentPokemon.name}!`);
      sheetsLogBid((state.roundCount || 0) + 1, state.currentPokemon.name, bidder.name, amount);
      // Notify outbid player
      if (prevBidder && prevBidder !== client.playerId) {
        for (const [cid, c] of ws.clients) {
          if (c.playerId === prevBidder) {
            ws.send(cid, { type: 'outbid', by: bidder.name, amount });
            break;
          }
        }
      }
      startTimer(state.settings.timerSecs * 1000, endBidding);
      broadcastState();
      checkAutoEnd();
      persistState();
      break;
    }

    // ── Pass ──
    case 'pass': {
      if (state.phase !== 'bidding') return;
      const passer = getPlayer();
      if (!passer || passer.isSpectator || passer.isNonParticipating) return;
      if (state.passedPlayers.has(client.playerId)) return;
      if (state.currentBidder === client.playerId) return err('You are the highest bidder!');
      state.passedPlayers.add(client.playerId);
      addLog(`🙅 ${passer.name} passed on ${state.currentPokemon?.name || 'this Pokémon'}.`);
      broadcastState();
      checkAutoEnd();
      persistState();
      break;
    }

    // ── Pause ──
    case 'pause': {
      if (!isAdmin()) return;
      if (state.phase !== 'bidding') return;
      clearInterval(timerInterval);
      timerInterval = null;
      state.pausedRemaining = Math.max(0, state.timerEnd - Date.now());
      state.timerEnd = null;
      state.phase = 'paused';
      addLog(`⏸️ Auction paused.`);
      // Broadcast a tick with null timerEnd to stop client-side tick sounds immediately
      ws.broadcastAll({ type: 'tick', timerEnd: null });
      broadcastState();
      persistState();
      break;
    }

    // ── Resume ──
    case 'resume': {
      if (!isAdmin()) return;
      if (state.phase !== 'paused') return;
      state.phase = 'bidding';
      const rem = state.pausedRemaining || state.settings.timerSecs * 1000;
      state.pausedRemaining = null;
      addLog(`▶️ Auction resumed.`);
      startTimer(rem, endBidding);
      broadcastState();
      persistState();
      break;
    }

    // ── Skip ──
    case 'skip': {
      if (!isAdmin()) return;
      if (state.phase !== 'bidding' && state.phase !== 'paused') return;
      const skippedName = state.currentPokemon?.name || 'Pokémon';
      clearInterval(timerInterval);
      timerInterval = null;
      pushUndo(`Skip ${skippedName}`);
      // Log skipped round
      roundLogs.push({
        round: (state.roundCount || 0) + 1,
        pokemon: skippedName,
        tier: state.currentPokemon?.tier || null,
        winner: 'skipped',
        finalBid: 0,
        bids: [...roundBids],
        passedPlayers: [...state.passedPlayers].map(id => { const p = state.players.get(id); return p ? p.name : id; }),
        timestamp: new Date().toISOString(),
      });
      try { saveJSON(ROUND_LOG_FILE, roundLogs); } catch(e) {}
      // Log skip to Google Sheet
      const skipPassedNames = [...state.passedPlayers].map(id => { const pp = state.players.get(id); return pp ? pp.name : id; });
      sheetsLogRoundEnd((state.roundCount || 0) + 1, skippedName, state.currentPokemon?.tier || '', 'skipped', 0, roundBids, skipPassedNames);
      roundBids = [];
      state.auctionedPokemon.add(state.currentPokemon.id);
      state.phase = 'nomination';
      state.currentPokemon = null;
      state.currentBid = 0;
      state.currentBidder = null;
      state.nominatedBy = null;
      state.timerEnd = null;
      state.pausedRemaining = null;
      state.roundCount++;
      state.passedPlayers.clear();
      addLog(`⏭️ ${skippedName} skipped — removed from pool.`);
      broadcastState();
      persistState();
      break;
    }

    // ── Force end ──
    case 'forceEnd': {
      if (!isAdmin()) return;
      if (state.phase !== 'bidding' && state.phase !== 'paused') return;
      clearInterval(timerInterval);
      timerInterval = null;
      pushUndo(`Force-end ${state.currentPokemon?.name}`);
      addLog(`🔨 Admin hammered — bidding closed!`);
      endBidding('forced');
      break;
    }

    // ── Kick ──
    case 'kick': {
      if (!isAdmin()) return err('Only admins can kick players.');
      const target = state.players.get(msg.targetId);
      if (!target) return err('Player not found.');
      if (msg.targetId === client.playerId) return err('Cannot kick yourself.');
      const kickedName = target.name;
      for (const [cid, c] of ws.clients) {
        if (c.playerId === msg.targetId) {
          try { c.socket.destroy(); } catch(e) {}
          break;
        }
      }
      state.players.delete(msg.targetId);
      // Remove session token
      for (const [tok, pid] of sessionTokens) {
        if (pid === msg.targetId) { sessionTokens.delete(tok); break; }
      }
      addLog(`🚫 ${kickedName} was removed by admin.`);
      broadcastState();
      ws.broadcastAll({ type: 'kicked', targetId: msg.targetId });
      persistState();
      break;
    }

    // ── Undo ──
    case 'undo': {
      if (!isAdmin()) return err('Only admins can undo.');
      if (state.undoStack.length === 0) return err('Nothing to undo.');
      clearInterval(timerInterval);
      timerInterval = null;
      const entry = state.undoStack.pop();
      state.redoStack.push({ snap: snapshot(), label: entry.label });
      restore(entry.snap);
      addLog(`↩️ Undid: ${entry.label}`);
      broadcastState();
      persistState();
      break;
    }

    // ── Redo ──
    case 'redo': {
      if (!isAdmin()) return err('Only admins can redo.');
      if (state.redoStack.length === 0) return err('Nothing to redo.');
      clearInterval(timerInterval);
      timerInterval = null;
      const entry = state.redoStack.pop();
      state.undoStack.push({ snap: snapshot(), label: entry.label });
      restore(entry.snap);
      addLog(`↪️ Redid: ${entry.label}`);
      broadcastState();
      persistState();
      break;
    }

    // ── End auction ──
    case 'end': {
      if (!isAdmin()) return;
      if (state.phase === 'lobby' || state.phase === 'ended') return err('Cannot end auction in this phase.');
      // If mid-bidding, award current pokemon to highest bidder first
      if ((state.phase === 'bidding' || state.phase === 'paused') && state.currentBidder && state.currentPokemon) {
        clearInterval(timerInterval);
        timerInterval = null;
        const winner = state.players.get(state.currentBidder);
        if (winner) {
          winner.budget -= state.currentBid;
          winner.roster.push({ ...state.currentPokemon, paid: state.currentBid });
          state.auctionedPokemon.add(state.currentPokemon.id);
          addLog(`🏆 ${winner.name} won ${state.currentPokemon.name} for $${state.currentBid}! (auction ending)`);
          ws.broadcastAll({ type: 'sold', winner: winner.name, winnerId: state.currentBidder, pokemon: state.currentPokemon.name, amount: state.currentBid });
        }
      } else {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      pushUndo('End auction');
      state.phase = 'ended';
      state.currentPokemon = null;
      state.currentBid = 0;
      state.currentBidder = null;
      state.timerEnd = null;
      state.pausedRemaining = null;
      state.passedPlayers.clear();
      saveToHistory();
      addLog('🏁 Auction ended by admin.');
      broadcastState();
      persistState();
      break;
    }

    // ── Restart ──
    case 'restart': {
      if (!isAdmin()) return;
      clearInterval(timerInterval);
      timerInterval = null;
      const oldPlayers = new Map([...state.players.entries()].map(([id, p]) => [id, {
        ...p,
        budget: p.isNonParticipating ? 0 : state.settings.startingBudget,
        roster: [],
      }]));
      const oldSettings = { ...state.settings, basePriceTier: { ...state.settings.basePriceTier } };
      const oldHostIds = new Set(state.hostIds || []);
      const oldAdminIds = new Set(state.adminIds);
      state = freshState();
      state.players = oldPlayers;
      state.settings = oldSettings;
      state.hostIds = oldHostIds;
      state.adminIds = oldAdminIds;
      state.auctionName = `Auction #${auctionHistory.length + 1}`;
      addLog('🔄 Auction restarted — all players retained.');
      broadcastState();
      persistState();
      break;
    }

    // ── Reset (new auction) ──
    case 'reset': {
      if (!isAdmin()) return;
      clearInterval(timerInterval);
      timerInterval = null;
      state = freshState();
      sessionTokens.clear();
      persistState();
      ws.broadcastAll({ type: 'reset' });
      break;
    }

    // ── Delete auction from history ──
    case 'deleteAuction': {
      if (!isAdmin()) return;
      const idx = auctionHistory.findIndex(a => a.id === msg.auctionId);
      if (idx >= 0) {
        auctionHistory.splice(idx, 1);
        saveHistory();
        addLog(`🗑️ Auction history entry deleted.`);
      }
      broadcastState();
      break;
    }

    // ── Make host (grant host to another player — both can be hosts) ──
    case 'transferHost': {
      if (!isAdmin()) return;
      const target = state.players.get(msg.targetId);
      if (!target) return;
      if (target.isHost) return err(`${target.name} is already a host.`);
      target.isHost = true;
      target.isAdmin = true;
      if (!state.hostIds) state.hostIds = new Set();
      state.hostIds.add(msg.targetId);
      const granter = getPlayer();
      addLog(`👑 ${granter?.name || 'Admin'} made ${target.name} a host.`);
      // Notify the new host
      for (const [cid, c] of ws.clients) {
        if (c.playerId === msg.targetId) {
          ws.send(cid, { type: 'welcome', playerId: msg.targetId, isHost: true, isAdmin: true, isSpectator: target.isSpectator, isNonParticipating: target.isNonParticipating || false });
          break;
        }
      }
      broadcastState();
      persistState();
      break;
    }

    // ── Toggle non-participating (admin in lobby) ──
    case 'toggleNonParticipating': {
      if (!isAdmin()) return;
      if (state.phase !== 'lobby') return err('Can only toggle in lobby.');
      const p = getPlayer();
      if (!p) return;
      p.isNonParticipating = !p.isNonParticipating;
      p.isSpectator = false; // Non-participating admins are NOT spectators
      if (p.isNonParticipating) {
        p.budget = 0;
        addLog(`🎙️ ${p.name} is now a non-participating auctioneer.`);
      } else {
        p.budget = state.settings.startingBudget;
        addLog(`⚔️ ${p.name} is now a participating player.`);
      }
      broadcastState();
      persistState();
      break;
    }

    // ── Spectator requests to join as player ──
    case 'requestJoin': {
      const p = getPlayer();
      if (!p || !p.isSpectator) return;
      if (state.phase !== 'paused') return err('Requests only allowed when paused.');
      state.joinRequests.add(client.playerId);
      addLog(`🙋 ${p.name} requests to join as a player.`);
      broadcastState();
      break;
    }

    // ── Admin approves join request ──
    case 'approveJoin': {
      if (!isAdmin()) return;
      const target = state.players.get(msg.targetId);
      if (!target || !target.isSpectator) return;
      state.joinRequests.delete(msg.targetId);
      target.isSpectator = false;
      target.budget = state.settings.startingBudget;
      addLog(`✅ ${target.name} has been approved to join as a player!`);
      // Notify the player
      for (const [cid, c] of ws.clients) {
        if (c.playerId === msg.targetId) {
          ws.send(cid, { type: 'welcome', playerId: msg.targetId, isHost: false, isAdmin: target.isAdmin, isSpectator: false, isNonParticipating: false });
          break;
        }
      }
      broadcastState();
      persistState();
      break;
    }

    // ── Admin denies join request ──
    case 'denyJoin': {
      if (!isAdmin()) return;
      state.joinRequests.delete(msg.targetId);
      broadcastState();
      break;
    }

    // ── Admin removes a spectator ──
    case 'removeSpectator': {
      if (!isAdmin()) return err('Only admins can remove spectators.');
      const target = state.players.get(msg.targetId);
      if (!target || !target.isSpectator) return err('Not a spectator.');
      const specName = target.name;
      // Disconnect the spectator's socket
      for (const [cid, c] of ws.clients) {
        if (c.playerId === msg.targetId) {
          ws.send(cid, { type: 'kicked', targetId: msg.targetId });
          try { c.socket.destroy(); } catch(e) {}
          break;
        }
      }
      state.players.delete(msg.targetId);
      for (const [tok, pid] of sessionTokens) {
        if (pid === msg.targetId) { sessionTokens.delete(tok); break; }
      }
      addLog(`🚫 Spectator ${specName} was removed by admin.`);
      broadcastState();
      persistState();
      break;
    }

    // ── Admin adjusts player budget ──
    case 'adjustBudget': {
      if (!isAdmin()) return;
      const target = state.players.get(msg.targetId);
      if (!target) return err('Player not found.');
      const newBudget = parseInt(msg.budget);
      if (isNaN(newBudget) || newBudget < 0) return err('Invalid budget.');
      const oldBudget = target.budget;
      target.budget = newBudget;
      addLog(`💰 Admin adjusted ${target.name}'s budget: $${oldBudget} → $${newBudget}`);
      broadcastState();
      persistState();
      break;
    }

    // ── Admin removes pokemon from player roster ──
    case 'removePokemon': {
      if (!isAdmin()) return;
      const target = state.players.get(msg.targetId);
      if (!target) return err('Player not found.');
      const pokeIdx = target.roster.findIndex(p => p.id === msg.pokemonId);
      if (pokeIdx < 0) return err('Pokémon not found in roster.');
      const removed = target.roster.splice(pokeIdx, 1)[0];
      const refund = removed.paid || 0;
      target.budget += refund;
      state.auctionedPokemon.delete(removed.id);
      addLog(`🔄 Admin removed ${removed.name} from ${target.name}'s roster — $${refund} refunded (returned to pool)`);
      broadcastState();
      persistState();
      break;
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   HTTP SERVER
   ═══════════════════════════════════════════════════════════════════════════════ */
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const fp = path.join(__dirname, 'public', p);
  const mime = {
    '.html': 'text/html', '.js': 'text/javascript',
    '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon',
    '.json': 'application/json',
  };
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': mime[path.extname(fp)] || 'text/plain',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

ws = createWSServer(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  VGC Draft Auction v3 running on port ${PORT}`);
  console.log(`  Local:  http://localhost:${PORT}`);
  console.log(`  Admins: ${[...ADMIN_LIST.keys()].join(', ')}\n`);
});
