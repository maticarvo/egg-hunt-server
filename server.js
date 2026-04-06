const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3002;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// ── Health check ──
app.get('/', (req, res) => {
  res.json({ game: 'math-tug', connected: io.engine.clientsCount });
});

// ══════════════════════════════════════════════
// GAME CONFIGURATION
// ══════════════════════════════════════════════

const ROPE_MAX = 10;          // posiciones a cada lado (total 20)
const PULL_NORMAL = 1;        // tirón por respuesta correcta
const PULL_BONUS = 2;         // tirón por racha (3+)
const WRONG_PENALTY = 1;      // retroceso por respuesta incorrecta
const ROUND_TIME = 60;        // segundos por ronda
const PROBLEMS_POOL = 4;      // opciones por problema
const STREAK_THRESHOLD = 3;   // racha para bonus

// Bot difficulty presets: { accuracy, minDelay, maxDelay } (ms)
const BOT_PRESETS = {
  facil:    { accuracy: 0.55, minDelay: 3500, maxDelay: 6000, name: 'Bot Fácil' },
  normal:   { accuracy: 0.75, minDelay: 2200, maxDelay: 4500, name: 'Bot Normal' },
  dificil:  { accuracy: 0.90, minDelay: 1400, maxDelay: 3000, name: 'Bot Difícil' },
};

// ══════════════════════════════════════════════
// PROBLEM GENERATION
// ══════════════════════════════════════════════

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateProblem(difficulty) {
  // difficulty: 1-3 (sube conforme avanza la partida)
  let a, b, op, answer;

  const roll = Math.random();

  if (difficulty === 1) {
    // Sumas y restas simples
    if (roll < 0.5) {
      a = randInt(2, 20); b = randInt(2, 20);
      op = '+'; answer = a + b;
    } else {
      a = randInt(10, 30); b = randInt(2, a);
      op = '−'; answer = a - b;
    }
  } else if (difficulty === 2) {
    // Multiplicaciones y sumas más grandes
    if (roll < 0.4) {
      a = randInt(2, 12); b = randInt(2, 12);
      op = '×'; answer = a * b;
    } else if (roll < 0.7) {
      a = randInt(10, 50); b = randInt(10, 50);
      op = '+'; answer = a + b;
    } else {
      a = randInt(20, 80); b = randInt(5, a);
      op = '−'; answer = a - b;
    }
  } else {
    // Divisiones, multiplicaciones grandes, mezcla
    if (roll < 0.35) {
      b = randInt(2, 12); answer = randInt(2, 12);
      a = b * answer;
      op = '÷';
    } else if (roll < 0.65) {
      a = randInt(3, 15); b = randInt(3, 15);
      op = '×'; answer = a * b;
    } else if (roll < 0.85) {
      a = randInt(20, 100); b = randInt(10, 60);
      op = '+'; answer = a + b;
    } else {
      a = randInt(30, 100); b = randInt(5, a);
      op = '−'; answer = a - b;
    }
  }

  // Generar opciones incorrectas
  const options = new Set([answer]);
  while (options.size < PROBLEMS_POOL) {
    let wrong;
    const offset = randInt(1, Math.max(5, Math.floor(answer * 0.3)));
    if (Math.random() < 0.5) {
      wrong = answer + offset;
    } else {
      wrong = answer - offset;
    }
    if (wrong < 0) wrong = answer + offset + randInt(1, 3);
    if (wrong !== answer) options.add(wrong);
  }

  // Mezclar opciones
  const shuffled = [...options].sort(() => Math.random() - 0.5);

  return {
    text: `${a} ${op} ${b}`,
    answer,
    options: shuffled
  };
}

// ══════════════════════════════════════════════
// ROOMS & MATCHMAKING
// ══════════════════════════════════════════════

const rooms = {};        // code → room
const queue = [];         // waiting players for quick match

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[randInt(0, chars.length - 1)];
  return rooms[code] ? genCode() : code;
}

function createRoom(code) {
  return {
    code,
    players: {},      // sid → { name, uid, side, streak, score }
    state: 'waiting',  // waiting | countdown | playing | finished
    ropePos: 0,        // -ROPE_MAX..+ROPE_MAX (neg=left wins, pos=right wins)
    round: 1,
    maxRounds: 3,
    roundTime: ROUND_TIME,
    timer: null,
    countdownTimer: null,
    timeLeft: ROUND_TIME,
    currentProblems: {},  // sid → current problem
    difficulty: 1,
    scores: { left: 0, right: 0 },  // rounds won
    history: []  // round results
  };
}

