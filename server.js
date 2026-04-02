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
const ROUND_TIME = 180; // 3 min max per round
const TICK_RATE = 45;
const EGGS_PER_PLAYER = 10;
const ITEM_SPAWN_INTERVAL = 7;
const MAX_ITEMS = 5;
const ITEM_TYPES = ['cage','speed','steal','magnet','confusion','shield','bomb_egg','radar'];
const SPAWN_POINTS = [{x:2,y:2},{x:MAP_W-3,y:2},{x:2,y:MAP_H-3},{x:MAP_W-3,y:MAP_H-3}]; // corners
const ITEM_DURATION = {cage:3000,speed:4000,magnet:6000,confusion:3000};
const COLORS = ['#3498db','#e74c3c','#2ecc71','#f1c40f'];

// ============ MAPS ============
const SOLID = ['fence','wall','tree','rock','kiosk','bush'];

const MAPS = {
  patio: {
    name: 'Pista Primavera',
    icon: '🌸',
    build: () => {
      const g = Array.from({length:MAP_H}, ()=>Array(MAP_W).fill('grass'));
      const o = Array.from({length:MAP_H}, ()=>Array(MAP_W).fill(null));
      // Bordes
      for(let x=0;x<MAP_W;x++){o[0][x]='fence';o[MAP_H-1][x]='fence';}
      for(let y=0;y<MAP_H;y++){o[y][0]='fence';o[y][MAP_W-1]='fence';}
      // Camino de carrera en circuito
      for(let x=3;x<MAP_W-3;x++){g[4][x]='path';g[MAP_H-5][x]='path';}
      for(let y=4;y<MAP_H-4;y++){g[y][3]='path';g[y][MAP_W-4]='path';}
      // Piso interior cemento
      for(let y=5;y<MAP_H-5;y++) for(let x=4;x<MAP_W-4;x++)
        g[y][x] = ((x+y)%7===0) ? 'cement_wave' : 'cement';
      // Árboles dispersos
      [[3,8],[3,15],[3,22],[6,6],[6,14],[6,22],
       [10,4],[10,12],[10,20],[10,26],
       [15,6],[15,14],[15,22],[18,8],[18,18]].forEach(([y,x])=>{
        if(y>0&&y<MAP_H-1&&x>0&&x<MAP_W-1&&!o[y][x]) o[y][x]='tree';
      });
      // Arbustos como obstáculos
      [[5,10],[5,18],[8,8],[8,20],[12,10],[12,18],
       [16,8],[16,20],[14,14]].forEach(([y,x])=>{
        if(y>0&&y<MAP_H-1&&x>0&&x<MAP_W-1&&!o[y][x]) o[y][x]='bush';
      });
      // Rocas
      [[7,16],[13,10],[9,24],[16,5]].forEach(([y,x])=>{
        if(y>0&&y<MAP_H-1&&x>0&&x<MAP_W-1&&!o[y][x]) o[y][x]='rock';
      });
      // Bancas decorativas
      g[8][12]='bench'; g[8][16]='bench'; g[14][12]='bench'; g[14][16]='bench';
      // Flores
      for(let y=1;y<MAP_H-1;y++) for(let x=1;x<MAP_W-1;x++)
        if(g[y][x]==='grass'&&((x*13+y*7)%11===0)) g[y][x]='flowers';
      return {ground:g, objects:o};
    }
  },
  cemento: {
    name: 'Gran Circuito',
    icon: '🏟️',
    build: () => {
      const g = Array.from({length:MAP_H}, ()=>Array(MAP_W).fill('cement'));
      const o = Array.from({length:MAP_H}, ()=>Array(MAP_W).fill(null));
      for(let x=0;x<MAP_W;x++){o[0][x]='fence';o[MAP_H-1][x]='fence';}
      for(let y=0;y<MAP_H;y++){o[y][0]='fence';o[y][MAP_W-1]='fence';}
      // Piso variado
      for(let y=1;y<MAP_H-1;y++) for(let x=1;x<MAP_W-1;x++)
        g[y][x] = ((x+y)%5===0) ? 'cement_wave' : 'cement';
      // Muros internos formando laberinto ligero
      for(let x=5;x<12;x++) o[5][x]='wall';
      for(let x=18;x<25;x++) o[5][x]='wall';
      for(let x=5;x<12;x++) o[16][x]='wall';
      for(let x=18;x<25;x++) o[16][x]='wall';
      for(let y=8;y<14;y++) o[y][14]='wall';
      // Kioscos en esquinas interiores
      o[3][3]='kiosk'; o[3][4]='kiosk'; o[4][3]='kiosk'; o[4][4]='kiosk';
      o[3][MAP_W-5]='kiosk'; o[3][MAP_W-4]='kiosk';
      o[MAP_H-5][3]='kiosk'; o[MAP_H-5][4]='kiosk';
      o[MAP_H-5][MAP_W-5]='kiosk'; o[MAP_H-5][MAP_W-4]='kiosk';
      return {ground:g, objects:o};
    }
  },
  jardin: {
    name: 'Bosque Encantado',
    icon: '🌳',
    build: () => {
      const g = Array.from({length:MAP_H}, ()=>Array(MAP_W).fill('grass'));
      const o = Array.from({length:MAP_H}, ()=>Array(MAP_W).fill(null));
      for(let x=0;x<MAP_W;x++){o[0][x]='fence';o[MAP_H-1][x]='fence';}
      for(let y=0;y<MAP_H;y++){o[y][0]='fence';o[y][MAP_W-1]='fence';}
      // Caminos cruzados
      for(let x=1;x<MAP_W-1;x++){g[MAP_H/2|0][x]='path';g[(MAP_H/3|0)][x]='path';g[(MAP_H*2/3|0)][x]='path';}
      for(let y=1;y<MAP_H-1;y++){g[y][MAP_W/2|0]='path';g[y][(MAP_W/3|0)]='path';g[y][(MAP_W*2/3|0)]='path';}
      // Muchos árboles
      [[2,3],[2,8],[2,14],[2,22],[2,27],
       [5,5],[5,12],[5,18],[5,25],
       [8,3],[8,16],[8,27],
       [12,5],[12,12],[12,22],
       [15,3],[15,9],[15,18],[15,25],
       [18,5],[18,14],[18,22],[18,27],
       [19,8],[19,18]].forEach(([y,x])=>{
        if(y>0&&y<MAP_H-1&&x>0&&x<MAP_W-1) o[y][x]='tree';
      });
      // Arbustos
      [[4,2],[4,17],[4,24],[9,7],[9,21],
       [13,8],[13,18],[17,4],[17,15],[17,24]].forEach(([y,x])=>{
        if(y>0&&y<MAP_H-1&&x>0&&x<MAP_W-1) o[y][x]='bush';
      });
      // Lagos
      [[6,8],[6,9],[6,10],[7,8],[7,9],[7,10],
       [14,20],[14,21],[15,20],[15,21]].forEach(([y,x])=>{
        if(y>0&&y<MAP_H-1&&x>0&&x<MAP_W-1) g[y][x]='water';
      });
      // Flores
      for(let y=1;y<MAP_H-1;y++) for(let x=1;x<MAP_W-1;x++)
        if(g[y][x]==='grass'&&((x*13+y*7)%9===0)) g[y][x]='flowers';
      return {ground:g, objects:o};
    }
  },
};
const MAP_IDS = Object.keys(MAPS);

