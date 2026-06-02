function getOrCreatePlayerToken() {
  let token = localStorage.getItem("gomokuPlayerToken");
  if (!token) {
    token = crypto.randomUUID ? crypto.randomUUID() : `player-${Date.now()}-${Math.random()}`;
    localStorage.setItem("gomokuPlayerToken", token);
  }
  return token;
}

const playerToken = getOrCreatePlayerToken();
const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 10000
});

const BOARD_SIZE = 15;
let myColor = null;
let currentTurn = null;
let gameStatus = "waiting";
let currentBoard = Array(BOARD_SIZE * BOARD_SIZE).fill(0);
let lastMoveColor = null;
let lastMove = null;
let undoPending = false;
let heartbeatTimer = null;
let currentRoomId = sessionStorage.getItem("gomokuCurrentRoomId");
let showLastMoveHighlight = localStorage.getItem("gomokuShowLastMoveHighlight") !== "false";
const seenGlobalMessageIds = new Set();

const $ = (id) => document.getElementById(id);
const board = $("board");
const joinButton = $("joinButton");
const createPrivateRoomButton = $("createPrivateRoomButton");
const privateRoomCodeInput = $("privateRoomCodeInput");
const joinPrivateRoomButton = $("joinPrivateRoomButton");
const privateRoomStatusText = $("privateRoomStatusText");
const privateRoomWaitingBox = $("privateRoomWaitingBox");
const createdRoomCodeText = $("createdRoomCodeText");
const cancelPrivateRoomButton = $("cancelPrivateRoomButton");
const roomChatCard = $("roomChatCard");
const playerNameInput = $("playerName");
const loginSection = $("loginSection");
const gameInfo = $("gameInfo");
const roomIdText = $("roomId");
const myColorText = $("myColor");
const statusText = $("statusText");
const lastMoveToggleButton = $("lastMoveToggleButton");
const blackPlayerText = $("blackPlayer");
const whitePlayerText = $("whitePlayer");
const connectionDot = $("connectionDot");
const connectionText = $("connectionText");
const toast = $("toast");
const resultModal = $("resultModal");
const resultModalCard = $("resultModalCard");
const resultIcon = $("resultIcon");
const resultBadge = $("resultBadge");
const resultTitle = $("resultTitle");
const resultMessage = $("resultMessage");
const rematchHint = $("rematchHint");
const homeButton = $("homeButton");
const rematchButton = $("rematchButton");
const undoButton = $("undoButton");
const undoRequestBox = $("undoRequestBox");
const undoRequestText = $("undoRequestText");
const acceptUndoButton = $("acceptUndoButton");
const rejectUndoButton = $("rejectUndoButton");
const chatMessages = $("chatMessages");
const chatForm = $("chatForm");
const chatInput = $("chatInput");
const sendChatButton = $("sendChatButton");
const globalChatMessages = $("globalChatMessages");
const globalChatForm = $("globalChatForm");
const globalChatInput = $("globalChatInput");
const rankingList = $("rankingList");
const refreshRankingButton = $("refreshRankingButton");

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2500);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (socket.connected) socket.emit("clientHeartbeat", { sentAt: Date.now() });
  }, 30000);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function setLobbyControlsDisabled(disabled) {
  joinButton.disabled = disabled;
  createPrivateRoomButton.disabled = disabled;
  privateRoomCodeInput.disabled = disabled;
  joinPrivateRoomButton.disabled = disabled;
}

function resetPrivateRoomLobby() {
  privateRoomWaitingBox.classList.add("hidden");
  createdRoomCodeText.textContent = "0000";
  privateRoomStatusText.textContent = "建立房間後，將 4 位數房號分享給朋友。";
  privateRoomCodeInput.value = "";
  setLobbyControlsDisabled(false);
  joinButton.textContent = "快速配對";
}

function updateLastMoveToggleButton() {
  lastMoveToggleButton.textContent = showLastMoveHighlight ? "開啟" : "關閉";
  lastMoveToggleButton.classList.toggle("active", showLastMoveHighlight);
  lastMoveToggleButton.setAttribute("aria-pressed", String(showLastMoveHighlight));
}

function getIndex(x, y) {
  return y * BOARD_SIZE + x;
}

function createBoard() {
  board.innerHTML = "";
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.x = x;
      cell.dataset.y = y;
      cell.addEventListener("click", () => handleCellClick(x, y));
      board.appendChild(cell);
    }
  }
  renderBoard();
}