function getPlayerCount(room) {
  return Object.keys(room.players).length;
}

function getRoomState(room, forSid) {
  const players = {};
  for (const [sid, p] of Object.entries(room.players)) {
    players[sid] = {
      name: p.name,
      side: p.side,
      streak: p.streak,
      score: p.score,
      answering: !!room.currentProblems[sid]
    };
  }

  const base = {
    code: room.code,
    state: room.state,
    ropePos: room.ropePos,
    round: room.round,
    maxRounds: room.maxRounds,
    timeLeft: room.timeLeft,
    players,
    scores: room.scores,
    difficulty: room.difficulty,
    history: room.history
  };

  // Include this player's current problem
  if (forSid && room.currentProblems[forSid]) {
    base.problem = {
      text: room.currentProblems[forSid].text,
      options: room.currentProblems[forSid].options
    };
  }

  return base;
}

function assignNewProblem(room, sid) {
  room.currentProblems[sid] = generateProblem(room.difficulty);
}

function checkRoundEnd(room) {
  if (room.ropePos <= -ROPE_MAX) {
    endRound(room, 'left');
    return true;
  }
  if (room.ropePos >= ROPE_MAX) {
    endRound(room, 'right');
    return true;
  }
  return false;
}

function endRound(room, winner) {
  clearInterval(room.timer);
  room.timer = null;
  stopBot(room);

  // Si se acabó el tiempo sin ganador, gana quien tenga la cuerda más cerca
  if (!winner) {
    if (room.ropePos < 0) winner = 'left';
    else if (room.ropePos > 0) winner = 'right';
    else winner = 'draw';
  }

  if (winner === 'left') room.scores.left++;
  else if (winner === 'right') room.scores.right++;

  room.history.push({ round: room.round, winner, ropePos: room.ropePos });

  // Check if match is over
  const winsNeeded = Math.ceil(room.maxRounds / 2);
  if (room.scores.left >= winsNeeded || room.scores.right >= winsNeeded || room.round >= room.maxRounds) {
    room.state = 'finished';
    broadcastState(room);
    return;
  }

  room.state = 'between_rounds';
  broadcastState(room);

  // Auto-start next round after 4s
  setTimeout(() => {
    if (!rooms[room.code]) return;
    if (getPlayerCount(room) < 2) return;
    startRound(room);
  }, 4000);
}

function startRound(room) {
  room.round++;
  room.ropePos = 0;
  room.timeLeft = room.roundTime;
  room.currentProblems = {};
  room.difficulty = Math.min(3, room.round);
  room.state = 'playing';

  // Assign initial problems
  for (const sid of Object.keys(room.players)) {
    room.players[sid].streak = 0;
    assignNewProblem(room, sid);
  }

  broadcastState(room);

  // Start bot loop if there's a bot
  if (room.botId && room.players[room.botId]) {
    startBotLoop(room);
  }

  // Start round timer
  room.timer = setInterval(() => {
    room.timeLeft--;
    if (room.timeLeft <= 0) {
      endRound(room, null);
    } else {
      // Broadcast time update every second
      broadcastState(room);
    }
  }, 1000);
}

function startMatch(room) {
  room.state = 'countdown';
  room.round = 0;
  room.scores = { left: 0, right: 0 };
  room.history = [];
  broadcastState(room);

  let count = 3;
  io.to(room.code).emit('countdown', count);

  room.countdownTimer = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(room.countdownTimer);
      room.countdownTimer = null;
      startRound(room);
    } else {
      io.to(room.code).emit('countdown', count);
    }
  }, 1000);
}

function broadcastState(room) {
  for (const sid of Object.keys(room.players)) {
    io.to(sid).emit('game-state', getRoomState(room, sid));
  }
}

function cleanupRoom(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.timer) clearInterval(room.timer);
  if (room.countdownTimer) clearInterval(room.countdownTimer);
  stopBot(room);
  delete rooms[code];
}

// ══════════════════════════════════════════════
// BOT LOGIC
// ══════════════════════════════════════════════

function addBot(room, preset) {
  const botId = 'bot_' + genCode();
  const cfg = BOT_PRESETS[preset] || BOT_PRESETS.normal;
  room.players[botId] = {
    name: cfg.name,
    uid: botId,
    side: 'right',
    streak: 0,
    score: 0,
    isBot: true,
    botCfg: cfg
  };
  room.botId = botId;
  return botId;
}

