require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const mongoose = require("mongoose");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 5 * 60 * 1000,
    skipMiddlewares: true
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const BOARD_SIZE = 15;
const DISCONNECT_GRACE_PERIOD_MS = 60 * 1000;
const GLOBAL_MESSAGE_STORAGE_LIMIT = 100;
const GLOBAL_MESSAGE_HISTORY_LIMIT = 100;
const ROOM_MESSAGE_HISTORY_LIMIT = 50;

// =====================================================
// MongoDB
// =====================================================
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB Atlas 連線成功"))
  .catch((error) => {
    console.error("❌ MongoDB Atlas 連線失敗");
    console.error(error.message);
  });

const gameSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true },
    previousRoomId: { type: String, default: null },
    round: { type: Number, default: 1 },
    players: [
      {
        socketId: String,
        name: String,
        color: String
      }
    ],
    board: {
      type: [Number],
      default: () => Array(BOARD_SIZE * BOARD_SIZE).fill(0)
    },
    currentTurn: { type: String, default: "black" },
    status: {
      type: String,
      enum: ["playing", "finished"],
      default: "playing"
    },
    winner: { type: String, default: null },
    moves: [
      {
        x: Number,
        y: Number,
        color: String,
        playerName: String,
        createdAt: { type: Date, default: Date.now }
      }
    ]
  },
  { timestamps: true }
);

const playerStatsSchema = new mongoose.Schema(
  {
    normalizedName: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    points: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    draws: { type: Number, default: 0 },
    gamesPlayed: { type: Number, default: 0 }
  },
  { timestamps: true, collection: "players" }
);

const globalMessageSchema = new mongoose.Schema(
  {
    playerName: { type: String, required: true, trim: true, maxlength: 20 },
    message: { type: String, required: true, trim: true, maxlength: 120 },
    createdAt: { type: Date, default: Date.now, index: true }
  },
  { versionKey: false, collection: "global_messages" }
);

const Game = mongoose.model("Game", gameSchema);
const PlayerStats = mongoose.model("PlayerStats", playerStatsSchema);
const GlobalMessage = mongoose.model("GlobalMessage", globalMessageSchema);

// =====================================================
// 記憶體中的即時狀態
// =====================================================
const waitingPlayers = [];
const waitingPrivateRooms = new Map();
const rooms = new Map();

// =====================================================
// 通用函式
// =====================================================
function cleanPlayerName(name) {
  return String(name || "").trim().slice(0, 20);
}

function normalizePlayerName(name) {
  return cleanPlayerName(name).toLowerCase();
}

function cleanChatMessage(message) {
  return String(message || "").trim().slice(0, 120);
}

function cleanToken(token) {
  return String(token || "").trim().slice(0, 120);
}

