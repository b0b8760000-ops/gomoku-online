const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 10000
});

const BOARD_SIZE = 15;
const BOARD_CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
const $ = (id) => document.getElementById(id);

// ==========================================
// 固定玩家 Token
// Socket ID 重新連線後可能改變，因此不適合作為玩家長期身分。
// ==========================================
function getOrCreatePlayerToken() {
  let token = localStorage.getItem("gomokuPlayerToken");

  if (!token) {
    token =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `player-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    localStorage.setItem("gomokuPlayerToken", token);
  }

  return token;
}

const playerToken = getOrCreatePlayerToken();

// ==========================================
// 畫面狀態
// ==========================================
let currentRoomId = localStorage.getItem("gomokuCurrentRoomId") || null;
let spectatingRoomId = sessionStorage.getItem("gomokuSpectatingRoomId") || null;
let isSpectating = false;
let myColor = null;
let currentTurn = null;
let gameStatus = "waiting";
let currentBoard = Array(BOARD_CELL_COUNT).fill(0);
let lastMove = null;
let lastMoveColor = null;
let undoPending = false;
let heartbeatTimer = null;
let toastTimer = null;

let showLastMoveHighlight =
  localStorage.getItem("gomokuShowLastMoveHighlight") !== "false";

// ==========================================
// DOM 元件
// ==========================================
const board = $("board");
const boardHint = $("boardHint");

const lobbySection = $("lobbySection");
const gameInfo = $("gameInfo");
const playerNameInput = $("playerName");
const joinButton = $("joinButton");
const createPrivateRoomButton = $("createPrivateRoomButton");
const privateRoomCodeInput = $("privateRoomCodeInput");
const joinPrivateRoomButton = $("joinPrivateRoomButton");
const lobbyWaitingBox = $("lobbyWaitingBox");
const lobbyWaitingTitle = $("lobbyWaitingTitle");
const lobbyWaitingHint = $("lobbyWaitingHint");
const createdRoomCodeText = $("createdRoomCodeText");
const cancelWaitingButton = $("cancelWaitingButton");

const roomIdText = $("roomId");
const myColorText = $("myColor");
const statusText = $("statusText");
const blackPlayerText = $("blackPlayer");
const whitePlayerText = $("whitePlayer");
const lastMoveToggleButton = $("lastMoveToggleButton");

const undoButton = $("undoButton");
const undoRequestBox = $("undoRequestBox");
const undoRequestText = $("undoRequestText");
const acceptUndoButton = $("acceptUndoButton");
const rejectUndoButton = $("rejectUndoButton");

const connectionDot = $("connectionDot");
const connectionText = $("connectionText");
const onlineCountText = $("onlineCountText");
const toast = $("toast");

const rankingList = $("rankingList");
const refreshRankingButton = $("refreshRankingButton");

const globalChatMessages = $("globalChatMessages");
const globalChatForm = $("globalChatForm");
const globalChatInput = $("globalChatInput");

const roomChatCard = $("roomChatCard");
const chatMessages = $("chatMessages");
const chatForm = $("chatForm");
const chatInput = $("chatInput");
const sendChatButton = $("sendChatButton");

const liveRoomList = $("liveRoomList");
const refreshLiveRoomsButton = $("refreshLiveRoomsButton");

const spectatorInfo = $("spectatorInfo");
const spectatorRoomIdText = $("spectatorRoomId");
const spectatorMatchText = $("spectatorMatch");
const spectatorTurnText = $("spectatorTurn");
const spectatorCountText = $("spectatorCount");
const gameSpectatorCountText = $("gameSpectatorCount");
const leaveSpectatingButton = $("leaveSpectatingButton");
const spectatorLastMoveToggleButton = $("spectatorLastMoveToggleButton");

const resultModal = $("resultModal");
const resultModalCard = $("resultModalCard");
const resultIcon = $("resultIcon");
const resultBadge = $("resultBadge");
const resultTitle = $("resultTitle");
const resultMessage = $("resultMessage");
const rematchHint = $("rematchHint");
const homeButton = $("homeButton");
const rematchButton = $("rematchButton");

// ==========================================
// 通用 UI
// ==========================================
function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");

  if (toastTimer) {
    clearTimeout(toastTimer);
  }

  toastTimer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 2800);
}

function getPlayerNameInput() {
  return playerNameInput.value.trim().slice(0, 20);
}

function saveDisplayName(name) {
  const cleanedName = String(name || "").trim().slice(0, 20);

  if (cleanedName) {
    localStorage.setItem("gomokuDisplayName", cleanedName);
    playerNameInput.value = cleanedName;

    if (socket.connected) {
      socket.emit("registerPresence", {
        playerToken,
        name: cleanedName
      });
    }
  }

  return cleanedName;
}

function saveCurrentRoomId(roomId) {
  currentRoomId = roomId;
  localStorage.setItem("gomokuCurrentRoomId", roomId);
}

function clearCurrentRoomId() {
  currentRoomId = null;
  localStorage.removeItem("gomokuCurrentRoomId");
}

function saveSpectatingRoomId(roomId) {
  spectatingRoomId = roomId;
  sessionStorage.setItem("gomokuSpectatingRoomId", roomId);
}

function clearSpectatingRoomId() {
  spectatingRoomId = null;
  sessionStorage.removeItem("gomokuSpectatingRoomId");
}

function setLobbyControlsDisabled(disabled) {
  joinButton.disabled = disabled;
  createPrivateRoomButton.disabled = disabled;
  privateRoomCodeInput.disabled = disabled;
  joinPrivateRoomButton.disabled = disabled;
}

function resetLobbyWaitingBox() {
  lobbyWaitingBox.classList.add("hidden");
  createdRoomCodeText.classList.add("hidden");
  createdRoomCodeText.textContent = "0000";
  lobbyWaitingTitle.textContent = "等待配對中";
  lobbyWaitingHint.textContent = "請稍候...";
  setLobbyControlsDisabled(false);
  joinButton.textContent = "快速配對";
}

function showLobbyWaiting({ title, hint, roomCode = null }) {
  setLobbyControlsDisabled(true);
  lobbyWaitingBox.classList.remove("hidden");
  lobbyWaitingTitle.textContent = title;
  lobbyWaitingHint.textContent = hint;

  if (roomCode) {
    createdRoomCodeText.textContent = roomCode;
    createdRoomCodeText.classList.remove("hidden");
  } else {
    createdRoomCodeText.classList.add("hidden");
  }
}

function updateLastMoveToggleButton() {
  const text = showLastMoveHighlight ? "開啟" : "關閉";

  lastMoveToggleButton.textContent = text;
  lastMoveToggleButton.classList.toggle("active", showLastMoveHighlight);
  lastMoveToggleButton.setAttribute("aria-pressed", String(showLastMoveHighlight));

  spectatorLastMoveToggleButton.textContent = text;
  spectatorLastMoveToggleButton.classList.toggle("active", showLastMoveHighlight);
  spectatorLastMoveToggleButton.setAttribute("aria-pressed", String(showLastMoveHighlight));
}

function updateUndoButton() {
  const canRequestUndo =
    gameStatus === "playing" &&
    myColor &&
    lastMoveColor === myColor &&
    !undoPending;

  undoButton.disabled = !canRequestUndo;
  undoButton.textContent = undoPending ? "等待悔棋處理..." : "申請悔棋";
}

function updateTurnText() {
  if (gameStatus !== "playing") {
    return;
  }

  if (isSpectating) {
    const turnText = currentTurn === "black" ? "黑棋" : "白棋";
    spectatorTurnText.textContent = `輪到${turnText}落子`;
    boardHint.textContent = `觀戰中：輪到${turnText}落子`;
    return;
  }

  if (undoPending) {
    statusText.textContent = "等待悔棋處理";
    boardHint.textContent = "請先完成悔棋處理";
    return;
  }

  if (currentTurn === myColor) {
    statusText.textContent = "輪到您落子";
    boardHint.textContent = "輪到您落子";
  } else {
    statusText.textContent = "等待對手落子";
    boardHint.textContent = "等待對手落子";
  }
}

// ==========================================
// 棋盤
// ==========================================
function getIndex(x, y) {
  return y * BOARD_SIZE + x;
}

function createBoard() {
  board.innerHTML = "";

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.dataset.x = String(x);
      cell.dataset.y = String(y);
      cell.setAttribute("aria-label", `棋盤位置 ${x + 1}, ${y + 1}`);
      cell.addEventListener("click", () => handleCellClick(x, y));
      board.appendChild(cell);
    }
  }

  renderBoard();
}

function renderBoard() {
  const cells = board.querySelectorAll(".cell");

  cells.forEach((cell) => {
    cell.innerHTML = "";

    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);
    const value = currentBoard[getIndex(x, y)];

    if (value === 0) {
      return;
    }

    const stone = document.createElement("div");
    stone.className = value === 1 ? "stone black" : "stone white";

    if (
      showLastMoveHighlight &&
      lastMove &&
      lastMove.x === x &&
      lastMove.y === y
    ) {
      stone.classList.add("lastMove");
    }

    cell.appendChild(stone);
  });
}

function handleCellClick(x, y) {
  if (isSpectating) {
    showToast("目前為觀戰模式，無法落子");
    return;
  }

  if (!currentRoomId || gameStatus !== "playing") {
    showToast("請先加入對局");
    return;
  }

  if (undoPending) {
    showToast("請先完成悔棋處理");
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

  socket.emit("makeMove", { x, y });
}

// ==========================================
// 聊天室 UI
// ==========================================
function resetRoomChat() {
  chatMessages.innerHTML = '<p class="emptyText">尚無房間訊息</p>';
  chatInput.value = "";
}

function enableRoomChat(enabled = true) {
  chatInput.disabled = !enabled;
  sendChatButton.disabled = !enabled;
}

function clearEmptyText(container) {
  container.querySelector(".emptyText")?.remove();
}

function appendChatMessage(container, data) {
  clearEmptyText(container);

  if (data.type === "system") {
    const systemItem = document.createElement("p");
    systemItem.className = "chatSystemMessage";
    systemItem.textContent = data.message;
    container.appendChild(systemItem);
  } else {
    const item = document.createElement("div");
    item.className = "chatMessage";

    const name = document.createElement("div");
    name.className = "chatMessageName";
    name.textContent = data.playerName;

    const text = document.createElement("div");
    text.className = "chatMessageText";
    text.textContent = data.message;

    item.appendChild(name);
    item.appendChild(text);
    container.appendChild(item);
  }

  container.scrollTop = container.scrollHeight;
}

function renderChatHistory(container, messages, emptyMessage) {
  container.innerHTML = "";

  if (!messages || messages.length === 0) {
    container.innerHTML = `<p class="emptyText">${emptyMessage}</p>`;
    return;
  }

  messages.forEach((message) => appendChatMessage(container, message));
}

// ==========================================
// 排行榜 UI
// ==========================================
function renderLeaderboard(players) {
  rankingList.innerHTML = "";

  if (!players || players.length === 0) {
    rankingList.innerHTML = '<p class="emptyText">尚無排行榜資料</p>';
    return;
  }

  players.forEach((player, index) => {
    const item = document.createElement("div");
    item.className = "rankingItem";

    const rankingIndex = document.createElement("div");
    rankingIndex.className = index === 0 ? "rankingIndex topOne" : "rankingIndex";
    rankingIndex.textContent = String(index + 1);

    const name = document.createElement("div");
    name.className = "rankingName";
    name.textContent = player.displayName;

    const score = document.createElement("div");
    score.className = "rankingScore";
    score.textContent = `${player.points} 分`;

    item.appendChild(rankingIndex);
    item.appendChild(name);
    item.appendChild(score);
    rankingList.appendChild(item);
  });
}

// ==========================================
// 可觀戰房間 UI
// ==========================================
function renderLiveRooms(rooms) {
  liveRoomList.innerHTML = "";

  if (!rooms || rooms.length === 0) {
    liveRoomList.innerHTML = '<p class="emptyText">目前沒有進行中的對局</p>';
    return;
  }

  rooms.forEach((room) => {
    const item = document.createElement("div");
    item.className = "liveRoomItem";

    const main = document.createElement("div");
    main.className = "liveRoomMain";

    const title = document.createElement("strong");
title.textContent =
  `⚫ 黑棋：${room.blackPlayer}　vs　⚪ 白棋：${room.whitePlayer}`;

    const meta = document.createElement("p");
    meta.textContent = `第 ${room.round} 局｜${room.moveCount} 步｜${room.spectatorCount} 人觀戰`;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "watchButton";
    button.dataset.watchRoomId = room.roomId;
    button.textContent = spectatingRoomId === room.roomId ? "觀戰中" : "觀戰";
    button.disabled =
      (Boolean(currentRoomId) && gameStatus === "playing") ||
      spectatingRoomId === room.roomId;

    main.appendChild(title);
    main.appendChild(meta);
    item.appendChild(main);
    item.appendChild(button);
    liveRoomList.appendChild(item);
  });
}

function updateSpectatorPanel(data) {
  const blackPlayer = data.players.find((player) => player.color === "black");
  const whitePlayer = data.players.find((player) => player.color === "white");
  const turnText = data.currentTurn === "black" ? "黑棋" : "白棋";

  spectatorRoomIdText.textContent = data.roomId;
spectatorMatchText.textContent =
  `⚫ 黑棋：${blackPlayer?.name || "等待玩家"} ｜ ⚪ 白棋：${whitePlayer?.name || "等待玩家"}`;
  spectatorTurnText.textContent =
    data.status === "playing" ? `輪到${turnText}落子` : "對局已結束";
  spectatorCountText.textContent = `${data.spectatorCount || 0} 人`;
}

// ==========================================
// 結果視窗
// ==========================================
function hideResultModal() {
  resultModal.classList.add("hidden");
  resultModalCard.className = "resultModalCard";
  rematchButton.disabled = false;
  rematchButton.textContent = "與同對手繼續";
  rematchHint.textContent = "可以返回首頁，或邀請同一位玩家再來一局。";
}

function showResultModal(type, customMessage = "") {
  hideResultModal();
  resultModal.classList.remove("hidden");
  resultModalCard.classList.add(type);

  if (type === "victory") {
    resultIcon.textContent = "🏆";
    resultBadge.textContent = "GAME OVER";
    resultTitle.textContent = "恭喜獲勝！";
    resultMessage.textContent = customMessage || "您成功完成五子連線，贏得本場對戰。";
    return;
  }

  if (type === "defeat") {
    resultIcon.textContent = "😢";
    resultBadge.textContent = "GAME OVER";
    resultTitle.textContent = "本局失敗";
    resultMessage.textContent = customMessage || "對手已完成五子連線，再接再厲。";
    return;
  }

  if (type === "draw") {
    resultIcon.textContent = "🤝";
    resultBadge.textContent = "GAME OVER";
    resultTitle.textContent = "本局平手";
    resultMessage.textContent = customMessage || "棋盤已滿，雙方未分出勝負。";
    return;
  }

  resultIcon.textContent = "🔌";
  resultBadge.textContent = "CONNECTION ENDED";
  resultTitle.textContent = "遊戲連線已失效";
  resultMessage.textContent = customMessage || "找不到可恢復的棋局，請返回首頁重新配對。";
  rematchButton.disabled = true;
  rematchButton.textContent = "無法繼續";
}

// ==========================================
// 進入遊戲與回首頁
// ==========================================
function enterGame(data) {
  clearSpectatingRoomId();
  isSpectating = false;
  saveCurrentRoomId(data.roomId);
  myColor = data.myColor;
  gameStatus = data.status || "playing";

  lobbySection.classList.add("hidden");
  spectatorInfo.classList.add("hidden");
  gameInfo.classList.remove("hidden");
  roomChatCard.classList.remove("hidden");

  roomIdText.textContent = data.roomId;
  myColorText.textContent = myColor === "black" ? "黑棋" : "白棋";

  resetLobbyWaitingBox();
  enableRoomChat(true);
  hideResultModal();
}

function enterSpectatorMode(data) {
  clearCurrentRoomId();
  saveSpectatingRoomId(data.roomId);
  isSpectating = true;
  myColor = null;
  gameStatus = data.status || "playing";

  lobbySection.classList.add("hidden");
  gameInfo.classList.add("hidden");
  spectatorInfo.classList.remove("hidden");
  roomChatCard.classList.add("hidden");
  enableRoomChat(false);
  hideResultModal();
}

function resetToHome() {
  clearCurrentRoomId();
  clearSpectatingRoomId();

  isSpectating = false;
  myColor = null;
  currentTurn = null;
  gameStatus = "waiting";
  currentBoard = Array(BOARD_CELL_COUNT).fill(0);
  lastMove = null;
  lastMoveColor = null;
  undoPending = false;

  lobbySection.classList.remove("hidden");
  gameInfo.classList.add("hidden");
  spectatorInfo.classList.add("hidden");
  roomChatCard.classList.add("hidden");
  undoRequestBox.classList.add("hidden");

  roomIdText.textContent = "尚未配對";
  myColorText.textContent = "尚未分配";
  statusText.textContent = "等待中";
  blackPlayerText.textContent = "等待玩家";
  whitePlayerText.textContent = "等待玩家";
  gameSpectatorCountText.textContent = "0 人";
  boardHint.textContent = "請先加入對戰";

  resetLobbyWaitingBox();
  resetRoomChat();
  enableRoomChat(false);
  hideResultModal();
  updateUndoButton();
  renderBoard();
}

// ==========================================
// 心跳
// ==========================================
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function sendHeartbeat() {
  if (!socket.connected) {
    return;
  }

  socket.timeout(5000).emit(
    "clientHeartbeat",
    { sentAt: Date.now() },
    (error) => {
      if (error) {
        console.warn("心跳沒有收到後端回覆");
      }
    }
  );
}

function startHeartbeat() {
  stopHeartbeat();
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, 30000);
}

// ==========================================
// 按鈕事件
// ==========================================
joinButton.addEventListener("click", () => {
  const name = saveDisplayName(getPlayerNameInput());

  if (!name) {
    showToast("請先輸入玩家名稱");
    playerNameInput.focus();
    return;
  }

  showLobbyWaiting({
    title: "快速配對中",
    hint: "正在等待另一位玩家加入..."
  });

  socket.emit("joinQueue", { name, playerToken });
});

createPrivateRoomButton.addEventListener("click", () => {
  const name = saveDisplayName(getPlayerNameInput());

  if (!name) {
    showToast("請先輸入玩家名稱");
    playerNameInput.focus();
    return;
  }

  setLobbyControlsDisabled(true);
  socket.emit("createPrivateRoom", { name, playerToken });
});

joinPrivateRoomButton.addEventListener("click", () => {
  const name = saveDisplayName(getPlayerNameInput());
  const roomCode = privateRoomCodeInput.value.trim();

  if (!name) {
    showToast("請先輸入玩家名稱");
    playerNameInput.focus();
    return;
  }

  if (!/^\d{4}$/.test(roomCode)) {
    showToast("請輸入正確的 4 位數房號");
    privateRoomCodeInput.focus();
    return;
  }

  setLobbyControlsDisabled(true);
  socket.emit("joinPrivateRoom", { name, roomCode, playerToken });
});

privateRoomCodeInput.addEventListener("input", () => {
  privateRoomCodeInput.value = privateRoomCodeInput.value.replace(/\D/g, "").slice(0, 4);
});

cancelWaitingButton.addEventListener("click", () => {
  socket.emit("cancelWaiting");
});

function toggleLastMoveHighlight() {
  showLastMoveHighlight = !showLastMoveHighlight;
  localStorage.setItem("gomokuShowLastMoveHighlight", String(showLastMoveHighlight));
  updateLastMoveToggleButton();
  renderBoard();
  showToast(showLastMoveHighlight ? "已開啟最後一步提示" : "已關閉最後一步提示");
}

lastMoveToggleButton.addEventListener("click", toggleLastMoveHighlight);
spectatorLastMoveToggleButton.addEventListener("click", toggleLastMoveHighlight);

undoButton.addEventListener("click", () => socket.emit("requestUndo"));

acceptUndoButton.addEventListener("click", () => {
  socket.emit("respondUndo", { accept: true });
  undoRequestBox.classList.add("hidden");
});

rejectUndoButton.addEventListener("click", () => {
  socket.emit("respondUndo", { accept: false });
  undoRequestBox.classList.add("hidden");
});

homeButton.addEventListener("click", () => {
  socket.emit("leaveRoom");
  resetToHome();
  showToast("已返回首頁");
});

rematchButton.addEventListener("click", () => {
  rematchButton.disabled = true;
  rematchButton.textContent = "等待對手同意...";
  rematchHint.textContent = "已同意再戰，等待對手確認。";
  socket.emit("requestRematch");
});

refreshRankingButton.addEventListener("click", () => socket.emit("getLeaderboard"));
refreshLiveRoomsButton.addEventListener("click", () => socket.emit("getSpectatableRooms"));

liveRoomList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-watch-room-id]");

  if (!button) {
    return;
  }

  socket.emit("watchRoom", {
    roomId: button.dataset.watchRoomId,
    playerToken,
    name: getPlayerNameInput()
  });
});

leaveSpectatingButton.addEventListener("click", () => {
  socket.emit("leaveSpectating");
  resetToHome();
  showToast("已離開觀戰");
});

globalChatForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const name = saveDisplayName(getPlayerNameInput());
  const message = globalChatInput.value.trim();

  if (!name) {
    showToast("請先在左側輸入玩家名稱");
    playerNameInput.focus();
    return;
  }

  if (!message) {
    return;
  }

  socket.emit("sendGlobalChatMessage", { name, message });
  globalChatInput.value = "";
  globalChatInput.focus();
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const message = chatInput.value.trim();

  if (!message) {
    return;
  }

  socket.emit("sendChatMessage", { message });
  chatInput.value = "";
  chatInput.focus();
});

// ==========================================
// Socket.IO：連線狀態
// ==========================================
socket.on("connect", () => {
  connectionDot.classList.add("online");
  connectionText.textContent = "伺服器連線正常";

  startHeartbeat();
  socket.emit("registerPresence", {
    playerToken,
    name: localStorage.getItem("gomokuDisplayName") || ""
  });
  socket.emit("getLeaderboard");
  socket.emit("getGlobalChatHistory");
  socket.emit("getSpectatableRooms");

  if (currentRoomId) {
    connectionText.textContent = "正在恢復未完成棋局...";
    socket.emit("resumeGame", { roomId: currentRoomId, playerToken });
  } else if (spectatingRoomId) {
    connectionText.textContent = "正在恢復觀戰...";
    socket.emit("watchRoom", {
      roomId: spectatingRoomId,
      playerToken,
      name: localStorage.getItem("gomokuDisplayName") || ""
    });
  }
});

socket.on("disconnect", () => {
  stopHeartbeat();
  connectionDot.classList.remove("online");
  connectionText.textContent = "伺服器連線中斷，正在重新連線...";

  if (currentRoomId && gameStatus === "playing") {
    statusText.textContent = "連線暫時中斷，請稍候";
    boardHint.textContent = "系統正在嘗試恢復連線";
  }
});

// ==========================================
// Socket.IO：大廳
// ==========================================
socket.on("queueStatus", (data) => {
  showLobbyWaiting({ title: "快速配對中", hint: data.message });
});

socket.on("privateRoomCreated", (data) => {
  showLobbyWaiting({
    title: "私人房間已建立",
    hint: "請將房號分享給朋友，等待對方加入。",
    roomCode: data.roomCode
  });

  showToast(`私人房間 ${data.roomCode} 已建立`);
});

socket.on("waitingCancelled", () => {
  resetLobbyWaitingBox();
  showToast("已取消等待");
});

socket.on("privateRoomError", (message) => {
  resetLobbyWaitingBox();
  showToast(message);
});

// ==========================================
// Socket.IO：開始、恢復與同步棋局
// ==========================================
socket.on("gameStarted", (data) => {
  resetRoomChat();
  enterGame(data);
  showToast("配對成功，遊戲開始");
});

socket.on("gameResumed", (data) => {
  enterGame(data);
  connectionText.textContent = "伺服器連線正常";
  showToast("已從 MongoDB 恢復未完成棋局");
});

socket.on("resumeGameFailed", (message) => {
  clearCurrentRoomId();
  resetToHome();
  showResultModal("unavailable", message);
});

socket.on("gameState", (data) => {
  currentBoard = data.board;
  currentTurn = data.currentTurn;
  gameStatus = data.status;
  lastMove = data.lastMove || null;
  lastMoveColor = data.lastMoveColor || null;
  undoPending = Boolean(data.undoPending);

  roomIdText.textContent = data.roomId;
  gameSpectatorCountText.textContent = `${data.spectatorCount || 0} 人`;

  const blackPlayer = data.players.find((player) => player.color === "black");
  const whitePlayer = data.players.find((player) => player.color === "white");

  blackPlayerText.textContent = blackPlayer
    ? `${blackPlayer.name}${blackPlayer.connected ? "" : "（離線）"}`
    : "等待玩家";

  whitePlayerText.textContent = whitePlayer
    ? `${whitePlayer.name}${whitePlayer.connected ? "" : "（離線）"}`
    : "等待玩家";

  renderBoard();
  updateTurnText();
  updateUndoButton();
});

socket.on("opponentConnectionStatus", (data) => {
  const opponent = data.players.find((player) => player.color !== myColor);

  if (opponent && !opponent.connected) {
    showToast("對手尚未重新連線，棋局已暫時保留");
  }
});

socket.on("sessionReplaced", () => {
  clearCurrentRoomId();
  resetToHome();
  showResultModal("unavailable", "此玩家已在另一個分頁恢復棋局，目前分頁已失效。");
});

// ==========================================
// Socket.IO：勝負與再戰
// ==========================================
socket.on("gameOver", (data) => {
  gameStatus = "finished";

  // 已完成棋局不再屬於 active_rooms。
  // 清除瀏覽器保存的舊房號，重新整理後不會再拉回已結束棋盤。
  clearCurrentRoomId();

  updateUndoButton();

  if (data.winner === "draw") {
    statusText.textContent = "本局平手";
    showResultModal("draw");
  } else if (data.winner === myColor) {
    statusText.textContent = "您獲勝了！";
    showResultModal("victory");
  } else {
    statusText.textContent = "對手獲勝";
    showResultModal("defeat");
  }
});

socket.on("rematchStatus", (data) => {
  rematchHint.textContent = `${data.accepted} / ${data.total} 位玩家已同意再戰`;
});

socket.on("rematchStarted", (data) => {
  resetRoomChat();
  enterGame(data);
  currentBoard = Array(BOARD_CELL_COUNT).fill(0);
  currentTurn = "black";
  gameStatus = "playing";
  lastMove = null;
  lastMoveColor = null;
  undoPending = false;
  renderBoard();
  updateUndoButton();
  showToast("雙方已同意，下一局開始！");
});

socket.on("opponentDisconnected", (data) => {
  gameStatus = "finished";
  clearCurrentRoomId();
  updateUndoButton();
  showResultModal("unavailable", data.message || "對手已離線，本局已結束。");
});

socket.on("rematchUnavailable", (data) => {
  clearCurrentRoomId();
  showResultModal("unavailable", data.message || "對手已離線，無法再戰。");
});

// ==========================================
// Socket.IO：悔棋
// ==========================================
socket.on("undoStatus", (data) => {
  undoPending = data.status === "pending";
  updateTurnText();
  updateUndoButton();
});

socket.on("undoRequestReceived", (data) => {
  undoRequestText.textContent = `${data.requesterName} 希望撤回最後一步，是否同意？`;
  undoRequestBox.classList.remove("hidden");
});

socket.on("undoResolved", (data) => {
  undoPending = false;
  undoRequestBox.classList.add("hidden");
  updateTurnText();
  updateUndoButton();
  showToast(data.accepted ? "對手已同意悔棋" : "對手拒絕悔棋");
});

// ==========================================
// Socket.IO：在線人數與觀戰
// ==========================================
socket.on("presenceUpdated", (data) => {
  onlineCountText.textContent = `在線 ${data.onlineCount || 0} 人`;
});

socket.on("spectatableRoomsUpdated", (rooms) => {
  renderLiveRooms(rooms);
});

socket.on("spectatorJoined", (data) => {
  enterSpectatorMode(data);
  showToast("已進入觀戰模式");
});

socket.on("spectatorRoomState", (data) => {
  if (!isSpectating && spectatingRoomId !== data.roomId) {
    return;
  }

  enterSpectatorMode(data);
  currentBoard = data.board;
  currentTurn = data.currentTurn;
  gameStatus = data.status;
  lastMove = data.lastMove || null;
  lastMoveColor = data.lastMoveColor || null;
  undoPending = false;

  updateSpectatorPanel(data);
  renderBoard();
  updateTurnText();
});

socket.on("spectatorRoomEnded", (data) => {
  if (!isSpectating) {
    return;
  }

  clearSpectatingRoomId();
  gameStatus = "finished";
  spectatorTurnText.textContent = "對局已結束";
  boardHint.textContent = "觀戰結束，可返回大廳選擇其他對局";
  showToast(data.message || "此對局已結束");
});

socket.on("spectatorLeft", () => {
  clearSpectatingRoomId();
});

// ==========================================
// Socket.IO：聊天室與排行榜
// ==========================================
socket.on("chatMessage", (data) => appendChatMessage(chatMessages, data));

socket.on("chatHistory", (messages) => {
  renderChatHistory(chatMessages, messages, "尚無房間訊息");
});

socket.on("globalChatMessage", (data) => appendChatMessage(globalChatMessages, data));

socket.on("globalChatHistory", (messages) => {
  renderChatHistory(globalChatMessages, messages, "尚無公開訊息");
});

socket.on("leaderboardUpdated", (players) => renderLeaderboard(players));

socket.on("errorMessage", (message) => showToast(message));

// ==========================================
// 初始化
// ==========================================
playerNameInput.value = localStorage.getItem("gomokuDisplayName") || "";
createBoard();
resetLobbyWaitingBox();
resetRoomChat();
enableRoomChat(false);
hideResultModal();
updateLastMoveToggleButton();
updateUndoButton();