function startBotLoop(room) {
  if (!room.botId) return;
  const botId = room.botId;
  const player = room.players[botId];
  if (!player) return;
  const cfg = player.botCfg;

  function botTick() {
    if (!rooms[room.code]) return;
    if (room.state !== 'playing') return;
    if (!room.players[botId]) return;

    const problem = room.currentProblems[botId];
    if (!problem) return;

    const delay = randInt(cfg.minDelay, cfg.maxDelay);

    room.botTimeout = setTimeout(() => {
      if (!rooms[room.code] || room.state !== 'playing') return;
      if (!room.players[botId]) return;

      const correct = Math.random() < cfg.accuracy;
      let answer;

      if (correct) {
        answer = problem.answer;
      } else {
        // Pick a wrong option
        const wrongs = problem.options.filter(o => o !== problem.answer);
        answer = wrongs[randInt(0, wrongs.length - 1)];
      }

      // Process the bot's answer (same logic as player answer)
      const p = room.players[botId];
      if (!p) return;

      if (answer === problem.answer) {
        p.streak++;
        p.score++;
        const pull = p.streak >= STREAK_THRESHOLD ? PULL_BONUS : PULL_NORMAL;
        if (p.side === 'left') room.ropePos -= pull;
        else room.ropePos += pull;
        room.ropePos = Math.max(-ROPE_MAX, Math.min(ROPE_MAX, room.ropePos));

        io.to(room.code).emit('pull', {
          side: p.side, amount: pull, streak: p.streak, playerName: p.name
        });

        if (!checkRoundEnd(room)) {
          assignNewProblem(room, botId);
          broadcastState(room);
          botTick();
        }
      } else {
        p.streak = 0;
        if (p.side === 'left') room.ropePos += WRONG_PENALTY;
        else room.ropePos -= WRONG_PENALTY;
        room.ropePos = Math.max(-ROPE_MAX, Math.min(ROPE_MAX, room.ropePos));

        io.to(room.code).emit('wrong', { side: p.side, playerName: p.name });

        if (!checkRoundEnd(room)) {
          assignNewProblem(room, botId);
          broadcastState(room);
          botTick();
        }
      }
    }, delay);
  }

  botTick();
}

function stopBot(room) {
  if (room.botTimeout) {
    clearTimeout(room.botTimeout);
    room.botTimeout = null;
  }
}

// ══════════════════════════════════════════════
// SOCKET.IO EVENTS
// ══════════════════════════════════════════════