function renderBoard() {
  document.querySelectorAll(".cell").forEach((cell) => {
    cell.innerHTML = "";
    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);
    const value = currentBoard[getIndex(x, y)];
    if (value === 0) return;

    const stone = document.createElement("div");
    stone.className = value === 1 ? "stone black" : "stone white";
    if (showLastMoveHighlight && lastMove && lastMove.x === x && lastMove.y === y) {
      stone.classList.add("lastMove");
    }
    cell.appendChild(stone);
  });
}

function handleCellClick(x, y) {
  if (!myColor) return showToast("請先加入配對");
  if (gameStatus !== "playing") return showToast("目前無法落子");
  if (undoPending) return showToast("請先完成悔棋處理");
  if (currentTurn !== myColor) return showToast("請等待對手落子");
  if (currentBoard[getIndex(x, y)] !== 0) return showToast("這個位置已經有棋子");
  socket.emit("makeMove", { x, y });
}

function updateTurnText() {
  if (gameStatus === "finished") return;
  if (undoPending) return void (statusText.textContent = "等待悔棋處理");
  statusText.textContent = currentTurn === myColor ? "輪到您落子" : "等待對手落子";
}

function updateUndoButton() {
  undoButton.disabled = !(gameStatus === "playing" && myColor && lastMoveColor === myColor && !undoPending);
  undoButton.textContent = undoPending ? "等待悔棋處理..." : "申請悔棋";
}

function resetChat() {
  chatMessages.innerHTML = '<p class="emptyText">配對成功後即可聊天</p>';
  chatInput.value = "";
  chatInput.disabled = true;
  sendChatButton.disabled = true;
}

function enableChat() {
  chatInput.disabled = false;
  sendChatButton.disabled = false;
}

