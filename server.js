const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// UUID fallback for Node < v14.17
function randomUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.randomBytes(1)[0] & 15 >> c / 4).toString(16)
  );
}

// ─── Zero-dependency WebSocket Server ─────────────────────────────────────────
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
        let len = buf[1] & 0x7f;
        let off = 2;
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
        try { handleMessage(id, JSON.parse(payload.toString('utf8'))); } catch(e) {}
      }
    });
    socket.on('close', () => {
      const c = clients.get(id);
      if (c && c.playerId) {
        const p = state.players.get(c.playerId);
        if (p) addLog(`🚪 ${p.name} disconnected.`);
        state.players.delete(c.playerId);
        broadcastAll({ type: 'state', state: getPublicState() });
      }
      clients.delete(id);
    });
    socket.on('error', () => clients.delete(id));
  });

  function encode(str) {
    const p = Buffer.from(str, 'utf8'), l = p.length;
    let h;
    if (l < 126) h = Buffer.from([0x81, l]);
    else if (l < 65536) h = Buffer.from([0x81, 126, l >> 8, l & 0xff]);
    else h = Buffer.from([0x81, 127, 0,0,0,0,(l>>24)&0xff,(l>>16)&0xff,(l>>8)&0xff,l&0xff]);
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

// ─── Pokémon Pool ─────────────────────────────────────────────────────────────
const POKEMON_POOL = [
  { id:1,  name:'Flutter Mane',    dex:987,  type1:'Ghost',    type2:'Fairy',    tier:'S' },
  { id:2,  name:'Calyrex-Ice',     dex:898,  type1:'Psychic',  type2:'Ice',      tier:'S' },
  { id:3,  name:'Calyrex-Shadow',  dex:898,  type1:'Psychic',  type2:'Ghost',    tier:'S' },
  { id:4,  name:'Koraidon',        dex:1007, type1:'Fighting', type2:'Dragon',   tier:'S' },
  { id:5,  name:'Miraidon',        dex:1008, type1:'Electric', type2:'Dragon',   tier:'S' },
  { id:6,  name:'Zacian',          dex:888,  type1:'Fairy',    type2:'',         tier:'S' },
  { id:7,  name:'Zamazenta',       dex:889,  type1:'Fighting', type2:'',         tier:'S' },
  { id:8,  name:'Kyogre',          dex:382,  type1:'Water',    type2:'',         tier:'S' },
  { id:9,  name:'Groudon',         dex:383,  type1:'Ground',   type2:'',         tier:'S' },
  { id:10, name:'Rayquaza',        dex:384,  type1:'Dragon',   type2:'Flying',   tier:'S' },
  { id:11, name:'Lunala',          dex:792,  type1:'Psychic',  type2:'Ghost',    tier:'S' },
  { id:12, name:'Solgaleo',        dex:791,  type1:'Psychic',  type2:'Steel',    tier:'S' },
  { id:13, name:'Urshifu-Single',  dex:892,  type1:'Fighting', type2:'Dark',     tier:'A' },
  { id:14, name:'Urshifu-Rapid',   dex:892,  type1:'Fighting', type2:'Water',    tier:'A' },
  { id:15, name:'Landorus-T',      dex:645,  type1:'Ground',   type2:'Flying',   tier:'A' },
  { id:16, name:'Tornadus',        dex:641,  type1:'Flying',   type2:'',         tier:'A' },
  { id:17, name:'Thundurus',       dex:642,  type1:'Electric', type2:'Flying',   tier:'A' },
  { id:18, name:'Incineroar',      dex:727,  type1:'Fire',     type2:'Dark',     tier:'A' },
  { id:19, name:'Rillaboom',       dex:812,  type1:'Grass',    type2:'',         tier:'A' },
  { id:20, name:'Grimmsnarl',      dex:861,  type1:'Dark',     type2:'Fairy',    tier:'A' },
  { id:21, name:'Amoonguss',       dex:591,  type1:'Grass',    type2:'Poison',   tier:'A' },
  { id:22, name:'Palafin',         dex:964,  type1:'Water',    type2:'',         tier:'A' },
  { id:23, name:'Iron Hands',      dex:992,  type1:'Fighting', type2:'Electric', tier:'A' },
  { id:24, name:'Chi-Yu',          dex:1004, type1:'Dark',     type2:'Fire',     tier:'A' },
  { id:25, name:'Chien-Pao',       dex:1002, type1:'Dark',     type2:'Ice',      tier:'A' },
  { id:26, name:'Ting-Lu',         dex:1001, type1:'Dark',     type2:'Ground',   tier:'A' },
  { id:27, name:'Wo-Chien',        dex:1000, type1:'Dark',     type2:'Grass',    tier:'A' },
  { id:28, name:'Gholdengo',       dex:1000, type1:'Steel',    type2:'Ghost',    tier:'B' },
  { id:29, name:'Dragapult',       dex:887,  type1:'Dragon',   type2:'Ghost',    tier:'B' },
  { id:30, name:'Volcarona',       dex:637,  type1:'Bug',      type2:'Fire',     tier:'B' },
  { id:31, name:'Garchomp',        dex:445,  type1:'Dragon',   type2:'Ground',   tier:'B' },
  { id:32, name:'Torkoal',         dex:324,  type1:'Fire',     type2:'',         tier:'B' },
  { id:33, name:'Ninetales-A',     dex:38,   type1:'Ice',      type2:'Fairy',    tier:'B' },
  { id:34, name:'Pelipper',        dex:279,  type1:'Water',    type2:'Flying',   tier:'B' },
  { id:35, name:'Whimsicott',      dex:547,  type1:'Grass',    type2:'Fairy',    tier:'B' },
  { id:36, name:'Talonflame',      dex:663,  type1:'Fire',     type2:'Flying',   tier:'B' },
  { id:37, name:'Mimikyu',         dex:778,  type1:'Ghost',    type2:'Fairy',    tier:'B' },
  { id:38, name:'Meowscarada',     dex:908,  type1:'Grass',    type2:'Dark',     tier:'B' },
  { id:39, name:'Skeledirge',      dex:909,  type1:'Fire',     type2:'Ghost',    tier:'B' },
  { id:40, name:'Quaquaval',       dex:910,  type1:'Water',    type2:'Fighting', tier:'B' },
  { id:41, name:'Arcanine',        dex:59,   type1:'Fire',     type2:'',         tier:'C' },
  { id:42, name:'Togekiss',        dex:468,  type1:'Fairy',    type2:'Flying',   tier:'C' },
  { id:43, name:'Sylveon',         dex:700,  type1:'Fairy',    type2:'',         tier:'C' },
  { id:44, name:'Goodra-Hisui',    dex:706,  type1:'Dragon',   type2:'Steel',    tier:'C' },
  { id:45, name:'Rotom-Wash',      dex:479,  type1:'Electric', type2:'Water',    tier:'C' },
  { id:46, name:'Rotom-Heat',      dex:479,  type1:'Electric', type2:'Fire',     tier:'C' },
  { id:47, name:'Tyranitar',       dex:248,  type1:'Rock',     type2:'Dark',     tier:'C' },
  { id:48, name:'Excadrill',       dex:530,  type1:'Ground',   type2:'Steel',    tier:'C' },
  { id:49, name:'Blaziken',        dex:257,  type1:'Fire',     type2:'Fighting', tier:'C' },
  { id:50, name:'Scizor',          dex:212,  type1:'Bug',      type2:'Steel',    tier:'C' },
  { id:51, name:'Baxcalibur',      dex:998,  type1:'Dragon',   type2:'Ice',      tier:'C' },
  { id:52, name:'Annihilape',      dex:979,  type1:'Fighting', type2:'Ghost',    tier:'C' },
  { id:53, name:'Dondozo',         dex:977,  type1:'Water',    type2:'',         tier:'C' },
  { id:54, name:'Tatsugiri',       dex:978,  type1:'Dragon',   type2:'Water',    tier:'C' },
  { id:55, name:'Porygon2',        dex:233,  type1:'Normal',   type2:'',         tier:'C' },
  { id:56, name:'Cresselia',       dex:488,  type1:'Psychic',  type2:'',         tier:'C' },
];

// ─── State Management ─────────────────────────────────────────────────────────
const DEFAULT_TIMER  = 30;
const DEFAULT_BUDGET = 100;

function freshState() {
  return {
    phase: 'lobby',           // lobby | nomination | bidding | paused | ended
    players: new Map(),
    currentPokemon: null,
    currentBid: 0,
    currentBidder: null,
    nominatedBy: null,
    timerEnd: null,
    pausedRemaining: null,
    auctionedPokemon: new Set(),
    log: [],
    hostId: null,
    settings: { timerSecs: DEFAULT_TIMER, startingBudget: DEFAULT_BUDGET },
    undoStack: [],            // array of snapshots
    redoStack: [],
    roundCount: 0,
  };
}

let state = freshState();
let timerInterval = null;
let ws;

// ─── Snapshot / Restore (for undo-redo) ──────────────────────────────────────
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
    settings: { ...state.settings },
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
  });
}