function buildMap(mapId) {
  const map = MAPS[mapId] || MAPS.patio;
  return map.build();
}
function isSolidInMap(objects, ground, wx, wy) {
  const tx=Math.floor(wx/TILE),ty=Math.floor(wy/TILE);
  if(tx<0||ty<0||tx>=MAP_W||ty>=MAP_H) return true;
  return SOLID.includes(objects[ty]?.[tx]) || ground[ty]?.[tx]==='water';
}

function findSpotInMap(objects, ground) {
  for(let i=0;i<100;i++){
    const tx=2+Math.floor(Math.random()*(MAP_W-4)),ty=2+Math.floor(Math.random()*(MAP_H-4));
    if(!objects[ty][tx]&&ground[ty][tx]!=='water') return {x:tx*TILE+TILE/2,y:ty*TILE+TILE/2};
  }
  return null;
}

// ============ ROOMS ============
const rooms = {};

function createRoom(code) {
  return {
    code, host: null, state: 'lobby',
    isPublic: false,
    settings: { rounds: 3, mapId: 'patio' },
    mapGround: null, mapObjects: null,
    round: 0, timer: ROUND_TIME,
    players: {}, playerOrder: [],
    eggs: [], items: [],
    eggIdCounter: 0, itemIdCounter: 0,
    itemSpawnTimer: 0,
    roundResults: [], seriesWins: {},
    tickInterval: null,
  };
}

function createPlayer(name, uid, colorIdx) {
  const sp = SPAWN_POINTS[colorIdx] || SPAWN_POINTS[0];
  return {
    uid, name, colorIdx, ready: false,
    x: sp.x*TILE, y: sp.y*TILE,
    dir: 'down', moving: false,
    collected: 0,
    item: null,
    stunned: 0, caged: 0, speedMult: 1,
    shield: false, magnetTimer: 0, stealActive: false, confusionTimer: 0,
    radarTimer: 0,
    connected: true,
  };
}

