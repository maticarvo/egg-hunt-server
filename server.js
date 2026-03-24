const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

const PORT = process.env.PORT || 3001;

// ============ CONFIG ============
const TILE = 32;
const MAP_W = 30, MAP_H = 22;
const ROUND_TIME = 120;
const TICK_RATE = 30; // 30 updates per second (~33ms)
const EGG_SPAWN_INTERVAL = 3;  // seconds
const ITEM_SPAWN_INTERVAL = 8;
const MAX_EGGS = 25;
const MAX_ITEMS = 4;
const ITEM_TYPES = ['cage','fake_egg','speed','steal','magnet','confusion','shield'];
const SPAWN_POINTS = [{x:2,y:2},{x:MAP_W-3,y:2},{x:2,y:MAP_H-3},{x:MAP_W-3,y:MAP_H-3}];
const ITEM_DURATION = {cage:3000,speed:4000,magnet:5000,confusion:3000};

// ============ MAP ============
const mapObjects = Array.from({length:MAP_H}, ()=>Array(MAP_W).fill(null));
const mapGround = Array.from({length:MAP_H}, ()=>Array(MAP_W).fill('grass'));

function initMap() {
  for(let x=0;x<MAP_W;x++){mapObjects[0][x]='fence';mapObjects[MAP_H-1][x]='fence';}
  for(let y=0;y<MAP_H;y++){mapObjects[y][0]='fence';mapObjects[y][MAP_W-1]='fence';}
  for(let x=1;x<MAP_W-1;x++){mapGround[MAP_H/2|0][x]='path';mapGround[(MAP_H/2|0)+1][x]='path';}
  for(let y=1;y<MAP_H-1;y++){mapGround[y][MAP_W/2|0]='path';mapGround[y][(MAP_W/2|0)+1]='path';}
  const cx=MAP_W/2|0,cy=MAP_H/2|0;
  mapGround[cy][cx]='water';mapGround[cy][cx+1]='water';mapGround[cy+1][cx]='water';mapGround[cy+1][cx+1]='water';
  const obs = [[4,4,'bush'],[4,8,'tree'],[4,13,'tree'],[4,17,'bush'],[8,3,'bush'],[8,7,'bush'],[8,14,'bush'],[8,18,'bush'],
    [13,4,'bush'],[13,8,'bush'],[13,13,'bush'],[13,17,'bush'],[7,5,'tree'],[7,16,'tree'],[14,5,'tree'],[14,16,'tree'],
    [3,10,'bush'],[18,10,'bush'],[3,11,'bush'],[18,11,'bush'],[10,3,'rock'],[10,18,'rock'],[11,3,'rock'],[11,18,'rock']];
  obs.forEach(([y,x,t])=>{if(y<MAP_H&&x<MAP_W)mapObjects[y][x]=t;});
}
initMap();

const SOLID = ['fence','bush','tree','rock'];
function isSolid(wx,wy) {
  const tx=Math.floor(wx/TILE),ty=Math.floor(wy/TILE);
  if(tx<0||ty<0||tx>=MAP_W||ty>=MAP_H)return true;
  return SOLID.includes(mapObjects[ty]?.[tx]) || mapGround[ty]?.[tx]==='water';
}

function findSpot() {
  for(let i=0;i<50;i++){
    const tx=2+Math.floor(Math.random()*(MAP_W-4)),ty=2+Math.floor(Math.random()*(MAP_H-4));
    if(!mapObjects[ty][tx]&&mapGround[ty][tx]!=='water') return {x:tx*TILE+TILE/2,y:ty*TILE+TILE/2};
  }
  return null;
}

// ============ ROOMS ============
const rooms = {};

function createRoom(code) {
  return {
    code,
    host: null,
    state: 'lobby',
    settings: { rounds: 3 },
    round: 0,
    timer: ROUND_TIME,
    players: {},       // socketId -> player data
    playerOrder: [],   // ordered socket IDs
    eggs: [],
    items: [],
    eggIdCounter: 0,
    itemIdCounter: 0,
    eggSpawnTimer: 0,
    itemSpawnTimer: 0,
    roundResults: [],
    seriesWins: {},
    tickInterval: null,
  };
}