function pushUndo(label) {
  state.undoStack.push({ snap: snapshot(), label: label || 'action' });
  if (state.undoStack.length > 40) state.undoStack.shift();
  state.redoStack = [];
}

// ─── Public state ─────────────────────────────────────────────────────────────
function getPublicState() {
  return {
    phase: state.phase,
    players: Object.fromEntries([...state.players.entries()].map(([id, p]) => [id, {
      name: p.name, budget: p.budget, roster: p.roster, isHost: p.isHost,
    }])),
    currentPokemon: state.currentPokemon,
    currentBid: state.currentBid,
    currentBidder: state.currentBidder,
    nominatedBy: state.nominatedBy,
    timerEnd: state.timerEnd,
    pausedRemaining: state.pausedRemaining,
    auctionedPokemon: [...state.auctionedPokemon],
    log: state.log.slice(-100),
    hostId: state.hostId,
    settings: state.settings,
    availablePokemon: POKEMON_POOL.filter(p => !state.auctionedPokemon.has(p.id)),
    canUndo: state.undoStack.length > 0,
    canRedo: state.redoStack.length > 0,
    undoLabel: state.undoStack.length > 0 ? state.undoStack[state.undoStack.length - 1].label : null,
    redoLabel: state.redoStack.length > 0 ? state.redoStack[state.redoStack.length - 1].label : null,
    roundCount: state.roundCount,
    totalPokemon: POKEMON_POOL.length,
  };
}