// ============ EGG SPAWNING ============
function findSpotNoOverlap(room, existingEggs, minDist) {
  for (let i = 0; i < 200; i++) {
    const px = TILE + Math.random() * ((MAP_W - 2) * TILE);
    const py = TILE + Math.random() * ((MAP_H - 2) * TILE);
    const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
    if (tx < 1 || ty < 1 || tx >= MAP_W - 1 || ty >= MAP_H - 1) continue;
    if (room.mapObjects[ty][tx]) continue;
    if (room.mapGround[ty][tx] === 'water') continue;
    const tooClose = existingEggs.some(e => Math.hypot(e.x - px, e.y - py) < minDist);
    if (!tooClose) return { x: px, y: py };
  }
  return findSpotInMap(room.mapObjects, room.mapGround);
}

function spawnEggs(room) {
  room.eggs = [];
  room.eggIdCounter = 0;
  const playerCount = Object.keys(room.players).length;
  const totalEggs = playerCount * EGGS_PER_PLAYER + 1; // +1 tiebreaker, all worth 1
  for (let i = 0; i < totalEggs; i++) {
    const pos = findSpotNoOverlap(room, room.eggs, 40);
    if (pos) {
      room.eggs.push({
        id: 'e' + room.eggIdCounter++,
        x: pos.x, y: pos.y,
        colorIdx: Math.floor(Math.random() * 8), // random color
        active: true, isGolden: false,
      });
    }
  }
}

