const socket = io();

const BOARD_SIZE = 15;

let myColor = null;
let currentTurn = null;
let gameStatus = "waiting";
let currentBoard = Array(225).fill(0);

const board = document.getElementById("board");
const joinButton = document.getElementById("joinButton");
const playerNameInput = document.getElementById("playerName");

const loginSection = document.getElementById("loginSection");
const gameInfo = document.getElementById("gameInfo");

const roomIdText = document.getElementById("roomId");
const myColorText = document.getElementById("myColor");
const statusText = document.getElementById("statusText");

const blackPlayerText = document.getElementById("blackPlayer");
const whitePlayerText = document.getElementById("whitePlayer");

const connectionDot = document.getElementById("connectionDot");
const connectionText = document.getElementById("connectionText");

const toast = document.getElementById("toast");

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");

  setTimeout(() => {
    toast.classList.add("hidden");
  }, 2500);
}

function getIndex(x, y) {
  return y * BOARD_SIZE + x;
}

function createBoard() {
  board.innerHTML = "";

  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      const cell = document.createElement("div");

      cell.className = "cell";
      cell.dataset.x = x;
      cell.dataset.y = y;

      cell.addEventListener("click", () => {
        handleCellClick(x, y);
      });

      board.appendChild(cell);
    }
  }

  renderBoard();
}

function renderBoard() {
  const cells = document.querySelectorAll(".cell");

  cells.forEach((cell) => {
    cell.innerHTML = "";

    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);

    const value = currentBoard[getIndex(x, y)];

    if (value === 0) {
      return;
    }

    const stone = document.createElement("div");

    stone.className =
      value === 1 ? "stone black" : "stone white";

    cell.appendChild(stone);
  });
}

function handleCellClick(x, y) {
  if (!myColor) {
    showToast("請先加入配對");
    return;
  }

  if (gameStatus !== "playing") {
    showToast("目前無法落子");
    return;
  }

  if (currentTurn !== myColor) {
    showToast("現在還沒輪到您");
    return;
  }

  if (currentBoard[getIndex(x, y)] !== 0) {
    showToast("這個位置已經有棋子");
    return;
  }

  socket.emit("makeMove", {
    x,
    y
  });
}

function updateTurnText() {
  if (gameStatus === "finished") {
    return;
  }

  if (currentTurn === myColor) {
    statusText.textContent = "輪到您落子";
  } else {
    statusText.textContent = "等待對手落子";
  }
}

joinButton.addEventListener("click", () => {
  const name = playerNameInput.value.trim();

  if (!name) {
    showToast("請先輸入玩家名稱");
    return;
  }

  joinButton.disabled = true;
  joinButton.textContent = "等待配對中...";

  socket.emit("joinQueue", {
    name
  });
});

socket.on("connect", () => {
  connectionDot.classList.add("online");
  connectionText.textContent = "伺服器連線正常";
});

socket.on("disconnect", () => {
  connectionDot.classList.remove("online");
  connectionText.textContent = "伺服器連線中斷";
});

socket.on("queueStatus", (data) => {
  statusText.textContent = data.message;
  showToast(data.message);
});

socket.on("gameStarted", (data) => {
  myColor = data.myColor;

  loginSection.classList.add("hidden");
  gameInfo.classList.remove("hidden");

  roomIdText.textContent = data.roomId;

  myColorText.textContent =
    myColor === "black" ? "黑棋" : "白棋";

  showToast("配對成功，遊戲開始");
});

socket.on("gameState", (data) => {
  currentBoard = data.board;
  currentTurn = data.currentTurn;
  gameStatus = data.status;

  const blackPlayer = data.players.find(
    (player) => player.color === "black"
  );

  const whitePlayer = data.players.find(
    (player) => player.color === "white"
  );

  blackPlayerText.textContent =
    blackPlayer?.name || "等待玩家";

  whitePlayerText.textContent =
    whitePlayer?.name || "等待玩家";

  renderBoard();
  updateTurnText();
});

socket.on("gameOver", (data) => {
  gameStatus = "finished";

  if (data.winner === myColor) {
    statusText.textContent = `您獲勝了！`;
    showToast(`恭喜！${data.winnerName} 獲勝`);
  } else {
    statusText.textContent = "對手獲勝";
    showToast(`${data.winnerName} 獲勝`);
  }
});

socket.on("opponentDisconnected", () => {
  gameStatus = "finished";
  statusText.textContent = "對手已離線，遊戲結束";
  showToast("對手已離線");
});

socket.on("errorMessage", (message) => {
  showToast(message);
});

createBoard();