function createPlayer(name, uid, colorIdx) {
  const sp = SPAWN_POINTS[colorIdx] || SPAWN_POINTS[0];
  return {
    uid, name, colorIdx, ready: false,
    x: sp.x * TILE, y: sp.y * TILE,
    dir: 'down', moving: false,
    score: 0, item: null,
    stunned: 0, caged: 0, speedMult: 1,
    shield: false, magnetTimer: 0, stealActive: false, confusionTimer: 0,
    connected: true,
  };
}

// ============ GAME TICK ============
function startRoomTick(code) {
  const room = rooms[code];
  if (!room || room.tickInterval) return;

  room.tickInterval = setInterval(() => {
    if (room.state !== 'playing') return;
    const dt = 1000 / TICK_RATE;

    // Timer
    room.timer -= dt / 1000;
    if (room.timer <= 0) { endRound(code); return; }

    // Update player status timers
    Object.values(room.players).forEach(p => {
      if (p.stunned > 0) p.stunned -= dt;
      if (p.caged > 0) p.caged -= dt;
      if (p.magnetTimer > 0) p.magnetTimer -= dt;
      if (p.confusionTimer > 0) p.confusionTimer -= dt;
      if (p.speedMult > 1) { p.speedMult -= dt/4000; if(p.speedMult<1) p.speedMult=1; }
    });

    // Spawn eggs
    room.eggSpawnTimer += dt / 1000;
    if (room.eggSpawnTimer >= EGG_SPAWN_INTERVAL) {
      room.eggSpawnTimer = 0;
      const activeEggs = room.eggs.filter(e => e.active).length;
      if (activeEggs < MAX_EGGS) {
        const pos = findSpot();
        if (pos) {
          const type = Math.random() < 0.1 ? 'golden' : 'normal';
          room.eggs.push({ id: 'e' + room.eggIdCounter++, x: pos.x, y: pos.y, type, active: true });
        }
      }
    }

    // Spawn items
    room.itemSpawnTimer += dt / 1000;
    if (room.itemSpawnTimer >= ITEM_SPAWN_INTERVAL) {
      room.itemSpawnTimer = 0;
      const activeItems = room.items.filter(i => i.active).length;
      if (activeItems < MAX_ITEMS) {
        const pos = findSpot();
        if (pos) {
          const type = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
          room.items.push({ id: 'i' + room.itemIdCounter++, x: pos.x, y: pos.y, type, active: true });
        }
      }
    }

    // Check egg pickups
    Object.entries(room.players).forEach(([sid, p]) => {
      if (p.stunned > 0 || p.caged > 0) return;
      room.eggs.forEach(egg => {
        if (!egg.active) return;
        const dist = Math.hypot(p.x + 10 - egg.x, p.y + 12 - egg.y);
        if (dist < 20) {
          egg.active = false;
          if (egg.type === 'fake') {
            p.stunned = 2000;
            io.to(sid).emit('effect', { type: 'stunned', duration: 2000 });
          } else {
            const pts = egg.type === 'golden' ? 3 : 1;
            p.score += pts;
            io.to(sid).emit('egg-collected', { type: egg.type, points: pts });
          }
        }
      });

      // Check item pickups
      room.items.forEach(item => {
        if (!item.active || p.item) return;
        const dist = Math.hypot(p.x + 10 - item.x, p.y + 12 - item.y);
        if (dist < 22) {
          item.active = false;
          p.item = item.type;
          io.to(sid).emit('item-collected', { type: item.type });
        }
      });

      // Magnet effect
      if (p.magnetTimer > 0) {
        room.eggs.forEach(egg => {
          if (!egg.active || egg.type === 'fake') return;
          const dist = Math.hypot(p.x + 10 - egg.x, p.y + 12 - egg.y);
          if (dist < 120 && dist > 20) {
            const a = Math.atan2(p.y + 12 - egg.y, p.x + 10 - egg.x);
            egg.x += Math.cos(a) * 3;
            egg.y += Math.sin(a) * 3;
          }
        });
      }

      // Steal touch
      if (p.stealActive) {
        Object.entries(room.players).forEach(([sid2, p2]) => {
          if (sid2 === sid) return;
          const dist = Math.hypot(p.x - p2.x, p.y - p2.y);
          if (dist < 30) {
            p.stealActive = false;
            const stolen = Math.min(2, p2.score);
            p.score += stolen;
            p2.score -= stolen;
            io.to(sid).emit('effect', { type: 'steal-success', victim: p2.name, amount: stolen });
            io.to(sid2).emit('effect', { type: 'steal-victim', thief: p.name, amount: stolen });
          }
        });
      }
    });

    // Broadcast state
    const state = {
      timer: room.timer,
      round: room.round,
      totalRounds: room.settings.rounds,
      players: {},
      eggs: room.eggs.filter(e => e.active).map(e => ({ id: e.id, x: Math.round(e.x), y: Math.round(e.y), type: e.type })),
      items: room.items.filter(i => i.active).map(i => ({ id: i.id, x: Math.round(i.x), y: Math.round(i.y), type: i.type })),
    };
    Object.entries(room.players).forEach(([sid, p]) => {
      if (!p.connected) return;
      state.players[sid] = {
        uid: p.uid, name: p.name, colorIdx: p.colorIdx,
        x: Math.round(p.x), y: Math.round(p.y), dir: p.dir, moving: p.moving,
        score: p.score, item: p.item,
        stunned: p.stunned > 0, caged: p.caged > 0,
        shield: p.shield, speedBoost: p.speedMult > 1,
        magnetActive: p.magnetTimer > 0, stealActive: p.stealActive,
        confused: p.confusionTimer > 0,
      };
    });
    // Send to each player individually with their own socketId
    Object.keys(room.players).forEach(sid => {
      io.to(sid).emit('state', { ...state, myId: sid });
    });

  }, 1000 / TICK_RATE);
}

