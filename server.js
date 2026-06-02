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
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// ==========================================
// MongoDB 連線
// ==========================================
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB Atlas 連線成功");
  })
  .catch((error) => {
    console.error("❌ MongoDB Atlas 連線失敗");
    console.error(error.message);
  });

// ==========================================
// MongoDB Schema
// ==========================================
const gameSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      unique: true
    },

    // 若是再來一局，記錄上一個房間編號
    previousRoomId: {
      type: String,
      default: null
    },

    // 第幾局
    round: {
      type: Number,
      default: 1
    },

    players: [
      {
        socketId: String,
        name: String,
        color: String
      }
    ],

    board: {
      type: [Number],
      default: () => Array(225).fill(0)
    },

    currentTurn: {
      type: String,
      default: "black"
    },

    status: {
      type: String,
      enum: ["playing", "finished"],
      default: "playing"
    },

    winner: {
      type: String,
      default: null
    },

    moves: [
      {
        x: Number,
        y: Number,
        color: String,
        playerName: String,
        createdAt: {
          type: Date,
          default: Date.now
        }
      }
    ]
  },
  {
    timestamps: true
  }
);

const Game = mongoose.model("Game", gameSchema);

// ==========================================
// 遊戲暫存資料
// ==========================================
const BOARD_SIZE = 15;

// 等待公開配對的玩家
const waitingPlayers = [];

// 正在進行或等待再來一局的房間
const rooms = new Map();

