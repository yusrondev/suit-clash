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

function createDeck() {
  const d = [];
  suits.forEach((s) => values.forEach((v) => d.push({ value: v, suit: s })));
  return d.sort(() => Math.random() - 0.5);
}

// ── ROOMS ─────────────────────────────────────────────────────────────────────
// rooms: Map<roomId, GameState>
const rooms = new Map();

// GLOBAL LEADERBOARD
// (Removed global leaderboard for room-specific implementation)

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
    nextStarter: null,
  };
}

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const CARDS_EACH = 4;

// ── HELPERS ───────────────────────────────────────────────────────────────────
function isActive(game, i) {
  return game.players[i] && !game.players[i].isOut;
}

function sendState(game) {
  game.players.forEach((p, i) => {
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

    const isMatchEnd = game.roundCount >= 7;

    io.to(roomId).emit("gameOver", {
      loserName: loser.name,
      isMatchEnd: isMatchEnd,
    });

    if (isMatchEnd) {
      game.roundCount = 0; // reset match
    }

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
    resolveRound(game, roomId);
    return;
  }

  // Cari giliran berikutnya: harus aktif, belum main, bukan skipPlayer
  let next = game.currentPlayer;
  let attempts = 0;
  do {
    next = (next + 1) % game.players.length;
    attempts++;
    if (attempts > game.players.length) {
      // Safety: tidak ada yang bisa main, resolve saja
      resolveRound(game, roomId);
      return;
    }
  } while (
    !isActive(game, next) ||
    game.playersPlayed.has(next) ||
    next === game.skipPlayer
  );

  game.currentPlayer = next;
  sendState(game);
}

function resolveRound(game, roomId) {
  let highest = game.controllerCard;

  game.roundCards.forEach((r) => {
    if (!highest || getRank(r.card.value) > getRank(highest.card.value)) {
      highest = r;
    }
  });

  const winnerIndex = highest.player;

  // Emit event to clear the table before resetting state
  io.to(roomId).emit("roundResolved", {
    winner: winnerIndex,
    winnerName:
      game.players[winnerIndex]?.name || "Pemain " + (winnerIndex + 1),
    roundCards: game.roundCards,
  });

  game.roundCards = [];
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
  setTimeout(() => sendState(game), 1200);
}

function startGame(game) {
  game.deck = createDeck();
  game.players.forEach((p) => {
    p.cards = [];
    p.isOut = false; // ✅ RESET DI SINI (INI YANG KURANG)

    for (let i = 0; i < CARDS_EACH; i++) {
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
  game.started = true;
}

// ── SOCKET ────────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  let currentRoom = null;
  let playerIndex = -1;

  // ── JOIN ROOM ──
  socket.on("joinRoom", ({ name, room }) => {
    const roomId = (room || "default").trim().toLowerCase();
    currentRoom = roomId;

    if (!rooms.has(roomId)) rooms.set(roomId, makeGame());
    const game = rooms.get(roomId);

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

  socket.on("getLeaderboard", () => {
    const game = rooms.get(currentRoom);
    if (!game) return;

    const sorted = Object.entries(game.leaderboard)
      .map(([name, data]) => ({
        name,
        win: data.win,
        lose: data.lose,
        point: data.point,
      }))
      .sort((a, b) => b.point - a.point);

    socket.emit("leaderboardData", sorted);
  });

  socket.on("takeTableCard", () => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game || !game.started) return;

    const pIndex = game.players.findIndex((p) => p.id === socket.id);
    if (game.currentPlayer !== pIndex) return;

    if (game.deck.length > 0) {
      socket.emit("errorMsg", { msg: "Deck masih ada kartu, silakan ambil dari deck." });
      return;
    }

    handleEmptyDeckTake(game, pIndex, currentRoom);
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

    const hasSuit = p.cards.some((c) => c.suit === game.currentSuit);
    if (hasSuit) return;

    // ✅ Normal draw dari deck
    if (game.deck.length > 0) {
      p.cards.push(game.deck.pop());
      sendState(game);
      return;
    }

    handleEmptyDeckTake(game, i, currentRoom);
  });

  // HELPER: Saat pemain tidak bisa jalan & deck habis
  function handleEmptyDeckTake(game, pIndex, currentRoom) {
    if (game.tableHistory.length === 0) return;

    const p = game.players[pIndex];
    const takenCard = game.tableHistory.pop();
    if (!takenCard) return;

    p.cards.push(takenCard);

    // ✅ Reset Meja & Suit
    game.tableCard = null;
    game.currentSuit = null;
    game.roundCards = [];
    game.playersPlayed.clear();
    game.skipPlayer = null;

    // ✅ MASUK FREE MODE - Pemain berikutnya (atau tetap controller) bisa buang kartu apa saja
    game.freeMode = true;

    // Tentukan siapa yang jalan selanjutnya (Pemain berikutnya searah jarum jam)
    let nextI = (pIndex + 1) % game.players.length;
    while (!isActive(game, nextI)) {
      nextI = (nextI + 1) % game.players.length;
    }

    game.controllerPlayer = nextI;
    game.currentPlayer = nextI;
    game.controllerCard = null;

    io.to(currentRoom).emit("toast", {
      msg: `${p.name} mengambil kartu meja. Putaran di-reset!`,
    });
    sendState(game);
  }

  // ── REORDER CARD IN HAND ──
  socket.on("reorderCardHand", ({ fromIndex, toIndex }) => {
    if (!currentRoom) return;
    const game = rooms.get(currentRoom);
    if (!game) return;

    const i = game.players.findIndex((p) => p.id === socket.id);
    if (i === -1) return;

    const player = game.players[i];
    if (
      fromIndex < 0 ||
      fromIndex >= player.cards.length ||
      toIndex < 0 ||
      toIndex >= player.cards.length
    )
      return;

    console.log(
      `[${currentRoom}] Reordering card from ${fromIndex} to ${toIndex} for ${player.name}`,
    );
    const [movedCard] = player.cards.splice(fromIndex, 1);
    player.cards.splice(toIndex, 0, movedCard);

    sendState(game);
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

    startGame(game);
    sendState(game);

    console.log(`[${currentRoom}] Game di-restart oleh HOST`);
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