// ============ GAME TICK ============
function startRoomTick(code) {
  const room = rooms[code];
  if (!room || room.tickInterval) return;

  room.tickInterval = setInterval(() => {
    if (room.state !== 'playing') return;
    const dt = 1000 / TICK_RATE;

    // Timer countdown
    room.timer -= dt / 1000;
    if (room.timer <= 0) { endRound(code); return; }

    // Update player status timers
    Object.values(room.players).forEach(p => {
      if (p.stunned > 0) p.stunned -= dt;
      if (p.caged > 0) p.caged -= dt;
      if (p.magnetTimer > 0) p.magnetTimer -= dt;
      if (p.confusionTimer > 0) p.confusionTimer -= dt;
      if (p.radarTimer > 0) p.radarTimer -= dt;
      if (p.speedMult > 1) { p.speedMult -= dt/4000; if(p.speedMult<1) p.speedMult=1; }
    });

    // Spawn items
    room.itemSpawnTimer += dt / 1000;
    if (room.itemSpawnTimer >= ITEM_SPAWN_INTERVAL) {
      room.itemSpawnTimer = 0;
      const activeItems = room.items.filter(i => i.active).length;
      if (activeItems < MAX_ITEMS) {
        const pos = findSpotInMap(room.mapObjects, room.mapGround);
        if (pos) {
          const type = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
          room.items.push({ id: 'i' + room.itemIdCounter++, x: pos.x, y: pos.y, type, active: true });
        }
      }
    }

    // Update bots
    updateBots(room, dt);

    // Check egg pickups - anyone can grab any egg
    Object.entries(room.players).forEach(([sid, p]) => {
      if (p.stunned > 0 || p.caged > 0) return;

      room.eggs.forEach(egg => {
        if (!egg.active) return;
        const dist = Math.hypot(p.x + 10 - egg.x, p.y + 12 - egg.y);
        if (dist < 22) {
          egg.active = false;
          p.collected++;
          const eggsLeft = room.eggs.filter(e => e.active && !e.isBomb).length;
          if (!p.isBot) {
            io.to(sid).emit('egg-collected', {
              collected: p.collected, eggsLeft,
            });
          }
          // Round ends when last egg is grabbed
          if (eggsLeft === 0) {
            // Winner = whoever collected the most
            let winnerSid = null, maxC = -1;
            Object.entries(room.players).forEach(([s, pp]) => {
              if (pp.collected > maxC) { maxC = pp.collected; winnerSid = s; }
            });
            Object.keys(room.players).forEach(sid2 => {
              if (room.players[sid2].isBot) return;
              if (sid2 === winnerSid) io.to(sid2).emit('effect', { type: 'winner' });
              else io.to(sid2).emit('effect', { type: 'someone-won', name: room.players[winnerSid]?.name });
            });
            endRound(code, winnerSid);
            return;
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
          if (!p.isBot) io.to(sid).emit('item-collected', { type: item.type });
        }
      });

      // Magnet: pulls YOUR eggs towards you
      if (p.magnetTimer > 0) {
        room.eggs.forEach(egg => {
          if (!egg.active) return;
          const dist = Math.hypot(p.x + 10 - egg.x, p.y + 12 - egg.y);
          if (dist < 150 && dist > 20) {
            const a = Math.atan2(p.y + 12 - egg.y, p.x + 10 - egg.x);
            egg.x += Math.cos(a) * 3;
            egg.y += Math.sin(a) * 3;
          }
        });
      }

      // Steal touch: -1 from victim, respawn a random collected egg
      if (p.stealActive) {
        Object.entries(room.players).forEach(([sid2, p2]) => {
          if (sid2 === sid) return;
          const dist = Math.hypot(p.x - p2.x, p.y - p2.y);
          if (dist < 30 && p2.collected > 0) {
            p.stealActive = false;
            p2.collected--;
            // Respawn a random inactive (collected) egg back on the map
            const inactive = room.eggs.filter(e => !e.active && !e.isBomb);
            if (inactive.length > 0) {
              const egg = inactive[Math.floor(Math.random() * inactive.length)];
              egg.active = true;
              const pos = findSpotInMap(room.mapObjects, room.mapGround);
              if (pos) { egg.x = pos.x; egg.y = pos.y; }
            }
            io.to(sid).emit('effect', { type: 'steal-success', victim: p2.name });
            if (!p2.isBot) io.to(sid2).emit('effect', { type: 'steal-victim', thief: p.name });
          }
        });
      }
    });

    // Broadcast state
    const state = {
      timer: room.timer,
      round: room.round,
      totalRounds: room.settings.rounds,
      mapId: room.settings.mapId,
      mapGround: room.mapGround,
      mapObjects: room.mapObjects,
      players: {},
      eggs: room.eggs.filter(e => e.active).map(e => ({
        id: e.id, x: Math.round(e.x), y: Math.round(e.y),
        colorIdx: e.colorIdx,
      })),
      items: room.items.filter(i => i.active).map(i => ({
        id: i.id, x: Math.round(i.x), y: Math.round(i.y), type: i.type
      })),
    };
    Object.entries(room.players).forEach(([sid, p]) => {
      if (!p.connected) return;
      state.players[sid] = {
        uid: p.uid, name: p.name, colorIdx: p.colorIdx,
        x: Math.round(p.x), y: Math.round(p.y), dir: p.dir, moving: p.moving,
        collected: p.collected,
        item: p.item,
        stunned: p.stunned > 0, caged: p.caged > 0,
        shield: p.shield, speedBoost: p.speedMult > 1,
        magnetActive: p.magnetTimer > 0, stealActive: p.stealActive,
        confused: p.confusionTimer > 0,
        radarActive: p.radarTimer > 0,
      };
    });
    Object.keys(room.players).forEach(sid => {
      if (room.players[sid].isBot) return;
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
  room.itemSpawnTimer = 0;

  // Build map
  const mapData = buildMap(room.settings.mapId || 'patio');
  room.mapGround = mapData.ground;
  room.mapObjects = mapData.objects;

  // Reset players
  const entries = Object.entries(room.players);
  entries.forEach(([sid, p], i) => {
    const sp = SPAWN_POINTS[i] || SPAWN_POINTS[0];
    p.x = sp.x*TILE; p.y = sp.y*TILE;
    p.collected = 0;
    p.item = null; p.dir = 'down';
    p.stunned = 0; p.caged = 0; p.speedMult = 1;
    p.shield = false; p.magnetTimer = 0; p.stealActive = false;
    p.confusionTimer = 0; p.radarTimer = 0;
  });

  // Spawn eggs for each player
  spawnEggs(room);

  // Spawn initial items
  room.items = [];
  room.itemIdCounter = 0;
  for (let i = 0; i < 3; i++) {
    const pos = findSpotInMap(room.mapObjects, room.mapGround);
    if (pos) {
      const type = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
      room.items.push({ id: 'i' + room.itemIdCounter++, x: pos.x, y: pos.y, type, active: true });
    }
  }

  // Countdown
  room.state = 'countdown';
  io.to(code).emit('countdown', 3);
  let cd = 3;
  const cdInterval = setInterval(() => {
    cd--;
    if (cd > 0) { io.to(code).emit('countdown', cd); }
    else {
      io.to(code).emit('countdown', 0);
      room.state = 'playing';
      startRoomTick(code);
      clearInterval(cdInterval);
    }
  }, 1000);
}

function endRound(code, winnerSid) {
  const room = rooms[code];
  if (!room) return;
  stopRoomTick(code);

  // If no explicit winner, whoever collected most wins
  if (!winnerSid) {
    let maxC = -1;
    Object.entries(room.players).forEach(([sid, p]) => {
      if (p.collected > maxC) { maxC = p.collected; winnerSid = sid; }
    });
  }

  const scores = {};
  Object.entries(room.players).forEach(([sid, p]) => { scores[sid] = p.collected; });
  room.roundResults.push(scores);

  if (winnerSid) room.seriesWins[winnerSid] = (room.seriesWins[winnerSid] || 0) + 1;

  const total = room.settings.rounds;
  const needed = Math.ceil(total / 2);
  let seriesWinner = null;
  Object.entries(room.seriesWins).forEach(([sid, w]) => { if (w >= needed) seriesWinner = sid; });

  if (seriesWinner || room.round >= total) {
    room.state = 'game_over';
    const playerData = {};
    Object.entries(room.players).forEach(([sid, p]) => {
      playerData[sid] = { uid: p.uid, name: p.name, colorIdx: p.colorIdx, wins: room.seriesWins[sid] || 0 };
    });
    io.to(code).emit('game-over', {
      roundResults: room.roundResults, seriesWins: room.seriesWins,
      seriesWinner: seriesWinner || winnerSid, players: playerData,
    });
  } else {
    room.state = 'round_end';
    const playerData = {};
    Object.entries(room.players).forEach(([sid, p]) => {
      playerData[sid] = { uid: p.uid, name: p.name, colorIdx: p.colorIdx };
    });
    io.to(code).emit('round-end', {
      round: room.round, scores,
      seriesWins: room.seriesWins, players: playerData,
      winner: winnerSid, winnerName: room.players[winnerSid]?.name || '???',
    });
  }
}

// ============ BOT AI ============
const BOT_NAMES = ['Sra. Mirta', 'Don Simón', "Ma'am Pamela"];
const BOT_SPEED = 2.5;

function addBots(code, count) {
  const room = rooms[code];
  if (!room) return;
  for (let i = 0; i < count; i++) {
    const botId = 'bot_' + i + '_' + Date.now();
    const colorIdx = Object.keys(room.players).length;
    const name = BOT_NAMES[i % BOT_NAMES.length];
    room.players[botId] = createPlayer(name, botId, colorIdx);
    room.players[botId].isBot = true;
    room.players[botId].botItemTimer = 0;
    room.players[botId].botDirTimer = 0;
    room.players[botId].ready = true;
    room.playerOrder.push(botId);
  }
}

function updateBots(room, dt) {
  Object.entries(room.players).forEach(([sid, p]) => {
    if (!p.isBot) return;
    if (p.stunned > 0 || p.caged > 0) return;

    // Find nearest active egg
    let nearestEgg = null, nearestDist = Infinity;
    room.eggs.forEach(egg => {
      if (!egg.active || egg.isBomb) return;
      const dist = Math.hypot(p.x + 10 - egg.x, p.y + 12 - egg.y);
      if (dist < nearestDist) { nearestDist = dist; nearestEgg = egg; }
    });

    if (nearestEgg) {
      const dx = nearestEgg.x - (p.x + 10);
      const dy = nearestEgg.y - (p.y + 12);
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist > 5) {
        const nx = dx/dist, ny = dy/dist;
        const speed = BOT_SPEED * p.speedMult;
        p.x = Math.max(TILE, Math.min(p.x + nx*speed, (MAP_W-1)*TILE-20));
        p.y = Math.max(TILE, Math.min(p.y + ny*speed, (MAP_H-1)*TILE-24));
        p.moving = true;
        if (Math.abs(nx) > Math.abs(ny)) p.dir = nx > 0 ? 'right' : 'left';
        else p.dir = ny > 0 ? 'down' : 'up';
      }
    } else {
      p.botDirTimer -= dt;
      if (p.botDirTimer <= 0) {
        p.botDirTimer = 1000 + Math.random()*2000;
        p.dir = ['up','down','left','right'][Math.floor(Math.random()*4)];
      }
      const speed = BOT_SPEED * 0.5;
      switch(p.dir) {
        case 'up': p.y = Math.max(TILE, p.y-speed); break;
        case 'down': p.y = Math.min((MAP_H-1)*TILE-24, p.y+speed); break;
        case 'left': p.x = Math.max(TILE, p.x-speed); break;
        case 'right': p.x = Math.min((MAP_W-1)*TILE-20, p.x+speed); break;
      }
      p.moving = true;
    }

    // Use items
    if (p.item) {
      p.botItemTimer -= dt;
      if (p.botItemTimer <= 0) {
        p.botItemTimer = 2000 + Math.random()*4000;
        let nearestPlayer = null, npDist = Infinity;
        Object.entries(room.players).forEach(([sid2, p2]) => {
          if (sid2 === sid) return;
          const d = Math.hypot(p.x-p2.x, p.y-p2.y);
          if (d < npDist) { npDist = d; nearestPlayer = {sid:sid2,p:p2}; }
        });

        switch(p.item) {
          case 'speed': p.speedMult = 2; break;
          case 'shield': p.shield = true; break;
          case 'magnet': p.magnetTimer = ITEM_DURATION.magnet; break;
          case 'radar': p.radarTimer = 5000; break;
          case 'cage':
            if (nearestPlayer && npDist < 150) {
              if (nearestPlayer.p.shield) nearestPlayer.p.shield = false;
              else { nearestPlayer.p.caged = 3000; if(!nearestPlayer.p.isBot) io.to(nearestPlayer.sid).emit('effect',{type:'caged',by:p.name}); }
            }
            break;
          case 'confusion':
            Object.entries(room.players).forEach(([sid2, p2]) => {
              if (sid2 === sid) return;
              if (p2.shield) p2.shield = false;
              else { p2.confusionTimer = 3000; if(!p2.isBot) io.to(sid2).emit('effect',{type:'confused',by:p.name}); }
            });
            break;
          case 'steal':
            p.stealActive = true;
            setTimeout(() => { p.stealActive = false; }, 5000);
            break;
          case 'bomb_egg':
            const bx=p.x+10, by2=p.y+12;
            room.eggs.push({id:'b'+room.eggIdCounter++,x:bx,y:by2,owner:'bomb',colorIdx:-1,active:true,collected:false,isBomb:true,placedBy:sid});
            setTimeout(()=>{
              const bomb=room.eggs.find(e=>e.x===bx&&e.y===by2&&e.isBomb&&e.active);
              if(!bomb)return; bomb.active=false;
              Object.entries(room.players).forEach(([sid2,p2])=>{
                const d=Math.hypot(p2.x+10-bx,p2.y+12-by2);
                if(d<100){
                  const a=Math.atan2(p2.y+12-by2,p2.x+10-bx);
                  const f=200*(1-d/100);
                  p2.x+=Math.cos(a)*f;p2.y+=Math.sin(a)*f;
                  p2.x=Math.max(TILE,Math.min(p2.x,(MAP_W-1)*TILE-20));
                  p2.y=Math.max(TILE,Math.min(p2.y,(MAP_H-1)*TILE-24));
                  p2.stunned=1000;
                  if(!p2.isBot)io.to(sid2).emit('effect',{type:'bomb-hit',angle:a,force:f});
                }
              });
              Object.keys(room.players).forEach(sid2=>{
                if(!room.players[sid2].isBot)io.to(sid2).emit('effect',{type:'bomb-explode',x:bx,y:by2});
              });
            },2000);
            break;
        }
        p.item = null;
      }
    }
  });
}

// ============ SOCKET HANDLERS ============
io.on('connection', (socket) => {
  let currentRoom = null;

  // ---- Public lobby browsing ----
  socket.on('join-public-lobby', () => {
    socket.join('public-lobby');
    socket.emit('public-rooms', getPublicRoomsList());
  });

  socket.on('leave-public-lobby', () => {
    socket.leave('public-lobby');
  });

  socket.on('create-public', ({ name, uid }, cb) => {
    const code = Math.random().toString(36).substring(2,6).toUpperCase();
    rooms[code] = createRoom(code);
    rooms[code].host = socket.id;
    rooms[code].isPublic = true;
    rooms[code].players[socket.id] = createPlayer(name, uid, 0);
    rooms[code].playerOrder.push(socket.id);
    socket.join(code);
    socket.leave('public-lobby');
    currentRoom = code;
    cb({ ok: true, code });
    io.to(code).emit('room-update', getRoomLobbyData(code));
    broadcastPublicRooms();
  });

  socket.on('quick-play', ({ name, uid }, cb) => {
    // Find a public room with space
    const available = Object.values(rooms).find(r =>
      r.isPublic && r.state === 'lobby' &&
      Object.values(r.players).filter(p => !p.isBot && p.connected).length < 4
    );
    if (available) {
      const count = Object.keys(available.players).length;
      available.players[socket.id] = createPlayer(name, uid, count);
      available.playerOrder.push(socket.id);
      socket.join(available.code);
      socket.leave('public-lobby');
      currentRoom = available.code;
      cb({ ok: true, code: available.code });
      io.to(available.code).emit('room-update', getRoomLobbyData(available.code));
      broadcastPublicRooms();
    } else {
      // No rooms available, create one
      const code = Math.random().toString(36).substring(2,6).toUpperCase();
      rooms[code] = createRoom(code);
      rooms[code].host = socket.id;
      rooms[code].isPublic = true;
      rooms[code].players[socket.id] = createPlayer(name, uid, 0);
      rooms[code].playerOrder.push(socket.id);
      socket.join(code);
      socket.leave('public-lobby');
      currentRoom = code;
      cb({ ok: true, code, created: true });
      io.to(code).emit('room-update', getRoomLobbyData(code));
      broadcastPublicRooms();
    }
  });

  socket.on('start-solo', ({ name, uid, rounds }, cb) => {
    const code = Math.random().toString(36).substring(2,6).toUpperCase();
    rooms[code] = createRoom(code);
    rooms[code].host = socket.id;
    rooms[code].settings.rounds = rounds || 3;
    rooms[code].players[socket.id] = createPlayer(name, uid, 0);
    rooms[code].playerOrder.push(socket.id);
    socket.join(code);
    currentRoom = code;
    addBots(code, 3);
    cb({ ok: true, code });
    io.to(code).emit('room-update', getRoomLobbyData(code));
  });

  socket.on('create-room', ({ name, uid }, cb) => {
    const code = Math.random().toString(36).substring(2,6).toUpperCase();
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
    if (!room) { cb({ok:false,error:'Sala no encontrada'}); return; }
    if (room.state !== 'lobby') { cb({ok:false,error:'Partida en curso'}); return; }
    const humanCount = Object.values(room.players).filter(p => !p.isBot && p.connected).length;
    if (humanCount >= 4) { cb({ok:false,error:'Sala llena'}); return; }
    const count = Object.keys(room.players).length;
    room.players[socket.id] = createPlayer(name, uid, count);
    room.playerOrder.push(socket.id);
    socket.join(code);
    socket.leave('public-lobby');
    currentRoom = code;
    cb({ ok: true, code });
    io.to(code).emit('room-update', getRoomLobbyData(code));
    if (room.isPublic) broadcastPublicRooms();
  });

  socket.on('ready', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players[socket.id];
    if (!player) return;
    player.ready = !player.ready;
    io.to(currentRoom).emit('room-update', getRoomLobbyData(currentRoom));
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

  socket.on('set-map', (mapId) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    if (rooms[currentRoom].host !== socket.id) return;
    if (MAPS[mapId]) {
      rooms[currentRoom].settings.mapId = mapId;
      io.to(currentRoom).emit('room-update', getRoomLobbyData(currentRoom));
    }
  });

  socket.on('move', (data) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const player = rooms[currentRoom].players[socket.id];
    if (!player || player.stunned > 0 || player.caged > 0) return;
    player.x = data.x; player.y = data.y;
    player.dir = data.dir; player.moving = data.moving;
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
          const dist = Math.hypot(p.x-p2.x, p.y-p2.y);
          if (dist < closestDist) {
            const ddx=p2.x-p.x, ddy=p2.y-p.y;
            let ok=false;
            if(p.dir==='right'&&ddx>0)ok=true;if(p.dir==='left'&&ddx<0)ok=true;
            if(p.dir==='down'&&ddy>0)ok=true;if(p.dir==='up'&&ddy<0)ok=true;
            if(ok){closest=sid;closestDist=dist;}
          }
        });
        if (closest) {
          const victim=room.players[closest];
          if(victim.shield){victim.shield=false;io.to(closest).emit('effect',{type:'shield-block',attack:'cage'});}
          else{victim.caged=ITEM_DURATION.cage;io.to(closest).emit('effect',{type:'caged',by:p.name});}
          io.to(socket.id).emit('effect',{type:'cage-used',hit:true});
        } else { io.to(socket.id).emit('effect',{type:'cage-miss'}); }
        break;
      }
      case 'speed':
        p.speedMult = 2;
        io.to(socket.id).emit('effect',{type:'speed-boost'});
        break;
      case 'steal':
        p.stealActive = true;
        setTimeout(() => { p.stealActive = false; }, 5000);
        io.to(socket.id).emit('effect',{type:'steal-active'});
        break;
      case 'magnet':
        p.magnetTimer = ITEM_DURATION.magnet;
        io.to(socket.id).emit('effect',{type:'magnet-active'});
        break;
      case 'confusion':
        Object.entries(room.players).forEach(([sid, p2]) => {
          if (sid === socket.id) return;
          if(p2.shield){p2.shield=false;io.to(sid).emit('effect',{type:'shield-block',attack:'confusion'});}
          else{p2.confusionTimer=ITEM_DURATION.confusion;io.to(sid).emit('effect',{type:'confused',by:p.name});}
        });
        io.to(socket.id).emit('effect',{type:'confusion-used'});
        break;
      case 'shield':
        p.shield = true;
        io.to(socket.id).emit('effect',{type:'shield-active'});
        break;
      case 'radar':
        p.radarTimer = 5000;
        io.to(socket.id).emit('effect',{type:'radar-active'});
        break;
      case 'bomb_egg': {
        const bombId = 'b'+room.eggIdCounter++;
        const bombX=p.x+10, bombY=p.y+12;
        room.eggs.push({id:bombId,x:bombX,y:bombY,owner:'bomb',colorIdx:-1,active:true,collected:false,isBomb:true,placedBy:socket.id});
        io.to(socket.id).emit('effect',{type:'bomb-placed'});
        setTimeout(()=>{
          const egg=room.eggs.find(e=>e.id===bombId);
          if(!egg||!egg.active)return; egg.active=false;
          const BLAST_RADIUS=100, LAUNCH_FORCE=200;
          Object.entries(room.players).forEach(([sid2,p2])=>{
            const dist=Math.hypot(p2.x+10-bombX,p2.y+12-bombY);
            if(dist<BLAST_RADIUS){
              const angle=Math.atan2(p2.y+12-bombY,p2.x+10-bombX);
              const force=LAUNCH_FORCE*(1-dist/BLAST_RADIUS);
              p2.x+=Math.cos(angle)*force;p2.y+=Math.sin(angle)*force;
              p2.x=Math.max(TILE,Math.min(p2.x,(MAP_W-1)*TILE-20));
              p2.y=Math.max(TILE,Math.min(p2.y,(MAP_H-1)*TILE-24));
              p2.stunned=1000;
              if(!p2.isBot)io.to(sid2).emit('effect',{type:'bomb-hit',angle,force});
            }
          });
          Object.keys(room.players).forEach(sid2=>{
            if(!room.players[sid2].isBot)io.to(sid2).emit('effect',{type:'bomb-explode',x:bombX,y:bombY});
          });
        },2000);
        break;
      }
    }
  });

  socket.on('next-round', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    if (rooms[currentRoom].host !== socket.id) return;
    const room = rooms[currentRoom];
    Object.values(room.players).forEach(p => { p.ready = false; });
    room.round++;
    startRound(currentRoom);
  });

  socket.on('back-to-lobby', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    room.state = 'lobby'; room.roundResults = [];
    room.seriesWins = {}; room.round = 0;
    Object.values(room.players).forEach(p => { p.ready = false; });
    io.to(currentRoom).emit('room-update', getRoomLobbyData(currentRoom));
  });

  socket.on('leave-room', () => leaveCurrentRoom(socket));
  socket.on('disconnect', () => leaveCurrentRoom(socket));

  function leaveCurrentRoom(sock) {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const wasPublic = room.isPublic;
    delete room.players[sock.id];
    room.playerOrder = room.playerOrder.filter(s => s !== sock.id);
    sock.leave(currentRoom);
    const remaining = Object.values(room.players).filter(p => !p.isBot);
    if (remaining.length === 0) {
      stopRoomTick(currentRoom); delete rooms[currentRoom];
    } else {
      if (room.host === sock.id) room.host = Object.keys(room.players).find(s => !room.players[s].isBot) || Object.keys(room.players)[0];
      io.to(currentRoom).emit('room-update', getRoomLobbyData(currentRoom));
    }
    currentRoom = null;
    if (wasPublic) broadcastPublicRooms();
  }
});

