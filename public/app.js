const socket = io();

const BOARD_SIZE = 15;

let myColor = null;
let currentTurn = null;
let gameStatus = "waiting";
let currentBoard =
  Array(BOARD_SIZE * BOARD_SIZE).fill(0);

let lastMoveColor = null;
let undoPending = false;

// ==========================================
// 基本元件
// ==========================================
const board = document.getElementById("board");

const joinButton =
  document.getElementById("joinButton");

const playerNameInput =
  document.getElementById("playerName");

const loginSection =
  document.getElementById("loginSection");

const gameInfo =
  document.getElementById("gameInfo");

const roomIdText =
  document.getElementById("roomId");

const myColorText =
  document.getElementById("myColor");

const statusText =
  document.getElementById("statusText");

const blackPlayerText =
  document.getElementById("blackPlayer");

const whitePlayerText =
  document.getElementById("whitePlayer");

const connectionDot =
  document.getElementById("connectionDot");

const connectionText =
  document.getElementById("connectionText");

const toast =
  document.getElementById("toast");

// ==========================================
// 結果視窗
// ==========================================
const resultModal =
  document.getElementById("resultModal");

const resultModalCard =
  document.getElementById("resultModalCard");

const resultIcon =
  document.getElementById("resultIcon");

const resultBadge =
  document.getElementById("resultBadge");

const resultTitle =
  document.getElementById("resultTitle");

const resultMessage =
  document.getElementById("resultMessage");

const rematchHint =
  document.getElementById("rematchHint");

const homeButton =
  document.getElementById("homeButton");

const rematchButton =
  document.getElementById("rematchButton");

// ==========================================
// 悔棋功能
// ==========================================
const undoButton =
  document.getElementById("undoButton");

const undoRequestBox =
  document.getElementById("undoRequestBox");

const undoRequestText =
  document.getElementById("undoRequestText");

const acceptUndoButton =
  document.getElementById("acceptUndoButton");

const rejectUndoButton =
  document.getElementById("rejectUndoButton");

// ==========================================
// 聊天室
// ==========================================
const chatMessages =
  document.getElementById("chatMessages");

const chatForm =
  document.getElementById("chatForm");

const chatInput =
  document.getElementById("chatInput");

const sendChatButton =
  document.getElementById("sendChatButton");

// ==========================================
// 排行榜
// ==========================================
const rankingList =
  document.getElementById("rankingList");

const refreshRankingButton =
  document.getElementById("refreshRankingButton");

// ==========================================
// 通用函式
// ==========================================
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

// ==========================================
// 棋盤
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

