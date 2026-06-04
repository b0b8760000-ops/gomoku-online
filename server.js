require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const mongoose = require("mongoose");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },

  // Socket.IO 自帶的短暫斷線恢復功能。
  // 我們另外仍使用 playerToken + active_rooms，處理 Render 完整重啟後的恢復。
  connectionStateRecovery: {
    maxDisconnectionDuration: 5 * 60 * 1000,
    skipMiddlewares: true
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = Number(process.env.PORT || 3000);
const BOARD_SIZE = 15;
const BOARD_CELL_COUNT = BOARD_SIZE * BOARD_SIZE;

// ==========================================
// 遊戲模式
// ==========================================
const GAME_MODE_STANDARD = "standard";
const GAME_MODE_BATTLE_ROYALE = "battle-royale";
const GAME_MODE_ROTATING_BOARD = "rotating-board";

const VALID_GAME_MODES = [
  GAME_MODE_STANDARD,
  GAME_MODE_BATTLE_ROYALE,
  GAME_MODE_ROTATING_BOARD
];

// 大逃殺模式：每 60 秒或每累積 10 手，任一條件先到就縮一圈。
// 15x15 -> 13x13 -> 11x11 -> 9x9 -> 7x7。
const BATTLE_ROYALE_SHRINK_INTERVAL_MS = 60 * 1000;
const BATTLE_ROYALE_MOVES_PER_SHRINK = 10;
const BATTLE_ROYALE_MIN_BOARD_SIZE = 7;
const BATTLE_ROYALE_ANIMATION_MS = 950;

// 輪盤五子棋：雙方合計每 10 手，整個棋盤順時針旋轉 90 度。
const ROTATING_BOARD_MOVES_PER_ROTATION = 10;
const ROTATING_BOARD_ANIMATION_MS = 900;

// 玩家一般短暫斷線時，保留房間 3 分鐘。
// Render 完整重啟時，則改由 MongoDB active_rooms 恢復。
const DISCONNECT_GRACE_PERIOD_MS = 3 * 60 * 1000;

// 雙方都離線超過 3 分鐘：視為放棄，不計分，直接清除 active_rooms。
// 另外每分鐘掃描一次 MongoDB，避免 Render 重啟造成記憶體計時器消失。
const BOTH_OFFLINE_TIMEOUT_MS = 3 * 60 * 1000;
const ABANDONED_ROOM_CHECK_INTERVAL_MS = 60 * 1000;

// 相容修改前留下的 active_rooms：舊資料沒有 bothOfflineSince。
// 若長時間沒有任何活動，視為殘留房間並清除。
const LEGACY_STALE_ROOM_TIMEOUT_MS = 15 * 60 * 1000;

// active_rooms 24 小時未更新後自動清除。
const ACTIVE_ROOM_TTL_MS = 24 * 60 * 60 * 1000;
// ==========================================
// 觀戰清單只顯示最近仍有活動的房間
//
// active_rooms 仍保留 24 小時供原玩家恢復，
// 但超過 6 分鐘沒有任何玩家心跳的房間，
// 不再顯示於公開觀戰清單。
// ==========================================
const SPECTATABLE_ROOM_VISIBLE_MS =
  6 * 60 * 1000;

// 在線玩家最多每 2 分鐘更新一次 MongoDB 活動時間。
// 不需要每 30 秒心跳都寫入資料庫。
const ROOM_PRESENCE_PERSIST_MS =
  2 * 60 * 1000;

// 聊天限制。
const ROOM_CHAT_LIMIT = 50;
const GLOBAL_CHAT_LOAD_LIMIT = 100;
const GLOBAL_CHAT_STORAGE_LIMIT = 10000;

// 防止聊天室洗版。
const GLOBAL_CHAT_COOLDOWN_MS = 700;
const ROOM_CHAT_COOLDOWN_MS = 500;

// ==========================================
// MongoDB 連線
// ==========================================
if (!process.env.MONGODB_URI) {
  console.error("❌ 缺少 MONGODB_URI，請先建立 .env 或設定 Render Environment Variable");
  process.exit(1);
}

mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log("✅ MongoDB Atlas 連線成功");

    // 啟動時順便清理公開聊天室過舊資料。
    await trimOldGlobalMessages().catch((error) => {
      console.error("⚠️ 啟動時清理公開聊天室失敗：", error.message);
    });

    await cleanupAbandonedRooms().catch((error) => {
      console.error("⚠️ 啟動時清理離線房間失敗：", error.message);
    });
  })
  .catch((error) => {
    console.error("❌ MongoDB Atlas 連線失敗：", error.message);
  });

// ==========================================
// MongoDB：歷史棋譜 games
// ==========================================
const historyPlayerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    color: { type: String, enum: ["black", "white"], required: true }
  },
  { _id: false }
);

const moveSchema = new mongoose.Schema(
  {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    color: { type: String, enum: ["black", "white"], required: true },
    playerName: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    collapsed: { type: Boolean, default: false }
  },
  { _id: false }
);

const gameSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, index: true },
    seriesId: { type: String, required: true, index: true },
    round: { type: Number, default: 1 },
    mode: {
      type: String,
      enum: VALID_GAME_MODES,
      default: GAME_MODE_STANDARD
    },
    shrinkLevel: { type: Number, default: 0 },
    rotationCount: { type: Number, default: 0 },
    activeMin: { type: Number, default: 0 },
    activeMax: { type: Number, default: BOARD_SIZE - 1 },
    players: { type: [historyPlayerSchema], default: [] },
    board: { type: [Number], default: () => Array(BOARD_CELL_COUNT).fill(0) },
    currentTurn: { type: String, enum: ["black", "white"], default: "black" },
    status: { type: String, enum: ["finished"], default: "finished" },
    winner: { type: String, enum: ["black", "white", "draw"], required: true },
    reason: {
      type: String,
      enum: ["five-in-row", "draw", "leave", "disconnect-timeout"],
      required: true
    },
    moves: { type: [moveSchema], default: [] },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: Date.now },

    // 使用原子更新防止重複計分。
    scoreApplied: { type: Boolean, default: false }
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "games"
  }
);

const Game = mongoose.model("Game", gameSchema);

// ==========================================
// MongoDB：排行榜 players
// ==========================================
const playerStatsSchema = new mongoose.Schema(
  {
    normalizedName: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, required: true },
    points: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    draws: { type: Number, default: 0 },
    gamesPlayed: { type: Number, default: 0 }
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "players"
  }
);

const PlayerStats = mongoose.model("PlayerStats", playerStatsSchema);

// ==========================================
// MongoDB：公開聊天室 global_messages
// ==========================================
const globalMessageSchema = new mongoose.Schema(
  {
    playerName: { type: String, required: true, trim: true, maxlength: 20 },
    message: { type: String, required: true, trim: true, maxlength: 120 },
    createdAt: { type: Date, default: Date.now, index: true }
  },
  {
    versionKey: false,
    collection: "global_messages"
  }
);

const GlobalMessage = mongoose.model("GlobalMessage", globalMessageSchema);

// ==========================================
// MongoDB：尚未完成的棋局 active_rooms
// Render 完整重啟後會從這裡恢復。
// ==========================================
const activePlayerSchema = new mongoose.Schema(
  {
    playerToken: { type: String, required: true },
    name: { type: String, required: true },
    color: { type: String, enum: ["black", "white"], required: true }
  },
  { _id: false }
);

const roomMessageSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["player", "system"], default: "player" },
    playerName: { type: String, default: "" },
    message: { type: String, required: true, maxlength: 160 },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const activeRoomSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, index: true },
    seriesId: { type: String, required: true, index: true },
    round: { type: Number, default: 1 },
    mode: {
      type: String,
      enum: VALID_GAME_MODES,
      default: GAME_MODE_STANDARD
    },
    shrinkLevel: { type: Number, default: 0 },
    activeMin: { type: Number, default: 0 },
    activeMax: { type: Number, default: BOARD_SIZE - 1 },
    movesSinceLastShrink: { type: Number, default: 0 },
    nextShrinkAt: { type: Date, default: null },
    rotationCount: { type: Number, default: 0 },
    movesSinceLastRotation: { type: Number, default: 0 },
    players: { type: [activePlayerSchema], default: [] },
    board: { type: [Number], default: () => Array(BOARD_CELL_COUNT).fill(0) },
    currentTurn: { type: String, enum: ["black", "white"], default: "black" },
    status: { type: String, enum: ["playing"], default: "playing" },
    moves: { type: [moveSchema], default: [] },
    roomChatMessages: { type: [roomMessageSchema], default: [] },
    lastActivityAt: { type: Date, default: Date.now },

    // 當兩位玩家都離線時，將開始時間寫入 MongoDB。
    // Render 重啟後仍可正確清除過期房間。
    bothOfflineSince: { type: Date, default: null },

    // expires: 0 代表以此欄位記錄的時間點為到期時間。
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "active_rooms"
  }
);

const ActiveRoom = mongoose.model("ActiveRoom", activeRoomSchema);

// ==========================================
// 記憶體暫存
// ==========================================
const waitingPlayers = [];
const waitingPrivateRooms = new Map();
const rooms = new Map();

// 目前在線訪客：以固定 playerToken 計算，不會因同一瀏覽器重複開分頁而重複計數。
const onlineVisitors = new Map();

