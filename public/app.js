const socket = io();

const BOARD_SIZE = 15;

let myColor = null;
let currentTurn = null;
let gameStatus = "waiting";
let currentBoard = Array(BOARD_SIZE * BOARD_SIZE).fill(0);

// ==========================================
// 基本畫面元件
// ==========================================
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
// 遊戲結果彈出視窗元件
// ==========================================
const resultModal = document.getElementById("resultModal");
const resultModalCard = document.getElementById("resultModalCard");

const resultIcon = document.getElementById("resultIcon");
const resultBadge = document.getElementById("resultBadge");
const resultTitle = document.getElementById("resultTitle");
const resultMessage = document.getElementById("resultMessage");

const rematchHint = document.getElementById("rematchHint");

const homeButton = document.getElementById("homeButton");
const rematchButton = document.getElementById("rematchButton");

// ==========================================
// 顯示右下角提示訊息
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
    showToast("請等待對手落子");
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
// 更新目前輪到誰的文字
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
// 隱藏結果視窗
// ==========================================
function hideResultModal() {
  resultModal.classList.add("hidden");

  resultModalCard.classList.remove(
    "victory",
    "defeat",
    "draw",
    "unavailable"
  );

  rematchButton.disabled = false;
  rematchButton.textContent = "與同對手繼續";

  rematchHint.textContent =
    "可以返回首頁，或邀請同一位玩家再來一局。";
}

// ==========================================
// 顯示結果視窗
// ==========================================
function showResultModal(type) {
  hideResultModal();

  resultModal.classList.remove("hidden");
  resultModalCard.classList.add(type);

  resultBadge.textContent = "GAME OVER";

  if (type === "victory") {
    resultIcon.textContent = "🏆";
    resultTitle.textContent = "恭喜獲勝！";

    resultMessage.textContent =
      "您成功完成五子連線，贏得本場對戰。";

    return;
  }

  if (type === "defeat") {
    resultIcon.textContent = "😢";
    resultTitle.textContent = "本局失敗";

    resultMessage.textContent =
      "對手已完成五子連線，再接再厲。";

    return;
  }

  if (type === "draw") {
    resultIcon.textContent = "🤝";
    resultTitle.textContent = "本局平手";

    resultMessage.textContent =
      "棋盤已滿，雙方未分出勝負。";

    return;
  }

  if (type === "unavailable") {
    resultIcon.textContent = "🔌";
    resultTitle.textContent = "對手已離線";

    resultMessage.textContent =
      "對手已返回首頁或離開遊戲，無法繼續對戰。";

    resultBadge.textContent = "CONNECTION ENDED";

    rematchButton.disabled = true;
    rematchButton.textContent = "無法繼續";
  }
}

// ==========================================
// 回到首頁
// ==========================================
function resetToHome() {
  myColor = null;
  currentTurn = null;
  gameStatus = "waiting";

  currentBoard =
    Array(BOARD_SIZE * BOARD_SIZE).fill(0);

  loginSection.classList.remove("hidden");
  gameInfo.classList.add("hidden");

  roomIdText.textContent = "尚未配對";
  myColorText.textContent = "尚未分配";
  statusText.textContent = "等待中";

  blackPlayerText.textContent = "等待玩家";
  whitePlayerText.textContent = "等待玩家";

  joinButton.disabled = false;
  joinButton.textContent = "開始配對";

  hideResultModal();
  renderBoard();
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
// 按下回首頁
// ==========================================
homeButton.addEventListener("click", () => {
  socket.emit("leaveRoom");

  resetToHome();

  showToast("已返回首頁");
});

// ==========================================
// 按下與同對手繼續
// ==========================================
rematchButton.addEventListener("click", () => {
  rematchButton.disabled = true;

  rematchButton.textContent =
    "已送出邀請，等待對手...";

  rematchHint.textContent =
    "已同意再來一局，等待對手確認。";

  socket.emit("requestRematch");
});

// ==========================================
// Socket.IO 基本連線狀態
// ==========================================
socket.on("connect", () => {
  connectionDot.classList.add("online");

  connectionText.textContent =
    "伺服器連線正常";
});

socket.on("disconnect", () => {
  connectionDot.classList.remove("online");

  connectionText.textContent =
    "伺服器連線中斷";
});

// ==========================================
// 等待配對
// ==========================================
socket.on("queueStatus", (data) => {
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

  hideResultModal();

  showToast("配對成功，遊戲開始");
});

// ==========================================
// 接收後端最新遊戲狀態
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
// 遊戲結束後顯示中央視窗
// ==========================================
socket.on("gameOver", (data) => {
  gameStatus = "finished";

  if (data.winner === "draw") {
    statusText.textContent = "本局平手";

    showResultModal("draw");
    return;
  }

  if (data.winner === myColor) {
    statusText.textContent = "您獲勝了！";

    showResultModal("victory");
  } else {
    statusText.textContent = "對手獲勝";

    showResultModal("defeat");
  }
});

// ==========================================
// 顯示再來一局同意人數
// ==========================================
socket.on("rematchStatus", (data) => {
  rematchHint.textContent =
    `${data.accepted} / ${data.total} 位玩家已同意再來一局`;

  if (data.accepted < data.total) {
    showToast("等待對手確認再來一局");
  }
});

// ==========================================
// 同一組玩家開始下一局
// ==========================================
socket.on("rematchStarted", (data) => {
  myColor = data.myColor;
  currentTurn = "black";
  gameStatus = "playing";

  currentBoard =
    Array(BOARD_SIZE * BOARD_SIZE).fill(0);

  roomIdText.textContent = data.roomId;

  myColorText.textContent =
    myColor === "black" ? "黑棋" : "白棋";

  hideResultModal();
  renderBoard();

  showToast("雙方已同意，下一局開始！");
});

// ==========================================
// 遊戲進行中對手離線
// ==========================================
socket.on("opponentDisconnected", () => {
  gameStatus = "finished";

  statusText.textContent =
    "對手已離線，遊戲結束";

  showResultModal("unavailable");
});

// ==========================================
// 遊戲結束後，對手選擇返回首頁
// ==========================================
socket.on("rematchUnavailable", (data) => {
  gameStatus = "finished";

  statusText.textContent =
    data?.message || "對手已離線，無法繼續對戰";

  showResultModal("unavailable");
});

// ==========================================
// 顯示錯誤
// ==========================================
socket.on("errorMessage", (message) => {
  showToast(message);
});

// ==========================================
// 初始化畫面
// ==========================================
createBoard();
hideResultModal();