function getRoomLobbyData(code) {
  const room = rooms[code];
  if (!room) return {};
  const players = {};
  Object.entries(room.players).forEach(([sid, p]) => {
    players[sid] = { uid: p.uid, name: p.name, colorIdx: p.colorIdx, ready: p.ready, connected: p.connected };
  });
  const maps = MAP_IDS.map(id => ({id, name: MAPS[id].name, icon: MAPS[id].icon}));
  return { code: room.code, state: room.state, host: room.host, settings: room.settings, players, isPublic: room.isPublic, maps };
}

function getPublicRoomsList() {
  return Object.values(rooms)
    .filter(r => r.isPublic && r.state === 'lobby')
    .map(r => {
      const humanCount = Object.values(r.players).filter(p => !p.isBot && p.connected).length;
      const hostPlayer = r.players[r.host];
      return {
        code: r.code,
        hostName: hostPlayer?.name || '???',
        players: humanCount,
        maxPlayers: 4,
        rounds: r.settings.rounds,
      };
    });
}

function broadcastPublicRooms() {
  io.to('public-lobby').emit('public-rooms', getPublicRoomsList());
}

app.get('/', (req, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length }));

server.listen(PORT, () => {
  console.log(`🐰 Rabbit Race Server running on port ${PORT}`);
});