// 觀戰者不寫入 MongoDB，只保存目前 Socket 連線。
// Render 重啟後，觀戰者重新連線時可再次加入 active_rooms 中仍存在的對局。
const spectatorsByRoom = new Map();

// ==========================================
// 通用工具
// ==========================================
function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function generateRoomId() {
  return generateId("ROOM");
}

function generateSeriesId() {
  return generateId("SERIES");
}

function generatePrivateRoomCode() {
  let roomCode;

  do {
    roomCode = String(Math.floor(1000 + Math.random() * 9000));
  } while (waitingPrivateRooms.has(roomCode));

  return roomCode;
}

function cleanPlayerName(value) {
  return String(value || "").trim().slice(0, 20);
}

function normalizePlayerName(value) {
  return cleanPlayerName(value).toLowerCase();
}

function cleanPlayerToken(value) {
  return String(value || "").trim().slice(0, 160);
}

function cleanRoomId(value) {
  return String(value || "").trim().slice(0, 100);
}

function cleanChatMessage(value, maxLength = 120) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanGameMode(value) {
  return VALID_GAME_MODES.includes(value)
    ? value
    : GAME_MODE_STANDARD;
}

function getBoardIndex(x, y) {
  return y * BOARD_SIZE + x;
}

function isValidPosition(x, y) {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    x < BOARD_SIZE &&
    y >= 0 &&
    y < BOARD_SIZE
  );
}

function getOppositeColor(color) {
  return color === "black" ? "white" : "black";
}

function isBattleRoyaleRoom(room) {
  return room?.mode === GAME_MODE_BATTLE_ROYALE;
}

function isRotatingBoardRoom(room) {
  return room?.mode === GAME_MODE_ROTATING_BOARD;
}

function isSpecialModeRoom(room) {
  return room?.mode !== GAME_MODE_STANDARD;
}

function getActiveBoardSize(room) {
  return room.activeMax - room.activeMin + 1;
}

function isPositionActive(room, x, y) {
  return (
    isValidPosition(x, y) &&
    x >= room.activeMin &&
    x <= room.activeMax &&
    y >= room.activeMin &&
    y <= room.activeMax
  );
}

function hasAvailableCell(room) {
  for (let y = room.activeMin; y <= room.activeMax; y += 1) {
    for (let x = room.activeMin; x <= room.activeMax; x += 1) {
      if (room.board[getBoardIndex(x, y)] === 0) {
        return true;
      }
    }
  }

  return false;
}

function getLatestVisibleMove(room) {
  for (let index = room.moves.length - 1; index >= 0; index -= 1) {
    const move = room.moves[index];

    if (!move.collapsed && isPositionActive(room, move.x, move.y)) {
      return move;
    }
  }

  return null;
}

function clearBattleRoyaleTimer(room) {
  if (room?.shrinkTimer) {
    clearTimeout(room.shrinkTimer);
    room.shrinkTimer = null;
  }
}

function clearRotationAnimationTimer(room) {
  if (room?.rotationAnimationTimer) {
    clearTimeout(room.rotationAnimationTimer);
    room.rotationAnimationTimer = null;
  }
}

function areAllPlayersConnected(room) {
  return room?.players?.length === 2 && room.players.every((player) => player.connected);
}

function pauseBattleRoyaleShrink(room) {
  if (!isBattleRoyaleRoom(room)) {
    return;
  }

  clearBattleRoyaleTimer(room);
  room.nextShrinkAt = null;
}

function getPlayerBySocketId(room, socketId) {
  return room.players.find((player) => player.socketId === socketId) || null;
}

function getPlayerByToken(room, playerToken) {
  return room.players.find((player) => player.playerToken === playerToken) || null;
}

function getOpponent(room, playerOrSocketId) {
  const socketId =
    typeof playerOrSocketId === "string"
      ? playerOrSocketId
      : playerOrSocketId?.socketId;

  return room.players.find((player) => player.socketId !== socketId) || null;
}

function clearPlayerDisconnectTimer(player) {
  if (player?.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }
}

function removeFromWaitingQueue(socketId) {
  const index = waitingPlayers.findIndex((player) => player.socketId === socketId);

  if (index !== -1) {
    waitingPlayers.splice(index, 1);
  }
}

function removePrivateRoomBySocketId(socketId) {
  for (const [roomCode, privateRoom] of waitingPrivateRooms.entries()) {
    if (privateRoom.creator.socketId === socketId) {
      waitingPrivateRooms.delete(roomCode);
      return roomCode;
    }
  }

  return null;
}

function clearWaitingState(socketId) {
  removeFromWaitingQueue(socketId);
  removePrivateRoomBySocketId(socketId);
}

function isMongoConnected() {
  return mongoose.connection.readyState === 1;
}

// ==========================================
// 在線人數
// 以 playerToken 而不是 socket.id 計算，避免同一個瀏覽器開兩個分頁被算成兩人。
// ==========================================
function broadcastPresence() {
  io.emit("presenceUpdated", {
    onlineCount: onlineVisitors.size
  });
}

function registerPresence(socket, data = {}) {
  const playerToken = cleanPlayerToken(data.playerToken);

  if (!playerToken) {
    return;
  }

  const previousToken = socket.data.presenceToken;

  if (previousToken && previousToken !== playerToken) {
    unregisterPresence(socket, false);
  }

  const displayName = cleanPlayerName(data.name || socket.data.displayName);
  const visitor = onlineVisitors.get(playerToken) || {
    socketIds: new Set(),
    displayName: ""
  };

  visitor.socketIds.add(socket.id);

  if (displayName) {
    visitor.displayName = displayName;
    socket.data.displayName = displayName;
  }

  socket.data.presenceToken = playerToken;
  onlineVisitors.set(playerToken, visitor);
  broadcastPresence();
}

function unregisterPresence(socket, shouldBroadcast = true) {
  const playerToken = socket.data.presenceToken;

  if (!playerToken) {
    return;
  }

  const visitor = onlineVisitors.get(playerToken);

  if (visitor) {
    visitor.socketIds.delete(socket.id);

    if (visitor.socketIds.size === 0) {
      onlineVisitors.delete(playerToken);
    }
  }

  socket.data.presenceToken = null;

  if (shouldBroadcast) {
    broadcastPresence();
  }
}

// ==========================================
// 觀戰
// ==========================================
function getSpectatorChannel(roomId) {
  return `spectate:${roomId}`;
}

function getSpectatorCount(roomId) {
  return spectatorsByRoom.get(roomId)?.size || 0;
}

function removeSpectator(socket, options = {}) {
  const { broadcast = true } = options;
  const roomId = socket.data.spectatingRoomId;

  if (!roomId) {
    return;
  }

  const spectators = spectatorsByRoom.get(roomId);

  if (spectators) {
    spectators.delete(socket.id);

    if (spectators.size === 0) {
      spectatorsByRoom.delete(roomId);
    }
  }

  socket.leave(getSpectatorChannel(roomId));
  socket.data.spectatingRoomId = null;

  const room = rooms.get(roomId);

  if (room) {
    emitRoomState(room);
  }

  if (broadcast) {
    broadcastSpectatableRooms().catch((error) => {
      console.error("⚠️ 更新可觀戰房間失敗：", error.message);
    });
  }
}

function closeSpectatorsForRoom(room, payload = {}) {
  const roomId = room.roomId;
  const channel = getSpectatorChannel(roomId);
  const spectators = spectatorsByRoom.get(roomId);

  io.to(channel).emit("spectatorRoomEnded", {
    roomId,
    winner: room.winner,
    winnerName: payload.winnerName || "",
    message: payload.message || "此對局已結束。"
  });

  if (spectators) {
    for (const socketId of spectators.keys()) {
      const spectatorSocket = io.sockets.sockets.get(socketId);

      if (spectatorSocket) {
        spectatorSocket.leave(channel);
        spectatorSocket.data.spectatingRoomId = null;
      }
    }
  }

  spectatorsByRoom.delete(roomId);
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

    while (
      isValidPosition(nextX, nextY) &&
      board[getBoardIndex(nextX, nextY)] === stoneValue
    ) {
      count += 1;
      nextX += dx;
      nextY += dy;
    }

    nextX = x - dx;
    nextY = y - dy;

    while (
      isValidPosition(nextX, nextY) &&
      board[getBoardIndex(nextX, nextY)] === stoneValue
    ) {
      count += 1;
      nextX -= dx;
      nextY -= dy;
    }

    if (count >= 5) {
      return true;
    }
  }

  return false;
}

// ==========================================
// 輪盤五子棋：順時針旋轉棋盤
// ==========================================
function rotatePositionClockwise(x, y) {
  return {
    x: BOARD_SIZE - 1 - y,
    y: x
  };
}

function rotateBoardClockwise(board) {
  const rotatedBoard = Array(BOARD_CELL_COUNT).fill(0);

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const target = rotatePositionClockwise(x, y);
      rotatedBoard[getBoardIndex(target.x, target.y)] = board[getBoardIndex(x, y)];
    }
  }

  return rotatedBoard;
}

function rotateMoveCoordinatesClockwise(moves) {
  moves.forEach((move) => {
    const target = rotatePositionClockwise(move.x, move.y);
    move.x = target.x;
    move.y = target.y;
  });
}

function hasWinningLineForColor(board, color) {
  const stoneValue = color === "black" ? 1 : 2;

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (
        board[getBoardIndex(x, y)] === stoneValue &&
        checkWin(board, x, y, stoneValue)
      ) {
        return true;
      }
    }
  }

  return false;
}