function addLog(msg) {
  state.log.push({ time: Date.now(), msg });
  if (state.log.length > 300) state.log.shift();
}

// ─── Timer ────────────────────────────────────────────────────────────────────
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

// ─── End bidding round ────────────────────────────────────────────────────────
function endBidding(reason) {
  clearInterval(timerInterval);
  timerInterval = null;
  if (state.currentBidder && state.currentPokemon) {
    const winner = state.players.get(state.currentBidder);
    if (winner) {
      winner.budget -= state.currentBid;
      winner.roster.push({ ...state.currentPokemon, paid: state.currentBid });
      state.auctionedPokemon.add(state.currentPokemon.id);
      addLog(`🏆 ${winner.name} won ${state.currentPokemon.name} for ${state.currentBid}cr!`);
    }
  } else if (state.currentPokemon) {
    state.auctionedPokemon.add(state.currentPokemon.id);
    addLog(`⏩ No bids — ${state.currentPokemon.name} goes unsold.`);
  }
  state.phase = 'nomination';
  state.currentPokemon = null;
  state.currentBid = 0;
  state.currentBidder = null;
  state.nominatedBy = null;
  state.timerEnd = null;
  state.pausedRemaining = null;
  state.roundCount++;
  ws.broadcastAll({ type: 'state', state: getPublicState() });
}

