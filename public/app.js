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

// ==========================================
// 新增：再來一局元件
// ==========================================
const rematchSection = document.getElementById("rematchSection");
const rematchButton = document.getElementById("rematchButton");
const rematchHint = document.getElementById("rematchHint");

// ==========================================
// 顯示右下角提示
// ==========================================
function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");

  setTimeout(() => {
    toast.classList.add("hidden");
  }, 2500);
}

// ==========================================
// 取得棋盤陣列索引
// ==========================================
function getIndex(x, y) {
  return y * BOARD_SIZE + x;
}

// ==========================================
// 建立棋盤
// ==========================================
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

// ==========================================
// 更新棋盤畫面
// ==========================================
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

// ==========================================
// 玩家點擊棋盤
// ==========================================
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

// ==========================================
// 更新目前回合文字
// ==========================================
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

// ==========================================
// 重設「再來一局」按鈕狀態
// ==========================================
function resetRematchControls() {
  rematchSection.classList.add("hidden");

  rematchButton.disabled = false;
  rematchButton.textContent = "與同一位玩家再來一局";

  rematchHint.textContent = "等待雙方選擇是否繼續對戰";
}

// ==========================================
// 按下開始配對
// ==========================================
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

// ==========================================
// 新增：按下再來一局
// ==========================================
rematchButton.addEventListener("click", () => {
  rematchButton.disabled = true;
  rematchButton.textContent = "已送出邀請，等待對手...";

  rematchHint.textContent =
    "已同意再來一局，等待對手確認";

  socket.emit("requestRematch");
});

// ==========================================
// Socket.IO 基本連線狀態
// ==========================================
socket.on("connect", () => {
  connectionDot.classList.add("online");
  connectionText.textContent = "伺服器連線正常";
});

socket.on("disconnect", () => {
  connectionDot.classList.remove("online");
  connectionText.textContent = "伺服器連線中斷";
});

// ==========================================
// 等待配對
// ==========================================
socket.on("queueStatus", (data) => {
  statusText.textContent = data.message;
  showToast(data.message);
});

// ==========================================
// 第一局開始
// ==========================================
socket.on("gameStarted", (data) => {
  myColor = data.myColor;

  loginSection.classList.add("hidden");
  gameInfo.classList.remove("hidden");

  roomIdText.textContent = data.roomId;

  myColorText.textContent =
    myColor === "black" ? "黑棋" : "白棋";

  resetRematchControls();

  showToast("配對成功，遊戲開始");
});

// ==========================================
// 更新棋盤資料
// ==========================================
socket.on("gameState", (data) => {
  currentBoard = data.board;
  currentTurn = data.currentTurn;
  gameStatus = data.status;

  roomIdText.textContent = data.roomId;

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

// ==========================================
// 遊戲結束
// ==========================================
socket.on("gameOver", (data) => {
  gameStatus = "finished";

  rematchSection.classList.remove("hidden");
  rematchButton.disabled = false;
  rematchButton.textContent = "與同一位玩家再來一局";
  rematchHint.textContent =
    "雙方都按下按鈕後，系統會自動開始下一局";

  if (data.winner === "draw") {
    statusText.textContent = "本局平手";
    showToast("棋盤已滿，本局平手");
    return;
  }

  if (data.winner === myColor) {
    statusText.textContent = "您獲勝了！";
    showToast(`恭喜！${data.winnerName} 獲勝`);
  } else {
    statusText.textContent = "對手獲勝";
    showToast(`${data.winnerName} 獲勝`);
  }
});

// ==========================================
// 新增：顯示再來一局同意人數
// ==========================================
socket.on("rematchStatus", (data) => {
  rematchSection.classList.remove("hidden");

  rematchHint.textContent =
    `${data.accepted} / ${data.total} 位玩家已同意再來一局`;

  if (data.accepted < data.total) {
    showToast("等待對手確認再來一局");
  }
});

// ==========================================
// 新增：同一組玩家開始下一局
// ==========================================
socket.on("rematchStarted", (data) => {
  myColor = data.myColor;
  currentBoard = Array(225).fill(0);
  currentTurn = "black";
  gameStatus = "playing";

  roomIdText.textContent = data.roomId;

  myColorText.textContent =
    myColor === "black" ? "黑棋" : "白棋";

  resetRematchControls();
  renderBoard();

  showToast("雙方已同意，下一局開始！");
});

// ==========================================
// 對手離線
// ==========================================
socket.on("opponentDisconnected", () => {
  gameStatus = "finished";

  rematchSection.classList.add("hidden");

  statusText.textContent = "對手已離線，遊戲結束";
  showToast("對手已離線");
});

// ==========================================
// 新增：遊戲結束後對手離線
// ==========================================
socket.on("rematchUnavailable", (data) => {
  rematchSection.classList.add("hidden");

  statusText.textContent =
    data?.message || "對手已離線，無法再來一局";

  showToast("對手已離線，無法繼續對戰");
});

// ==========================================
// 顯示錯誤
// ==========================================
socket.on("errorMessage", (message) => {
  showToast(message);
});

createBoard();
resetRematchControls();