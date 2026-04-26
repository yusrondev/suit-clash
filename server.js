const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// ── DECK ──────────────────────────────────────────────────────────────────────
const suits = ["♠", "♥", "♦", "♣"];
const values = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
];

function getRank(v) {
  if (v === "A") return 14;
  if (v === "K") return 13;
  if (v === "Q") return 12;
  if (v === "J") return 11;
  return parseInt(v);
}

const CARDS_EACH = 4;

function createDeck() {
  const d = [];
  suits.forEach((s) => values.forEach((v) => d.push({ value: v, suit: s })));
  return d.sort(() => Math.random() - 0.5);
}

// ── ROOMS ─────────────────────────────────────────────────────────────────────
// rooms: Map<roomId, GameState>
const rooms = new Map();

function makeGame() {
  return {
    players: [], // [{id, name, cards}]
    deck: [],
    tableCard: null,
    currentSuit: null,
    currentPlayer: 0,

    controllerPlayer: null,
    controllerCard: null,
    freeMode: false,

    roundCards: [],
    outOrder: [], // urutan pemain keluar
    tableHistory: [], // Persistent history of cards played
    playersPlayed: new Set(),
    skipPlayer: null,

    started: false,
    leaderboard: {}, // 🔥 per-room leaderboard
    roundCount: 0,
    maxRounds: 7, // 🔥 NEW: Dinamis dari Host
    nextStarter: null,
    lastTakerProvider: null, // Tracks who played the card that was just taken
  };
}

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

// ── BOT AI ────────────────────────────────────────────────────────────────────
const BOT_ID = '__bot__';

function isBotTurn(game) {
  const cur = game.players[game.currentPlayer];
  return cur && cur.isBot;
}

function scheduleBotTurn(game, roomId) {
  if (!game || !game.started) return;
  if (!isBotTurn(game)) return;

  // Jeda acak 1.2s - 2.4s supaya terasa alami
  const delay = 1200 + Math.random() * 1200;
  setTimeout(() => {
    if (!game.started) return;
    if (!isBotTurn(game)) return;
    runBotTurn(game, roomId);
  }, delay);
}