function stopRoomTick(code) {
  const room = rooms[code];
  if (room?.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }
}

// ============ ROUND MANAGEMENT ============
function startRound(code) {
  const room = rooms[code];
  if (!room) return;

  room.state = 'playing';
  room.timer = ROUND_TIME;
  room.eggSpawnTimer = 0;
  room.itemSpawnTimer = 0;

  // Reset players
  const entries = Object.entries(room.players);
  entries.forEach(([sid, p], i) => {
    const sp = SPAWN_POINTS[i] || SPAWN_POINTS[0];
    p.x = sp.x * TILE; p.y = sp.y * TILE;
    p.score = 0; p.item = null; p.dir = 'down';
    p.stunned = 0; p.caged = 0; p.speedMult = 1;
    p.shield = false; p.magnetTimer = 0; p.stealActive = false; p.confusionTimer = 0;
  });

  // Spawn initial eggs
  room.eggs = [];
  room.items = [];
  room.eggIdCounter = 0;
  room.itemIdCounter = 0;
  for (let i = 0; i < 15; i++) {
    const pos = findSpot();
    if (pos) room.eggs.push({ id: 'e' + room.eggIdCounter++, x: pos.x, y: pos.y, type: 'normal', active: true });
  }

  // Countdown
  room.state = 'countdown';
  io.to(code).emit('countdown', 3);
  let cd = 3;
  const cdInterval = setInterval(() => {
    cd--;
    if (cd > 0) {
      io.to(code).emit('countdown', cd);
    } else {
      io.to(code).emit('countdown', 0);
      room.state = 'playing';
      startRoomTick(code);
      clearInterval(cdInterval);
    }
  }, 1000);
}