async function rotateRotatingBoardRoom(room, triggeringColor) {
  if (
    !room ||
    !rooms.has(room.roomId) ||
    room.status !== "playing" ||
    !isRotatingBoardRoom(room) ||
    room.rotating
  ) {
    return;
  }

  room.rotating = true;
  clearRotationAnimationTimer(room);

  const boardBefore = [...room.board];
  room.board = rotateBoardClockwise(room.board);
  rotateMoveCoordinatesClockwise(room.moves);
  room.rotationCount += 1;
  room.movesSinceLastRotation = 0;

  await persistActiveRoom(room);

  const payload = {
    roomId: room.roomId,
    boardBefore,
    boardAfter: [...room.board],
    rotationCount: room.rotationCount,
    movesUntilRotation: ROTATING_BOARD_MOVES_PER_ROTATION,
    animationMs: ROTATING_BOARD_ANIMATION_MS
  };

  io.to(room.roomId).emit("boardRotate", payload);
  io.to(getSpectatorChannel(room.roomId)).emit("boardRotate", payload);

  await emitSystemRoomMessage(
    room,
    `🔄 輪盤啟動！棋盤已順時針旋轉 90 度，目前共旋轉 ${room.rotationCount} 次。`
  );

  room.rotationAnimationTimer = setTimeout(async () => {
    if (!rooms.has(room.roomId) || room.status !== "playing") {
      return;
    }

    room.rotating = false;
    room.rotationAnimationTimer = null;

    // 按照已確認規則：旋轉後若雙方同時形成五子，剛剛落子的玩家優先獲勝。
    if (hasWinningLineForColor(room.board, triggeringColor)) {
      await finalizeRoom(room, triggeringColor, "five-in-row");
      return;
    }

    const opponentColor = getOppositeColor(triggeringColor);

    if (hasWinningLineForColor(room.board, opponentColor)) {
      await finalizeRoom(room, opponentColor, "five-in-row");
      return;
    }

    if (!hasAvailableCell(room)) {
      await finalizeRoom(room, "draw", "draw");
      return;
    }

    emitRoomState(room);
    await broadcastSpectatableRooms();
  }, ROTATING_BOARD_ANIMATION_MS);
}

// ==========================================
// MongoDB：公開聊天室
// ==========================================
async function getRecentGlobalMessages() {
  const messages = await GlobalMessage.find({})
    .sort({ createdAt: -1, _id: -1 })
    .limit(GLOBAL_CHAT_LOAD_LIMIT)
    .lean();

  return messages
    .reverse()
    .map((item) => ({
      type: "player",
      playerName: item.playerName,
      message: item.message,
      createdAt: item.createdAt
    }));
}

async function trimOldGlobalMessages() {
  if (!isMongoConnected()) {
    return;
  }

  const totalCount = await GlobalMessage.countDocuments();
  const excessCount = totalCount - GLOBAL_CHAT_STORAGE_LIMIT;

  if (excessCount <= 0) {
    return;
  }

  const oldMessages = await GlobalMessage.find({})
    .sort({ createdAt: 1, _id: 1 })
    .limit(excessCount)
    .select({ _id: 1 })
    .lean();

  const ids = oldMessages.map((item) => item._id);

  if (ids.length > 0) {
    await GlobalMessage.deleteMany({ _id: { $in: ids } });
    console.log(`🧹 已刪除 ${ids.length} 則過舊公開訊息`);
  }
}

// ==========================================
// MongoDB：排行榜
// ==========================================
async function getLeaderboard() {
  return PlayerStats.find({})
    .sort({ points: -1, wins: -1, gamesPlayed: 1, updatedAt: 1 })
    .limit(10)
    .lean();
}