function runBotTurn(game, roomId) {
  const botIndex = game.currentPlayer;
  const bot = game.players[botIndex];
  if (!bot || !bot.isBot) return;

  const isFree = game.freeMode && game.controllerPlayer === botIndex;

  // ── Cari kartu yang bisa dimainkan ──
  let playableCards;
  if (isFree) {
    playableCards = bot.cards.map((c, i) => ({ c, i })); // bisa pakai kartu apa saja
  } else {
    playableCards = bot.cards
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.suit === game.currentSuit);
  }

  // ── Strategi Bot ──
  if (playableCards.length > 0) {
    // Pilih kartu tertinggi jika free mode, terendah jika bukan
    playableCards.sort((a, b) => {
      const ra = getRank(a.c.value);
      const rb = getRank(b.c.value);
      return isFree ? rb - ra : ra - rb; // free: mainkan tinggi dulu, biasa: rendah dulu
    });

    const chosen = playableCards[0];
    const card = bot.cards.splice(chosen.i, 1)[0];

    if (isFree) {
      game.currentSuit = card.suit;
      game.tableCard = card;
      game.tableHistory.push(card);
      game.controllerCard = { player: botIndex, card };
      game.freeMode = false;
      game.skipPlayer = botIndex;

      io.to(roomId).emit('botAction', { action: 'play', botName: bot.name, card });
      if (checkEnd(game, roomId)) return;
      nextTurn(game, roomId);
    } else {
      if (!game.controllerCard || getRank(card.value) > getRank(game.controllerCard.card.value)) {
        game.controllerPlayer = botIndex;
        game.controllerCard = { player: botIndex, card };
      }
      game.roundCards.push({ player: botIndex, card });
      game.playersPlayed.add(botIndex);
      game.tableCard = card;
      game.tableHistory.push(card);

      io.to(roomId).emit('botAction', { action: 'play', botName: bot.name, card });
      if (checkEnd(game, roomId)) return;
      nextTurn(game, roomId);
    }
    return;
  }

  // ── Tidak ada kartu cocok: ambil dari deck terus sampai dapat yang cocok ──
  if (game.deck.length > 0) {
    const drawn = game.deck.pop();
    bot.cards.push(drawn);
    io.to(roomId).emit('botAction', { action: 'draw', botName: bot.name });
    sendState(game);

    const canPlayDrawn = isFree || drawn.suit === game.currentSuit;
    if (canPlayDrawn) {
      // Dapat kartu cocok — langsung main setelah jeda kecil
      setTimeout(() => runBotTurn(game, roomId), 900);
    } else if (game.deck.length > 0) {
      // Masih ada deck, coba ambil lagi setelah jeda
      setTimeout(() => runBotTurn(game, roomId), 800);
    } else {
      // Deck habis, coba ambil dari meja
      if (game.tableHistory.length > 0 && !game.freeMode) {
        io.to(roomId).emit('botAction', { action: 'takeTable', botName: bot.name });
        resolveTableTake(game, botIndex, roomId);
      } else {
        game.playersPlayed.add(botIndex);
        if (checkEnd(game, roomId)) return;
        nextTurn(game, roomId);
      }
    }
    return;
  }

  // ── Deck habis: ambil dari meja ──
  if (game.tableHistory.length > 0 && !game.freeMode) {
    io.to(roomId).emit('botAction', { action: 'takeTable', botName: bot.name });
    resolveTableTake(game, botIndex, roomId);
    return;
  }

  // Fallback: tidak bisa apa-apa, skip ronde
  game.playersPlayed.add(botIndex);
  nextTurn(game, roomId);
}

