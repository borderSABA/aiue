(() => {
'use strict';

const $ = s => document.querySelector(s);
const screens = [...document.querySelectorAll('.screen')];

const GAME_ID = 'aiue-battle';
const GAME_NAME = 'あいうえバトル';
const MAX_PLAYERS = 10;
const WORKER_ORIGIN = String(
  window.AIUE_SERVER_URL || 'https://aiue-online.naitoryo7110.workers.dev'
).replace(/\/$/, '');
const SERVER_URL = WORKER_ORIGIN;
const COMMON_MANAGER_URL = 'https://boardgame-hub-api.naitoryo7110.workers.dev';
const COMMON_PLAYER_NAME_KEY = 'boardgamePlayerName';
const ROOM_IDS = ['room1', 'room2', 'room3', 'room4'];
const APP_VERSION = 'v0.19';
const VERSION = '0.17';
const ROOM_COUNT = ROOM_IDS.length;
const NAME_DRAFT_KEY = `${GAME_ID}-name-draft`;
const ACTIVE_ROOM_KEY = `${GAME_ID}-online-room`;
const ACTIVE_NAME_KEY = `${GAME_ID}-online-active-name`;
const kanaRows = [
  ['あ','い','う','え','お'],
  ['か','き','く','け','こ'],
  ['さ','し','す','せ','そ'],
  ['た','ち','つ','て','と'],
  ['な','に','ぬ','ね','の'],
  ['は','ひ','ふ','へ','ほ'],
  ['ま','み','む','め','も'],
  ['や','','ゆ','','よ'],
  ['ら','り','る','れ','ろ'],
  ['わ','','を','ー','ん']
];
const voicedMap = {
  'が':'か','ぎ':'き','ぐ':'く','げ':'け','ご':'こ','ざ':'さ','じ':'し','ず':'す','ぜ':'せ','ぞ':'そ',
  'だ':'た','ぢ':'ち','づ':'つ','で':'て','ど':'と','ば':'は','び':'ひ','ぶ':'ふ','べ':'へ','ぼ':'ほ',
  'ぱ':'は','ぴ':'ひ','ぷ':'ふ','ぺ':'へ','ぽ':'ほ','ゔ':'う',
  'ぁ':'あ','ぃ':'い','ぅ':'う','ぇ':'え','ぉ':'お','ゃ':'や','ゅ':'ゆ','ょ':'よ','っ':'つ','ゎ':'わ','ヵ':'か','ヶ':'け'
};
const allowed = new Set(kanaRows.flat().filter(Boolean));

let selectedRoom = null;
let socket = null;
let roomState = null;
let currentPlayerName = '';
let selectedKana = '';
let attackPending = false;
let intentionalClose = false;
let lastAttackEvent = '';
let lastPassEvent = '';
let toastTimer = null;
let roomPollTimer = null;
let cpuTurnTimer = null;
let turnTimerInterval = null;
let timeoutSentForToken = '';
let timeoutLastSentAt = 0;
// Server-synchronized local deadline. Do not compare a server timestamp directly
// against each device clock because guest devices may have clock skew.
let syncedTurnToken = '';
let syncedTurnDeadlineLocal = 0;
let reconnectTimer = null;
let reconnectAttempts = 0;
let commonNameSavedForSession = null;
let actionSeq = 0;

function commonSavedName() {
  return String(
    localStorage.getItem(COMMON_PLAYER_NAME_KEY) || ''
  ).trim().slice(0, 32);
}

function saveCommonNameOnActualStart(playerName) {
  const name = String(playerName || '').trim().slice(0, 32);
  if (!name) return;
  localStorage.setItem(COMMON_PLAYER_NAME_KEY, name);
}

function roomIdFromNo(roomNo) {
  return ROOM_IDS[Number(roomNo) - 1] || null;
}

function roomNoFromId(roomId) {
  const index = ROOM_IDS.indexOf(String(roomId || ''));
  return index >= 0 ? index + 1 : null;
}

function tokenKey(roomId) {
  return `${GAME_ID}-online-token-${roomId}`;
}

function getToken(roomId) {
  let token = localStorage.getItem(tokenKey(roomId));
  if (!token) {
    token = crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '')
      : `t${Date.now()}${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(tokenKey(roomId), token);
  }
  return token;
}

function newActionId(prefix = 'op') {
  actionSeq = (actionSeq + 1) % 1000000;
  return [
    prefix,
    Date.now(),
    actionSeq,
    Math.random().toString(36).slice(2, 8)
  ].join('-');
}

function clearActiveRoom() {
  localStorage.removeItem(ACTIVE_ROOM_KEY);
  localStorage.removeItem(ACTIVE_NAME_KEY);
}

function rememberActiveRoom(roomId, playerName) {
  if (!roomId || !playerName) return;
  localStorage.setItem(ACTIVE_ROOM_KEY, roomId);
  localStorage.setItem(ACTIVE_NAME_KEY, playerName);
}

function onRoomStateReceived(state) {
  const roomId = roomIdFromNo(state.roomNo);
  const meName = state.me?.name || currentPlayerName;
  if (roomId && meName) {
    currentPlayerName = meName;
    rememberActiveRoom(roomId, meName);
  }

  const started =
    state.status === 'playing'
    || state.phase === 'playing'
    || state.gameStarted === true;

  const sessionId = state.gameSessionId || null;

  if (
    started
    && sessionId
    && commonNameSavedForSession !== sessionId
  ) {
    saveCommonNameOnActualStart(meName);
    commonNameSavedForSession = sessionId;
  }
}

function normalizeWord(raw) {
  let s = String(raw || '').trim().replace(/\s+/g, '').normalize('NFKC');
  s = s.replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  s = [...s].map(ch => voicedMap[ch] || ch).filter(ch => allowed.has(ch)).join('');
  return s.slice(0, 15);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function show(id) {
  screens.forEach(x => x.classList.toggle('active', x.id === id));
  document.body.classList.toggle('game-active', id === 'gameScreen');
  const inRoom = selectedRoom !== null && id !== 'lobbyScreen';
  $('#roomChip').textContent = inRoom ? `ROOM ${selectedRoom}` : 'ロビー';
  $('#leaveRoomBtn').classList.toggle('hidden', !inRoom);
  $('#logBtn').classList.toggle('hidden', !(id === 'gameScreen' || id === 'resultScreen'));
}

function toast(message, ms = 2600) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function roomStatusLabel(room) {
  if (room.status === 'playing' || room.phase === 'playing') {
    return ['ゲーム中', 'playing'];
  }
  if (room.status === 'finished' || room.phase === 'result') {
    return ['終了', 'playing'];
  }
  return ['待機中', room.players ? 'playing' : 'empty'];
}

async function fetchRooms() {
  if (!SERVER_URL) {
    $('#serverStatus').textContent = 'SERVER_URL 未設定';
    return;
  }
  try {
    const res = await fetch(`${SERVER_URL}/rooms`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderRooms(data.rooms || []);
    $('#serverStatus').textContent = 'オンライン接続中';
    $('#serverStatus').classList.add('ok');
  } catch (e) {
    $('#serverStatus').textContent = 'サーバー未接続';
    $('#serverStatus').classList.remove('ok');
    renderRooms([]);
  }
}

function renderRooms(rooms) {
  const byNo = new Map(rooms.map(r => [Number(r.roomNo), r]));
  const root = $('#roomsGrid');
  root.innerHTML = '';

  for (let room = 1; room <= ROOM_COUNT; room++) {
    const roomId = roomIdFromNo(room);
    const meta = byNo.get(room) || {
      roomNo: room,
      roomId,
      status: 'lobby',
      phase: 'lobby',
      players: 0,
      participantNames: []
    };
    const [label, cls] = roomStatusLabel(meta);
    const names = Array.isArray(meta.participantNames)
      ? meta.participantNames
      : [];
    const isReconnect =
      localStorage.getItem(ACTIVE_ROOM_KEY) === roomId
      && !!localStorage.getItem(tokenKey(roomId));

    const card = document.createElement('article');
    card.className = 'room-card' + (meta.players ? ' occupied' : '');
    card.innerHTML = `
      <div class="room-card-top">
        <span class="room-no">ROOM ${room}</span>
        <span class="room-status ${cls}">${label}</span>
      </div>
      <div class="room-people"><b>${meta.players || 0}</b><span>/ ${MAX_PLAYERS}人</span></div>
      <div class="room-players-summary">参加者：${names.length ? names.map(escapeHtml).join('、') : 'なし'}</div>
      <div class="room-actions">
        <button class="primary enter-room" data-room="${room}">${isReconnect ? '再接続' : '参加する'}</button>
        <button class="room-init" data-init="${room}">初期化</button>
      </div>`;
    root.append(card);
  }

  root.querySelectorAll('.enter-room').forEach(btn => {
    btn.addEventListener('click', () => joinRoom(Number(btn.dataset.room)));
  });
  root.querySelectorAll('.room-init').forEach(btn => {
    btn.addEventListener('click', () => resetRoomFromLobby(Number(btn.dataset.init)));
  });
}

async function resetRoomFromLobby(room) {
  const roomId = roomIdFromNo(room);
  if (!roomId) return;
  const ok = confirm(`ROOM ${room} を初期化しますか？`);
  if (!ok) return;

  try {
    const url = new URL(`${WORKER_ORIGIN}/reset-empty`);
    url.searchParams.set('roomId', roomId);
    url.searchParams.set('actionId', newActionId('reset'));
    const response = await fetch(url, {
      method: 'POST',
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'ROOMを初期化できませんでした。');
    }
    toast(`ROOM ${room} を初期化しました`);
    await fetchRooms();
  } catch (error) {
    toast(error.message || 'ROOMを初期化できませんでした。');
  }
}

function makeNumberOptions() {
  const target = $('#targetCount');
  target.innerHTML = '';
  for (let n = 2; n <= 10; n++) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = `${n}人`;
    target.append(opt);
  }
  for (const id of ['minLength', 'maxLength']) {
    const select = $('#' + id);
    select.innerHTML = '';
    for (let n = 2; n <= 15; n++) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = `${n}文字`;
      select.append(opt);
    }
  }
}

function getPlayerName() {
  return $('#playerNameInput').value.trim().slice(0, 32);
}

async function checkRoomJoin(roomId, playerName, token) {
  const url = new URL(`${WORKER_ORIGIN}/join-check`);
  url.searchParams.set('roomId', roomId);
  url.searchParams.set('name', playerName);
  url.searchParams.set('token', token);

  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'ROOMへ参加できません。');
  }

  return data;
}

function openRoomSocket(room, name, token) {
  closeSocket(true);
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  selectedRoom = room;
  currentPlayerName = name;
  roomState = null;
  selectedKana = '';
  attackPending = false;
  intentionalClose = false;
  $('#roomLabel').textContent = `ROOM ${room}`;
  show('roomScreen');
  $('#roomGuide').textContent = '接続中…';

  const wsBase = WORKER_ORIGIN
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:');
  const url = new URL(`${wsBase}/room/${room}/ws`);
  url.searchParams.set('room', String(room));
  url.searchParams.set('token', token);
  url.searchParams.set('name', name);

  const ws = new WebSocket(url);
  socket = ws;

  ws.addEventListener('open', () => {
    if (socket !== ws) return;
    reconnectAttempts = 0;
    $('#serverStatus').textContent = 'オンライン接続中';
    $('#serverStatus').classList.add('ok');
  });

  ws.addEventListener('message', e => {
    if (socket !== ws) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    socket = null;
    if (intentionalClose) return;
    if (selectedRoom !== null) {
      $('#serverStatus').textContent = '再接続中…';
      $('#serverStatus').classList.remove('ok');
      scheduleReconnect();
    }
  });

  ws.addEventListener('error', () => {
    if (socket !== ws) return;
    if (!intentionalClose) {
      $('#serverStatus').textContent = '再接続中…';
      $('#serverStatus').classList.remove('ok');
    }
  });
}

async function joinRoom(room, options = {}) {
  const roomId = roomIdFromNo(room);
  if (!roomId) return;

  const name = String(
    options.name ?? getPlayerName()
  ).trim().slice(0, 32);

  if (!name) {
    toast('プレイヤー名を入力してください');
    $('#playerNameInput').focus();
    return;
  }

  const token = getToken(roomId);

  try {
    const check = await checkRoomJoin(
      roomId,
      name,
      token
    );

    if (options.reconnect && check.hostCheck === true) {
      clearActiveRoom();
      selectedRoom = null;
      roomState = null;
      currentPlayerName = '';
      show('lobbyScreen');
      await fetchRooms();
      return;
    }
  } catch (error) {
    if (options.reconnect) {
      clearActiveRoom();
      selectedRoom = null;
      roomState = null;
      currentPlayerName = '';
      show('lobbyScreen');
      await fetchRooms();
    }
    toast(error.message || 'ROOMへ参加できません。');
    return;
  }

  $('#playerNameInput').value = name;
  sessionStorage.setItem(NAME_DRAFT_KEY, name);
  openRoomSocket(room, name, token);
}

function scheduleReconnect() {
  if (intentionalClose || selectedRoom === null) return;
  clearTimeout(reconnectTimer);
  const delay = Math.min(5000, 700 + reconnectAttempts * 700);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectCurrentRoom();
  }, delay);
}

async function reconnectCurrentRoom() {
  if (intentionalClose || selectedRoom === null) return;
  if (socket && (
    socket.readyState === WebSocket.OPEN
    || socket.readyState === WebSocket.CONNECTING
  )) {
    return;
  }

  const roomId = roomIdFromNo(selectedRoom);
  const name =
    currentPlayerName
    || localStorage.getItem(ACTIVE_NAME_KEY)
    || getPlayerName();

  if (!roomId || !name) {
    clearActiveRoom();
    selectedRoom = null;
    show('lobbyScreen');
    return;
  }

  const token = getToken(roomId);
  try {
    const check = await checkRoomJoin(
      roomId,
      name,
      token
    );
    if (check.hostCheck === true) {
      clearActiveRoom();
      selectedRoom = null;
      roomState = null;
      currentPlayerName = '';
      show('lobbyScreen');
      fetchRooms();
      return;
    }
    openRoomSocket(selectedRoom, name, token);
  } catch (error) {
    clearActiveRoom();
    selectedRoom = null;
    roomState = null;
    currentPlayerName = '';
    show('lobbyScreen');
    toast(error.message || '再接続できませんでした。');
    fetchRooms();
  }
}

function handleServerMessage(msg) {
  if (msg.type === 'state') {
    roomState = msg;
    attackPending = false;
    syncTurnDeadlineFromState(msg);
    onRoomStateReceived(msg);
    routeFromState();
    return;
  }
  if (msg.type === 'attackEvent') {
    if (msg.eventId && msg.eventId === lastAttackEvent) return;
    lastAttackEvent = msg.eventId || '';
    showAttack(msg.attackerName, msg.kana, msg.hit);
    return;
  }
  if (msg.type === 'passEvent') {
    if (msg.eventId && msg.eventId === lastPassEvent) return;
    lastPassEvent = msg.eventId || '';
    showPass(msg.playerName || 'プレイヤー');
    return;
  }
  if (msg.type === 'error') {
    attackPending = false;
    toast(msg.message || '操作できません');
    renderGame();
    return;
  }
  if (msg.type === 'roomReset') {
    toast('部屋が初期化されました');
    intentionalClose = true;
    try { socket?.close(); } catch {}
    socket = null;
    selectedRoom = null;
    roomState = null;
    currentPlayerName = '';
    clearActiveRoom();
    show('lobbyScreen');
    fetchRooms();
  }
}

function routeFromState() {
  if (!roomState) return;
  // Defensive normalization: a stale browser cache or older server state must not stop rendering.
  if (!Array.isArray(roomState.players)) roomState.players = [];
  if (!Array.isArray(roomState.used)) roomState.used = [];
  if (!Array.isArray(roomState.logs)) roomState.logs = [];
  $('#roomChip').textContent = `ROOM ${roomState.roomNo}`;
  if (roomState.phase === 'lobby') {
    show('roomScreen');
    renderRoomScreen();
  } else if (roomState.phase === 'word') {
    show('wordScreen');
    renderWordScreen();
  } else if (roomState.phase === 'playing') {
    show('gameScreen');
    buildKanaIfNeeded();
    renderGame();
  } else if (roomState.phase === 'result') {
    show('resultScreen');
    renderResult();
  }
}

function isHost() {
  return !!roomState && roomState.hostId === roomState.meId;
}

function renderRoomScreen() {
  if (!roomState) return;
  const host = isHost();
  $('#hostBadge').textContent = host ? 'あなたがホスト' : '参加者';
  $('#themeInput').value = roomState.theme || '食べ物';
  $('#targetCount').value = String(roomState.targetCount || 2);
  $('#minLength').value = String(roomState.minLength || 2);
  $('#maxLength').value = String(roomState.maxLength || 10);
  $('#timeLimitEnabled').checked = !!roomState.timeLimitEnabled;
  $('#timeLimitSeconds').value = String(roomState.timeLimitSeconds || 30);
  const timeSummary = $('#timeLimitSummary');
  if (timeSummary) {
    timeSummary.textContent = roomState.timeLimitEnabled
      ? `現在の設定：時間制限 ON / ${Number(roomState.timeLimitSeconds || 30)}秒`
      : '現在の設定：時間制限 OFF';
  }
  $('#themeInput').disabled = !host;
  $('#targetCount').disabled = !host;
  $('#minLength').disabled = !host;
  $('#maxLength').disabled = !host;
  $('#timeLimitEnabled').disabled = !host;
  $('#timeLimitSeconds').disabled = !host || !roomState.timeLimitEnabled;
  $('#startWordsBtn').classList.toggle('hidden', !host);
  $('#addCpuBtn').classList.toggle('hidden', !host);

  const full = roomState.players.length === roomState.targetCount;
  $('#startWordsBtn').disabled = !full || roomState.players.length < 2;
  $('#addCpuBtn').disabled = !host || roomState.players.length >= 10;
  $('#roomGuide').textContent = host
    ? (full ? '参加者が揃いました。ワード入力を開始できます。' : `参加者を待っています（${roomState.players.length}/${roomState.targetCount}人）`)
    : 'ホストが設定して開始するまでお待ちください。';

  $('#roomPlayers').innerHTML = roomState.players.map(p => `
    <div class="online-player-row ${p.id === roomState.meId ? 'me' : ''}">
      <div class="online-player-name">${escapeHtml(p.name)}</div>
      <div class="online-player-tags">
        ${p.id === roomState.hostId ? '<span class="mini-tag host">HOST</span>' : ''}
        ${p.isCpu ? '<span class="mini-tag cpu">CPU</span>' : ''}
        ${p.id === roomState.meId ? '<span class="mini-tag me">自分</span>' : ''}
        ${host && p.isCpu ? `<button class="cpu-remove" data-cpu-id="${escapeHtml(p.id)}">削除</button>` : ''}
        ${p.isCpu ? '' : `<span class="connection-dot ${p.connected ? 'on' : ''}"></span>`}
      </div>
    </div>`).join('');
  $('#roomPlayers').querySelectorAll('.cpu-remove').forEach(btn => {
    btn.addEventListener('click', () => send({ type: 'removeCpu', cpuId: btn.dataset.cpuId, actionId: newActionId('cpu-remove') }));
  });
}

function renderWordScreen() {
  if (!roomState) return;
  const me = roomState.players.find(p => p.id === roomState.meId);
  if (!me) return;
  $('#wordPlayerName').textContent = me.name;
  $('#wordTheme').textContent = roomState.theme;
  $('#wordInput').placeholder = `${roomState.minLength || 2}〜${roomState.maxLength || 10}文字`;
  $('#wordInput').maxLength = roomState.maxLength || 10;
  $('#wordEntryArea').classList.toggle('hidden', me.ready);
  $('#wordWaitingArea').classList.toggle('hidden', !me.ready);
  $('#readyCounter').textContent = `入力済み ${roomState.readyCount}/${roomState.targetCount}人　ほかのプレイヤーを待っています。`;
  if (!me.ready) setTimeout(() => $('#wordInput').focus(), 60);
}

function buildKanaIfNeeded() {
  const board = $('#kanaBoard');
  if (board.children.length === 50) return;
  board.innerHTML = '';
  kanaRows.forEach(row => row.forEach(k => {
    const btn = document.createElement('button');
    btn.className = 'kana-cell' + (k ? '' : ' blank');
    btn.textContent = k;
    btn.disabled = !k;
    if (k) btn.addEventListener('click', () => selectKana(k));
    board.append(btn);
  }));
}

function selectKana(kana) {
  if (!roomState || roomState.phase !== 'playing' || attackPending) return;
  const me = roomState.players.find(p => p.id === roomState.meId);
  const myTurn = roomState.currentId === roomState.meId && me?.alive;
  if (!myTurn || roomState.used.includes(kana)) return;
  selectedKana = kana;
  renderKana();
}

function attackSelected() {
  if (!selectedKana || attackPending || !roomState) return;
  const me = roomState.players.find(p => p.id === roomState.meId);
  if (roomState.currentId !== roomState.meId || !me?.alive || roomState.used.includes(selectedKana)) return;
  attackPending = true;
  send({ type: 'attack', kana: selectedKana });
  selectedKana = '';
  renderKana();
}

function renderGame() {
  if (!roomState) return;
  try { renderPlayers(); } catch (e) { console.error('renderPlayers failed', e); }
  try { renderKana(); } catch (e) { console.error('renderKana failed', e); }
  try { renderStatus(); } catch (e) { console.error('renderStatus failed', e); }
  try { renderLog(); } catch (e) { console.error('renderLog failed', e); }
  scheduleCpuTurnIfNeeded();
}

function renderPlayers() {
  const maxLength = roomState.maxLength || 10;
  const players = Array.isArray(roomState.players) ? roomState.players : [];
  const splitAt = Math.min(5, Math.ceil(players.length / 2));
  const left = players.slice(0, splitAt);
  const right = players.slice(splitAt, splitAt + 5);

  const cardHtml = p => {
    const isMe = p.id === roomState.meId;
    const slots = [];
    for (let i = 0; i < maxLength; i++) {
      const ch = p.slots?.[i] ?? null;
      const hit = !!p.revealedMask?.[i];
      if (isMe && ch !== null) {
        // 自分の回答は常に見える。HITされた位置だけ赤背景にする。
        slots.push(`<div class="slot revealed own${hit ? ' hit-cell' : ''}">${escapeHtml(ch)}</div>`);
      } else if (!isMe && ch !== null) {
        // 相手はHITした本来の位置だけ公開する。
        slots.push(`<div class="slot revealed hit-cell">${escapeHtml(ch)}</div>`);
      } else {
        // 最大文字数ぶん必ず「？」枠を残す。generic .hidden とは分離する。
        slots.push('<div class="slot concealed">?</div>');
      }
    }
    const classes = [
      'player-card',
      p.id === roomState.currentId && p.alive ? 'current' : '',
      !p.alive ? 'eliminated' : '',
      isMe ? 'my-player' : '',
      p.isCpu ? 'cpu-player' : ''
    ].filter(Boolean).join(' ');
    return `<div class="${classes}">
      ${!p.alive ? '<div class="eliminated-tag">脱落</div>' : ''}
      <div class="player-head">
        <div class="player-name">${escapeHtml(p.name)}${p.isCpu ? '<span class="cpu-mark">CPU</span>' : ''}${isMe ? '<span class="you-mark">自分</span>' : ''}</div>
      </div>
      <div class="word-slots${maxLength >= 11 ? ' pc-two-row mobile-three-row' : (maxLength >= 6 ? ' mobile-two-row' : '')}" style="--slot-count:${maxLength};--pc-cols:${Math.ceil(maxLength / 2)};--mobile-cols:${maxLength >= 11 ? Math.ceil(maxLength / 3) : Math.ceil(maxLength / 2)}">${slots.join('')}</div>
    </div>`;
  };

  const leftRoot = $('#playersLeft');
  const rightRoot = $('#playersRight');
  if (leftRoot && rightRoot) {
    leftRoot.innerHTML = left.map(cardHtml).join('');
    rightRoot.innerHTML = right.map(cardHtml).join('');
    return;
  }

  // Compatibility fallback for an older cached HTML layout.
  const legacyRoot = $('#players');
  if (legacyRoot) legacyRoot.innerHTML = players.map(cardHtml).join('');
}

function renderKana() {
  if (!roomState) return;
  const me = roomState.players.find(p => p.id === roomState.meId);
  const myTurn = roomState.currentId === roomState.meId && me?.alive;
  const kanaBoard = $('#kanaBoard');
  kanaBoard?.classList.toggle('my-turn-outline', !!myTurn);
  [...kanaBoard.children].forEach(btn => {
    const k = btn.textContent;
    if (!k) return;
    const used = roomState.used.includes(k);
    btn.classList.toggle('used', used);
    btn.classList.toggle('selected', selectedKana === k);
    btn.disabled = used || !myTurn || attackPending;
  });
  const selected = $('#selectedKana');
  selected.textContent = selectedKana || (myTurn ? '未選択' : '待機中');
  selected.classList.toggle('has-value', !!selectedKana);
  $('#attackBtn').disabled = !myTurn || !selectedKana || attackPending;
}

function renderStatus() {
  const current = roomState.players.find(p => p.id === roomState.currentId);
  const me = roomState.players.find(p => p.id === roomState.meId);
  const myTurn = roomState.currentId === roomState.meId && me?.alive;
  $('#gameTheme').textContent = roomState.theme;
  $('#gameMinLength').textContent = `${roomState.minLength || 2}文字`;
  $('#gameMaxLength').textContent = `${roomState.maxLength || 10}文字`;
  $('#turnLine').textContent = current ? `${current.name} のターン` : '';
  updateTurnTimer();
  if (!me?.alive) {
    $('#messageStrip').textContent = 'あなたは脱落しました';
    $('#messageStrip').className = 'message-strip miss';
  } else if (myTurn) {
    $('#messageStrip').textContent = '文字を選んで「アタック」';
    $('#messageStrip').className = 'message-strip';
  } else {
    $('#messageStrip').textContent = `${current?.name || '相手'} の操作を待っています`;
    $('#messageStrip').className = 'message-strip';
  }
}

function renderLog() {
  const target = $('#logModal');
  if (!target) return;
  target.innerHTML = (roomState.logs || []).map(x => `<div class="log-item ${escapeHtml(x.type || '')}">${escapeHtml(x.text)}</div>`).join('');
  target.scrollTop = target.scrollHeight;
}

function renderResult() {
  if (!roomState) return;
  const winner = roomState.players.find(p => p.id === roomState.winnerId);
  $('#winnerName').textContent = winner?.name || '勝者なし';
  $('#answerList').innerHTML = roomState.players.map(p => `
    <div class="answer-row"><span>${escapeHtml(p.name)}</span><span>${escapeHtml(p.slots.join(''))}</span></div>`).join('');
  $('#againBtn').classList.toggle('hidden', !isHost());
}

function showAttack(name, kana, hit) {
  const overlay = $('#attackOverlay');
  overlay.classList.remove('pass-mode');
  $('#attackName').textContent = name;
  $('#attackLabel').textContent = '攻撃！';
  $('#attackKana').textContent = kana;
  const result = $('#attackResult');
  result.textContent = '';
  result.className = 'attack-result';
  overlay.classList.add('show');
  setTimeout(() => {
    result.textContent = hit ? 'HIT！' : 'MISS！';
    result.classList.add(hit ? 'hit' : 'miss');
  }, 650);
  setTimeout(() => overlay.classList.remove('show'), 1550);
}

function showPass(name) {
  const overlay = $('#attackOverlay');
  overlay.classList.add('pass-mode');
  $('#attackName').textContent = name;
  $('#attackLabel').textContent = '時間切れ';
  $('#attackKana').textContent = 'パス！';
  const result = $('#attackResult');
  result.textContent = '次のプレイヤーへ';
  result.className = 'attack-result miss';
  overlay.classList.add('show');
  setTimeout(() => {
    overlay.classList.remove('show');
    overlay.classList.remove('pass-mode');
  }, 1550);
}

function syncTurnDeadlineFromState(state) {
  const token = String(state?.turnToken || '');
  const serverNow = Number(state?.serverNow || 0);
  const deadlineAt = Number(state?.turnDeadlineAt || 0);

  if (
    state?.phase !== 'playing'
    || !state?.timeLimitEnabled
    || !token
    || !serverNow
    || !deadlineAt
  ) {
    syncedTurnToken = '';
    syncedTurnDeadlineLocal = 0;
    return;
  }

  // Convert the server-side remaining duration into a local monotonic countdown.
  // This keeps every client aligned even when device clocks differ.
  const remainingMs = Math.max(0, deadlineAt - serverNow);
  syncedTurnToken = token;
  syncedTurnDeadlineLocal = Date.now() + remainingMs;
}

function clearTurnTimer() {
  clearInterval(turnTimerInterval);
  turnTimerInterval = null;
}

function updateTurnTimer() {
  const wrap = $('#turnTimer');
  const value = $('#turnTimerValue');
  if (!wrap || !value || !roomState || roomState.phase !== 'playing' || !roomState.timeLimitEnabled) {
    if (wrap) wrap.classList.add('hidden');
    clearTurnTimer();
    return;
  }

  const current = roomState.players.find(p => p.id === roomState.currentId);
  if (!current || current.isCpu || !roomState.turnToken || !roomState.turnStartedAt) {
    wrap.classList.add('hidden');
    clearTurnTimer();
    return;
  }

  wrap.classList.remove('hidden');
  const token = roomState.turnToken;
  const tick = () => {
    if (!roomState || roomState.phase !== 'playing' || roomState.turnToken !== token) {
      clearTurnTimer();
      return;
    }
    const endAt =
      syncedTurnToken === token && syncedTurnDeadlineLocal > 0
        ? syncedTurnDeadlineLocal
        : Date.now() + Math.max(
            0,
            Number(roomState.turnDeadlineAt || 0) - Number(roomState.serverNow || 0)
          );
    const remainingMs = Math.max(0, endAt - Date.now());
    const remainingSec = Math.ceil(remainingMs / 1000);
    value.textContent = String(remainingSec);
    wrap.classList.toggle('danger', remainingSec <= 5);
    if (remainingMs <= 0) {
      const now = Date.now();
      const shouldSend =
        timeoutSentForToken !== token
        || now - timeoutLastSentAt >= 1000;
      if (shouldSend) {
        const sent = send({
          type: 'timeoutPass',
          turnToken: token,
          actionId: newActionId('timeout-pass')
        });
        if (sent) {
          timeoutSentForToken = token;
          timeoutLastSentAt = now;
        }
      }
    }
  };
  clearTurnTimer();
  tick();
  turnTimerInterval = setInterval(tick, 250);
}

function scheduleCpuTurnIfNeeded() {
  clearTimeout(cpuTurnTimer);
  cpuTurnTimer = null;
  if (!roomState || roomState.phase !== 'playing') return;
  const current = roomState.players.find(p => p.id === roomState.currentId);
  if (!current?.isCpu || !current.alive || !roomState.turnToken) return;
  const token = roomState.turnToken;
  cpuTurnTimer = setTimeout(() => {
    if (!roomState || roomState.phase !== 'playing' || roomState.turnToken !== token) return;
    send({ type: 'cpuTick', turnToken: token });
  }, 1200);
}

function addCpu() {
  if (!isHost()) return;
  send({ type: 'addCpu', actionId: newActionId('cpu-add') });
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    toast('サーバーに接続されていません');
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

function syncConfig() {
  if (!isHost()) return false;
  const minLength = Number($('#minLength').value);
  const maxLength = Number($('#maxLength').value);
  if (minLength > maxLength) {
    toast('最低文字数は最高文字数以下にしてください');
    return false;
  }
  return send({
    type: 'setConfig',
    actionId: newActionId('config'),
    theme: $('#themeInput').value.trim() || '自由',
    targetCount: Number($('#targetCount').value),
    minLength,
    maxLength,
    timeLimitEnabled: $('#timeLimitEnabled').checked,
    timeLimitSeconds: Math.max(1, Math.min(3600, Number($('#timeLimitSeconds').value) || 30))
  });
}

function startWords() {
  if (!isHost()) return;
  const minLength = Number($('#minLength').value);
  const maxLength = Number($('#maxLength').value);
  if (minLength > maxLength) {
    toast('最低文字数は最高文字数以下にしてください');
    return;
  }
  send({
    type: 'startWords',
    actionId: newActionId('start'),
    theme: $('#themeInput').value.trim() || '自由',
    targetCount: Number($('#targetCount').value),
    minLength,
    maxLength,
    timeLimitEnabled: $('#timeLimitEnabled').checked,
    timeLimitSeconds: Math.max(1, Math.min(3600, Number($('#timeLimitSeconds').value) || 30))
  });
}

function submitWord() {
  const word = normalizeWord($('#wordInput').value);
  const minLength = roomState?.minLength || 2;
  const maxLength = roomState?.maxLength || 10;
  if (word.length < minLength || word.length > maxLength) {
    toast(`${minLength}〜${maxLength}文字で入力してください`);
    return;
  }
  if (send({ type: 'submitWord', word })) {
    $('#wordInput').value = '';
    $('#normalizedPreview').textContent = '変換後：—';
  }
}

function leaveRoom() {
  clearTimeout(cpuTurnTimer);
  clearTurnTimer();
  clearTimeout(reconnectTimer);
  cpuTurnTimer = null;
  reconnectTimer = null;

  if (socket?.readyState === WebSocket.OPEN) {
    send({ type: 'leave' });
  }

  intentionalClose = true;
  try { socket?.close(1000, 'left'); } catch {}
  socket = null;
  selectedRoom = null;
  roomState = null;
  currentPlayerName = '';
  selectedKana = '';
  attackPending = false;
  reconnectAttempts = 0;
  commonNameSavedForSession = null;
  clearActiveRoom();
  show('lobbyScreen');
  fetchRooms();
}

function closeSocket(markIntentional = true) {
  clearTimeout(cpuTurnTimer);
  clearTurnTimer();
  cpuTurnTimer = null;
  if (!socket) return;
  if (markIntentional) intentionalClose = true;
  const closingSocket = socket;
  socket = null;
  try { closingSocket.close(); } catch {}
}

$('#targetCount').addEventListener('change', syncConfig);
$('#minLength').addEventListener('change', () => {
  if (Number($('#minLength').value) > Number($('#maxLength').value)) $('#maxLength').value = $('#minLength').value;
  syncConfig();
});
$('#maxLength').addEventListener('change', () => {
  if (Number($('#maxLength').value) < Number($('#minLength').value)) $('#minLength').value = $('#maxLength').value;
  syncConfig();
});
$('#timeLimitEnabled').addEventListener('change', () => {
  $('#timeLimitSeconds').disabled = !isHost() || !$('#timeLimitEnabled').checked;
  syncConfig();
});
$('#timeLimitSeconds').addEventListener('change', () => {
  const el = $('#timeLimitSeconds');
  el.value = String(Math.max(1, Math.min(3600, Number(el.value) || 30)));
  syncConfig();
});
$('#themeInput').addEventListener('change', syncConfig);
$('#addCpuBtn').addEventListener('click', addCpu);
$('#startWordsBtn').addEventListener('click', startWords);
$('#saveWordBtn').addEventListener('click', submitWord);
$('#attackBtn').addEventListener('click', attackSelected);
$('#wordInput').addEventListener('input', e => {
  const w = normalizeWord(e.target.value);
  $('#normalizedPreview').textContent = `変換後：${w || '—'}`;
});
$('#wordInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); submitWord(); }
});
$('#leaveRoomBtn').addEventListener('click', leaveRoom);
$('#againBtn').addEventListener('click', () => send({ type: 'restart', actionId: newActionId('restart') }));
$('#backLobbyBtn').addEventListener('click', leaveRoom);
$('#logBtn').addEventListener('click', () => {
  renderLog();
  const d = $('#logDialog');
  if (d.showModal) d.showModal(); else d.setAttribute('open', '');
});
$('#closeLogBtn').addEventListener('click', () => {
  const d = $('#logDialog');
  if (d.close) d.close(); else d.removeAttribute('open');
});
$('#ruleBtn').addEventListener('click', () => {
  const d = $('#ruleDialog');
  if (d.showModal) d.showModal(); else d.setAttribute('open', '');
});
$('#closeRuleBtn').addEventListener('click', () => {
  const d = $('#ruleDialog');
  if (d.close) d.close(); else d.removeAttribute('open');
});

makeNumberOptions();

const initialName =
  sessionStorage.getItem(NAME_DRAFT_KEY)
  ?? commonSavedName()
  ?? '';
$('#playerNameInput').value = initialName;
$('#playerNameInput').addEventListener('input', event => {
  sessionStorage.setItem(NAME_DRAFT_KEY, event.target.value);
});

show('lobbyScreen');
fetchRooms();

const savedRoomId = localStorage.getItem(ACTIVE_ROOM_KEY);
const savedActiveName = localStorage.getItem(ACTIVE_NAME_KEY);
const savedRoomNo = roomNoFromId(savedRoomId);

if (
  savedRoomNo
  && savedActiveName
  && localStorage.getItem(tokenKey(savedRoomId))
) {
  currentPlayerName = savedActiveName;
  $('#playerNameInput').value = savedActiveName;
  joinRoom(savedRoomNo, {
    reconnect: true,
    name: savedActiveName
  });
}

roomPollTimer = setInterval(() => {
  if (selectedRoom === null) fetchRooms();
}, 3000);

document.addEventListener('visibilitychange', () => {
  if (
    document.visibilityState === 'visible'
    && selectedRoom !== null
    && (!socket || socket.readyState !== WebSocket.OPEN)
  ) {
    scheduleReconnect();
  }
});

window.addEventListener('online', () => {
  if (
    selectedRoom !== null
    && (!socket || socket.readyState !== WebSocket.OPEN)
  ) {
    scheduleReconnect();
  }
});

window.addEventListener('beforeunload', () => {
  clearTimeout(cpuTurnTimer);
  clearTimeout(reconnectTimer);
  try { socket?.close(); } catch {}
});
})();