async function broadcastLeaderboard() {
  const leaderboard = await getLeaderboard();
  io.emit("leaderboardUpdated", leaderboard);
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

async function applyScoreOnce(room) {
  const history = await Game.findOneAndUpdate(
    { roomId: room.roomId, scoreApplied: false },
    { $set: { scoreApplied: true } },
    { new: false }
  );

  if (!history) {
    return;
  }

  const blackPlayer = room.players.find((player) => player.color === "black");
  const whitePlayer = room.players.find((player) => player.color === "white");

  if (!blackPlayer || !whitePlayer) {
    return;
  }

  if (room.winner === "draw") {
    await updatePlayerStats(blackPlayer.name, { points: 1, draws: 1, gamesPlayed: 1 });
    await updatePlayerStats(whitePlayer.name, { points: 1, draws: 1, gamesPlayed: 1 });
  } else {
    const winner = room.winner === "black" ? blackPlayer : whitePlayer;
    const loser = room.winner === "black" ? whitePlayer : blackPlayer;

    await updatePlayerStats(winner.name, { points: 3, wins: 1, gamesPlayed: 1 });
    await updatePlayerStats(loser.name, { losses: 1, gamesPlayed: 1 });
  }

  await broadcastLeaderboard();
}

// ==========================================
// active_rooms：同步與恢復
// ==========================================
function createExpiryDate() {
  return new Date(Date.now() + ACTIVE_ROOM_TTL_MS);
}

function toActiveRoomDocument(room) {
  return {
    roomId: room.roomId,
    seriesId: room.seriesId,
    round: room.round,
    mode: room.mode,
    shrinkLevel: room.shrinkLevel,
    activeMin: room.activeMin,
    activeMax: room.activeMax,
    movesSinceLastShrink: room.movesSinceLastShrink,
    nextShrinkAt: room.nextShrinkAt,
    rotationCount: room.rotationCount,
    movesSinceLastRotation: room.movesSinceLastRotation,
    players: room.players.map((player) => ({
      playerToken: player.playerToken,
      name: player.name,
      color: player.color
    })),
    board: room.board,
    currentTurn: room.currentTurn,
    status: "playing",
    moves: room.moves,
    roomChatMessages: room.roomChatMessages.slice(-ROOM_CHAT_LIMIT),
    lastActivityAt: new Date(),
    bothOfflineSince: room.bothOfflineSince || null,
    expiresAt: createExpiryDate()
  };
}

async function persistActiveRoom(room) {
  if (room.status !== "playing") {
    return;
  }

  await ActiveRoom.updateOne(
    { roomId: room.roomId },
    { $set: toActiveRoomDocument(room) },
    { upsert: true }
  );
}
// ==========================================
// 在線玩家心跳：低頻率更新房間活動時間
//
// 心跳仍然每 30 秒傳一次，
// 但 MongoDB 最多每 2 分鐘才更新一次。
// ==========================================
async function touchActiveRoomPresence(
  roomId
) {
  if (!roomId) {
    return;
  }

  const now =
    new Date();

  const updateThreshold =
    new Date(
      Date.now() -
        ROOM_PRESENCE_PERSIST_MS
    );

  await ActiveRoom.updateOne(
    {
      roomId,
      status:
        "playing",

      lastActivityAt: {
        $lt:
          updateThreshold
      }
    },
    {
      $set: {
        lastActivityAt:
          now,

        expiresAt:
          createExpiryDate()
      }
    }
  );
}

function scheduleBattleRoyaleShrink(room) {
  clearBattleRoyaleTimer(room);

  if (
    !isBattleRoyaleRoom(room) ||
    room.status !== "playing" ||
    !areAllPlayersConnected(room) ||
    getActiveBoardSize(room) <= BATTLE_ROYALE_MIN_BOARD_SIZE
  ) {
    room.nextShrinkAt = null;
    return;
  }

  const targetTime = room.nextShrinkAt
    ? new Date(room.nextShrinkAt).getTime()
    : Date.now() + BATTLE_ROYALE_SHRINK_INTERVAL_MS;

  room.nextShrinkAt = new Date(targetTime);

  room.shrinkTimer = setTimeout(() => {
    shrinkBattleRoyaleRoom(room, "time").catch((error) => {
      console.error("❌ 大逃殺模式定時縮圈失敗：", error.message);
    });
  }, Math.max(0, targetTime - Date.now()));
}

function getCollapseRing(room) {
  const positions = [];
  const min = room.activeMin;
  const max = room.activeMax;

  for (let value = min; value <= max; value += 1) {
    positions.push({ x: value, y: min });

    if (max !== min) {
      positions.push({ x: value, y: max });
    }
  }

  for (let value = min + 1; value < max; value += 1) {
    positions.push({ x: min, y: value });
    positions.push({ x: max, y: value });
  }

  return positions;
}

async function shrinkBattleRoyaleRoom(room, trigger = "time") {
  if (
    !room ||
    !rooms.has(room.roomId) ||
    room.status !== "playing" ||
    !isBattleRoyaleRoom(room) ||
    room.shrinking ||
    getActiveBoardSize(room) <= BATTLE_ROYALE_MIN_BOARD_SIZE
  ) {
    return;
  }

  room.shrinking = true;
  clearBattleRoyaleTimer(room);

  if (room.undoRequest) {
    room.undoRequest = null;
    io.to(room.roomId).emit("undoStatus", { status: "resolved" });
    io.to(room.roomId).emit("undoResolved", { accepted: false });
  }

  const boardBefore = [...room.board];
  const collapsedPositions = getCollapseRing(room);
  const collapsedKeys = new Set(
    collapsedPositions.map((position) => `${position.x},${position.y}`)
  );

  for (const position of collapsedPositions) {
    room.board[getBoardIndex(position.x, position.y)] = 0;
  }

  room.moves.forEach((move) => {
    if (collapsedKeys.has(`${move.x},${move.y}`)) {
      move.collapsed = true;
    }
  });

  room.activeMin += 1;
  room.activeMax -= 1;
  room.shrinkLevel += 1;
  room.movesSinceLastShrink = 0;
  room.nextShrinkAt =
    getActiveBoardSize(room) > BATTLE_ROYALE_MIN_BOARD_SIZE
      ? new Date(Date.now() + BATTLE_ROYALE_SHRINK_INTERVAL_MS)
      : null;

  await persistActiveRoom(room);

  const payload = {
    roomId: room.roomId,
    trigger,
    collapsedPositions,
    boardBefore,
    boardAfter: [...room.board],
    shrinkLevel: room.shrinkLevel,
    activeMin: room.activeMin,
    activeMax: room.activeMax,
    activeBoardSize: getActiveBoardSize(room),
    nextShrinkAt: room.nextShrinkAt,
    movesUntilShrink: BATTLE_ROYALE_MOVES_PER_SHRINK
  };

  io.to(room.roomId).emit("boardShrink", payload);
  io.to(getSpectatorChannel(room.roomId)).emit("boardShrink", payload);

  await emitSystemRoomMessage(
    room,
    `⚔️ 棋盤外圈已崩塌，目前剩下 ${payload.activeBoardSize} × ${payload.activeBoardSize}。`
  );

  setTimeout(async () => {
    if (!rooms.has(room.roomId) || room.status !== "playing") {
      return;
    }

    room.shrinking = false;
    emitRoomState(room);

    if (!hasAvailableCell(room)) {
      await finalizeRoom(room, "draw", "draw");
      return;
    }

    scheduleBattleRoyaleShrink(room);
    await broadcastSpectatableRooms();
  }, BATTLE_ROYALE_ANIMATION_MS);
}

function restoreRoomFromActiveDocument(document) {
  return {
    roomId: document.roomId,
    seriesId: document.seriesId,
    round: document.round,
    mode: cleanGameMode(document.mode),
    shrinkLevel: Number(document.shrinkLevel || 0),
    activeMin: Number(document.activeMin || 0),
    activeMax: Number.isInteger(document.activeMax) ? document.activeMax : BOARD_SIZE - 1,
    movesSinceLastShrink: Number(document.movesSinceLastShrink || 0),
    nextShrinkAt: document.nextShrinkAt || null,
    shrinkTimer: null,
    shrinking: false,
    rotationCount: Number(document.rotationCount || 0),
    movesSinceLastRotation: Number(document.movesSinceLastRotation || 0),
    rotating: false,
    rotationAnimationTimer: null,
    board: [...document.board],
    players: document.players.map((player) => ({
      socketId: null,
      socket: null,
      playerToken: player.playerToken,
      name: player.name,
      color: player.color,
      connected: false,
      disconnectTimer: null
    })),
    currentTurn: document.currentTurn,
    status: "playing",
    winner: null,
    reason: null,
    moves: document.moves.map((move) => ({
      x: move.x,
      y: move.y,
      color: move.color,
      playerName: move.playerName,
      createdAt: move.createdAt,
      collapsed: Boolean(move.collapsed)
    })),
    roomChatMessages: document.roomChatMessages.map((item) => ({
      type: item.type,
      playerName: item.playerName,
      message: item.message,
      createdAt: item.createdAt
    })),
    undoRequest: null,
    rematchVotes: new Set(),
    rematchStarting: false,
    finalized: false,
    bothOfflineSince: document.bothOfflineSince || null,
    startedAt: document.createdAt || new Date()
  };
}

function areBothPlayersOffline(room) {
  return (
    room &&
    room.players.length === 2 &&
    room.players.every((player) => !player.connected)
  );
}

function isBothOfflineExpired(roomOrDocument) {
  const bothOfflineSince = roomOrDocument?.bothOfflineSince;

  if (!bothOfflineSince) {
    return false;
  }

  return (
    Date.now() - new Date(bothOfflineSince).getTime() >=
    BOTH_OFFLINE_TIMEOUT_MS
  );
}

async function abandonRoom(roomId) {
  const room = rooms.get(roomId);

  if (room) {
    room.players.forEach(clearPlayerDisconnectTimer);
    clearBattleRoyaleTimer(room);
    clearRotationAnimationTimer(room);
    room.status = "abandoned";
    room.winner = null;
    room.reason = "both-offline-timeout";

    io.to(room.roomId).emit("roomExpired", {
      message: "雙方離線超過 3 分鐘，本局已自動結束。"
    });

    closeSpectatorsForRoom(room, {
      message: "雙方玩家皆已離線，本次觀戰已結束。"
    });

    rooms.delete(roomId);
  }

  await ActiveRoom.deleteOne({ roomId });
  console.log(`🧹 雙方離線過久，已清除房間：${roomId}`);
}

function scheduleDisconnectTimeout(room, player) {
  if (!room || !player || player.connected || player.disconnectTimer) {
    return;
  }

  player.disconnectTimer = setTimeout(() => {
    finalizeDisconnectedRoom(room, player).catch((error) => {
      console.error("❌ 離線逾時處理失敗：", error.message);
    });
  }, DISCONNECT_GRACE_PERIOD_MS);
}

async function cleanupAbandonedRooms() {
  if (!isMongoConnected()) {
    return;
  }

  const bothOfflineCutoff = new Date(Date.now() - BOTH_OFFLINE_TIMEOUT_MS);
  const legacyStaleCutoff = new Date(Date.now() - LEGACY_STALE_ROOM_TIMEOUT_MS);

  const abandonedRooms = await ActiveRoom.find({
    status: "playing",
    $or: [
      {
        bothOfflineSince: {
          $ne: null,
          $lte: bothOfflineCutoff
        }
      },
      {
        bothOfflineSince: null,
        lastActivityAt: {
          $lte: legacyStaleCutoff
        }
      }
    ]
  })
    .select({ roomId: 1 })
    .lean();

  for (const item of abandonedRooms) {
    await abandonRoom(item.roomId);
  }

  if (abandonedRooms.length > 0) {
    await broadcastSpectatableRooms();
  }
}

async function getOrRestoreRoom(roomId) {
  const inMemoryRoom = rooms.get(roomId);

  if (inMemoryRoom) {
    if (isBothOfflineExpired(inMemoryRoom)) {
      await abandonRoom(roomId);
      return null;
    }

    return inMemoryRoom;
  }

  const document = await ActiveRoom.findOne({
    roomId,
    status: "playing",
    expiresAt: { $gt: new Date() }
  }).lean();

  if (!document) {
    return null;
  }

  if (isBothOfflineExpired(document)) {
    await abandonRoom(roomId);
    return null;
  }

  const room = restoreRoomFromActiveDocument(document);
  rooms.set(roomId, room);

  console.log(`♻️ 已從 MongoDB 恢復房間：${roomId}`);
  return room;
}

async function getSpectatableRooms() {
  const visibleAfter =
    new Date(
      Date.now() -
        SPECTATABLE_ROOM_VISIBLE_MS
    );

  const activeRooms =
    await ActiveRoom.find({
      status:
        "playing",

      expiresAt: {
        $gt:
          new Date()
      },

      // 超過 6 分鐘沒有任何活動時，
      // 不再顯示於觀戰清單。
      lastActivityAt: {
        $gt:
          visibleAfter
      }
    })
    .sort({ updatedAt: -1 })
    .limit(50)
    .lean();

  return activeRooms.map((room) => {
    const blackPlayer = room.players.find((player) => player.color === "black");
    const whitePlayer = room.players.find((player) => player.color === "white");

    return {
      roomId: room.roomId,
      round: room.round,
      mode: cleanGameMode(room.mode),
      activeBoardSize: Number(room.activeMax ?? BOARD_SIZE - 1) - Number(room.activeMin ?? 0) + 1,
      blackPlayer: blackPlayer?.name || "黑棋玩家",
      whitePlayer: whitePlayer?.name || "白棋玩家",
      currentTurn: room.currentTurn,
      moveCount: room.moves.length,
      rotationCount: Number(room.rotationCount || 0),
      movesUntilRotation: Math.max(0, ROTATING_BOARD_MOVES_PER_ROTATION - Number(room.movesSinceLastRotation || 0)),
      spectatorCount: getSpectatorCount(room.roomId),
      updatedAt: room.updatedAt
    };
  });
}

async function broadcastSpectatableRooms() {
  io.emit("spectatableRoomsUpdated", await getSpectatableRooms());
}

// ==========================================
// 房間狀態與房間聊天室
// ==========================================
function buildRoomState(room) {
  const lastMove = getLatestVisibleMove(room);

  return {
    roomId: room.roomId,
    seriesId: room.seriesId,
    round: room.round,
    mode: room.mode,
    shrinkLevel: room.shrinkLevel,
    activeMin: room.activeMin,
    activeMax: room.activeMax,
    activeBoardSize: getActiveBoardSize(room),
    movesSinceLastShrink: room.movesSinceLastShrink,
    movesUntilShrink: Math.max(0, BATTLE_ROYALE_MOVES_PER_SHRINK - room.movesSinceLastShrink),
    nextShrinkAt: room.nextShrinkAt,
    shrinking: Boolean(room.shrinking),
    rotationCount: room.rotationCount,
    movesSinceLastRotation: room.movesSinceLastRotation,
    movesUntilRotation: Math.max(0, ROTATING_BOARD_MOVES_PER_ROTATION - room.movesSinceLastRotation),
    rotating: Boolean(room.rotating),
    undoAllowed: !isSpecialModeRoom(room),
    board: room.board,
    players: room.players.map((player) => ({
      name: player.name,
      color: player.color,
      connected: Boolean(player.connected)
    })),
    currentTurn: room.currentTurn,
    status: room.status,
    winner: room.winner,
    moveCount: room.moves.length,
    lastMoveColor: lastMove?.color || null,
    lastMove: lastMove
      ? { x: lastMove.x, y: lastMove.y, color: lastMove.color }
      : null,
    undoPending: Boolean(room.undoRequest),
    spectatorCount: getSpectatorCount(room.roomId)
  };
}

function appendRoomMessage(room, message) {
  room.roomChatMessages.push(message);

  if (room.roomChatMessages.length > ROOM_CHAT_LIMIT) {
    room.roomChatMessages.shift();
  }
}

async function emitSystemRoomMessage(room, message, persist = true) {
  const item = {
    type: "system",
    playerName: "",
    message,
    createdAt: new Date()
  };

  appendRoomMessage(room, item);
  io.to(room.roomId).emit("chatMessage", item);

  if (persist && room.status === "playing") {
    await persistActiveRoom(room);
  }
}

function emitRoomState(room) {
  const state = buildRoomState(room);

  io.to(room.roomId).emit("gameState", state);
  io.to(getSpectatorChannel(room.roomId)).emit("spectatorRoomState", state);
}

// ==========================================
// 歷史棋譜與結束處理
// ==========================================
function toHistoryDocument(room) {
  return {
    roomId: room.roomId,
    seriesId: room.seriesId,
    round: room.round,
    mode: room.mode,
    shrinkLevel: room.shrinkLevel,
    rotationCount: room.rotationCount,
    activeMin: room.activeMin,
    activeMax: room.activeMax,
    players: room.players.map((player) => ({
      name: player.name,
      color: player.color
    })),
    board: room.board,
    currentTurn: room.currentTurn,
    status: "finished",
    winner: room.winner,
    reason: room.reason,
    moves: room.moves,
    startedAt: room.startedAt,
    endedAt: new Date()
  };
}

async function finalizeRoom(room, winner, reason, options = {}) {
  const { emitGameOver = true, deleteFromMemory = false } = options;

  if (room.finalized) {
    return;
  }

  room.status = "finished";
  room.winner = winner;
  room.reason = reason;
  room.finalized = true;
  room.undoRequest = null;

  room.players.forEach(clearPlayerDisconnectTimer);
  clearBattleRoyaleTimer(room);
  clearRotationAnimationTimer(room);

  await Game.updateOne(
    { roomId: room.roomId },
    {
      $set: toHistoryDocument(room),
      $setOnInsert: { scoreApplied: false }
    },
    { upsert: true }
  );

  await applyScoreOnce(room);
  await ActiveRoom.deleteOne({ roomId: room.roomId });

  emitRoomState(room);

  const winnerPlayer = room.players.find((player) => player.color === winner);
  const winnerName = winner === "draw" ? "平手" : winnerPlayer?.name || "未知玩家";

  if (emitGameOver) {
    io.to(room.roomId).emit("gameOver", {
      winner,
      winnerName,
      reason
    });
  }

  closeSpectatorsForRoom(room, {
    winnerName,
    message: winner === "draw" ? "此對局以平手結束。" : `${winnerName} 已獲勝，本次觀戰結束。`
  });

  await broadcastSpectatableRooms();

  if (deleteFromMemory) {
    rooms.delete(room.roomId);
  }
}

// ==========================================
// 建立新局與再戰
// ==========================================
function createLivePlayer(player, color) {
  return {
    socketId: player.socketId,
    socket: player.socket,
    playerToken: player.playerToken,
    name: player.name,
    color,
    connected: true,
    disconnectTimer: null
  };
}

async function startGame(player1, player2, options = {}) {
  const roomId = generateRoomId();
  const seriesId = options.seriesId || generateSeriesId();
  const round = options.round || 1;
  const startEventName = options.startEventName || "gameStarted";
  const mode = cleanGameMode(options.mode);

  const room = {
    roomId,
    seriesId,
    round,
    mode,
    shrinkLevel: 0,
    activeMin: 0,
    activeMax: BOARD_SIZE - 1,
    movesSinceLastShrink: 0,
    nextShrinkAt:
      mode === GAME_MODE_BATTLE_ROYALE
        ? new Date(Date.now() + BATTLE_ROYALE_SHRINK_INTERVAL_MS)
        : null,
    shrinkTimer: null,
    shrinking: false,
    rotationCount: 0,
    movesSinceLastRotation: 0,
    rotating: false,
    rotationAnimationTimer: null,
    board: Array(BOARD_CELL_COUNT).fill(0),
    players: [
      createLivePlayer(player1, options.player1Color || "black"),
      createLivePlayer(player2, options.player2Color || "white")
    ],
    currentTurn: "black",
    status: "playing",
    winner: null,
    reason: null,
    moves: [],
    roomChatMessages: (options.roomChatMessages || []).slice(-ROOM_CHAT_LIMIT),
    undoRequest: null,
    rematchVotes: new Set(),
    rematchStarting: false,
    finalized: false,
    bothOfflineSince: null,
    startedAt: new Date()
  };

  rooms.set(roomId, room);

  for (const player of room.players) {
    removeSpectator(player.socket, { broadcast: false });
    player.socket.join(roomId);
    player.socket.data.roomId = roomId;
    player.socket.data.playerToken = player.playerToken;
    player.socket.data.displayName = player.name;
  }

  await persistActiveRoom(room);
  scheduleBattleRoyaleShrink(room);

  for (const player of room.players) {
    io.to(player.socketId).emit(startEventName, {
      roomId,
      seriesId,
      round,
      mode: room.mode,
      myColor: player.color
    });
  }

  emitRoomState(room);
  let startMessage = `第 ${round} 局開始，黑棋先行。`;

  if (mode === GAME_MODE_BATTLE_ROYALE) {
    startMessage = `第 ${round} 局開始：⚔️ 大逃殺模式。每 60 秒或每 10 手會縮小一圈，黑棋先行。`;
  }

  if (mode === GAME_MODE_ROTATING_BOARD) {
    startMessage = `第 ${round} 局開始：🔄 輪盤五子棋。雙方每累積 10 手，棋盤會順時針旋轉 90 度；特殊模式暫不支援悔棋。`;
  }

  await emitSystemRoomMessage(room, startMessage);
  await broadcastSpectatableRooms();

  console.log(`🎮 房間建立成功：${roomId}`);
  return room;
}

async function startRematch(oldRoom) {
  const blackPlayer = oldRoom.players.find((player) => player.color === "black");
  const whitePlayer = oldRoom.players.find((player) => player.color === "white");

  if (!blackPlayer?.socket || !whitePlayer?.socket) {
    throw new Error("其中一位玩家已離線");
  }

  const oldRoomId = oldRoom.roomId;

  const newRoom = await startGame(
    {
      socketId: blackPlayer.socketId,
      socket: blackPlayer.socket,
      playerToken: blackPlayer.playerToken,
      name: blackPlayer.name
    },
    {
      socketId: whitePlayer.socketId,
      socket: whitePlayer.socket,
      playerToken: whitePlayer.playerToken,
      name: whitePlayer.name
    },
    {
      seriesId: oldRoom.seriesId,
      round: oldRoom.round + 1,
      player1Color: "white",
      player2Color: "black",
      roomChatMessages: oldRoom.roomChatMessages,
      mode: oldRoom.mode,
      startEventName: "rematchStarted"
    }
  );

  for (const player of oldRoom.players) {
    player.socket?.leave(oldRoomId);
  }

  clearBattleRoyaleTimer(oldRoom);
  clearRotationAnimationTimer(oldRoom);
  rooms.delete(oldRoomId);

  io.to(newRoom.roomId).emit("chatHistory", newRoom.roomChatMessages);
  console.log(`🔄 同一組玩家開始第 ${newRoom.round} 局：${newRoom.roomId}`);
}

// ==========================================
// 玩家離線逾時
// ==========================================
async function finalizeDisconnectedRoom(room, disconnectedPlayer) {
  if (!rooms.has(room.roomId) || disconnectedPlayer.connected) {
    return;
  }

  if (areBothPlayersOffline(room)) {
    if (isBothOfflineExpired(room)) {
      await abandonRoom(room.roomId);
      await broadcastSpectatableRooms();
    }

    return;
  }

  const opponent = room.players.find(
    (player) => player.playerToken !== disconnectedPlayer.playerToken
  );

  if (room.status === "playing") {
    const winner = getOppositeColor(disconnectedPlayer.color);

    await finalizeRoom(room, winner, "disconnect-timeout", {
      emitGameOver: false,
      deleteFromMemory: true
    });

    if (opponent?.socketId) {
      io.to(opponent.socketId).emit("opponentDisconnected", {
        winner,
        message: `${disconnectedPlayer.name} 離線超過 3 分鐘，本局已結束。`
      });
    }
  } else {
    rooms.delete(room.roomId);
  }
}

// ==========================================
// Socket.IO
// ==========================================
io.on("connection", (socket) => {
  console.log(`🔌 玩家連線：${socket.id}`);

  // ----------------------------------------
  // 在線人數
  // ----------------------------------------
  socket.on("registerPresence", (data) => {
    registerPresence(socket, data);
  });

  // ----------------------------------------
  // 取得目前可觀戰房間
  // ----------------------------------------
  socket.on("getSpectatableRooms", async () => {
    try {
      socket.emit("spectatableRoomsUpdated", await getSpectatableRooms());
    } catch (error) {
      console.error("❌ 讀取可觀戰房間失敗：", error.message);
      socket.emit("errorMessage", "可觀戰房間載入失敗，請稍後再試");
    }
  });

  // ----------------------------------------
  // 加入觀戰
  // ----------------------------------------
  socket.on("watchRoom", async (data) => {
    const roomId = cleanRoomId(data?.roomId);
    const playerToken = cleanPlayerToken(data?.playerToken);

    if (!roomId || !playerToken) {
      socket.emit("errorMessage", "觀戰資料不完整，請重新整理頁面");
      return;
    }

    const currentPlayingRoom = rooms.get(socket.data.roomId);

    if (currentPlayingRoom?.status === "playing") {
      socket.emit("errorMessage", "您正在對局中，無法同時觀戰");
      return;
    }

    try {
      const room = await getOrRestoreRoom(roomId);

      if (!room || room.status !== "playing") {
        socket.emit("errorMessage", "此對局已結束或不存在");
        await broadcastSpectatableRooms();
        return;
      }

      removeSpectator(socket, { broadcast: false });

      const spectators = spectatorsByRoom.get(roomId) || new Map();
      spectators.set(socket.id, {
        playerToken,
        name: cleanPlayerName(socket.data.displayName || data?.name) || "訪客"
      });

      spectatorsByRoom.set(roomId, spectators);
      socket.data.spectatingRoomId = roomId;
      socket.join(getSpectatorChannel(roomId));

      socket.emit("spectatorJoined", {
        roomId,
        spectatorCount: getSpectatorCount(roomId)
      });

      socket.emit("spectatorRoomState", buildRoomState(room));
      emitRoomState(room);
      await broadcastSpectatableRooms();
    } catch (error) {
      console.error("❌ 加入觀戰失敗：", error.message);
      socket.emit("errorMessage", "加入觀戰失敗，請稍後再試");
    }
  });

  // ----------------------------------------
  // 離開觀戰
  // ----------------------------------------
  socket.on("leaveSpectating", () => {
    removeSpectator(socket);
    socket.emit("spectatorLeft");
  });

  // ----------------------------------------
  // 心跳：不寫 MongoDB，只維持連線活動。
  // ----------------------------------------
  socket.on("clientHeartbeat", (_data, callback) => {
    const now = Date.now();
    socket.data.lastHeartbeatAt = now;
        // 若玩家正在對局中，
    // 低頻率更新 MongoDB 房間活動時間。
    //
    // 不要 await，避免心跳回覆被 MongoDB 延遲。
    if (
      socket.data.roomId
    ) {
      touchActiveRoomPresence(
        socket.data.roomId
      ).catch((error) => {
        console.error(
          "❌ 更新房間在線狀態失敗：",
          error.message
        );
      });
    }

    // 每 5 分鐘印一次即可，避免 Logs 太多。
    if (!socket.data.lastHeartbeatLogAt || now - socket.data.lastHeartbeatLogAt > 5 * 60 * 1000) {
      socket.data.lastHeartbeatLogAt = now;
      console.log(`💓 收到玩家心跳：${socket.id}`);
    }

    if (typeof callback === "function") {
      callback({ success: true, serverTime: now });
    }
  });

  // ----------------------------------------
  // 排行榜
  // ----------------------------------------
  socket.on("getLeaderboard", async () => {
    try {
      socket.emit("leaderboardUpdated", await getLeaderboard());
    } catch (error) {
      console.error("❌ 讀取排行榜失敗：", error.message);
    }
  });

  // ----------------------------------------
  // 公開聊天室歷史
  // ----------------------------------------
  socket.on("getGlobalChatHistory", async () => {
    try {
      socket.emit("globalChatHistory", await getRecentGlobalMessages());
    } catch (error) {
      console.error("❌ 讀取公開聊天室失敗：", error.message);
      socket.emit("errorMessage", "公開聊天室載入失敗，請稍後再試");
    }
  });

  // ----------------------------------------
  // 公開聊天室傳送
  // ----------------------------------------
  socket.on("sendGlobalChatMessage", async (data) => {
    const now = Date.now();

    if (now - (socket.data.lastGlobalChatAt || 0) < GLOBAL_CHAT_COOLDOWN_MS) {
      socket.emit("errorMessage", "訊息傳送過快，請稍候再試");
      return;
    }

    const playerName = cleanPlayerName(socket.data.displayName || data?.name);
    const message = cleanChatMessage(data?.message, 120);

    if (!playerName) {
      socket.emit("errorMessage", "請先輸入玩家名稱");
      return;
    }

    if (!message) {
      return;
    }

    socket.data.displayName = playerName;
    socket.data.lastGlobalChatAt = now;

    try {
      const savedMessage = await GlobalMessage.create({ playerName, message });

      const chatMessage = {
        type: "player",
        playerName: savedMessage.playerName,
        message: savedMessage.message,
        createdAt: savedMessage.createdAt
      };

      io.emit("globalChatMessage", chatMessage);
      await trimOldGlobalMessages();
    } catch (error) {
      console.error("❌ 儲存公開聊天室失敗：", error.message);
      socket.emit("errorMessage", "公開訊息傳送失敗，請稍後再試");
    }
  });

  // ----------------------------------------
  // 快速配對
  // ----------------------------------------
  socket.on("joinQueue", async (data) => {
    const name = cleanPlayerName(data?.name);
    const playerToken = cleanPlayerToken(data?.playerToken);
    const mode = cleanGameMode(data?.mode);

    if (!name || !playerToken) {
      socket.emit("errorMessage", "玩家名稱或識別碼遺失，請重新整理頁面");
      return;
    }

    clearWaitingState(socket.id);
    removeSpectator(socket);

    socket.data.displayName = name;
    socket.data.playerToken = playerToken;

    waitingPlayers.push({ socketId: socket.id, socket, name, playerToken, mode });

    socket.emit("queueStatus", {
      message: "正在等待另一位快速配對玩家加入..."
    });

    // 尋找 Token 不同的兩位玩家，避免同一個瀏覽器誤配自己。
    for (let i = 0; i < waitingPlayers.length; i += 1) {
      for (let j = i + 1; j < waitingPlayers.length; j += 1) {
        if (
          waitingPlayers[i].playerToken === waitingPlayers[j].playerToken ||
          waitingPlayers[i].mode !== waitingPlayers[j].mode
        ) {
          continue;
        }

        const player2 = waitingPlayers.splice(j, 1)[0];
        const player1 = waitingPlayers.splice(i, 1)[0];

        try {
          await startGame(player1, player2, { mode: player1.mode });
        } catch (error) {
          console.error("❌ 建立快速配對失敗：", error.message);
          io.to(player1.socketId).emit("errorMessage", "建立對局失敗，請重新配對");
          io.to(player2.socketId).emit("errorMessage", "建立對局失敗，請重新配對");
        }

        return;
      }
    }
  });

  // ----------------------------------------
  // 取消等待
  // ----------------------------------------
  socket.on("cancelWaiting", () => {
    clearWaitingState(socket.id);
    socket.emit("waitingCancelled");
  });

  // ----------------------------------------
  // 建立私人房間
  // ----------------------------------------
  socket.on("createPrivateRoom", (data) => {
    const name = cleanPlayerName(data?.name);
    const playerToken = cleanPlayerToken(data?.playerToken);
    const mode = cleanGameMode(data?.mode);

    if (!name || !playerToken) {
      socket.emit("privateRoomError", "玩家名稱或識別碼遺失，請重新整理頁面");
      return;
    }

    clearWaitingState(socket.id);
    removeSpectator(socket);

    const roomCode = generatePrivateRoomCode();
    const creator = { socketId: socket.id, socket, name, playerToken };

    waitingPrivateRooms.set(roomCode, {
      roomCode,
      creator,
      mode,
      createdAt: Date.now()
    });

    socket.data.displayName = name;
    socket.data.playerToken = playerToken;
    socket.data.privateRoomCode = roomCode;

    socket.emit("privateRoomCreated", { roomCode, mode });
    console.log(`🔐 私人房間已建立：${roomCode}，建立者：${name}`);
  });

  // ----------------------------------------
  // 加入私人房間
  // ----------------------------------------
  socket.on("joinPrivateRoom", async (data) => {
    const name = cleanPlayerName(data?.name);
    const playerToken = cleanPlayerToken(data?.playerToken);
    const roomCode = String(data?.roomCode || "").trim();

    if (!name || !playerToken) {
      socket.emit("privateRoomError", "玩家名稱或識別碼遺失，請重新整理頁面");
      return;
    }

    if (!/^\d{4}$/.test(roomCode)) {
      socket.emit("privateRoomError", "請輸入正確的 4 位數房號");
      return;
    }

    const privateRoom = waitingPrivateRooms.get(roomCode);

    if (!privateRoom) {
      socket.emit("privateRoomError", "找不到此私人房間，請確認房號是否正確");
      return;
    }

    if (privateRoom.creator.playerToken === playerToken) {
      socket.emit("privateRoomError", "不能加入自己建立的私人房間");
      return;
    }

    const creatorSocket = io.sockets.sockets.get(privateRoom.creator.socketId);

    if (!creatorSocket) {
      waitingPrivateRooms.delete(roomCode);
      socket.emit("privateRoomError", "房間建立者已離線，請重新建立房間");
      return;
    }

    clearWaitingState(socket.id);
    removeSpectator(socket);
    waitingPrivateRooms.delete(roomCode);

    creatorSocket.data.privateRoomCode = null;
    socket.data.privateRoomCode = null;
    socket.data.displayName = name;
    socket.data.playerToken = playerToken;

    try {
      await startGame(privateRoom.creator, {
        socketId: socket.id,
        socket,
        name,
        playerToken
      }, {
        mode: privateRoom.mode
      });

      console.log(`🔓 私人房間 ${roomCode} 開始對局`);
    } catch (error) {
      console.error("❌ 私人房間開始失敗：", error.message);
      io.to(privateRoom.creator.socketId).emit("privateRoomError", "建立對局失敗，請重新建立房間");
      socket.emit("privateRoomError", "加入對局失敗，請重新嘗試");
    }
  });

  // ----------------------------------------
  // 恢復未完成對局
  // 記憶體沒有房間時，改查 MongoDB active_rooms。
  // ----------------------------------------
  socket.on("resumeGame", async (data) => {
    const roomId = cleanRoomId(data?.roomId);
    const playerToken = cleanPlayerToken(data?.playerToken);

    if (!roomId || !playerToken) {
      socket.emit("resumeGameFailed", "恢復資料不完整，請返回首頁重新配對。");
      return;
    }

    try {
      const room = await getOrRestoreRoom(roomId);

      if (!room || room.status !== "playing") {
        socket.emit("resumeGameFailed", "找不到尚未完成的棋局，請返回首頁重新配對。");
        return;
      }

      const player = getPlayerByToken(room, playerToken);

      if (!player) {
        socket.emit("resumeGameFailed", "無法確認玩家身分，請返回首頁重新配對。");
        return;
      }

      clearPlayerDisconnectTimer(player);

      // 若玩家在其他分頁已有舊連線，讓舊分頁失效。
      if (player.socketId && player.socketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(player.socketId);

        if (oldSocket) {
          oldSocket.emit("sessionReplaced");
          oldSocket.leave(roomId);
          oldSocket.data.roomId = null;
        }
      }

      removeSpectator(socket, { broadcast: false });

      player.socketId = socket.id;
      player.socket = socket;
      player.connected = true;
      room.bothOfflineSince = null;

      socket.data.roomId = roomId;
      socket.data.playerToken = playerToken;
      socket.data.displayName = player.name;
      socket.join(roomId);

      if (isBattleRoyaleRoom(room) && areAllPlayersConnected(room)) {
        room.nextShrinkAt = new Date(Date.now() + BATTLE_ROYALE_SHRINK_INTERVAL_MS);
        scheduleBattleRoyaleShrink(room);
      }

      await persistActiveRoom(room);

      // Render 完整重啟後，記憶體中的離線計時器會消失。
      // 重新為尚未回來的玩家建立寬限計時器。
      for (const offlinePlayer of room.players.filter((item) => !item.connected)) {
        scheduleDisconnectTimeout(room, offlinePlayer);
      }

      socket.emit("gameResumed", {
        roomId: room.roomId,
        seriesId: room.seriesId,
        round: room.round,
        mode: room.mode,
        myColor: player.color,
        status: room.status
      });

      emitRoomState(room);
      socket.emit("chatHistory", room.roomChatMessages);

      io.to(roomId).emit("opponentConnectionStatus", {
        players: room.players.map((item) => ({
          name: item.name,
          color: item.color,
          connected: Boolean(item.connected)
        }))
      });

      console.log(`♻️ 玩家恢復棋局：${player.name}，房間：${roomId}`);
    } catch (error) {
      console.error("❌ 恢復棋局失敗：", error.message);
      socket.emit("resumeGameFailed", "恢復棋局時發生錯誤，請返回首頁重新配對。");
    }
  });

  // ----------------------------------------
  // 玩家落子
  // ----------------------------------------
  socket.on("makeMove", async (data) => {
    const room = rooms.get(socket.data.roomId);

    if (!room || room.status !== "playing") {
      socket.emit("errorMessage", "找不到可進行的遊戲房間");
      return;
    }

    const player = getPlayerBySocketId(room, socket.id);
    const opponent = getOpponent(room, socket.id);

    if (!player) {
      socket.emit("errorMessage", "您不是這個房間的玩家");
      return;
    }

    if (!opponent?.connected) {
      socket.emit("errorMessage", "對手尚未重新連線，請稍候");
      return;
    }

    if (room.undoRequest) {
      socket.emit("errorMessage", "請先完成悔棋處理");
      return;
    }

    if (room.shrinking) {
      socket.emit("errorMessage", "棋盤正在崩塌，請稍候再落子");
      return;
    }

    if (room.rotating) {
      socket.emit("errorMessage", "棋盤正在旋轉，請稍候再落子");
      return;
    }

    if (room.currentTurn !== player.color) {
      socket.emit("errorMessage", "現在還沒輪到您");
      return;
    }

    const x = Number(data?.x);
    const y = Number(data?.y);

    if (!isValidPosition(x, y) || !isPositionActive(room, x, y)) {
      socket.emit("errorMessage", "此位置已經崩塌，請在目前有效棋盤內落子");
      return;
    }

    const index = getBoardIndex(x, y);

    if (room.board[index] !== 0) {
      socket.emit("errorMessage", "這個位置已經有棋子");
      return;
    }

    const stoneValue = player.color === "black" ? 1 : 2;

    room.board[index] = stoneValue;
    room.moves.push({
      x,
      y,
      color: player.color,
      playerName: player.name,
      createdAt: new Date(),
      collapsed: false
    });

    const hasWinner = checkWin(room.board, x, y, stoneValue);
    const isDraw = !hasWinner && !hasAvailableCell(room);

    if (hasWinner) {
      await finalizeRoom(room, player.color, "five-in-row");
      return;
    }

    if (isDraw) {
      await finalizeRoom(room, "draw", "draw");
      return;
    }

    room.currentTurn = getOppositeColor(player.color);

    if (isBattleRoyaleRoom(room)) {
      room.movesSinceLastShrink += 1;
    }

    if (isRotatingBoardRoom(room)) {
      room.movesSinceLastRotation += 1;
    }

    try {
      if (
        isRotatingBoardRoom(room) &&
        room.movesSinceLastRotation >= ROTATING_BOARD_MOVES_PER_ROTATION
      ) {
        await rotateRotatingBoardRoom(room, player.color);
        await broadcastSpectatableRooms();
        return;
      }

      await persistActiveRoom(room);
      emitRoomState(room);
      await broadcastSpectatableRooms();

      if (
        isBattleRoyaleRoom(room) &&
        room.movesSinceLastShrink >= BATTLE_ROYALE_MOVES_PER_SHRINK
      ) {
        await shrinkBattleRoyaleRoom(room, "moves");
      }
    } catch (error) {
      console.error("❌ 儲存進行中棋局失敗：", error.message);
      socket.emit("errorMessage", "棋局保存失敗，請稍後再試");
    }
  });

  // ----------------------------------------
  // 申請悔棋
  // ----------------------------------------
  socket.on("requestUndo", () => {
    const room = rooms.get(socket.data.roomId);

    if (!room || room.status !== "playing") {
      socket.emit("errorMessage", "目前無法悔棋");
      return;
    }

    if (isSpecialModeRoom(room)) {
      socket.emit("errorMessage", "特殊模式暫時不支援悔棋");
      return;
    }

    if (room.undoRequest) {
      socket.emit("errorMessage", "目前已有待處理的悔棋申請");
      return;
    }

    const player = getPlayerBySocketId(room, socket.id);
    const opponent = getOpponent(room, socket.id);
    const lastMove = room.moves[room.moves.length - 1];

    if (!player || !opponent?.connected) {
      socket.emit("errorMessage", "對手尚未連線，無法申請悔棋");
      return;
    }

    if (
      !lastMove ||
      lastMove.collapsed ||
      !isPositionActive(room, lastMove.x, lastMove.y) ||
      lastMove.color !== player.color
    ) {
      socket.emit("errorMessage", "只能撤回自己剛剛落下的最後一步");
      return;
    }

    room.undoRequest = {
      requesterToken: player.playerToken,
      requesterName: player.name
    };

    io.to(room.roomId).emit("undoStatus", {
      status: "pending",
      requesterName: player.name
    });

    io.to(opponent.socketId).emit("undoRequestReceived", {
      requesterName: player.name
    });
  });

  // ----------------------------------------
  // 回應悔棋
  // ----------------------------------------
  socket.on("respondUndo", async (data) => {
    const room = rooms.get(socket.data.roomId);

    if (!room?.undoRequest) {
      socket.emit("errorMessage", "目前沒有待處理的悔棋申請");
      return;
    }

    if (isSpecialModeRoom(room)) {
      room.undoRequest = null;
      socket.emit("errorMessage", "特殊模式暫時不支援悔棋");
      return;
    }

    const responder = getPlayerBySocketId(room, socket.id);

    if (!responder || responder.playerToken === room.undoRequest.requesterToken) {
      socket.emit("errorMessage", "不能回應自己的悔棋申請");
      return;
    }

    const accepted = Boolean(data?.accept);

    if (!accepted) {
      room.undoRequest = null;
      io.to(room.roomId).emit("undoStatus", { status: "resolved" });
      io.to(room.roomId).emit("undoResolved", { accepted: false });
      return;
    }

    const removedMove = room.moves.pop();

    if (!removedMove) {
      room.undoRequest = null;
      return;
    }

    room.board[getBoardIndex(removedMove.x, removedMove.y)] = 0;
    room.currentTurn = removedMove.color;

    if (isBattleRoyaleRoom(room)) {
      room.movesSinceLastShrink = Math.max(0, room.movesSinceLastShrink - 1);
    }
    room.undoRequest = null;

    try {
      await persistActiveRoom(room);
      io.to(room.roomId).emit("undoStatus", { status: "resolved" });
      emitRoomState(room);
      await broadcastSpectatableRooms();
      io.to(room.roomId).emit("undoResolved", { accepted: true });
      await emitSystemRoomMessage(room, `${removedMove.playerName} 的最後一步已撤回。`);
    } catch (error) {
      console.error("❌ 更新悔棋資料失敗：", error.message);
      socket.emit("errorMessage", "悔棋保存失敗，請稍後再試");
    }
  });

  // ----------------------------------------
  // 房間聊天室
  // ----------------------------------------
  socket.on("sendChatMessage", async (data) => {
    const now = Date.now();
    const room = rooms.get(socket.data.roomId);

    if (!room || room.status !== "playing") {
      socket.emit("errorMessage", "請先進入對局");
      return;
    }

    if (now - (socket.data.lastRoomChatAt || 0) < ROOM_CHAT_COOLDOWN_MS) {
      socket.emit("errorMessage", "訊息傳送過快，請稍候再試");
      return;
    }

    const player = getPlayerBySocketId(room, socket.id);
    const message = cleanChatMessage(data?.message, 120);

    if (!player || !message) {
      return;
    }

    socket.data.lastRoomChatAt = now;

    const chatMessage = {
      type: "player",
      playerName: player.name,
      message,
      createdAt: new Date()
    };

    appendRoomMessage(room, chatMessage);

    try {
      await persistActiveRoom(room);
      io.to(room.roomId).emit("chatMessage", chatMessage);
    } catch (error) {
      console.error("❌ 儲存房間聊天室失敗：", error.message);
      socket.emit("errorMessage", "房間訊息傳送失敗，請稍後再試");
    }
  });

  // ----------------------------------------
  // 再來一局
  // ----------------------------------------
  socket.on("requestRematch", async () => {
    const room = rooms.get(socket.data.roomId);

    if (!room || room.status !== "finished") {
      socket.emit("errorMessage", "目前無法開始再戰");
      return;
    }

    const player = getPlayerBySocketId(room, socket.id);

    if (!player) {
      socket.emit("errorMessage", "您不是這個房間的玩家");
      return;
    }

    if (room.players.some((item) => !item.connected || !item.socket)) {
      socket.emit("errorMessage", "對手已離線，無法再戰");
      return;
    }

    room.rematchVotes.add(player.playerToken);

    io.to(room.roomId).emit("rematchStatus", {
      accepted: room.rematchVotes.size,
      total: room.players.length
    });

    if (room.rematchVotes.size === room.players.length && !room.rematchStarting) {
      room.rematchStarting = true;

      try {
        await startRematch(room);
      } catch (error) {
        room.rematchStarting = false;
        console.error("❌ 再戰建立失敗：", error.message);
        io.to(room.roomId).emit("errorMessage", "再戰建立失敗，請返回首頁重新配對");
      }
    }
  });

  // ----------------------------------------
  // 主動回首頁
  // ----------------------------------------
  socket.on("leaveRoom", async () => {
    clearWaitingState(socket.id);
    removeSpectator(socket);

    const roomId = socket.data.roomId;

    if (!roomId) {
      socket.emit("leftRoom");
      return;
    }

    const room = rooms.get(roomId);

    socket.leave(roomId);
    socket.data.roomId = null;

    if (!room) {
      await ActiveRoom.deleteOne({ roomId });
      socket.emit("leftRoom");
      return;
    }

    const leavingPlayer = getPlayerBySocketId(room, socket.id);
    const opponent = getOpponent(room, socket.id);

    if (room.status === "playing" && leavingPlayer) {
      await finalizeRoom(room, getOppositeColor(leavingPlayer.color), "leave", {
        emitGameOver: false,
        deleteFromMemory: true
      });

      if (opponent?.socketId) {
        io.to(opponent.socketId).emit("opponentDisconnected", {
          winner: getOppositeColor(leavingPlayer.color),
          message: `${leavingPlayer.name} 已返回首頁，本局已結束。`
        });
      }
    } else {
      rooms.delete(roomId);

      if (opponent?.socketId) {
        io.to(opponent.socketId).emit("rematchUnavailable", {
          message: `${leavingPlayer?.name || "對手"} 已返回首頁，無法再戰。`
        });
      }
    }

    socket.emit("leftRoom");
  });

  // ----------------------------------------
  // Socket 離線：先保留房間 3 分鐘
  // ----------------------------------------
  socket.on("disconnect", async () => {
    console.log(`⚠️ 玩家暫時離線：${socket.id}`);

    unregisterPresence(socket);
    removeSpectator(socket);
    clearWaitingState(socket.id);

    const roomId = socket.data.roomId;

    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);

    // Render 若完整重啟，rooms 本來就會消失；
    // active_rooms 仍保留，等玩家重新連線後恢復。
    if (!room) {
      return;
    }

    const player = getPlayerBySocketId(room, socket.id);

    if (!player) {
      return;
    }

    player.connected = false;
    player.socket = null;

    clearPlayerDisconnectTimer(player);

    if (room.status === "playing") {
      pauseBattleRoyaleShrink(room);

      if (areBothPlayersOffline(room)) {
        if (!room.bothOfflineSince) {
          room.bothOfflineSince = new Date();
        }

        await emitSystemRoomMessage(
          room,
          "雙方玩家皆已離線。若 3 分鐘內無人重新連線，本局將自動結束且不計分。"
        );
      } else {
        room.bothOfflineSince = null;

        await emitSystemRoomMessage(
          room,
          isBattleRoyaleRoom(room)
            ? `${player.name} 暫時離線，系統將保留棋局 3 分鐘；大逃殺縮圈倒數已暫停。`
            : `${player.name} 暫時離線，系統將保留棋局 3 分鐘。`
        );
      }

      emitRoomState(room);
      scheduleDisconnectTimeout(room, player);
    } else {
      rooms.delete(roomId);
    }
  });
});