function resolveTableTake(game, pIndex, roomId) {
  const p = game.players[pIndex];
  if (!game.tableHistory || game.tableHistory.length === 0) {
    // 🔥 Jika deck kosong & meja kosong, terpaksa skip ronde ini
    console.log(`[${roomId}] ${p.name} skip karena deck & meja kosong`);
    game.playersPlayed.add(pIndex);
    if (checkEnd(game, roomId)) return;
    nextTurn(game, roomId);
    return;
  }

  const takenCard = game.tableHistory.pop();
  if (!takenCard) return;
  p.cards.push(takenCard);

  // Identify who played this card to track potential winner if round ends
  // Identify who played this card to track potential winner if round ends
  let playedBy = -1;
  if (game.controllerCard && game.controllerCard.card.suit === takenCard.suit && game.controllerCard.card.value === takenCard.value) {
    playedBy = game.controllerCard.player;
    // 🔥 TUNTUTAN USER: Jangan hapus controllerCard agar dia tetap dianggap pemenang 
    // jika tidak ada yang mengeluarkan kartu lebih tinggi.
  } else {
    const rcIndex = game.roundCards.findIndex(rc => rc.card.suit === takenCard.suit && rc.card.value === takenCard.value);
    if (rcIndex !== -1) {
      playedBy = game.roundCards[rcIndex].player;
      // 🔥 TUNTUTAN USER: Jangan hapus dari roundCards agar tetap masuk hitungan 'highest'
    }
  }

  if (playedBy !== -1) {
    game.lastTakerProvider = playedBy;
  }

  // Mark this player as "played" for this round
  game.playersPlayed.add(pIndex);

  // Update Table Visual
  if (game.tableHistory.length > 0) {
    game.tableCard = game.tableHistory[game.tableHistory.length - 1];
  } else {
    game.tableCard = null;
  }

  const msg = `${p.name}${p.isBot ? ' (Bot)' : ''} mengambil kartu meja.`;
  io.to(roomId).emit('toast', { msg });

  console.log(`[${roomId}] ${p.name} takeTable. Continuing round...`);

  sendState(game);
  
  // 🔥 TUNTUTAN USER: Jika ambil dari meja, ronde langsung berakhir.
  // Pemenang (kartu tertinggi) akan memulai ronde baru (Free Mode).
  // Ini memastikan urutan giliran kembali normal dari pemenang.
  resolveRound(game, roomId);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function isActive(game, i) {
  const p = game.players[i];
  if (!p || p.isOut) return false;
  if (p.cards.length === 0) return false; // Pemain tanpa kartu tidak aktif
  return true;
}

function isPlayerStuck(game, pIndex) {
  const p = game.players[pIndex];
  if (!isActive(game, pIndex)) return false;

  // Jika freeMode dan dia controller, wajib main (tidak stuck)
  if (game.freeMode && game.controllerPlayer === pIndex) return false;

  // Jika punya kartu cocok, tidak stuck
  const hasSuit = p.cards.some((c) => c.suit === game.currentSuit);
  if (hasSuit) return false;

  // Jika deck masih ada, bisa ambil (tidak stuck)
  if (game.deck.length > 0) return false;

  // Jika meja masih ada kartu, bisa ambil (tidak stuck)
  if (game.tableHistory && game.tableHistory.length > 0) return false;

  return true;
}

function sendState(game) {
  game.players.forEach((p, i) => {
    if (p.isBot) return; // Bot tidak punya socket, skip
    io.to(p.id).emit("state", {
      yourCards: p.cards,
      tableCard: game.tableCard,
      currentSuit: game.currentSuit,
      currentPlayer: game.currentPlayer,
      yourIndex: i,
      controller: game.controllerPlayer,
      skip: game.skipPlayer,
      deckCount: game.deck.length,
      totalPlayers: game.players.length,
      playersCardCount: game.players.map((pl) => pl.cards.length),
      playerNames: game.players.map((pl) => pl.name),
      playersIsOut: game.players.map((pl) => pl.isOut),
      roundCards: game.roundCards,
      tableHistory: game.tableHistory || [],
      freeMode: game.freeMode,
      started: game.started,
      roundCount: game.roundCount,
      maxRounds: game.maxRounds,
      attackCharges: game.players.map(pl => pl.attackCharges),
    });
  });
}

function checkEnd(game, roomId) {
  let someoneOut = false;

  game.players.forEach((p, i) => {
    if (p.cards.length === 0 && !p.isOut) {
      p.isOut = true;
      someoneOut = true;

      // Tandai sebagai sudah "main" di ronde ini agar tidak ditunggu lagi
      game.playersPlayed.add(i);

      game.outOrder.push(i); // 🔥 simpan urutan keluar
      if (game.outOrder.length === 1) {
        game.nextStarter = i;
      }

      console.log(`${p.name} keluar dari ronde`);

      io.to(roomId).emit("playerOut", {
        name: p.name,
      });
    }
  });

  const activePlayers = game.players.filter((p) => !p.isOut);

  // kalau tinggal 1 → dia kalah
  if (activePlayers.length === 1) {
    const loserIndex = game.players.findIndex(p => !p.isOut);
    const loser = game.players[loserIndex];

    console.log(`Game selesai! ${loser.name} kalah`);

    // 🔥 HITUNG POIN BERDASARKAN URUTAN
    const pointsTable = [10, 7, 5, 3]; // bisa adjust

    game.outOrder.forEach((playerIndex, rank) => {
      const player = game.players[playerIndex];
      const point = pointsTable[rank] || 1;

      if (!game.leaderboard[player.name]) {
        game.leaderboard[player.name] = { win: 0, lose: 0, point: 0 };
      }

      game.leaderboard[player.name].win += 1;
      game.leaderboard[player.name].point += point;
    });

    // ❌ loser
    if (!game.leaderboard[loser.name]) {
      game.leaderboard[loser.name] = { win: 0, lose: 0, point: 0 };
    }
    game.leaderboard[loser.name].lose += 1;

    const isMatchEnd = game.roundCount >= game.maxRounds;

    io.to(roomId).emit("gameOver", {
      loserName: loser.name,
      isMatchEnd: isMatchEnd,
    });

    game.started = false;
    return true;
  }

  return false;
}

function nextTurn(game, roomId) {
  // Pemain yang harus main: aktif (tidak out), bukan skipPlayer
  const activePlayers = game.players
    .map((_, i) => i)
    .filter((i) => isActive(game, i) && i !== game.skipPlayer);

  // Pemain yang masih belum main di ronde ini (aktif & belum played)
  const stillNeedToPlay = activePlayers.filter(
    (i) => !game.playersPlayed.has(i)
  );

  if (stillNeedToPlay.length === 0) {
    sendState(game);
    resolveRound(game, roomId);
    return;
  }

  // Cari giliran berikutnya
  let next = game.currentPlayer;
  let attempts = 0;
  do {
    next = (next + 1) % game.players.length;
    attempts++;
    if (attempts > game.players.length) {
      sendState(game);
      resolveRound(game, roomId);
      return;
    }
  } while (
    !isActive(game, next) ||
    game.playersPlayed.has(next) ||
    next === game.skipPlayer
  );

  // 🔥 CEK APAKAH PEMAIN TERJEBAK (STUCK)
  if (isPlayerStuck(game, next)) {
    console.log(`[${roomId}] ${game.players[next].name} auto-skip (stuck: no cards to match/draw/take)`);
    game.playersPlayed.add(next);
    
    // Kirim notifikasi ke UI
    io.to(roomId).emit("toast", { msg: `${game.players[next].name} dilewati karena kartu habis.` });
    
    // Lanjut cari pemain berikutnya secara rekursif
    nextTurn(game, roomId);
    return;
  }

  game.currentPlayer = next;
  sendState(game);
  scheduleBotTurn(game, game._roomId);
}

function resolveRound(game, roomId) {
  let highest = game.controllerCard;

  game.roundCards.forEach((r) => {
    if (!highest || getRank(r.card.value) > getRank(highest.card.value)) {
      highest = r;
    }
  });

  let winnerIndex;
  if (highest) {
    winnerIndex = highest.player;
  } else if (game.lastTakerProvider !== null && game.lastTakerProvider !== undefined) {
    winnerIndex = game.lastTakerProvider;
  } else {
    // Fallback: This should only happen if everyone took the very first card of the match
    winnerIndex = game.controllerPlayer !== null ? game.controllerPlayer : 0;
  }

  // Reset tracker
  game.lastTakerProvider = null;

  // Emit event to clear the table before resetting state
  io.to(roomId).emit("roundResolved", {
    winner: winnerIndex,
    winnerName:
      game.players[winnerIndex]?.name || "Pemain " + (winnerIndex + 1),
    roundCards: game.roundCards,
  });

  game.roundCards = [];
  game.tableHistory = []; // 🔥 Bersihkan meja setelah ronde selesai
  game.playersPlayed.clear();
  game.skipPlayer = null;
  game.controllerCard = null;

  // Jika pemenang ronde sudah isOut (kartu habis = menang), cari pemain aktif berikutnya
  let nextController = winnerIndex;
  if (!isActive(game, winnerIndex)) {
    let attempts = 0;
    do {
      nextController = (nextController + 1) % game.players.length;
      attempts++;
      if (attempts > game.players.length) {
        nextController = winnerIndex; // fallback, seharusnya tidak terjadi
        break;
      }
    } while (!isActive(game, nextController));
  }

  game.controllerPlayer = nextController;
  game.currentPlayer = nextController;
  game.freeMode = true;

  // Short delay before sending next state so clients can show the clear animation
  setTimeout(() => {
    sendState(game);
    scheduleBotTurn(game, game._roomId);
  }, 500);
}

function startGame(game) {
  if (game.roundCount === 0) {
    game.leaderboard = {};
  }

  game.deck = createDeck();
  game.players.forEach((p, playerIdx) => {
    p.cards = [];
    p.isOut = false;
    p.attackCharges = {}; 
    
    // Initialize charges for each opponent
    game.players.forEach((_, targetIdx) => {
      if (targetIdx !== playerIdx) {
        p.attackCharges[targetIdx] = 2;
      }
    });

    console.log(`[Game] Initialized attackCharges for ${p.name} (idx ${playerIdx}):`, p.attackCharges);

    for (let k = 0; k < CARDS_EACH; k++) {
      p.cards.push(game.deck.pop());
    }
  });

  game.tableCard = game.deck.pop();
  game.tableHistory = [game.tableCard]; // Start with the first card
  game.currentSuit = game.tableCard.suit;
  game.roundCount++;

  if (game.nextStarter !== null && game.players[game.nextStarter]) {
    game.currentPlayer = game.nextStarter;
    console.log(`[Game Start] Ronde ${game.roundCount}: Pemenang sebelumnya ${game.players[game.currentPlayer].name} mulai duluan.`);
    game.nextStarter = null; // reset
  } else {
    // FALLBACK: Kartu Tertinggi (untuk Ronde 1)
    let highestVal = -1;
    let highestSuitIdx = 4; // ♠=0, ♥=1, ♦=2, ♣=3

    game.players.forEach((p, i) => {
      p.cards.forEach((c) => {
        const val = getRank(c.value);
        const sIdx = suits.indexOf(c.suit);
        if (val > highestVal || (val === highestVal && sIdx < highestSuitIdx)) {
          highestVal = val;
          highestSuitIdx = sIdx;
          game.currentPlayer = i;
        }
      });
    });
    console.log(`[Game Start] Ronde ${game.roundCount}: Kartu Tertinggi: ${suits[highestSuitIdx]}${highestVal} milik ${game.players[game.currentPlayer].name}`);
  }

  game.controllerPlayer = null;
  game.controllerCard = null;
  game.freeMode = false;
  game.roundCards = [];
  game.outOrder = [];
  game.playersPlayed.clear();
  game.skipPlayer = null;
  game.lastTakerProvider = null;
  game.started = true;
}

// ── SOCKET ────────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  let currentRoom = null;
  let playerIndex = -1;

  // ── JOIN WITH BOT (1v1) ──
  socket.on("joinWithBot", ({ name }) => {
    // Buat room unik per sesi
    const roomId = 'bot_' + socket.id.slice(0, 8);
    currentRoom = roomId;

    if (!rooms.has(roomId)) rooms.set(roomId, makeGame());
    const game = rooms.get(roomId);
    game._roomId = roomId;

    socket.join(roomId);
    playerIndex = 0;

    // Tambah pemain manusia
    game.players.push({
      id: socket.id,
      name: name || 'Pemain',
      cards: [],
      isOut: false,
      isBot: false,
      attackCharges: {},
    });

    // Tambah bot
    const botNames = ['Ada', 'Eva', 'Max', 'Rex', 'Neo'];
    const botName = botNames[Math.floor(Math.random() * botNames.length)] + ' 🤖';
    game.players.push({
      id: BOT_ID,
      name: botName,
      cards: [],
      isOut: false,
      isBot: true,
      attackCharges: {},
    });

    console.log(`[${roomId}] ${name} vs Bot (${botName}) — Game dimulai!`);

    startGame(game);
    sendState(game);

    // Schedule bot turn jika bot duluan
    scheduleBotTurn(game, roomId);
  });

  // ── JOIN ROOM ──
  socket.on("joinRoom", ({ name, room }) => {
    const roomId = (room || "default").trim().toLowerCase();
    currentRoom = roomId;

    if (!rooms.has(roomId)) rooms.set(roomId, makeGame());
    const game = rooms.get(roomId);
    game._roomId = roomId;

    // If game is in progress, reject
    if (game.started) {
      socket.emit("errorMsg", {
        msg: "Game sedang berlangsung, coba room lain.",
      });
      return;
    }

    // If room is full, reject
    if (game.players.length >= MAX_PLAYERS) {
      socket.emit("errorMsg", {
        msg: `Room ${roomId} sudah penuh (maks 4 pemain).`,
      });
      return;
    }

    socket.join(roomId);

    playerIndex = game.players.length;
    game.players.push({
      id: socket.id,
      name: name || "Pemain " + (playerIndex + 1),
      cards: [],
      isOut: false,
      attackCharges: {}, // { targetIndex: charges }
    });

    console.log(
      `[${roomId}] ${name} bergabung (${game.players.length}/${MAX_PLAYERS})`,
    );

    // Notify others
    socket.to(roomId).emit("playerJoined", { name });

    // ALWAYS send state so indices (who is host) are synced
    sendState(game);

    if (game.players.length < MIN_PLAYERS) {
      socket.emit("waitingForPlayers", { count: game.players.length });
    }
  });

  socket.on("checkRoom", ({ room }) => {
    const roomId = (room || "default").trim().toLowerCase();
    const game = rooms.get(roomId);
    if (!game) {
      socket.emit("roomInfo", { exists: false });
    } else {
      socket.emit("roomInfo", { 
        exists: true, 
        hostName: game.players[0] ? game.players[0].name : "Unknown",
        playerCount: game.players.length,
        started: game.started
      });
    }
  });

  socket.on("kickPlayer", ({ targetIndex }) => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || game.started) return;

    // Only host (index 0) can kick
    if (game.players[0].id !== socket.id) return;

    const target = game.players[targetIndex];
    if (!target || target.isBot || targetIndex === 0) return;

    console.log(`[${currentRoom}] Host kicking ${target.name}`);

    // Notify the target
    io.to(target.id).emit("kicked");

    // Remove from room
    game.players.splice(targetIndex, 1);
    
    // Broadcast leave
    io.to(currentRoom).emit("playerLeft", { name: target.name });

    // Send state to everyone
    sendState(game);
  });

  socket.on("getLeaderboard", () => {
    const game = rooms.get(currentRoom);
    // ✅ TUNTUTAN USER: Hanya tampilkan pemain yang sedang ada di room ini (biar gak global/nyampur)
    const currentNames = game.players.map(p => p.name);
    
    const sorted = Object.entries(game.leaderboard)
      .filter(([name]) => currentNames.includes(name))
      .map(([name, data]) => ({
        name,
        win: data.win,
        lose: data.lose,
        point: data.point,
      }))
      .sort((a, b) => b.point - a.point);

    socket.emit("leaderboardData", sorted);
  });

  socket.on("setMaxRounds", (rounds) => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || game.started) return;

    // Hanya host (index 0) yang bisa ubah
    if (game.players[0].id !== socket.id) return;

    const r = parseInt(rounds);
    if (r >= 1 && r <= 20) {
      game.maxRounds = r;
      sendState(game);
    }
  });

  socket.on("takeTableCard", () => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || !game.started) return;

    // ✅ TUNTUTAN USER: Pastikan meja memang ada kartunya sebelum diolah
    if (!game.tableHistory || game.tableHistory.length === 0) {
      return;
    }

    const pIndex = game.players.findIndex((p) => p.id === socket.id);
    if (game.currentPlayer !== pIndex) {
      console.log(`[${currentRoom}] Unauthorized: ${socket.id} mencoba ambil kartu meja padahal bukan gilirannya!`);
      return;
    }

    console.log(`[${currentRoom}] ${game.players[pIndex].name} mencoba ambil kartu meja. freeMode: ${game.freeMode}, currentSuit: ${game.currentSuit}`);

    // ✅ TUNTUTAN USER: Gak boleh ambil kalau lagi freeMode (dia pemimpin round)
    if (game.freeMode) {
      socket.emit("errorMsg", { msg: "Anda adalah pemimpin putaran, wajib mengeluarkan kartu." });
      return;
    }

    // ✅ TUNTUTAN USER: Gak boleh ambil kalau punya kartu yang cocok (suit sama)
    const p = game.players[pIndex];
    if (game.currentSuit) {
        const hasSuit = p.cards.some((c) => c.suit === game.currentSuit);
        if (hasSuit) {
            socket.emit("errorMsg", { msg: "Anda punya kartu yang cocok, silakan keluarkan kartu." });
            return;
        }
    }

    if (game.deck.length > 0) {
      socket.emit("errorMsg", { msg: "Deck masih ada kartu, silakan ambil dari deck dulu." });
      return;
    }

    resolveTableTake(game, pIndex, currentRoom);
  });

  socket.on("sendEmoji", (data) => {
    if (!currentRoom) return;

    const game = rooms.get(currentRoom);
    if (!game) return;

    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;

    io.to(currentRoom).emit("emoji", {
      name: player.name,
      emoji: data.emoji,
      text: data.text
    });
  });

  socket.on("attackPlayer", ({ targetIndex }) => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || !game.started) return;

    const attackerIndex = game.players.findIndex(p => p.id === socket.id);
    if (attackerIndex === -1) return;

    const attacker = game.players[attackerIndex];
    if (!attacker.attackCharges || (attacker.attackCharges[targetIndex] || 0) <= 0) {
      socket.emit("errorMsg", { msg: "Jatah serangan ke pemain ini habis!" });
      return;
    }

    const target = game.players[targetIndex];
    if (!target) return;

    attacker.attackCharges[targetIndex]--;
    
    // Broadcast attack event
    io.to(currentRoom).emit("playerAttacked", {
      attackerIndex,
      targetIndex,
      attackerName: attacker.name,
      targetName: target.name
    });

    // Also update state to sync charges (optional, but good for UI)
    sendState(game);
  });

  socket.on("chat", (msg) => {
    if (!currentRoom) return;

    const game = rooms.get(currentRoom);
    if (!game) return;

    const p = game.players.find(pl => pl.id === socket.id);
    if (!p) return;

    io.to(currentRoom).emit("chat", {
      name: p.name,
      msg
    });
  });

  // ── START GAME (Manual) ──
  socket.on("startGame", () => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || game.started) return;

    // Host is game.players[0]
    if (game.players[0].id !== socket.id) {
      console.log(
        `[${currentRoom}] Rejek startGame: Pemain id ${socket.id} bukan host.`,
      );
      socket.emit("errorMsg", {
        msg: "Hanya host yang bisa memulai permainan.",
      });
      return;
    }

    if (game.players.length < MIN_PLAYERS) {
      console.log(
        `[${currentRoom}] Rejek startGame: Pemain kurang (${game.players.length}/${MIN_PLAYERS}).`,
      );
      socket.emit("errorMsg", {
        msg: `Butuh minimal ${MIN_PLAYERS} pemain untuk memulai.`,
      });
      return;
    }

    startGame(game);
    sendState(game);
    console.log(`[${currentRoom}] Game dimulai secara manual oleh Host`);
  });