function appendChatMessage(data) {
  chatMessages.querySelector(".emptyText")?.remove();
  if (data.type === "system") {
    const item = document.createElement("p");
    item.className = "chatSystemMessage";
    item.textContent = data.message;
    chatMessages.appendChild(item);
  } else {
    const item = document.createElement("div");
    item.className = "chatMessage";
    const name = document.createElement("div");
    name.className = "chatMessageName";
    name.textContent = data.playerName;
    const text = document.createElement("div");
    text.className = "chatMessageText";
    text.textContent = data.message;
    item.append(name, text);
    chatMessages.appendChild(item);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendGlobalChatMessage(data) {
  if (data.id && seenGlobalMessageIds.has(data.id)) return;
  if (data.id) seenGlobalMessageIds.add(data.id);
  globalChatMessages.querySelector(".emptyText")?.remove();
  const item = document.createElement("div");
  item.className = "chatMessage";
  const name = document.createElement("div");
  name.className = "chatMessageName";
  name.textContent = data.playerName;
  const text = document.createElement("div");
  text.className = "chatMessageText";
  text.textContent = data.message;
  item.append(name, text);
  globalChatMessages.appendChild(item);
  globalChatMessages.scrollTop = globalChatMessages.scrollHeight;
}

function renderLeaderboard(players) {
  rankingList.innerHTML = "";
  if (!players?.length) {
    rankingList.innerHTML = '<p class="emptyText">尚無排行榜資料</p>';
    return;
  }
  players.forEach((player, index) => {
    const item = document.createElement("div");
    item.className = "rankingItem";
    const rank = document.createElement("div");
    rank.className = index === 0 ? "rankingIndex topOne" : "rankingIndex";
    rank.textContent = index + 1;
    const name = document.createElement("div");
    name.className = "rankingName";
    name.textContent = player.displayName;
    const score = document.createElement("div");
    score.className = "rankingScore";
    score.textContent = `${player.points} 分`;
    item.append(rank, name, score);
    rankingList.appendChild(item);
  });
}

function hideResultModal() {
  resultModal.classList.add("hidden");
  resultModalCard.classList.remove("victory", "defeat", "draw", "unavailable");
  rematchButton.disabled = false;
  rematchButton.textContent = "與同對手繼續";
  rematchHint.textContent = "可以返回首頁，或邀請同一位玩家再來一局。";
}

function showResultModal(type, customMessage = "") {
  hideResultModal();
  resultModal.classList.remove("hidden");
  resultModalCard.classList.add(type);
  resultBadge.textContent = type === "unavailable" ? "CONNECTION ENDED" : "GAME OVER";

  const content = {
    victory: ["🏆", "恭喜獲勝！", "您成功完成五子連線，贏得本場對戰。"],
    defeat: ["😢", "本局失敗", "對手已完成五子連線，再接再厲。"],
    draw: ["🤝", "本局平手", "棋盤已滿，雙方未分出勝負。"],
    unavailable: ["🔌", "遊戲連線已失效", customMessage || "對手已離線或伺服器曾重新啟動，請返回首頁重新配對。"]
  }[type];

  [resultIcon.textContent, resultTitle.textContent, resultMessage.textContent] = content;
  if (type === "unavailable") {
    rematchButton.disabled = true;
    rematchButton.textContent = "無法繼續";
  }
}

function saveCurrentRoom(roomId) {
  currentRoomId = roomId;
  sessionStorage.setItem("gomokuCurrentRoomId", roomId);
}

function resetToHome() {
  currentRoomId = null;
  sessionStorage.removeItem("gomokuCurrentRoomId");
  myColor = null;
  currentTurn = null;
  gameStatus = "waiting";
  currentBoard = Array(BOARD_SIZE * BOARD_SIZE).fill(0);
  lastMoveColor = null;
  lastMove = null;
  undoPending = false;
  loginSection.classList.remove("hidden");
  gameInfo.classList.add("hidden");
  roomChatCard.classList.add("hidden");
  roomIdText.textContent = "尚未配對";
  myColorText.textContent = "尚未分配";
  statusText.textContent = "等待中";
  blackPlayerText.textContent = "等待玩家";
  whitePlayerText.textContent = "等待玩家";
  undoRequestBox.classList.add("hidden");
  resetPrivateRoomLobby();
  resetChat();
  hideResultModal();
  updateUndoButton();
  renderBoard();
}

joinButton.addEventListener("click", () => {
  const name = playerNameInput.value.trim();
  if (!name) return showToast("請先輸入玩家名稱");
  setLobbyControlsDisabled(true);
  joinButton.textContent = "等待配對中...";
  socket.emit("joinQueue", { name, playerToken });
});

createPrivateRoomButton.addEventListener("click", () => {
  const name = playerNameInput.value.trim();
  if (!name) return showToast("請先輸入玩家名稱");
  setLobbyControlsDisabled(true);
  socket.emit("createPrivateRoom", { name, playerToken });
});

joinPrivateRoomButton.addEventListener("click", () => {
  const name = playerNameInput.value.trim();
  const roomCode = privateRoomCodeInput.value.trim();
  if (!name) return showToast("請先輸入玩家名稱");
  if (!/^\d{4}$/.test(roomCode)) return showToast("請輸入正確的 4 位數房號");
  setLobbyControlsDisabled(true);
  socket.emit("joinPrivateRoom", { name, roomCode, playerToken });
});

cancelPrivateRoomButton.addEventListener("click", () => socket.emit("cancelPrivateRoom"));
privateRoomCodeInput.addEventListener("input", () => {
  privateRoomCodeInput.value = privateRoomCodeInput.value.replace(/\D/g, "").slice(0, 4);
});

homeButton.addEventListener("click", () => {
  socket.emit("leaveRoom");
  resetToHome();
  showToast("已返回首頁");
});

rematchButton.addEventListener("click", () => {
  rematchButton.disabled = true;
  rematchButton.textContent = "已送出邀請，等待對手...";
  rematchHint.textContent = "已同意再來一局，等待對手確認。";
  socket.emit("requestRematch");
});

undoButton.addEventListener("click", () => socket.emit("requestUndo"));
acceptUndoButton.addEventListener("click", () => socket.emit("respondUndo", { accept: true }));
rejectUndoButton.addEventListener("click", () => socket.emit("respondUndo", { accept: false }));

lastMoveToggleButton.addEventListener("click", () => {
  showLastMoveHighlight = !showLastMoveHighlight;
  localStorage.setItem("gomokuShowLastMoveHighlight", String(showLastMoveHighlight));
  updateLastMoveToggleButton();
  renderBoard();
});

globalChatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = playerNameInput.value.trim();
  const message = globalChatInput.value.trim();
  if (!name) return showToast("請先在左側輸入玩家名稱");
  if (!message) return;
  socket.emit("sendGlobalChatMessage", { name, message });
  globalChatInput.value = "";
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  socket.emit("sendChatMessage", { message });
  chatInput.value = "";
});

refreshRankingButton.addEventListener("click", () => socket.emit("getLeaderboard"));

socket.on("connect", () => {
  connectionDot.classList.add("online");
  connectionText.textContent = "伺服器連線正常";
  startHeartbeat();
  socket.emit("getLeaderboard");
  socket.emit("getGlobalChatHistory");
  if (currentRoomId) socket.emit("resumeGame", { roomId: currentRoomId, playerToken });
});

