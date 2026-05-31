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

// 等待配對的玩家
const waitingPlayers = [];

// 已建立的房間
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

async function startGame(player1, player2) {
  const roomId = generateRoomId();

  const room = {
    roomId,
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
    winner: null
  };

  rooms.set(roomId, room);

  player1.socket.join(roomId);
  player2.socket.join(roomId);

  player1.socket.data.roomId = roomId;
  player2.socket.data.roomId = roomId;

  await Game.create(room);

  io.to(player1.socketId).emit("gameStarted", {
    roomId,
    myColor: "black"
  });

  io.to(player2.socketId).emit("gameStarted", {
    roomId,
    myColor: "white"
  });

  io.to(roomId).emit("gameState", buildRoomState(room));

  console.log(`🎮 房間建立成功：${roomId}`);
  console.log(`⚫ 黑棋：${player1.name}`);
  console.log(`⚪ 白棋：${player2.name}`);
}

// ==========================================
// Socket.IO 即時連線
// ==========================================
io.on("connection", (socket) => {
  console.log(`🔌 玩家連線：${socket.id}`);

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

    if (isWinner) {
      room.status = "finished";
      room.winner = playerColor;
    } else {
      room.currentTurn =
        playerColor === "black" ? "white" : "black";
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
  });

  socket.on("disconnect", async () => {
    console.log(`❌ 玩家離線：${socket.id}`);

    removeFromWaitingQueue(socket.id);

    const roomId = socket.data.roomId;

    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);

    if (!room || room.status !== "playing") {
      return;
    }

    const disconnectedColor = getPlayerColor(room, socket.id);

    if (!disconnectedColor) {
      return;
    }

    const winnerColor =
      disconnectedColor === "black" ? "white" : "black";

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
  console.log(`🚀 Server 已啟動`);
  console.log(`🌐 本機網址：http://localhost:${PORT}`);
});