// ── PLAY CARD ──
  socket.on("playCard", ({ index, cardId }) => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || !game.started) return;

    const i = game.players.findIndex((p) => p.id === socket.id);
    if (i !== game.currentPlayer) return;
    if (!isActive(game, i)) return;

    const player = game.players[i];

    // Cari kartu berdasarkan cardId (value|suit) untuk hindari race condition index
    let resolvedIndex = index;
    if (cardId) {
      const [cv, cs] = cardId.split('|');
      const found = player.cards.findIndex(c => c.value === cv && c.suit === cs);
      if (found !== -1) resolvedIndex = found;
    }

    const card = player.cards[resolvedIndex];
    if (!card) return;

    // CONTROLLER FREE PLAY
    if (game.freeMode && i === game.controllerPlayer) {
      player.cards.splice(resolvedIndex, 1);

      game.currentSuit = card.suit;
      game.tableCard = card;
      game.tableHistory.push(card);

      game.controllerCard = { player: i, card };
      game.freeMode = false;
      game.skipPlayer = i;

      if (checkEnd(game, currentRoom)) return;
      nextTurn(game, currentRoom);
      return;
    }

    // INVALID SUIT
    if (card.suit !== game.currentSuit) return;

    player.cards.splice(resolvedIndex, 1);

    // ✅ TUNTUTAN USER: Cek apakah kartu baru lebih tinggi dari kartu tertinggi di meja
    if (!game.controllerCard || getRank(card.value) > getRank(game.controllerCard.card.value)) {
      game.controllerPlayer = i;
      game.controllerCard = { player: i, card };
    }

    game.roundCards.push({ player: i, card });
    game.playersPlayed.add(i);
    game.tableCard = card;
    game.tableHistory.push(card);

    if (checkEnd(game, currentRoom)) return;
    nextTurn(game, currentRoom);
  });

  // ── DRAW CARD ──
  socket.on("drawCard", () => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || !game.started) return;

    const i = game.players.findIndex((p) => p.id === socket.id);
    if (i !== game.currentPlayer) return;

    const p = game.players[i];

    // ✅ TUNTUTAN USER: Pemimpin tidak boleh ambil kartu (baik dari deck maupun meja)
    if (game.freeMode) {
      socket.emit("errorMsg", { msg: "Anda adalah pemimpin putaran, wajib mengeluarkan kartu." });
      return;
    }

    if (game.currentSuit) {
        const hasSuit = p.cards.some((c) => c.suit === game.currentSuit);
        if (hasSuit) {
          socket.emit("errorMsg", { msg: "Anda punya kartu yang cocok, silakan keluarkan kartu." });
          return;
        }
    }

    // ✅ Normal draw dari deck
    if (game.deck.length > 0) {
      p.cards.push(game.deck.pop());
      sendState(game);
      return;
    }

    resolveTableTake(game, i, currentRoom);
  });


  // ── RESTART ──
  socket.on("restartGame", () => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game) return;

    // ✅ CEK HOST
    if (game.players[0].id !== socket.id) {
      socket.emit("errorMsg", {
        msg: "Hanya host yang bisa memulai ulang permainan.",
      });
      return;
    }

    if (game.players.length < MIN_PLAYERS) return;

    // 🔥 NEW: Reset Match jika sudah selesai
    const isMatchEnd = game.roundCount >= game.maxRounds || game.roundCount === 0;
    if (isMatchEnd) {
        console.log(`[${currentRoom}] Match Reset: Resetting roundCount and leaderboard.`);
        game.roundCount = 0;
        game.leaderboard = {};
        // Notify everyone that leaderboard is now empty
        io.to(currentRoom).emit("leaderboardData", []);
    }

    startGame(game);
    sendState(game);
    scheduleBotTurn(game, currentRoom); 

    console.log(`[${currentRoom}] Game di-restart oleh HOST (Ronde: ${game.roundCount})`);
  });

  // ── DISCONNECT ──
  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game) return;

    const p = game.players.find((pl) => pl.id === socket.id);
    const name = p ? p.name : "Pemain";

    game.players = game.players.filter((pl) => pl.id !== socket.id);
    game.started = false;

    io.to(currentRoom).emit("playerLeft", { name });

    // Clean empty rooms
    if (game.players.length === 0) {
      rooms.delete(currentRoom);
      console.log(`[${currentRoom}] Room dihapus`);
    } else {
      console.log(
        `[${currentRoom}] ${name} keluar (${game.players.length} pemain tersisa)`,
      );
      sendState(game);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));