// ==========================================
// API
// ==========================================
app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    service: "gomoku-online",
    mongoReady: isMongoConnected(),
    onlineCount: onlineVisitors.size,
    timestamp: new Date().toISOString()
  });
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

app.get("/api/games", async (_req, res) => {
  try {
    const games = await Game.find({}).sort({ endedAt: -1 }).limit(20).lean();
    res.json({ success: true, count: games.length, data: games });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 僅提供測試用摘要，不回傳 playerToken。
app.get("/api/active-rooms", async (_req, res) => {
  try {
    const activeRooms = await ActiveRoom.find({ status: "playing" })
      .sort({ updatedAt: -1 })
      .select({ roomId: 1, seriesId: 1, round: 1, mode: 1, activeMin: 1, activeMax: 1, rotationCount: 1, movesSinceLastRotation: 1, players: 1, currentTurn: 1, updatedAt: 1 })
      .lean();

    const safeRooms = activeRooms.map((room) => ({
      roomId: room.roomId,
      seriesId: room.seriesId,
      round: room.round,
      mode: cleanGameMode(room.mode),
      activeBoardSize: Number(room.activeMax ?? BOARD_SIZE - 1) - Number(room.activeMin ?? 0) + 1,
      rotationCount: Number(room.rotationCount || 0),
      movesUntilRotation: Math.max(0, ROTATING_BOARD_MOVES_PER_ROTATION - Number(room.movesSinceLastRotation || 0)),
      currentTurn: room.currentTurn,
      updatedAt: room.updatedAt,
      players: room.players.map((player) => ({
        name: player.name,
        color: player.color
      }))
    }));

    res.json({ success: true, count: safeRooms.length, data: safeRooms });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/spectatable-rooms", async (_req, res) => {
  try {
    const spectatableRooms = await getSpectatableRooms();
    res.json({ success: true, count: spectatableRooms.length, data: spectatableRooms });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// 啟動 Server
// ==========================================
// ==========================================
// 每分鐘重新廣播可觀戰清單
//
// 即使沒有玩家手動按重新整理，
// 已失效的房間也會自動從畫面移除。
// ==========================================
setInterval(() => {
  if (!isMongoConnected()) {
    return;
  }

  broadcastSpectatableRooms()
    .catch((error) => {
      console.error(
        "❌ 自動更新觀戰清單失敗：",
        error.message
      );
    });
}, 60 * 1000);

// 每分鐘清理雙方離線過久，或修改前留下的殘留房間。
setInterval(() => {
  cleanupAbandonedRooms().catch((error) => {
    console.error("❌ 自動清理離線房間失敗：", error.message);
  });
}, ABANDONED_ROOM_CHECK_INTERVAL_MS);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server 已啟動");
  console.log(`🌐 本機網址：http://localhost:${PORT}`);
});