// ─── Message Handler ──────────────────────────────────────────────────────────
function handleMessage(clientId, msg) {
  const client = ws.clients.get(clientId);
  if (!client) return;
  const isHost = () => state.players.get(client.playerId).isHost === true;
  const err = (m) => ws.send(clientId, { type: 'error', msg: m });

  switch (msg.type) {

    case 'join': {
      const name = String(msg.name || '').trim().slice(0, 20);
      if (!name) return;
      const first = state.players.size === 0;
      const playerId = randomUUID();
      client.playerId = playerId;
      state.players.set(playerId, {
        name, budget: state.settings.startingBudget, roster: [], isHost: first,
      });
      if (first) state.hostId = playerId;
      addLog(`👋 ${name} joined${first ? ' as Host 👑' : ''}.`);
      ws.send(clientId, { type: 'welcome', playerId, isHost: first });
      ws.broadcastAll({ type: 'state', state: getPublicState() });
      break;
    }

    case 'settings': {
      if (!isHost()) return err('Only the host can change settings.');
      if (state.phase !== 'lobby') return err('Settings can only be changed in the lobby.');
      const t = parseInt(msg.timerSecs), b = parseInt(msg.startingBudget);
      if (!isNaN(t) && t >= 5 && t <= 300) state.settings.timerSecs = t;
      if (!isNaN(b) && b >= 10 && b <= 9999) {
        state.settings.startingBudget = b;
        for (const [, p] of state.players) p.budget = b;
      }
      addLog(`⚙️ Settings → Timer: ${state.settings.timerSecs}s | Budget: ${state.settings.startingBudget}cr`);
      ws.broadcastAll({ type: 'state', state: getPublicState() });
      break;
    }

    case 'start': {
      if (!isHost()) return err('Only the host can start.');
      if (state.players.size < 1) return err('At least 1 player required.');
      for (const [, p] of state.players) p.budget = state.settings.startingBudget;
      state.phase = 'nomination';
      addLog(`🎉 Auction started! ${state.players.size} trainers | ${state.settings.startingBudget}cr each | ${state.settings.timerSecs}s timer`);
      ws.broadcastAll({ type: 'state', state: getPublicState() });
      break;
    }

    case 'nominate': {
      if (state.phase !== 'nomination') return;
      const pokemon = POKEMON_POOL.find(p => p.id === msg.pokemonId);
      if (!pokemon || state.auctionedPokemon.has(pokemon.id)) return;
      const nominator = state.players.get(client.playerId);
      if (!nominator) return;
      const startBid = Math.max(1, Math.min(parseInt(msg.startBid) || 1, nominator.budget));
      pushUndo(`Nominate ${pokemon.name}`);
      state.currentPokemon = pokemon;
      state.currentBid = startBid;
      state.currentBidder = null;
      state.nominatedBy = client.playerId;
      state.phase = 'bidding';
      addLog(`📣 ${nominator.name} nominated ${pokemon.name}! Opening: ${startBid}cr`);
      startTimer(state.settings.timerSecs * 1000, endBidding);
      ws.broadcastAll({ type: 'state', state: getPublicState() });
      break;
    }

    case 'bid': {
      if (state.phase !== 'bidding') return;
      const bidder = state.players.get(client.playerId);
      if (!bidder) return;
      const amount = parseInt(msg.amount);
      if (isNaN(amount) || amount <= state.currentBid) return err(`Must bid above ${state.currentBid}cr`);
      if (amount > bidder.budget) return err(`Only ${bidder.budget}cr left!`);
      state.currentBid = amount;
      state.currentBidder = client.playerId;
      addLog(`💰 ${bidder.name} → ${amount}cr on ${state.currentPokemon.name}!`);
      startTimer(state.settings.timerSecs * 1000, endBidding);
      ws.broadcastAll({ type: 'state', state: getPublicState() });
      break;
    }

    case 'pause': {
      if (!isHost()) return;
      if (state.phase !== 'bidding') return;
      clearInterval(timerInterval);
      timerInterval = null;
      state.pausedRemaining = Math.max(0, state.timerEnd - Date.now());
      state.timerEnd = null;
      state.phase = 'paused';
      addLog(`⏸️ Auction paused by host.`);
      ws.broadcastAll({ type: 'state', state: getPublicState() });
      break;
    }

    case 'resume': {
      if (!isHost()) return;
      if (state.phase !== 'paused') return;
      state.phase = 'bidding';
      const rem = state.pausedRemaining || state.settings.timerSecs * 1000;
      state.pausedRemaining = null;
      addLog(`▶️ Auction resumed.`);
      startTimer(rem, endBidding);
      ws.broadcastAll({ type: 'state', state: getPublicState() });
      break;
    }

    case 'skip': {
      if (!isHost()) return;
      if (state.phase !== 'bidding' && state.phase !== 'paused') return;
      const skippedName = state.currentPokemon.name || 'Pokémon';
      clearInterval(timerInterval);
      timerInterval = null;
      pushUndo(`Skip ${skippedName}`);
      // Put it back in pool (don't add to auctioned)
      state.phase = 'nomination';
      state.currentPokemon = null;
      state.currentBid = 0;
      state.currentBidder = null;
      state.nominatedBy = null;
      state.timerEnd = null;
      state.pausedRemaining = null;
      addLog(`⏭️ ${skippedName} skipped — back in the pool.`);
      ws.broadcastAll({ type: 'state', state: getPublicState() });
      break;
    }

    case 'forceEnd': {
      // Host forces bidding to end immediately, awarding current top bid
      if (!isHost()) return;
      if (state.phase !== 'bidding' && state.phase !== 'paused') return;
      clearInterval(timerInterval);
      timerInterval = null;
      pushUndo(`Force-end ${state.currentPokemon.name}`);
      addLog(`🔨 Host hammered — bidding closed!`);
      endBidding('forced');
      break;
    }

    case 'undo': {
      if (!isHost()) return err('Only the host can undo.');
      if (state.undoStack.length === 0) return err('Nothing to undo.');
      clearInterval(timerInterval);
      timerInterval = null;
      const entry = state.undoStack.pop();
      state.redoStack.push({ snap: snapshot(), label: entry.label });
      restore(entry.snap);
      addLog(`↩️ Undid: ${entry.label}`);
      ws.broadcastAll({ type: 'state', state: getPublicState() });
      break;
    }

    case 'redo': {
      if (!isHost()) return err('Only the host can redo.');
      if (state.redoStack.length === 0) return err('Nothing to redo.');
      clearInterval(timerInterval);
      timerInterval = null;
      const entry = state.redoStack.pop();
      state.undoStack.push({ snap: snapshot(), label: entry.label });
      restore(entry.snap);
      addLog(`↪️ Redid: ${entry.label}`);
      ws.broadcastAll({ type: 'state', state: getPublicState() });
      break;
    }

    case 'end': {
      if (!isHost()) return;
      clearInterval(timerInterval);
      timerInterval = null;
      pushUndo('End auction');
      state.phase = 'ended';
      state.timerEnd = null;
      addLog('🏁 Auction ended by host.');
      ws.broadcastAll({ type: 'state', state: getPublicState() });
      break;
    }

    case 'reset': {
      if (!isHost()) return;
      clearInterval(timerInterval);
      timerInterval = null;
      state = freshState();
      ws.broadcastAll({ type: 'reset' });
      break;
    }

    case 'transferHost': {
      if (!isHost()) return;
      const target = state.players.get(msg.targetId);
      if (!target || msg.targetId === client.playerId) return;
      const old = state.players.get(client.playerId);
      if (old) old.isHost = false;
      target.isHost = true;
      state.hostId = msg.targetId;
      addLog(`👑 Host transferred to ${target.name}.`);
      ws.broadcastAll({ type: 'state', state: getPublicState() });
      break;
    }
  }
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const fp = path.join(__dirname, 'public', p);
  const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png' };
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'text/plain', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

ws = createWSServer(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║         🎮  VGC DRAFT AUCTION SERVER             ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Local:    http://localhost:${PORT}                 ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Public URL: setting up tunnel...                ║');
  console.log('╚══════════════════════════════════════════════════╝');

  try {
    // Dynamically require localtunnel — install it if missing
    let localtunnel;
    try {
      localtunnel = require('localtunnel');
    } catch {
      console.log('\n  ⚙️  localtunnel not found — installing (one-time)...');
      require('child_process').execSync('npm install localtunnel --save', { stdio: 'inherit' });
      localtunnel = require('localtunnel');
    }

    const tunnel = await localtunnel({ port: PORT });

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  🌐  Public URL (share this with friends!):              ║');
    console.log(`║  👉  ${tunnel.url.padEnd(52)}║`);
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  Local:  http://localhost:' + String(PORT).padEnd(32) + '║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    tunnel.on('close', () => {
      console.log('⚠️  Tunnel closed. Restart the server to get a new public URL.');
    });

    tunnel.on('error', (err) => {
      console.error('⚠️  Tunnel error:', err.message);
    });

  } catch (err) {
    console.log('\n  ⚠️  Could not start tunnel:', err.message);
    console.log('  Players on the same Wi-Fi can use your local IP instead.\n');
  }
});