socket.on("disconnect", () => {
  stopHeartbeat();
  connectionDot.classList.remove("online");
  connectionText.textContent = "伺服器連線中斷，正在重新連線...";
  if (myColor && gameStatus === "playing") statusText.textContent = "連線暫時中斷，請稍候";
});

socket.on("privateRoomCreated", ({ roomCode }) => {
  privateRoomWaitingBox.classList.remove("hidden");
  createdRoomCodeText.textContent = roomCode;
  privateRoomStatusText.textContent = "私人房間已建立，等待朋友加入。";
});
socket.on("privateRoomCancelled", () => resetPrivateRoomLobby());
socket.on("privateRoomError", (message) => {
  resetPrivateRoomLobby();
  showToast(message);
});
socket.on("queueStatus", ({ message }) => showToast(message));

function enterGame(data) {
  myColor = data.myColor;
  saveCurrentRoom(data.roomId);
  loginSection.classList.add("hidden");
  gameInfo.classList.remove("hidden");
  roomChatCard.classList.remove("hidden");
  roomIdText.textContent = data.roomId;
  myColorText.textContent = myColor === "black" ? "黑棋" : "白棋";
  enableChat();
  hideResultModal();
}

socket.on("gameStarted", (data) => {
  enterGame(data);
  resetChat();
  enableChat();
  showToast("配對成功，遊戲開始");
});

socket.on("gameResumed", (data) => {
  enterGame(data);
  gameStatus = data.status;
  showToast("連線已恢復，可以繼續遊戲");
});

socket.on("resumeGameFailed", (message) => {
  if (!currentRoomId) return;
  sessionStorage.removeItem("gomokuCurrentRoomId");
  currentRoomId = null;
  gameStatus = "finished";
  showResultModal("unavailable", message);
});

socket.on("gameState", (data) => {
  currentBoard = data.board;
  currentTurn = data.currentTurn;
  gameStatus = data.status;
  lastMoveColor = data.lastMoveColor;
  lastMove = data.lastMove || null;
  undoPending = data.undoPending;
  roomIdText.textContent = data.roomId;
  blackPlayerText.textContent = data.players.find((player) => player.color === "black")?.name || "等待玩家";
  whitePlayerText.textContent = data.players.find((player) => player.color === "white")?.name || "等待玩家";
  renderBoard();
  updateTurnText();
  updateUndoButton();
});

socket.on("gameOver", (data) => {
  gameStatus = "finished";
  updateUndoButton();
  if (data.winner === "draw") return showResultModal("draw");
  showResultModal(data.winner === myColor ? "victory" : "defeat");
});

socket.on("rematchStatus", ({ accepted, total }) => {
  rematchHint.textContent = `${accepted} / ${total} 位玩家已同意再來一局`;
});

socket.on("rematchStartedNotice", () => showToast("雙方已同意，下一局開始！"));
socket.on("undoStatus", (data) => {
  undoPending = data.status === "pending";
  updateTurnText();
  updateUndoButton();
});
socket.on("undoRequestReceived", ({ requesterName }) => {
  undoRequestText.textContent = `${requesterName} 希望撤回最後一步，是否同意？`;
  undoRequestBox.classList.remove("hidden");
});
socket.on("undoResolved", ({ accepted }) => {
  undoPending = false;
  undoRequestBox.classList.add("hidden");
  updateTurnText();
  updateUndoButton();
  showToast(accepted ? "對手已同意悔棋" : "對手拒絕悔棋");
});
socket.on("chatMessage", appendChatMessage);
socket.on("chatHistory", (messages) => {
  chatMessages.innerHTML = "";
  if (!messages?.length) return void (chatMessages.innerHTML = '<p class="emptyText">尚無聊天訊息</p>');
  messages.forEach(appendChatMessage);
});
socket.on("globalChatMessage", appendGlobalChatMessage);
socket.on("globalChatHistory", (messages) => {
  globalChatMessages.innerHTML = "";
  seenGlobalMessageIds.clear();
  if (!messages?.length) return void (globalChatMessages.innerHTML = '<p class="emptyText">尚無公開訊息</p>');
  messages.forEach(appendGlobalChatMessage);
});
socket.on("leaderboardUpdated", renderLeaderboard);
socket.on("opponentDisconnected", (data) => {
  gameStatus = "finished";
  showResultModal("unavailable", data?.message);
});
socket.on("rematchUnavailable", (data) => showResultModal("unavailable", data?.message));
socket.on("errorMessage", showToast);

createBoard();
resetChat();
hideResultModal();
updateUndoButton();
roomChatCard.classList.add("hidden");
resetPrivateRoomLobby();
updateLastMoveToggleButton();
