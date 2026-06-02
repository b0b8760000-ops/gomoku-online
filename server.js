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

const PORT =
  process.env.PORT || 3000;

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
// MongoDB：棋譜 Schema
// ==========================================
const gameSchema =
  new mongoose.Schema(
    {
      roomId: {
        type: String,
        required: true,
        unique: true
      },

      previousRoomId: {
        type: String,
        default: null
      },

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
        default: () =>
          Array(225).fill(0)
      },

      currentTurn: {
        type: String,
        default: "black"
      },

      status: {
        type: String,
        enum: [
          "playing",
          "finished"
        ],
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

const Game =
  mongoose.model("Game", gameSchema);

// ==========================================
// MongoDB：排行榜 Schema
// ==========================================
const playerStatsSchema =
  new mongoose.Schema(
    {
      normalizedName: {
        type: String,
        required: true,
        unique: true
      },

      displayName: {
        type: String,
        required: true
      },

      points: {
        type: Number,
        default: 0
      },

      wins: {
        type: Number,
        default: 0
      },

      losses: {
        type: Number,
        default: 0
      },

      draws: {
        type: Number,
        default: 0
      },

      gamesPlayed: {
        type: Number,
        default: 0
      }
    },
    {
      timestamps: true,
      collection: "players"
    }
  );

const PlayerStats =
  mongoose.model(
    "PlayerStats",
    playerStatsSchema
  );

// ==========================================
// 暫存資料
// ==========================================
const BOARD_SIZE = 15;

const waitingPlayers = [];

const rooms = new Map();

// ==========================================
// 通用輔助函式
// ==========================================
function generateRoomId() {
  return (
    `ROOM-${Date.now()}-` +
    `${Math.floor(Math.random() * 10000)}`
  );
}

function cleanPlayerName(name) {
  return String(name || "")
    .trim()
    .slice(0, 20);
}

function normalizePlayerName(name) {
  return cleanPlayerName(name)
    .toLowerCase();
}

function cleanChatMessage(message) {
  return String(message || "")
    .trim()
    .slice(0, 120);
}

function removeFromWaitingQueue(
  socketId
) {
  const index =
    waitingPlayers.findIndex(
      (player) =>
        player.socketId === socketId
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
  return color === "black"
    ? "white"
    : "black";
}

function getPlayerColor(
  room,
  socketId
) {
  const player =
    room.players.find(
      (item) =>
        item.socketId === socketId
    );

  return player
    ? player.color
    : null;
}

function getPlayerName(
  room,
  socketId
) {
  const player =
    room.players.find(
      (item) =>
        item.socketId === socketId
    );

  return player
    ? player.name
    : "未知玩家";
}

function getOpponent(
  room,
  socketId
) {
  return room.players.find(
    (player) =>
      player.socketId !== socketId
  );
}

function checkWin(
  board,
  x,
  y,
  stoneValue
) {
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
      board[
        getBoardIndex(nextX, nextY)
      ] === stoneValue
    ) {
      count++;

      nextX += dx;
      nextY += dy;
    }

    nextX = x - dx;
    nextY = y - dy;

    while (
      isValidPosition(nextX, nextY) &&
      board[
        getBoardIndex(nextX, nextY)
      ] === stoneValue
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

function buildRoomState(room) {
  const lastMove =
    room.moves[
      room.moves.length - 1
    ];

  return {
    roomId: room.roomId,
    round: room.round,
    board: room.board,

    players:
      room.players.map(
        (player) => ({
          name: player.name,
          color: player.color
        })
      ),

    currentTurn:
      room.currentTurn,

    status:
      room.status,

    winner:
      room.winner,

    moveCount:
      room.moves.length,

    lastMoveColor:
      lastMove
        ? lastMove.color
        : null,

    undoPending:
      Boolean(room.undoRequest)
  };
}

// ==========================================
// 排行榜
// ==========================================
async function getLeaderboard() {
  return PlayerStats
    .find()
    .sort({
      points: -1,
      wins: -1,
      gamesPlayed: 1,
      updatedAt: 1
    })
    .limit(10)
    .lean();
}

async function broadcastLeaderboard() {
  try {
    const leaderboard =
      await getLeaderboard();

    io.emit(
      "leaderboardUpdated",
      leaderboard
    );
  } catch (error) {
    console.error(
      "❌ 讀取排行榜失敗：",
      error.message
    );
  }
}

async function updatePlayerStats(
  name,
  increments
) {
  await PlayerStats.updateOne(
    {
      normalizedName:
        normalizePlayerName(name)
    },
    {
      $set: {
        displayName:
          cleanPlayerName(name)
      },

      $inc: increments
    },
    {
      upsert: true
    }
  );
}

async function recordResult(
  room,
  winnerColor
) {
  if (room.scoreRecorded) {
    return;
  }

  room.scoreRecorded = true;

  const blackPlayer =
    room.players.find(
      (player) =>
        player.color === "black"
    );

  const whitePlayer =
    room.players.find(
      (player) =>
        player.color === "white"
    );

  if (
    !blackPlayer ||
    !whitePlayer
  ) {
    return;
  }

  try {
    if (winnerColor === "draw") {
      await updatePlayerStats(
        blackPlayer.name,
        {
          points: 1,
          draws: 1,
          gamesPlayed: 1
        }
      );

      await updatePlayerStats(
        whitePlayer.name,
        {
          points: 1,
          draws: 1,
          gamesPlayed: 1
        }
      );
    } else {
      const winner =
        winnerColor === "black"
          ? blackPlayer
          : whitePlayer;

      const loser =
        winnerColor === "black"
          ? whitePlayer
          : blackPlayer;

      await updatePlayerStats(
        winner.name,
        {
          points: 3,
          wins: 1,
          gamesPlayed: 1
        }
      );

      await updatePlayerStats(
        loser.name,
        {
          losses: 1,
          gamesPlayed: 1
        }
      );
    }

    await broadcastLeaderboard();
  } catch (error) {
    console.error(
      "❌ 更新排行榜失敗：",
      error.message
    );
  }
}

// ==========================================
// 聊天室
// ==========================================
function emitSystemChat(
  roomId,
  message
) {
  io.to(roomId).emit(
    "chatMessage",
    {
      type: "system",
      message,
      createdAt:
        new Date().toISOString()
    }
  );
}

// ==========================================
// 建立第一局
// ==========================================
async function startGame(
  player1,
  player2
) {
  const roomId =
    generateRoomId();

  const room = {
    roomId,

    previousRoomId: null,

    round: 1,

    board:
      Array(225).fill(0),

    players: [
      {
        socketId:
          player1.socketId,

        name:
          player1.name,

        color:
          "black"
      },

      {
        socketId:
          player2.socketId,

        name:
          player2.name,

        color:
          "white"
      }
    ],

    currentTurn:
      "black",

    status:
      "playing",

    winner:
      null,

    moves:
      [],

    chatMessages:
      [],

    undoRequest:
      null,

    rematchVotes:
      new Set(),

    rematchStarting:
      false,

    scoreRecorded:
      false
  };

  rooms.set(roomId, room);

  player1.socket.join(roomId);

  player2.socket.join(roomId);

  player1.socket.data.roomId =
    roomId;

  player2.socket.data.roomId =
    roomId;

  await Game.create({
    roomId:
      room.roomId,

    previousRoomId:
      room.previousRoomId,

    round:
      room.round,

    players:
      room.players,

    board:
      room.board,

    currentTurn:
      room.currentTurn,

    status:
      room.status,

    winner:
      room.winner,

    moves:
      []
  });

  io.to(
    player1.socketId
  ).emit(
    "gameStarted",
    {
      roomId,
      myColor: "black",
      round: room.round
    }
  );

  io.to(
    player2.socketId
  ).emit(
    "gameStarted",
    {
      roomId,
      myColor: "white",
      round: room.round
    }
  );

  io.to(roomId).emit(
    "gameState",
    buildRoomState(room)
  );

  emitSystemChat(
    roomId,
    "配對成功，第 1 局開始，黑棋先行。"
  );

  console.log(
    `🎮 房間建立成功：${roomId}`
  );
}

// ==========================================
// 與同一組玩家開始下一局
// ==========================================
async function startRematch(
  oldRoom
) {
  const oldRoomId =
    oldRoom.roomId;

  const newRoomId =
    generateRoomId();

  const newPlayers =
    oldRoom.players.map(
      (player) => ({
        socketId:
          player.socketId,

        name:
          player.name,

        color:
          getOppositeColor(
            player.color
          )
      })
    );

  const playerSockets =
    newPlayers.map(
      (player) =>
        io.sockets.sockets.get(
          player.socketId
        )
    );

  if (
    playerSockets.some(
      (playerSocket) =>
        !playerSocket
    )
  ) {
    throw new Error(
      "其中一位玩家已經離線"
    );
  }

  const newRoom = {
    roomId:
      newRoomId,

    previousRoomId:
      oldRoomId,

    round:
      (oldRoom.round || 1) + 1,

    board:
      Array(225).fill(0),

    players:
      newPlayers,

    currentTurn:
      "black",

    status:
      "playing",

    winner:
      null,

    moves:
      [],

    chatMessages:
      oldRoom.chatMessages
        .slice(-50),

    undoRequest:
      null,

    rematchVotes:
      new Set(),

    rematchStarting:
      false,

    scoreRecorded:
      false
  };

  await Game.create({
    roomId:
      newRoom.roomId,

    previousRoomId:
      newRoom.previousRoomId,

    round:
      newRoom.round,

    players:
      newRoom.players,

    board:
      newRoom.board,

    currentTurn:
      newRoom.currentTurn,

    status:
      newRoom.status,

    winner:
      newRoom.winner,

    moves:
      []
  });

  rooms.set(newRoomId, newRoom);

  newPlayers.forEach(
    (player, index) => {
      const playerSocket =
        playerSockets[index];

      playerSocket.leave(
        oldRoomId
      );

      playerSocket.join(
        newRoomId
      );

      playerSocket.data.roomId =
        newRoomId;

      io.to(
        player.socketId
      ).emit(
        "rematchStarted",
        {
          roomId:
            newRoomId,

          myColor:
            player.color,

          round:
            newRoom.round
        }
      );
    }
  );

  io.to(newRoomId).emit(
    "gameState",
    buildRoomState(newRoom)
  );

  io.to(newRoomId).emit(
    "chatHistory",
    newRoom.chatMessages
  );

  emitSystemChat(
    newRoomId,
    `雙方同意繼續，第 ${newRoom.round} 局開始，黑棋先行。`
  );

  rooms.delete(oldRoomId);

  console.log(
    `🔄 第 ${newRoom.round} 局開始：${newRoomId}`
  );
}

// ==========================================
// Socket.IO
// ==========================================
io.on(
  "connection",
  (socket) => {
    console.log(
      `🔌 玩家連線：${socket.id}`
    );

    // ======================================
    // 初次取得排行榜
    // ======================================
    socket.on(
      "getLeaderboard",
      async () => {
        try {
          const leaderboard =
            await getLeaderboard();

          socket.emit(
            "leaderboardUpdated",
            leaderboard
          );
        } catch (error) {
          console.error(
            "❌ 讀取排行榜失敗：",
            error.message
          );
        }
      }
    );

    // ======================================
    // 加入公開配對
    // ======================================
    socket.on(
      "joinQueue",
      async (data) => {
        const name =
          cleanPlayerName(
            data?.name
          );

        if (!name) {
          socket.emit(
            "errorMessage",
            "請先輸入玩家名稱"
          );

          return;
        }

        removeFromWaitingQueue(
          socket.id
        );

        const player = {
          socketId:
            socket.id,

          socket,

          name
        };

        waitingPlayers.push(
          player
        );

        socket.emit(
          "queueStatus",
          {
            message:
              "等待另一位玩家加入..."
          }
        );

        console.log(
          `⏳ ${name} 正在等待配對`
        );

        if (
          waitingPlayers.length >= 2
        ) {
          const player1 =
            waitingPlayers.shift();

          const player2 =
            waitingPlayers.shift();

          try {
            await startGame(
              player1,
              player2
            );
          } catch (error) {
            console.error(
              "❌ 建立遊戲失敗：",
              error.message
            );

            io.to(
              player1.socketId
            ).emit(
              "errorMessage",
              "建立遊戲失敗，請重新整理頁面"
            );

            io.to(
              player2.socketId
            ).emit(
              "errorMessage",
              "建立遊戲失敗，請重新整理頁面"
            );
          }
        }
      }
    );

    // ======================================
    // 玩家落子
    // ======================================
    socket.on(
      "makeMove",
      async (data) => {
        const roomId =
          socket.data.roomId;

        const room =
          rooms.get(roomId);

        if (!room) {
          socket.emit(
            "errorMessage",
            "找不到目前的遊戲房間"
          );

          return;
        }

        if (
          room.status !==
          "playing"
        ) {
          socket.emit(
            "errorMessage",
            "這場遊戲已經結束"
          );

          return;
        }

        if (room.undoRequest) {
          socket.emit(
            "errorMessage",
            "請先完成悔棋處理"
          );

          return;
        }

        const x =
          Number(data?.x);

        const y =
          Number(data?.y);

        if (
          !isValidPosition(x, y)
        ) {
          socket.emit(
            "errorMessage",
            "落子位置錯誤"
          );

          return;
        }

        const playerColor =
          getPlayerColor(
            room,
            socket.id
          );

        if (!playerColor) {
          socket.emit(
            "errorMessage",
            "您不是這個房間的玩家"
          );

          return;
        }

        if (
          room.currentTurn !==
          playerColor
        ) {
          socket.emit(
            "errorMessage",
            "現在還沒輪到您"
          );

          return;
        }

        const index =
          getBoardIndex(x, y);

        if (
          room.board[index] !== 0
        ) {
          socket.emit(
            "errorMessage",
            "這個位置已經有棋子"
          );

          return;
        }

        const stoneValue =
          playerColor === "black"
            ? 1
            : 2;

        room.board[index] =
          stoneValue;

        const playerName =
          getPlayerName(
            room,
            socket.id
          );

        const move = {
          x,
          y,
          color:
            playerColor,

          playerName,

          createdAt:
            new Date()
        };

        room.moves.push(move);

        const isWinner =
          checkWin(
            room.board,
            x,
            y,
            stoneValue
          );

        const isDraw =
          !isWinner &&
          room.board.every(
            (cell) =>
              cell !== 0
          );

        if (isWinner) {
          room.status =
            "finished";

          room.winner =
            playerColor;
        } else if (isDraw) {
          room.status =
            "finished";

          room.winner =
            "draw";
        } else {
          room.currentTurn =
            getOppositeColor(
              playerColor
            );
        }

        try {
          await Game.updateOne(
            {
              roomId
            },
            {
              $set: {
                board:
                  room.board,

                currentTurn:
                  room.currentTurn,

                status:
                  room.status,

                winner:
                  room.winner
              },

              $push: {
                moves:
                  move
              }
            }
          );
        } catch (error) {
          console.error(
            "❌ 寫入 MongoDB 失敗：",
            error.message
          );
        }

        io.to(roomId).emit(
          "gameState",
          buildRoomState(room)
        );

        if (isWinner) {
          await recordResult(
            room,
            playerColor
          );

          io.to(roomId).emit(
            "gameOver",
            {
              winner:
                playerColor,

              winnerName:
                playerName
            }
          );

          console.log(
            `🏆 ${playerName} 獲勝：${roomId}`
          );
        }

        if (isDraw) {
          await recordResult(
            room,
            "draw"
          );

          io.to(roomId).emit(
            "gameOver",
            {
              winner:
                "draw",

              winnerName:
                "平手"
            }
          );

          console.log(
            `🤝 平手：${roomId}`
          );
        }
      }
    );

    // ======================================
    // 新增：悔棋申請
    // ======================================
    socket.on(
      "requestUndo",
      () => {
        const roomId =
          socket.data.roomId;

        const room =
          rooms.get(roomId);

        if (!room) {
          socket.emit(
            "errorMessage",
            "找不到目前的遊戲房間"
          );

          return;
        }

        if (
          room.status !==
          "playing"
        ) {
          socket.emit(
            "errorMessage",
            "遊戲結束後無法悔棋"
          );

          return;
        }

        if (room.undoRequest) {
          socket.emit(
            "errorMessage",
            "目前已有悔棋申請"
          );

          return;
        }

        const lastMove =
          room.moves[
            room.moves.length - 1
          ];

        if (!lastMove) {
          socket.emit(
            "errorMessage",
            "目前沒有可以撤回的棋子"
          );

          return;
        }

        const playerColor =
          getPlayerColor(
            room,
            socket.id
          );

        if (
          lastMove.color !==
          playerColor
        ) {
          socket.emit(
            "errorMessage",
            "只能撤回自己剛剛落下的最後一步"
          );

          return;
        }

        const requesterName =
          getPlayerName(
            room,
            socket.id
          );

        const opponent =
          getOpponent(
            room,
            socket.id
          );

        if (!opponent) {
          socket.emit(
            "errorMessage",
            "找不到對手"
          );

          return;
        }

        room.undoRequest = {
          requesterSocketId:
            socket.id,

          requesterName
        };

        io.to(roomId).emit(
          "undoStatus",
          {
            status:
              "pending",

            requesterName
          }
        );

        io.to(
          opponent.socketId
        ).emit(
          "undoRequestReceived",
          {
            requesterName
          }
        );
      }
    );

    // ======================================
    // 新增：回應悔棋申請
    // ======================================
    socket.on(
      "respondUndo",
      async (data) => {
        const roomId =
          socket.data.roomId;

        const room =
          rooms.get(roomId);

        if (
          !room ||
          !room.undoRequest
        ) {
          socket.emit(
            "errorMessage",
            "目前沒有待處理的悔棋申請"
          );

          return;
        }

        if (
          room.undoRequest
            .requesterSocketId ===
          socket.id
        ) {
          socket.emit(
            "errorMessage",
            "不能回應自己的悔棋申請"
          );

          return;
        }

        const accepted =
          Boolean(data?.accept);

        if (!accepted) {
          room.undoRequest =
            null;

          io.to(roomId).emit(
            "undoStatus",
            {
              status:
                "resolved"
            }
          );

          io.to(roomId).emit(
            "undoResolved",
            {
              accepted:
                false
            }
          );

          return;
        }

        const removedMove =
          room.moves.pop();

        if (!removedMove) {
          room.undoRequest =
            null;

          return;
        }

        room.board[
          getBoardIndex(
            removedMove.x,
            removedMove.y
          )
        ] = 0;

        room.currentTurn =
          removedMove.color;

        room.undoRequest =
          null;

        try {
          await Game.updateOne(
            {
              roomId
            },
            {
              $set: {
                board:
                  room.board,

                currentTurn:
                  room.currentTurn
              },

              $pop: {
                moves: 1
              }
            }
          );
        } catch (error) {
          console.error(
            "❌ 更新悔棋紀錄失敗：",
            error.message
          );
        }

        io.to(roomId).emit(
          "undoStatus",
          {
            status:
              "resolved"
          }
        );

        io.to(roomId).emit(
          "gameState",
          buildRoomState(room)
        );

        io.to(roomId).emit(
          "undoResolved",
          {
            accepted:
              true
          }
        );

        emitSystemChat(
          roomId,
          `${removedMove.playerName} 的最後一步已撤回。`
        );
      }
    );

    // ======================================
    // 新增：聊天室
    // ======================================
    socket.on(
      "sendChatMessage",
      (data) => {
        const roomId =
          socket.data.roomId;

        const room =
          rooms.get(roomId);

        if (!room) {
          socket.emit(
            "errorMessage",
            "請先加入遊戲房間"
          );

          return;
        }

        const message =
          cleanChatMessage(
            data?.message
          );

        if (!message) {
          return;
        }

        const playerName =
          getPlayerName(
            room,
            socket.id
          );

        const chatMessage = {
          type:
            "player",

          playerName,

          message,

          createdAt:
            new Date().toISOString()
        };

        room.chatMessages.push(
          chatMessage
        );

        if (
          room.chatMessages.length >
          50
        ) {
          room.chatMessages.shift();
        }

        io.to(roomId).emit(
          "chatMessage",
          chatMessage
        );
      }
    );

    // ======================================
    // 再戰申請
    // ======================================
    socket.on(
      "requestRematch",
      async () => {
        const roomId =
          socket.data.roomId;

        const room =
          rooms.get(roomId);

        if (!room) {
          socket.emit(
            "errorMessage",
            "找不到目前的遊戲房間"
          );

          return;
        }

        if (
          room.status !==
          "finished"
        ) {
          socket.emit(
            "errorMessage",
            "目前遊戲尚未結束"
          );

          return;
        }

        const isPlayer =
          room.players.some(
            (player) =>
              player.socketId ===
              socket.id
          );

        if (!isPlayer) {
          return;
        }

        room.rematchVotes.add(
          socket.id
        );

        io.to(roomId).emit(
          "rematchStatus",
          {
            accepted:
              room.rematchVotes.size,

            total:
              room.players.length
          }
        );

        if (
          room.rematchVotes.size ===
            room.players.length &&
          !room.rematchStarting
        ) {
          room.rematchStarting =
            true;

          try {
            await startRematch(
              room
            );
          } catch (error) {
            room.rematchStarting =
              false;

            console.error(
              "❌ 再來一局失敗：",
              error.message
            );

            io.to(roomId).emit(
              "errorMessage",
              "再來一局失敗，請重新配對"
            );
          }
        }
      }
    );

    // ======================================
    // 主動返回首頁
    // ======================================
    socket.on(
      "leaveRoom",
      async () => {
        const roomId =
          socket.data.roomId;

        if (!roomId) {
          return;
        }

        const room =
          rooms.get(roomId);

        socket.leave(roomId);

        socket.data.roomId =
          null;

        if (!room) {
          return;
        }

        const leavingPlayer =
          room.players.find(
            (player) =>
              player.socketId ===
              socket.id
          );

        const opponent =
          getOpponent(
            room,
            socket.id
          );

        const opponentSocket =
          opponent
            ? io.sockets.sockets.get(
                opponent.socketId
              )
            : null;

        if (opponentSocket) {
          opponentSocket.data.roomId =
            null;
        }

        if (
          room.status ===
            "playing" &&
          leavingPlayer &&
          opponent
        ) {
          room.status =
            "finished";

          room.winner =
            getOppositeColor(
              leavingPlayer.color
            );

          try {
            await Game.updateOne(
              {
                roomId
              },
              {
                $set: {
                  status:
                    room.status,

                  winner:
                    room.winner
                }
              }
            );

            await recordResult(
              room,
              room.winner
            );
          } catch (error) {
            console.error(
              "❌ 更新退出狀態失敗：",
              error.message
            );
          }

          io.to(
            opponent.socketId
          ).emit(
            "opponentDisconnected",
            {
              winner:
                room.winner
            }
          );
        } else if (opponent) {
          io.to(
            opponent.socketId
          ).emit(
            "rematchUnavailable",
            {
              message:
                `${leavingPlayer?.name || "對手"} 已返回首頁，無法再來一局`
            }
          );
        }

        rooms.delete(roomId);
      }
    );

    // ======================================
    // 中途離線
    // ======================================
    socket.on(
      "disconnect",
      async () => {
        console.log(
          `❌ 玩家離線：${socket.id}`
        );

        removeFromWaitingQueue(
          socket.id
        );

        const roomId =
          socket.data.roomId;

        if (!roomId) {
          return;
        }

        const room =
          rooms.get(roomId);

        if (!room) {
          return;
        }

        const disconnectedColor =
          getPlayerColor(
            room,
            socket.id
          );

        const opponent =
          getOpponent(
            room,
            socket.id
          );

        const opponentSocket =
          opponent
            ? io.sockets.sockets.get(
                opponent.socketId
              )
            : null;

        if (opponentSocket) {
          opponentSocket.data.roomId =
            null;
        }

        if (
          !disconnectedColor
        ) {
          return;
        }

        if (
          room.status ===
          "finished"
        ) {
          io.to(roomId).emit(
            "rematchUnavailable",
            {
              message:
                "對手已離線，無法再來一局"
            }
          );

          rooms.delete(roomId);

          return;
        }

        const winnerColor =
          getOppositeColor(
            disconnectedColor
          );

        room.status =
          "finished";

        room.winner =
          winnerColor;

        try {
          await Game.updateOne(
            {
              roomId
            },
            {
              $set: {
                status:
                  room.status,

                winner:
                  room.winner
              }
            }
          );

          await recordResult(
            room,
            winnerColor
          );
        } catch (error) {
          console.error(
            "❌ 更新離線狀態失敗：",
            error.message
          );
        }

        io.to(roomId).emit(
          "opponentDisconnected",
          {
            winner:
              winnerColor
          }
        );

        rooms.delete(roomId);
      }
    );
  }
);

// ==========================================
// API
// ==========================================
app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,

      message:
        "五子棋後端正常運作"
    });
  }
);

app.get(
  "/api/games",
  async (req, res) => {
    try {
      const games =
        await Game.find()
          .sort({
            createdAt: -1
          })
          .limit(20);

      res.json({
        success: true,
        data: games
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
);

app.get(
  "/api/leaderboard",
  async (req, res) => {
    try {
      const leaderboard =
        await getLeaderboard();

      res.json({
        success: true,
        data: leaderboard
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
);

// ==========================================
// 啟動 Server
// ==========================================
server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("🚀 Server 已啟動");

    console.log(
      `🌐 本機網址：http://localhost:${PORT}`
    );
  }
);