function generateRoomId() {
  return `ROOM-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function generatePrivateRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (waitingPrivateRooms.has(code));
  return code;
}

function removeFromWaitingQueue(socketId) {
  const index = waitingPlayers.findIndex((player) => player.socketId === socketId);
  if (index !== -1) waitingPlayers.splice(index, 1);
}

function removePrivateRoomBySocketId(socketId) {
  for (const [code, room] of waitingPrivateRooms.entries()) {
    if (room.creator.socketId === socketId) {
      waitingPrivateRooms.delete(code);
      return code;
    }
  }
  return null;
}

function clearWaitingState(socketId) {
  removeFromWaitingQueue(socketId);
  removePrivateRoomBySocketId(socketId);
}

function getBoardIndex(x, y) {
  return y * BOARD_SIZE + x;
}

function isValidPosition(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
}

function getOppositeColor(color) {
  return color === "black" ? "white" : "black";
}

function getPlayerBySocketId(room, socketId) {
  return room.players.find((player) => player.socketId === socketId);
}

function getPlayerByToken(room, playerToken) {
  return room.players.find((player) => player.playerToken === playerToken);
}

function getOpponent(room, player) {
  return room.players.find((item) => item.playerToken !== player.playerToken);
}

function safeRoomPlayers(room) {
  return room.players.map((player) => ({
    socketId: player.socketId,
    name: player.name,
    color: player.color
  }));
}

function clearPlayerDisconnectTimer(player) {
  if (player?.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }
}

function clearRoomDisconnectTimers(room) {
  room.players.forEach(clearPlayerDisconnectTimer);
}

function checkWin(board, x, y, stoneValue) {
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1]
  ];

  for (const [dx, dy] of directions) {
    let count = 1;
    let nextX = x + dx;
    let nextY = y + dy;

    while (isValidPosition(nextX, nextY) && board[getBoardIndex(nextX, nextY)] === stoneValue) {
      count += 1;
      nextX += dx;
      nextY += dy;
    }

    nextX = x - dx;
    nextY = y - dy;

    while (isValidPosition(nextX, nextY) && board[getBoardIndex(nextX, nextY)] === stoneValue) {
      count += 1;
      nextX -= dx;
      nextY -= dy;
    }

    if (count >= 5) return true;
  }

  return false;
}

function buildRoomState(room) {
  const lastMove = room.moves.at(-1) || null;

  return {
    roomId: room.roomId,
    round: room.round,
    board: room.board,
    players: room.players.map((player) => ({
      name: player.name,
      color: player.color,
      connected: player.connected
    })),
    currentTurn: room.currentTurn,
    status: room.status,
    winner: room.winner,
    moveCount: room.moves.length,
    lastMoveColor: lastMove?.color || null,
    lastMove: lastMove
      ? { x: lastMove.x, y: lastMove.y, color: lastMove.color }
      : null,
    undoPending: Boolean(room.undoRequest)
  };
}

function emitSystemRoomMessage(room, message) {
  const chatMessage = {
    type: "system",
    message,
    createdAt: new Date().toISOString()
  };

  room.chatMessages.push(chatMessage);
  if (room.chatMessages.length > ROOM_MESSAGE_HISTORY_LIMIT) room.chatMessages.shift();
  io.to(room.roomId).emit("chatMessage", chatMessage);
}

// =====================================================
// 公開聊天室 MongoDB
// =====================================================
async function getRecentGlobalMessages() {
  const messages = await GlobalMessage.find({})
    .sort({ createdAt: -1, _id: -1 })
    .limit(GLOBAL_MESSAGE_HISTORY_LIMIT)
    .lean();

  return messages.reverse().map((item) => ({
    id: String(item._id),
    type: "player",
    playerName: item.playerName,
    message: item.message,
    createdAt: item.createdAt
  }));
}

async function trimOldGlobalMessages() {
  const total = await GlobalMessage.countDocuments();
  const excess = total - GLOBAL_MESSAGE_STORAGE_LIMIT;
  if (excess <= 0) return;

  const oldMessages = await GlobalMessage.find({})
    .sort({ createdAt: 1, _id: 1 })
    .limit(excess)
    .select({ _id: 1 })
    .lean();

  if (oldMessages.length === 0) return;

  await GlobalMessage.deleteMany({
    _id: { $in: oldMessages.map((item) => item._id) }
  });

  console.log(`🧹 已刪除 ${oldMessages.length} 則過舊公開訊息`);
}

// =====================================================
// 排行榜
// =====================================================
async function getLeaderboard() {
  return PlayerStats.find({})
    .sort({ points: -1, wins: -1, gamesPlayed: 1, updatedAt: 1 })
    .limit(10)
    .lean();
}

async function broadcastLeaderboard() {
  io.emit("leaderboardUpdated", await getLeaderboard());
}

async function updatePlayerStats(name, increments) {
  await PlayerStats.updateOne(
    { normalizedName: normalizePlayerName(name) },
    {
      $set: { displayName: cleanPlayerName(name) },
      $inc: increments
    },
    { upsert: true }
  );
}

async function recordResult(room, winnerColor) {
  if (room.scoreRecorded) return;
  room.scoreRecorded = true;

  const black = room.players.find((player) => player.color === "black");
  const white = room.players.find((player) => player.color === "white");
  if (!black || !white) return;

  if (winnerColor === "draw") {
    await updatePlayerStats(black.name, { points: 1, draws: 1, gamesPlayed: 1 });
    await updatePlayerStats(white.name, { points: 1, draws: 1, gamesPlayed: 1 });
  } else {
    const winner = winnerColor === "black" ? black : white;
    const loser = winnerColor === "black" ? white : black;
    await updatePlayerStats(winner.name, { points: 3, wins: 1, gamesPlayed: 1 });
    await updatePlayerStats(loser.name, { losses: 1, gamesPlayed: 1 });
  }

  await broadcastLeaderboard();
}

// =====================================================
// 建立遊戲與再戰
// =====================================================
async function startGame(player1, player2, previousRoomId = null, round = 1, previousChatMessages = []) {
  const roomId = generateRoomId();
  const room = {
    roomId,
    previousRoomId,
    round,
    board: Array(BOARD_SIZE * BOARD_SIZE).fill(0),
    players: [
      {
        socketId: player1.socketId,
        socket: player1.socket,
        playerToken: player1.playerToken,
        name: player1.name,
        color: "black",
        connected: true,
        disconnectTimer: null
      },
      {
        socketId: player2.socketId,
        socket: player2.socket,
        playerToken: player2.playerToken,
        name: player2.name,
        color: "white",
        connected: true,
        disconnectTimer: null
      }
    ],
    currentTurn: "black",
    status: "playing",
    winner: null,
    moves: [],
    chatMessages: previousChatMessages.slice(-ROOM_MESSAGE_HISTORY_LIMIT),
    undoRequest: null,
    rematchVotes: new Set(),
    rematchStarting: false,
    scoreRecorded: false
  };

  rooms.set(roomId, room);

  for (const player of room.players) {
    player.socket.join(roomId);
    player.socket.data.roomId = roomId;
    player.socket.data.playerToken = player.playerToken;
    player.socket.data.displayName = player.name;
  }

  await Game.create({
    roomId,
    previousRoomId,
    round,
    players: safeRoomPlayers(room),
    board: room.board,
    currentTurn: room.currentTurn,
    status: room.status,
    winner: room.winner,
    moves: []
  });

  io.to(room.players[0].socketId).emit("gameStarted", { roomId, myColor: "black", round });
  io.to(room.players[1].socketId).emit("gameStarted", { roomId, myColor: "white", round });
  io.to(roomId).emit("gameState", buildRoomState(room));
  emitSystemRoomMessage(room, `第 ${round} 局開始，黑棋先行。`);

  console.log(`🎮 房間建立成功：${roomId}`);
  return room;
}

async function startRematch(oldRoom) {
  const oldRoomId = oldRoom.roomId;
  const orderedPlayers = oldRoom.players
    .map((player) => ({
      socketId: player.socketId,
      socket: io.sockets.sockets.get(player.socketId),
      playerToken: player.playerToken,
      name: player.name,
      oldColor: player.color
    }))
    .sort((a, b) => (a.oldColor === "white" ? -1 : 1));

  if (orderedPlayers.some((player) => !player.socket)) {
    throw new Error("其中一位玩家已離線");
  }

  orderedPlayers.forEach((player) => player.socket.leave(oldRoomId));
  const newRoom = await startGame(
    orderedPlayers[0],
    orderedPlayers[1],
    oldRoomId,
    (oldRoom.round || 1) + 1,
    oldRoom.chatMessages
  );

  io.to(newRoom.roomId).emit("rematchStartedNotice", { round: newRoom.round });
  rooms.delete(oldRoomId);
  clearRoomDisconnectTimers(oldRoom);
}

async function finalizeDisconnectedRoom(room, disconnectedPlayer) {
  if (!rooms.has(room.roomId) || disconnectedPlayer.connected) return;

  const opponent = getOpponent(room, disconnectedPlayer);

  if (room.status === "playing") {
    room.status = "finished";
    room.winner = getOppositeColor(disconnectedPlayer.color);

    await Game.updateOne(
      { roomId: room.roomId },
      { $set: { status: room.status, winner: room.winner } }
    );

    await recordResult(room, room.winner);
  }

  if (opponent?.socketId) {
    io.to(opponent.socketId).emit("opponentDisconnected", {
      winner: room.winner,
      message: `${disconnectedPlayer.name} 離線超過 60 秒，遊戲已結束。`
    });
  }

  clearRoomDisconnectTimers(room);
  rooms.delete(room.roomId);
  console.log(`❌ 玩家離線逾時：${disconnectedPlayer.name}`);
}

// =====================================================
// Socket.IO
// =====================================================
io.on("connection", (socket) => {
  console.log(`🔌 玩家連線：${socket.id}`);

  socket.on("clientHeartbeat", (_data, callback) => {
    if (typeof callback === "function") callback({ success: true, serverTime: Date.now() });
  });

  socket.on("getLeaderboard", async () => {
    try {
      socket.emit("leaderboardUpdated", await getLeaderboard());
    } catch (error) {
      console.error("❌ 讀取排行榜失敗：", error.message);
    }
  });

  socket.on("getGlobalChatHistory", async () => {
    try {
      socket.emit("globalChatHistory", await getRecentGlobalMessages());
    } catch (error) {
      console.error("❌ 讀取公開聊天室失敗：", error.message);
      socket.emit("errorMessage", "公開聊天室載入失敗，請稍後再試");
    }
  });

  socket.on("sendGlobalChatMessage", async (data) => {
    const now = Date.now();
    if (now - (socket.data.lastGlobalChatAt || 0) < 700) {
      socket.emit("errorMessage", "訊息傳送過快，請稍候再試");
      return;
    }

    const playerName = cleanPlayerName(socket.data.displayName || data?.name);
    const message = cleanChatMessage(data?.message);
    if (!playerName) return socket.emit("errorMessage", "請先輸入玩家名稱");
    if (!message) return;

    socket.data.displayName = playerName;
    socket.data.lastGlobalChatAt = now;

    try {
      const saved = await GlobalMessage.create({ playerName, message });
      await trimOldGlobalMessages();
      io.emit("globalChatMessage", {
        id: String(saved._id),
        type: "player",
        playerName: saved.playerName,
        message: saved.message,
        createdAt: saved.createdAt
      });
    } catch (error) {
      console.error("❌ 儲存公開聊天室訊息失敗：", error.message);
      socket.emit("errorMessage", "訊息傳送失敗，請稍後再試");
    }
  });

  socket.on("joinQueue", async (data) => {
    const name = cleanPlayerName(data?.name);
    const playerToken = cleanToken(data?.playerToken);
    if (!name) return socket.emit("errorMessage", "請先輸入玩家名稱");
    if (!playerToken) return socket.emit("errorMessage", "玩家識別碼遺失，請重新整理頁面");

    clearWaitingState(socket.id);
    socket.data.displayName = name;
    socket.data.playerToken = playerToken;

    waitingPlayers.push({ socketId: socket.id, socket, name, playerToken });
    socket.emit("queueStatus", { message: "等待另一位玩家加入..." });

    if (waitingPlayers.length >= 2) {
      const player1 = waitingPlayers.shift();
      const player2 = waitingPlayers.shift();
      try {
        await startGame(player1, player2);
      } catch (error) {
        console.error("❌ 建立遊戲失敗：", error.message);
        io.to(player1.socketId).emit("errorMessage", "建立遊戲失敗，請重新配對");
        io.to(player2.socketId).emit("errorMessage", "建立遊戲失敗，請重新配對");
      }
    }
  });

  socket.on("createPrivateRoom", (data) => {
    const name = cleanPlayerName(data?.name);
    const playerToken = cleanToken(data?.playerToken);
    if (!name) return socket.emit("privateRoomError", "請先輸入玩家名稱");
    if (!playerToken) return socket.emit("privateRoomError", "玩家識別碼遺失，請重新整理頁面");

    clearWaitingState(socket.id);
    const roomCode = generatePrivateRoomCode();
    waitingPrivateRooms.set(roomCode, {
      roomCode,
      creator: { socketId: socket.id, socket, name, playerToken },
      createdAt: Date.now()
    });

    socket.data.displayName = name;
    socket.data.playerToken = playerToken;
    socket.data.privateRoomCode = roomCode;
    socket.emit("privateRoomCreated", { roomCode });
  });

  socket.on("joinPrivateRoom", async (data) => {
    const name = cleanPlayerName(data?.name);
    const playerToken = cleanToken(data?.playerToken);
    const roomCode = String(data?.roomCode || "").trim();

    if (!name) return socket.emit("privateRoomError", "請先輸入玩家名稱");
    if (!playerToken) return socket.emit("privateRoomError", "玩家識別碼遺失，請重新整理頁面");
    if (!/^\d{4}$/.test(roomCode)) return socket.emit("privateRoomError", "請輸入正確的 4 位數房號");

    const privateRoom = waitingPrivateRooms.get(roomCode);
    if (!privateRoom) return socket.emit("privateRoomError", "找不到此房間，請確認房號是否正確");
    if (privateRoom.creator.socketId === socket.id) return socket.emit("privateRoomError", "不能加入自己建立的房間");
    if (!io.sockets.sockets.get(privateRoom.creator.socketId)) {
      waitingPrivateRooms.delete(roomCode);
      return socket.emit("privateRoomError", "房間建立者已離線");
    }

    clearWaitingState(socket.id);
    waitingPrivateRooms.delete(roomCode);
    privateRoom.creator.socket.data.privateRoomCode = null;
    socket.data.displayName = name;
    socket.data.playerToken = playerToken;

    try {
      await startGame(privateRoom.creator, { socketId: socket.id, socket, name, playerToken });
    } catch (error) {
      console.error("❌ 私人房間開始失敗：", error.message);
      io.to(privateRoom.creator.socketId).emit("privateRoomError", "建立對局失敗，請重新建立房間");
      socket.emit("privateRoomError", "加入對局失敗，請重新嘗試");
    }
  });

  socket.on("cancelPrivateRoom", () => {
    removePrivateRoomBySocketId(socket.id);
    socket.data.privateRoomCode = null;
    socket.emit("privateRoomCancelled");
  });

  socket.on("resumeGame", (data) => {
    const roomId = String(data?.roomId || "").trim();
    const playerToken = cleanToken(data?.playerToken);
    if (!roomId || !playerToken) return socket.emit("resumeGameFailed", "恢復資料不完整，請返回首頁重新配對。");

    const room = rooms.get(roomId);
    if (!room) return socket.emit("resumeGameFailed", "原本房間已不存在，可能是伺服器重新啟動，請返回首頁重新配對。");

    const player = getPlayerByToken(room, playerToken);
    if (!player) return socket.emit("resumeGameFailed", "無法確認玩家身分，請返回首頁重新配對。");

    clearPlayerDisconnectTimer(player);
    player.socketId = socket.id;
    player.socket = socket;
    player.connected = true;
    socket.data.roomId = roomId;
    socket.data.playerToken = playerToken;
    socket.data.displayName = player.name;
    socket.join(roomId);

    socket.emit("gameResumed", { roomId, myColor: player.color, status: room.status, round: room.round });
    socket.emit("gameState", buildRoomState(room));
    socket.emit("chatHistory", room.chatMessages);
    emitSystemRoomMessage(room, `${player.name} 已重新連線。`);
  });

  socket.on("makeMove", async (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return socket.emit("errorMessage", "找不到目前的遊戲房間");
    if (room.status !== "playing") return socket.emit("errorMessage", "這場遊戲已經結束");
    if (room.undoRequest) return socket.emit("errorMessage", "請先完成悔棋處理");

    const x = Number(data?.x);
    const y = Number(data?.y);
    if (!isValidPosition(x, y)) return socket.emit("errorMessage", "落子位置錯誤");

    const player = getPlayerBySocketId(room, socket.id);
    if (!player) return socket.emit("errorMessage", "您不是這個房間的玩家");
    if (room.currentTurn !== player.color) return socket.emit("errorMessage", "現在還沒輪到您");

    const index = getBoardIndex(x, y);
    if (room.board[index] !== 0) return socket.emit("errorMessage", "這個位置已經有棋子");

    const stoneValue = player.color === "black" ? 1 : 2;
    room.board[index] = stoneValue;
    const move = { x, y, color: player.color, playerName: player.name, createdAt: new Date() };
    room.moves.push(move);

    const isWinner = checkWin(room.board, x, y, stoneValue);
    const isDraw = !isWinner && room.board.every((cell) => cell !== 0);

    if (isWinner) {
      room.status = "finished";
      room.winner = player.color;
    } else if (isDraw) {
      room.status = "finished";
      room.winner = "draw";
    } else {
      room.currentTurn = getOppositeColor(player.color);
    }

    await Game.updateOne(
      { roomId: room.roomId },
      {
        $set: {
          board: room.board,
          currentTurn: room.currentTurn,
          status: room.status,
          winner: room.winner
        },
        $push: { moves: move }
      }
    );

    io.to(room.roomId).emit("gameState", buildRoomState(room));

    if (isWinner || isDraw) {
      await recordResult(room, room.winner);
      io.to(room.roomId).emit("gameOver", { winner: room.winner, winnerName: player.name });
    }
  });

  socket.on("requestUndo", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return socket.emit("errorMessage", "找不到目前的遊戲房間");
    if (room.status !== "playing") return socket.emit("errorMessage", "遊戲結束後無法悔棋");
    if (room.undoRequest) return socket.emit("errorMessage", "目前已有悔棋申請");

    const player = getPlayerBySocketId(room, socket.id);
    const lastMove = room.moves.at(-1);
    if (!player || !lastMove) return socket.emit("errorMessage", "目前沒有可以撤回的棋子");
    if (lastMove.color !== player.color) return socket.emit("errorMessage", "只能撤回自己剛剛落下的最後一步");

    const opponent = getOpponent(room, player);
    room.undoRequest = { requesterToken: player.playerToken, requesterName: player.name };
    io.to(room.roomId).emit("undoStatus", { status: "pending", requesterName: player.name });
    io.to(opponent.socketId).emit("undoRequestReceived", { requesterName: player.name });
  });

  socket.on("respondUndo", async (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room?.undoRequest) return socket.emit("errorMessage", "目前沒有待處理的悔棋申請");

    const player = getPlayerBySocketId(room, socket.id);
    if (!player) return socket.emit("errorMessage", "您不是這個房間的玩家");
    if (room.undoRequest.requesterToken === player.playerToken) return socket.emit("errorMessage", "不能回應自己的悔棋申請");

    const accepted = Boolean(data?.accept);
    room.undoRequest = null;

    if (!accepted) {
      io.to(room.roomId).emit("undoStatus", { status: "resolved" });
      io.to(room.roomId).emit("undoResolved", { accepted: false });
      return;
    }

    const removedMove = room.moves.pop();
    if (!removedMove) return;

    room.board[getBoardIndex(removedMove.x, removedMove.y)] = 0;
    room.currentTurn = removedMove.color;

    await Game.updateOne(
      { roomId: room.roomId },
      {
        $set: { board: room.board, currentTurn: room.currentTurn },
        $pop: { moves: 1 }
      }
    );

    io.to(room.roomId).emit("undoStatus", { status: "resolved" });
    io.to(room.roomId).emit("gameState", buildRoomState(room));
    io.to(room.roomId).emit("undoResolved", { accepted: true });
    emitSystemRoomMessage(room, `${removedMove.playerName} 的最後一步已撤回。`);
  });

  socket.on("sendChatMessage", (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return socket.emit("errorMessage", "請先加入遊戲房間");

    const player = getPlayerBySocketId(room, socket.id);
    const message = cleanChatMessage(data?.message);
    if (!player || !message) return;

    const chatMessage = {
      type: "player",
      playerName: player.name,
      message,
      createdAt: new Date().toISOString()
    };

    room.chatMessages.push(chatMessage);
    if (room.chatMessages.length > ROOM_MESSAGE_HISTORY_LIMIT) room.chatMessages.shift();
    io.to(room.roomId).emit("chatMessage", chatMessage);
  });

  socket.on("requestRematch", async () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return socket.emit("errorMessage", "找不到目前的遊戲房間");
    if (room.status !== "finished") return socket.emit("errorMessage", "目前遊戲尚未結束");

    const player = getPlayerBySocketId(room, socket.id);
    if (!player) return;

    room.rematchVotes.add(player.playerToken);
    io.to(room.roomId).emit("rematchStatus", { accepted: room.rematchVotes.size, total: room.players.length });

    if (room.rematchVotes.size === room.players.length && !room.rematchStarting) {
      room.rematchStarting = true;
      try {
        await startRematch(room);
      } catch (error) {
        room.rematchStarting = false;
        console.error("❌ 再來一局失敗：", error.message);
        io.to(room.roomId).emit("errorMessage", "再來一局失敗，請重新配對");
      }
    }
  });

  socket.on("leaveRoom", async () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    socket.data.roomId = null;
    if (!room) return;

    const leavingPlayer = getPlayerBySocketId(room, socket.id);
    if (!leavingPlayer) return;
    const opponent = getOpponent(room, leavingPlayer);

    socket.leave(roomId);
    clearRoomDisconnectTimers(room);

    if (room.status === "playing") {
      room.status = "finished";
      room.winner = getOppositeColor(leavingPlayer.color);
      await Game.updateOne({ roomId }, { $set: { status: room.status, winner: room.winner } });
      await recordResult(room, room.winner);
      if (opponent?.socketId) {
        io.to(opponent.socketId).emit("opponentDisconnected", {
          winner: room.winner,
          message: `${leavingPlayer.name} 已返回首頁。`
        });
      }
    } else if (opponent?.socketId) {
      io.to(opponent.socketId).emit("rematchUnavailable", {
        message: `${leavingPlayer.name} 已返回首頁，無法再來一局`
      });
    }

    rooms.delete(roomId);
  });

  socket.on("disconnect", () => {
    console.log(`⚠️ 玩家暫時離線：${socket.id}`);
    clearWaitingState(socket.id);

    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    const player = getPlayerBySocketId(room, socket.id);
    if (!player) return;

    player.connected = false;
    clearPlayerDisconnectTimer(player);
    emitSystemRoomMessage(room, `${player.name} 暫時離線，系統將保留房間 60 秒。`);

    player.disconnectTimer = setTimeout(() => {
      finalizeDisconnectedRoom(room, player).catch((error) => {
        console.error("❌ 更新離線結果失敗：", error.message);
      });
    }, DISCONNECT_GRACE_PERIOD_MS);
  });
});

// =====================================================
// API
// =====================================================
app.get("/api/health", (_req, res) => {
  res.json({ success: true, message: "五子棋後端正常運作" });
});

app.get("/api/games", async (_req, res) => {
  try {
    res.json({ success: true, data: await Game.find({}).sort({ createdAt: -1 }).limit(20) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/leaderboard", async (_req, res) => {
  try {
    res.json({ success: true, data: await getLeaderboard() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/global-messages", async (_req, res) => {
  try {
    const messages = await getRecentGlobalMessages();
    res.json({ success: true, count: messages.length, data: messages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server 已啟動");
  console.log(`🌐 本機網址：http://localhost:${PORT}`);
});