function endRound(code) {
  const room = rooms[code];
  if (!room) return;
  stopRoomTick(code);

  const scores = {};
  Object.entries(room.players).forEach(([sid, p]) => { scores[sid] = p.score; });
  room.roundResults.push(scores);

  // Round winner
  let maxS = -1, rw = null;
  Object.entries(scores).forEach(([sid, s]) => { if (s > maxS) { maxS = s; rw = sid; } });
  if (rw) room.seriesWins[rw] = (room.seriesWins[rw] || 0) + 1;

  const total = room.settings.rounds;
  const needed = Math.ceil(total / 2);
  let seriesWinner = null;
  Object.entries(room.seriesWins).forEach(([sid, w]) => { if (w >= needed) seriesWinner = sid; });

  if (seriesWinner || room.round >= total) {
    room.state = 'game_over';
    // Build final data
    const playerData = {};
    Object.entries(room.players).forEach(([sid, p]) => {
      playerData[sid] = { uid: p.uid, name: p.name, colorIdx: p.colorIdx, wins: room.seriesWins[sid] || 0 };
    });
    io.to(code).emit('game-over', {
      roundResults: room.roundResults,
      seriesWins: room.seriesWins,
      seriesWinner: seriesWinner || rw,
      players: playerData,
    });
  } else {
    room.state = 'round_end';
    const playerData = {};
    Object.entries(room.players).forEach(([sid, p]) => {
      playerData[sid] = { uid: p.uid, name: p.name, colorIdx: p.colorIdx };
    });
    io.to(code).emit('round-end', {
      round: room.round,
      scores,
      seriesWins: room.seriesWins,
      players: playerData,
    });
  }
}