function renderBoard() {
  const cells =
    document.querySelectorAll(".cell");

  cells.forEach((cell) => {
    cell.innerHTML = "";

    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);

    const value =
      currentBoard[getIndex(x, y)];

    if (value === 0) {
      return;
    }

    const stone =
      document.createElement("div");

    stone.className =
      value === 1
        ? "stone black"
        : "stone white";

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

  if (undoPending) {
    showToast("請先完成悔棋處理");
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
// 狀態文字與按鈕
// ==========================================
function updateTurnText() {
  if (gameStatus === "finished") {
    return;
  }

  if (undoPending) {
    statusText.textContent =
      "等待悔棋處理";
    return;
  }

  if (currentTurn === myColor) {
    statusText.textContent =
      "輪到您落子";
  } else {
    statusText.textContent =
      "等待對手落子";
  }
}

function updateUndoButton() {
  const canRequestUndo =
    gameStatus === "playing" &&
    myColor &&
    lastMoveColor === myColor &&
    !undoPending;

  undoButton.disabled = !canRequestUndo;

  if (undoPending) {
    undoButton.textContent =
      "等待悔棋處理...";
  } else {
    undoButton.textContent =
      "申請悔棋";
  }
}

// ==========================================
// 聊天室
// ==========================================
function resetChat() {
  chatMessages.innerHTML = `
    <p class="emptyText">
      配對成功後即可聊天
    </p>
  `;

  chatInput.value = "";
  chatInput.disabled = true;
  sendChatButton.disabled = true;
}

function enableChat() {
  chatInput.disabled = false;
  sendChatButton.disabled = false;
}

function clearEmptyChatText() {
  const emptyText =
    chatMessages.querySelector(".emptyText");

  if (emptyText) {
    emptyText.remove();
  }
}

function appendChatMessage(data) {
  clearEmptyChatText();

  if (data.type === "system") {
    const item =
      document.createElement("p");

    item.className =
      "chatSystemMessage";

    item.textContent =
      data.message;

    chatMessages.appendChild(item);
  } else {
    const item =
      document.createElement("div");

    item.className =
      "chatMessage";

    const name =
      document.createElement("div");

    name.className =
      "chatMessageName";

    name.textContent =
      data.playerName;

    const text =
      document.createElement("div");

    text.className =
      "chatMessageText";

    text.textContent =
      data.message;

    item.appendChild(name);
    item.appendChild(text);

    chatMessages.appendChild(item);
  }

  chatMessages.scrollTop =
    chatMessages.scrollHeight;
}

chatForm.addEventListener(
  "submit",
  (event) => {
    event.preventDefault();

    const message =
      chatInput.value.trim();

    if (!message) {
      return;
    }

    socket.emit("sendChatMessage", {
      message
    });

    chatInput.value = "";
    chatInput.focus();
  }
);

// ==========================================
// 排行榜
// ==========================================
function renderLeaderboard(players) {
  rankingList.innerHTML = "";

  if (!players || players.length === 0) {
    rankingList.innerHTML = `
      <p class="emptyText">
        尚無排行榜資料
      </p>
    `;

    return;
  }

  players.forEach((player, index) => {
    const item =
      document.createElement("div");

    item.className =
      "rankingItem";

    const rankingIndex =
      document.createElement("div");

    rankingIndex.className =
      index === 0
        ? "rankingIndex topOne"
        : "rankingIndex";

    rankingIndex.textContent =
      index + 1;

    const name =
      document.createElement("div");

    name.className =
      "rankingName";

    name.textContent =
      player.displayName;

    const score =
      document.createElement("div");

    score.className =
      "rankingScore";

    score.textContent =
      `${player.points} 分`;

    item.appendChild(rankingIndex);
    item.appendChild(name);
    item.appendChild(score);

    rankingList.appendChild(item);
  });
}

refreshRankingButton.addEventListener(
  "click",
  () => {
    socket.emit("getLeaderboard");
  }
);

// ==========================================
// 結果視窗
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

  rematchButton.textContent =
    "與同對手繼續";

  rematchHint.textContent =
    "可以返回首頁，或邀請同一位玩家再來一局。";
}

function showResultModal(type) {
  hideResultModal();

  resultModal.classList.remove("hidden");

  resultModalCard.classList.add(type);

  resultBadge.textContent =
    "GAME OVER";

  if (type === "victory") {
    resultIcon.textContent = "🏆";

    resultTitle.textContent =
      "恭喜獲勝！";

    resultMessage.textContent =
      "您成功完成五子連線，贏得本場對戰。";

    return;
  }

  if (type === "defeat") {
    resultIcon.textContent = "😢";

    resultTitle.textContent =
      "本局失敗";

    resultMessage.textContent =
      "對手已完成五子連線，再接再厲。";

    return;
  }

  if (type === "draw") {
    resultIcon.textContent = "🤝";

    resultTitle.textContent =
      "本局平手";

    resultMessage.textContent =
      "棋盤已滿，雙方未分出勝負。";

    return;
  }

  if (type === "unavailable") {
    resultIcon.textContent = "🔌";

    resultTitle.textContent =
      "對手已離線";

    resultMessage.textContent =
      "對手已返回首頁或離開遊戲，無法繼續對戰。";

    resultBadge.textContent =
      "CONNECTION ENDED";

    rematchButton.disabled = true;

    rematchButton.textContent =
      "無法繼續";
  }
}

// ==========================================
// 回首頁
// ==========================================
function resetToHome() {
  myColor = null;
  currentTurn = null;
  gameStatus = "waiting";

  lastMoveColor = null;
  undoPending = false;

  currentBoard =
    Array(BOARD_SIZE * BOARD_SIZE).fill(0);

  loginSection.classList.remove("hidden");
  gameInfo.classList.add("hidden");

  roomIdText.textContent =
    "尚未配對";

  myColorText.textContent =
    "尚未分配";

  statusText.textContent =
    "等待中";

  blackPlayerText.textContent =
    "等待玩家";

  whitePlayerText.textContent =
    "等待玩家";

  joinButton.disabled = false;

  joinButton.textContent =
    "開始配對";

  undoRequestBox.classList.add("hidden");

  updateUndoButton();
  resetChat();
  hideResultModal();
  renderBoard();
}

// ==========================================
// 按鈕事件
// ==========================================
joinButton.addEventListener(
  "click",
  () => {
    const name =
      playerNameInput.value.trim();

    if (!name) {
      showToast("請先輸入玩家名稱");
      return;
    }

    joinButton.disabled = true;

    joinButton.textContent =
      "等待配對中...";

    socket.emit("joinQueue", {
      name
    });
  }
);

homeButton.addEventListener(
  "click",
  () => {
    socket.emit("leaveRoom");

    resetToHome();

    showToast("已返回首頁");
  }
);

rematchButton.addEventListener(
  "click",
  () => {
    rematchButton.disabled = true;

    rematchButton.textContent =
      "已送出邀請，等待對手...";

    rematchHint.textContent =
      "已同意再來一局，等待對手確認。";

    socket.emit("requestRematch");
  }
);

undoButton.addEventListener(
  "click",
  () => {
    socket.emit("requestUndo");
  }
);

acceptUndoButton.addEventListener(
  "click",
  () => {
    socket.emit("respondUndo", {
      accept: true
    });

    undoRequestBox.classList.add("hidden");
  }
);

rejectUndoButton.addEventListener(
  "click",
  () => {
    socket.emit("respondUndo", {
      accept: false
    });

    undoRequestBox.classList.add("hidden");
  }
);

// ==========================================
// Socket.IO 基本連線
// ==========================================
socket.on("connect", () => {
  connectionDot.classList.add("online");

  connectionText.textContent =
    "伺服器連線正常";

  socket.emit("getLeaderboard");
});

socket.on("disconnect", () => {
  connectionDot.classList.remove("online");

  connectionText.textContent =
    "伺服器連線中斷";
});

// ==========================================
// 配對與遊戲狀態
// ==========================================
socket.on("queueStatus", (data) => {
  showToast(data.message);
});

socket.on("gameStarted", (data) => {
  myColor = data.myColor;

  loginSection.classList.add("hidden");
  gameInfo.classList.remove("hidden");

  roomIdText.textContent =
    data.roomId;

  myColorText.textContent =
    myColor === "black"
      ? "黑棋"
      : "白棋";

  hideResultModal();
  enableChat();

  showToast("配對成功，遊戲開始");
});

socket.on("gameState", (data) => {
  currentBoard = data.board;
  currentTurn = data.currentTurn;
  gameStatus = data.status;

  lastMoveColor =
    data.lastMoveColor;

  undoPending =
    data.undoPending;

  roomIdText.textContent =
    data.roomId;

  const blackPlayer =
    data.players.find(
      (player) =>
        player.color === "black"
    );

  const whitePlayer =
    data.players.find(
      (player) =>
        player.color === "white"
    );

  blackPlayerText.textContent =
    blackPlayer?.name ||
    "等待玩家";

  whitePlayerText.textContent =
    whitePlayer?.name ||
    "等待玩家";

  renderBoard();
  updateTurnText();
  updateUndoButton();
});

// ==========================================
// 遊戲結束
// ==========================================
socket.on("gameOver", (data) => {
  gameStatus = "finished";

  updateUndoButton();

  if (data.winner === "draw") {
    statusText.textContent =
      "本局平手";

    showResultModal("draw");
    return;
  }

  if (data.winner === myColor) {
    statusText.textContent =
      "您獲勝了！";

    showResultModal("victory");
  } else {
    statusText.textContent =
      "對手獲勝";

    showResultModal("defeat");
  }
});

// ==========================================
// 再戰
// ==========================================
socket.on("rematchStatus", (data) => {
  rematchHint.textContent =
    `${data.accepted} / ${data.total} 位玩家已同意再來一局`;

  if (data.accepted < data.total) {
    showToast("等待對手確認再來一局");
  }
});

socket.on("rematchStarted", (data) => {
  myColor = data.myColor;
  currentTurn = "black";
  gameStatus = "playing";

  lastMoveColor = null;
  undoPending = false;

  currentBoard =
    Array(BOARD_SIZE * BOARD_SIZE).fill(0);

  roomIdText.textContent =
    data.roomId;

  myColorText.textContent =
    myColor === "black"
      ? "黑棋"
      : "白棋";

  hideResultModal();

  undoRequestBox.classList.add("hidden");

  renderBoard();
  updateUndoButton();

  showToast("雙方已同意，下一局開始！");
});

// ==========================================
// 悔棋
// ==========================================
socket.on("undoStatus", (data) => {
  undoPending =
    data.status === "pending";

  updateTurnText();
  updateUndoButton();

  if (data.status === "pending") {
    showToast(
      `${data.requesterName} 已提出悔棋申請`
    );
  }
});

socket.on(
  "undoRequestReceived",
  (data) => {
    undoRequestText.textContent =
      `${data.requesterName} 希望撤回最後一步，是否同意？`;

    undoRequestBox.classList.remove("hidden");
  }
);

socket.on("undoResolved", (data) => {
  undoPending = false;

  undoRequestBox.classList.add("hidden");

  updateTurnText();
  updateUndoButton();

  if (data.accepted) {
    showToast("對手已同意悔棋");
  } else {
    showToast("對手拒絕悔棋");
  }
});

// ==========================================
// 聊天室
// ==========================================
socket.on("chatMessage", (data) => {
  appendChatMessage(data);
});

socket.on("chatHistory", (messages) => {
  chatMessages.innerHTML = "";

  if (!messages || messages.length === 0) {
    chatMessages.innerHTML = `
      <p class="emptyText">
        尚無聊天訊息
      </p>
    `;

    return;
  }

  messages.forEach((message) => {
    appendChatMessage(message);
  });
});

// ==========================================
// 排行榜
// ==========================================
socket.on(
  "leaderboardUpdated",
  (players) => {
    renderLeaderboard(players);
  }
);

// ==========================================
// 對手離線
// ==========================================
socket.on(
  "opponentDisconnected",
  () => {
    gameStatus = "finished";

    statusText.textContent =
      "對手已離線，遊戲結束";

    updateUndoButton();

    showResultModal("unavailable");
  }
);

socket.on(
  "rematchUnavailable",
  (data) => {
    gameStatus = "finished";

    statusText.textContent =
      data?.message ||
      "對手已離線，無法繼續對戰";

    showResultModal("unavailable");
  }
);

// ==========================================
// 錯誤訊息
// ==========================================
socket.on("errorMessage", (message) => {
  showToast(message);
});

// ==========================================
// 初始化
// ==========================================
createBoard();
resetChat();
hideResultModal();
updateUndoButton();