io.on('connection', (socket) => {
  let currentRoom = null;

  // ── Quick Match ──
  socket.on('quick-match', ({ name, uid }, cb) => {
    // Check if someone is waiting
    const skipped = [];
    let matched = false;

    while (queue.length > 0) {
      const waiting = queue.shift();

      // Skip disconnected or destroyed rooms
      if (!waiting.socket.connected || !rooms[waiting.code]) continue;

      // Skip self (same uid = same user in another tab/session)
      if (waiting.uid === uid && uid) {
        // Clean up the stale room
        cleanupRoom(waiting.code);
        continue;
      }

      // Valid match found
      const room = rooms[waiting.code];
      room.players[socket.id] = {
        name, uid, side: 'right', streak: 0, score: 0
      };
      socket.join(waiting.code);
      currentRoom = waiting.code;
      cb({ ok: true, code: waiting.code, side: 'right' });

      // Re-add any skipped entries
      queue.unshift(...skipped);

      startMatch(room);
      matched = true;
      break;
    }

    if (!matched) {
      // Re-add skipped entries
      queue.unshift(...skipped);

      // No one waiting → create room and queue
      const code = genCode();
      rooms[code] = createRoom(code);
      rooms[code].players[socket.id] = {
        name, uid, side: 'left', streak: 0, score: 0
      };
      socket.join(code);
      currentRoom = code;
      queue.push({ socket, code, uid });
      cb({ ok: true, code, side: 'left', waiting: true });
      broadcastState(rooms[code]);
    }
  });

  // ── Play vs Bot ──
  socket.on('play-bot', ({ name, uid, difficulty }, cb) => {
    const preset = BOT_PRESETS[difficulty] ? difficulty : 'normal';
    const code = genCode();
    rooms[code] = createRoom(code);
    rooms[code].players[socket.id] = {
      name, uid, side: 'left', streak: 0, score: 0
    };
    addBot(rooms[code], preset);
    socket.join(code);
    currentRoom = code;
    cb({ ok: true, code, side: 'left' });
    startMatch(rooms[code]);
  });

  // ── Create Private Room ──
  socket.on('create-room', ({ name, uid }, cb) => {
    const code = genCode();
    rooms[code] = createRoom(code);
    rooms[code].players[socket.id] = {
      name, uid, side: 'left', streak: 0, score: 0
    };
    socket.join(code);
    currentRoom = code;
    cb({ ok: true, code, side: 'left' });
    broadcastState(rooms[code]);
  });

  // ── Join Private Room ──
  socket.on('join-room', ({ code, name, uid }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: 'Sala no encontrada' });
    if (getPlayerCount(room) >= 2) return cb({ ok: false, error: 'Sala llena' });
    if (room.state !== 'waiting') return cb({ ok: false, error: 'Partida en curso' });

    room.players[socket.id] = {
      name, uid, side: 'right', streak: 0, score: 0
    };
    socket.join(code);
    currentRoom = code;
    cb({ ok: true, code, side: 'right' });

    startMatch(room);
  });

  // ── Answer Problem ──
  socket.on('answer', ({ answer }, cb) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.state !== 'playing') return;

    const problem = room.currentProblems[socket.id];
    if (!problem) return;

    const player = room.players[socket.id];
    if (!player) return;

    const correct = answer === problem.answer;

    if (correct) {
      player.streak++;
      player.score++;
      const pull = player.streak >= STREAK_THRESHOLD ? PULL_BONUS : PULL_NORMAL;

      if (player.side === 'left') {
        room.ropePos -= pull;
      } else {
        room.ropePos += pull;
      }

      // Clamp
      room.ropePos = Math.max(-ROPE_MAX, Math.min(ROPE_MAX, room.ropePos));

      // Emit pull event for animation
      io.to(room.code).emit('pull', {
        side: player.side,
        amount: pull,
        streak: player.streak,
        playerName: player.name
      });

      // Check win
      if (!checkRoundEnd(room)) {
        assignNewProblem(room, socket.id);
        broadcastState(room);
      }
    } else {
      player.streak = 0;

      // Penalty: other side gets a small pull
      const penalty = WRONG_PENALTY;
      if (player.side === 'left') {
        room.ropePos += penalty;
      } else {
        room.ropePos -= penalty;
      }
      room.ropePos = Math.max(-ROPE_MAX, Math.min(ROPE_MAX, room.ropePos));

      io.to(room.code).emit('wrong', {
        side: player.side,
        playerName: player.name
      });

      if (!checkRoundEnd(room)) {
        assignNewProblem(room, socket.id);
        broadcastState(room);
      }
    }

    if (cb) cb({ correct });
  });

  // ── Rematch ──
  socket.on('rematch', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.state !== 'finished') return;
    if (getPlayerCount(room) < 2) return;

    // Reset
    room.ropePos = 0;
    room.round = 0;
    room.scores = { left: 0, right: 0 };
    room.history = [];
    room.currentProblems = {};
    for (const p of Object.values(room.players)) {
      p.streak = 0;
      p.score = 0;
    }

    startMatch(room);
  });

  // ── Leave ──
  socket.on('leave', () => {
    leaveRoom(socket);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    // Remove from queue
    const qIdx = queue.findIndex(q => q.socket.id === socket.id);
    if (qIdx !== -1) queue.splice(qIdx, 1);

    leaveRoom(socket);
  });

  function leaveRoom(sock) {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    delete room.players[sock.id];
    delete room.currentProblems[sock.id];
    sock.leave(currentRoom);

    // Count remaining human players
    const humans = Object.values(room.players).filter(p => !p.isBot).length;

    if (humans === 0) {
      cleanupRoom(currentRoom);
    } else {
      // If game was playing, other player wins
      if (room.state === 'playing' || room.state === 'countdown') {
        if (room.timer) clearInterval(room.timer);
        if (room.countdownTimer) clearInterval(room.countdownTimer);
        room.timer = null;
        room.countdownTimer = null;
        room.state = 'opponent_left';
        broadcastState(room);
      } else {
        room.state = 'waiting';
        broadcastState(room);
      }
    }

    currentRoom = null;
  }
});

// ── Start Server ──
server.listen(PORT, () => {
  console.log(`🧮 Math Tug Server running on port ${PORT}`);
});