// ==========================================
// 輔助函式
// ==========================================
function generateRoomId() {
  return `ROOM-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function removeFromWaitingQueue(socketId) {
  const index = waitingPlayers.findIndex(
    (player) => player.socketId === socketId
  );

  if (index !== -1) {
    waitingPlayers.splice(index, 1);
  }
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
      count++;
      nextX += dx;
      nextY += dy;
    }

    nextX = x - dx;
    nextY = y - dy;

    while (
      isValidPosition(nextX, nextY) &&
      board[getBoardIndex(nextX, nextY)] === stoneValue
    ) {
      count++;
      nextX -= dx;
      nextY -= dy;
    }

    if (count >= 5) {
      return true;
    }
  }

  return false;
}

function getPlayerColor(room, socketId) {
  const player = room.players.find(
    (item) => item.socketId === socketId
  );

  return player ? player.color : null;
}

function getPlayerName(room, socketId) {
  const player = room.players.find(
    (item) => item.socketId === socketId
  );

  return player ? player.name : "未知玩家";
}

function buildRoomState(room) {
  return {
    roomId: room.roomId,
    round: room.round,
    board: room.board,

    players: room.players.map((player) => ({
      name: player.name,
      color: player.color
    })),

    currentTurn: room.currentTurn,
    status: room.status,
    winner: room.winner
  };
}

// ==========================================
// 建立第一局
// ==========================================
async function startGame(player1, player2) {
  const roomId = generateRoomId();

  const room = {
    roomId,
    previousRoomId: null,
    round: 1,

    board: Array(225).fill(0),

    players: [
      {
        socketId: player1.socketId,
        name: player1.name,
        color: "black"
      },
      {
        socketId: player2.socketId,
        name: player2.name,
        color: "white"
      }
    ],

    currentTurn: "black",
    status: "playing",
    winner: null,

    // 使用 Set，避免同一位玩家重複投票
    rematchVotes: new Set(),

    // 避免雙方同時按下後重複建立房間
    rematchStarting: false
  };

  rooms.set(roomId, room);

  player1.socket.join(roomId);
  player2.socket.join(roomId);

  player1.socket.data.roomId = roomId;
  player2.socket.data.roomId = roomId;

  await Game.create({
    roomId: room.roomId,
    previousRoomId: room.previousRoomId,
    round: room.round,
    players: room.players,
    board: room.board,
    currentTurn: room.currentTurn,
    status: room.status,
    winner: room.winner,
    moves: []
  });

  io.to(player1.socketId).emit("gameStarted", {
    roomId,
    myColor: "black",
    round: room.round
  });

  io.to(player2.socketId).emit("gameStarted", {
    roomId,
    myColor: "white",
    round: room.round
  });

  io.to(roomId).emit("gameState", buildRoomState(room));

  console.log(`🎮 房間建立成功：${roomId}`);
  console.log(`⚫ 黑棋：${player1.name}`);
  console.log(`⚪ 白棋：${player2.name}`);
}

// ==========================================
// 新增：與同一組玩家開始下一局
// ==========================================
async function startRematch(oldRoom) {
  const oldRoomId = oldRoom.roomId;
  const newRoomId = generateRoomId();

  // 交換黑白棋，讓雙方輪流先下
  const newPlayers = oldRoom.players.map((player) => ({
    socketId: player.socketId,
    name: player.name,
    color: getOppositeColor(player.color)
  }));

  const playerSockets = newPlayers.map((player) =>
    io.sockets.sockets.get(player.socketId)
  );

  // 避免其中一位玩家已經離線
  if (playerSockets.some((playerSocket) => !playerSocket)) {
    throw new Error("其中一位玩家已經離線");
  }

  const newRoom = {
    roomId: newRoomId,
    previousRoomId: oldRoomId,
    round: (oldRoom.round || 1) + 1,

    board: Array(225).fill(0),

    players: newPlayers,

    currentTurn: "black",
    status: "playing",
    winner: null,

    rematchVotes: new Set(),
    rematchStarting: false
  };

  // 每一局都建立新的 MongoDB 紀錄
  // 不會覆蓋上一局棋譜
  await Game.create({
    roomId: newRoom.roomId,
    previousRoomId: newRoom.previousRoomId,
    round: newRoom.round,
    players: newRoom.players,
    board: newRoom.board,
    currentTurn: newRoom.currentTurn,
    status: newRoom.status,
    winner: newRoom.winner,
    moves: []
  });

  rooms.set(newRoomId, newRoom);

  // 讓原本兩位玩家離開舊房間並加入新房間
  newPlayers.forEach((player, index) => {
    const playerSocket = playerSockets[index];

    playerSocket.leave(oldRoomId);
    playerSocket.join(newRoomId);
    playerSocket.data.roomId = newRoomId;

    io.to(player.socketId).emit("rematchStarted", {
      roomId: newRoomId,
      myColor: player.color,
      round: newRoom.round
    });
  });

  io.to(newRoomId).emit("gameState", buildRoomState(newRoom));

  rooms.delete(oldRoomId);

  console.log(`🔄 同一組玩家開始第 ${newRoom.round} 局`);
  console.log(`🎮 新房間：${newRoomId}`);
}

// ==========================================
// Socket.IO 即時連線
// ==========================================
io.on("connection", (socket) => {
  console.log(`🔌 玩家連線：${socket.id}`);

  // ========================================
  // 加入公開配對
  // ========================================
  socket.on("joinQueue", async (data) => {
    const name = String(data?.name || "").trim();

    if (!name) {
      socket.emit("errorMessage", "請先輸入玩家名稱");
      return;
    }

    removeFromWaitingQueue(socket.id);

    const player = {
      socketId: socket.id,
      socket,
      name
    };

    waitingPlayers.push(player);

    socket.emit("queueStatus", {
      message: "等待另一位玩家加入..."
    });

    console.log(`⏳ ${name} 正在等待配對`);

    if (waitingPlayers.length >= 2) {
      const player1 = waitingPlayers.shift();
      const player2 = waitingPlayers.shift();

      try {
        await startGame(player1, player2);
      } catch (error) {
        console.error("❌ 建立遊戲失敗：", error.message);

        io.to(player1.socketId).emit(
          "errorMessage",
          "建立遊戲失敗，請重新整理頁面"
        );

        io.to(player2.socketId).emit(
          "errorMessage",
          "建立遊戲失敗，請重新整理頁面"
        );
      }
    }
  });

  // ========================================
  // 玩家落子
  // ========================================
  socket.on("makeMove", async (data) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit("errorMessage", "找不到目前的遊戲房間");
      return;
    }

    if (room.status !== "playing") {
      socket.emit("errorMessage", "這場遊戲已經結束");
      return;
    }

    const x = Number(data?.x);
    const y = Number(data?.y);

    if (!isValidPosition(x, y)) {
      socket.emit("errorMessage", "落子位置錯誤");
      return;
    }

    const playerColor = getPlayerColor(room, socket.id);

    if (!playerColor) {
      socket.emit("errorMessage", "您不是這個房間的玩家");
      return;
    }

    if (room.currentTurn !== playerColor) {
      socket.emit("errorMessage", "現在還沒輪到您");
      return;
    }

    const index = getBoardIndex(x, y);

    if (room.board[index] !== 0) {
      socket.emit("errorMessage", "這個位置已經有棋子");
      return;
    }

    const stoneValue = playerColor === "black" ? 1 : 2;

    room.board[index] = stoneValue;

    const playerName = getPlayerName(room, socket.id);

    const move = {
      x,
      y,
      color: playerColor,
      playerName,
      createdAt: new Date()
    };

    const isWinner = checkWin(room.board, x, y, stoneValue);

    const isDraw =
      !isWinner &&
      room.board.every((cell) => cell !== 0);

    if (isWinner) {
      room.status = "finished";
      room.winner = playerColor;
    } else if (isDraw) {
      room.status = "finished";
      room.winner = "draw";
    } else {
      room.currentTurn = getOppositeColor(playerColor);
    }

    try {
      await Game.updateOne(
        { roomId },
        {
          $set: {
            board: room.board,
            currentTurn: room.currentTurn,
            status: room.status,
            winner: room.winner
          },

          $push: {
            moves: move
          }
        }
      );
    } catch (error) {
      console.error("❌ 寫入 MongoDB 失敗：", error.message);
    }

    io.to(roomId).emit("gameState", buildRoomState(room));

    if (isWinner) {
      io.to(roomId).emit("gameOver", {
        winner: playerColor,
        winnerName: playerName
      });

      console.log(`🏆 ${playerName} 獲勝，房間：${roomId}`);
    }

    if (isDraw) {
      io.to(roomId).emit("gameOver", {
        winner: "draw",
        winnerName: "平手"
      });

      console.log(`🤝 平手，房間：${roomId}`);
    }
  });

  // ========================================
  // 新增：要求與同一位玩家再來一局
  // ========================================
  socket.on("requestRematch", async () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit("errorMessage", "找不到目前的遊戲房間");
      return;
    }

    if (room.status !== "finished") {
      socket.emit("errorMessage", "目前遊戲尚未結束");
      return;
    }

    const isPlayer = room.players.some(
      (player) => player.socketId === socket.id
    );

    if (!isPlayer) {
      socket.emit("errorMessage", "您不是這個房間的玩家");
      return;
    }

    room.rematchVotes.add(socket.id);

    io.to(roomId).emit("rematchStatus", {
      accepted: room.rematchVotes.size,
      total: room.players.length
    });

    if (
      room.rematchVotes.size === room.players.length &&
      !room.rematchStarting
    ) {
      room.rematchStarting = true;

      try {
        await startRematch(room);
      } catch (error) {
        room.rematchStarting = false;

        console.error("❌ 再來一局失敗：", error.message);

        io.to(roomId).emit("errorMessage", "再來一局失敗，請重新配對");
      }
    }
  });

  // ========================================
  // 玩家離線
  // ========================================
  socket.on("disconnect", async () => {
    console.log(`❌ 玩家離線：${socket.id}`);

    removeFromWaitingQueue(socket.id);

    const roomId = socket.data.roomId;

    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);

    if (!room) {
      return;
    }

    const disconnectedColor = getPlayerColor(room, socket.id);

    if (!disconnectedColor) {
      return;
    }

    // 遊戲結束後，有玩家離線
    // 代表不能繼續再來一局
    if (room.status === "finished") {
      io.to(roomId).emit("rematchUnavailable", {
        message: "對手已離線，無法再來一局"
      });

      rooms.delete(roomId);
      return;
    }

    // 遊戲進行中，有玩家中途離線
    const winnerColor = getOppositeColor(disconnectedColor);

    room.status = "finished";
    room.winner = winnerColor;

    try {
      await Game.updateOne(
        { roomId },
        {
          $set: {
            status: room.status,
            winner: room.winner
          }
        }
      );
    } catch (error) {
      console.error("❌ 更新離線狀態失敗：", error.message);
    }

    io.to(roomId).emit("opponentDisconnected", {
      winner: winnerColor
    });

    rooms.delete(roomId);
  });
});

// ==========================================
// 測試 API
// ==========================================
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "五子棋後端正常運作"
  });
});

app.get("/api/games", async (req, res) => {
  try {
    const games = await Game.find()
      .sort({ createdAt: -1 })
      .limit(20);

    res.json({
      success: true,
      data: games
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ==========================================
// 啟動 Server
// ==========================================
server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server 已啟動");
  console.log(`🌐 本機網址：http://localhost:${PORT}`);
});