// ============ SOCKET HANDLERS ============
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create-room', ({ name, uid }, cb) => {
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
    rooms[code] = createRoom(code);
    rooms[code].host = socket.id;
    rooms[code].players[socket.id] = createPlayer(name, uid, 0);
    rooms[code].playerOrder.push(socket.id);
    socket.join(code);
    currentRoom = code;
    cb({ ok: true, code });
    io.to(code).emit('room-update', getRoomLobbyData(code));
  });

  socket.on('join-room', ({ code, name, uid }, cb) => {
    const room = rooms[code];
    if (!room) { cb({ ok: false, error: 'Sala no encontrada' }); return; }
    if (room.state !== 'lobby') { cb({ ok: false, error: 'Partida en curso' }); return; }
    const count = Object.keys(room.players).length;
    if (count >= 4) { cb({ ok: false, error: 'Sala llena' }); return; }

    room.players[socket.id] = createPlayer(name, uid, count);
    room.playerOrder.push(socket.id);
    socket.join(code);
    currentRoom = code;
    cb({ ok: true, code });
    io.to(code).emit('room-update', getRoomLobbyData(code));
  });

  socket.on('ready', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players[socket.id];
    if (!player) return;
    player.ready = !player.ready;
    io.to(currentRoom).emit('room-update', getRoomLobbyData(currentRoom));

    // Check if all ready
    const entries = Object.values(room.players).filter(p => p.connected);
    if (entries.length >= 2 && entries.every(p => p.ready)) {
      room.round = (room.round || 0) + 1;
      startRound(currentRoom);
    }
  });

  socket.on('set-rounds', (rounds) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    if (rooms[currentRoom].host !== socket.id) return;
    rooms[currentRoom].settings.rounds = rounds;
    io.to(currentRoom).emit('room-update', getRoomLobbyData(currentRoom));
  });

  socket.on('move', (data) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const player = rooms[currentRoom].players[socket.id];
    if (!player || player.stunned > 0 || player.caged > 0) return;
    player.x = data.x;
    player.y = data.y;
    player.dir = data.dir;
    player.moving = data.moving;
  });

  socket.on('use-item', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const p = room.players[socket.id];
    if (!p || !p.item || p.stunned > 0 || p.caged > 0) return;
    const item = p.item;
    p.item = null;

    switch (item) {
      case 'cage': {
        let closest = null, closestDist = 150;
        Object.entries(room.players).forEach(([sid, p2]) => {
          if (sid === socket.id) return;
          const dist = Math.hypot(p.x - p2.x, p.y - p2.y);
          if (dist < closestDist) {
            const ddx = p2.x - p.x, ddy = p2.y - p.y;
            let ok = false;
            if (p.dir === 'right' && ddx > 0) ok = true;
            if (p.dir === 'left' && ddx < 0) ok = true;
            if (p.dir === 'down' && ddy > 0) ok = true;
            if (p.dir === 'up' && ddy < 0) ok = true;
            if (ok) { closest = sid; closestDist = dist; }
          }
        });
        if (closest) {
          const victim = room.players[closest];
          if (victim.shield) {
            victim.shield = false;
            io.to(closest).emit('effect', { type: 'shield-block', attack: 'cage' });
          } else {
            victim.caged = ITEM_DURATION.cage;
            io.to(closest).emit('effect', { type: 'caged', by: p.name });
          }
          io.to(socket.id).emit('effect', { type: 'cage-used', hit: !!closest });
        } else {
          io.to(socket.id).emit('effect', { type: 'cage-miss' });
        }
        break;
      }
      case 'fake_egg':
        room.eggs.push({ id: 'e' + room.eggIdCounter++, x: p.x + 10, y: p.y + 12, type: 'fake', active: true });
        io.to(socket.id).emit('effect', { type: 'fake-placed' });
        break;
      case 'speed':
        p.speedMult = 2;
        io.to(socket.id).emit('effect', { type: 'speed-boost' });
        break;
      case 'steal':
        p.stealActive = true;
        setTimeout(() => { p.stealActive = false; }, 5000);
        io.to(socket.id).emit('effect', { type: 'steal-active' });
        break;
      case 'magnet':
        p.magnetTimer = ITEM_DURATION.magnet;
        io.to(socket.id).emit('effect', { type: 'magnet-active' });
        break;
      case 'confusion':
        Object.entries(room.players).forEach(([sid, p2]) => {
          if (sid === socket.id) return;
          if (p2.shield) {
            p2.shield = false;
            io.to(sid).emit('effect', { type: 'shield-block', attack: 'confusion' });
          } else {
            p2.confusionTimer = ITEM_DURATION.confusion;
            io.to(sid).emit('effect', { type: 'confused', by: p.name });
          }
        });
        io.to(socket.id).emit('effect', { type: 'confusion-used' });
        break;
      case 'shield':
        p.shield = true;
        io.to(socket.id).emit('effect', { type: 'shield-active' });
        break;
    }
  });

  socket.on('next-round', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    if (rooms[currentRoom].host !== socket.id) return;
    const room = rooms[currentRoom];
    // Reset ready
    Object.values(room.players).forEach(p => { p.ready = false; });
    room.round++;
    startRound(currentRoom);
  });

  socket.on('back-to-lobby', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    room.state = 'lobby';
    room.roundResults = [];
    room.seriesWins = {};
    room.round = 0;
    Object.values(room.players).forEach(p => { p.ready = false; });
    io.to(currentRoom).emit('room-update', getRoomLobbyData(currentRoom));
  });

  socket.on('leave-room', () => {
    leaveCurrentRoom(socket);
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
  });

  function leaveCurrentRoom(sock) {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    delete room.players[sock.id];
    room.playerOrder = room.playerOrder.filter(s => s !== sock.id);
    sock.leave(currentRoom);

    if (Object.keys(room.players).length === 0) {
      stopRoomTick(currentRoom);
      delete rooms[currentRoom];
    } else {
      // If host left, assign new host
      if (room.host === sock.id) {
        room.host = Object.keys(room.players)[0];
      }
      io.to(currentRoom).emit('room-update', getRoomLobbyData(currentRoom));
    }
    currentRoom = null;
  }
});

function getRoomLobbyData(code) {
  const room = rooms[code];
  if (!room) return {};
  const players = {};
  Object.entries(room.players).forEach(([sid, p]) => {
    players[sid] = { uid: p.uid, name: p.name, colorIdx: p.colorIdx, ready: p.ready, connected: p.connected };
  });
  return {
    code: room.code,
    state: room.state,
    host: room.host,
    settings: room.settings,
    players,
  };
}

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length }));

server.listen(PORT, () => {
  console.log(`🥚 Egg Hunt Server running on port ${PORT}`);
});
