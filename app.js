(() => {
'use strict';

const $ = s => document.querySelector(s);
const screens = [...document.querySelectorAll('.screen')];
const VERSION = '0.6';
const ROOM_COUNT = 4;
const SERVER_URL = String(window.AIUE_SERVER_URL || '').replace(/\/$/, '');
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
let selectedKana = '';
let attackPending = false;
let intentionalClose = false;
let lastAttackEvent = '';
let toastTimer = null;
let roomPollTimer = null;

const clientId = getClientId();

function getClientId() {
  try {
    if (window.name && window.name.startsWith('aiue-client:')) return window.name.slice(12);
    const id = crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.name = `aiue-client:${id}`;
    return id;
  } catch {
    return `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function normalizeWord(raw) {
  let s = String(raw || '').trim().replace(/\s+/g, '').normalize('NFKC');
  s = s.replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  s = [...s].map(ch => voicedMap[ch] || ch).filter(ch => allowed.has(ch)).join('');
  return s.slice(0, 10);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function show(id) {
  screens.forEach(x => x.classList.toggle('active', x.id === id));
  const inRoom = selectedRoom !== null && id !== 'lobbyScreen';
  $('#roomChip').textContent = inRoom ? `ROOM ${selectedRoom}` : 'ロビー';
  $('#roomResetBtn').classList.toggle('hidden', !inRoom);
  $('#leaveRoomBtn').classList.toggle('hidden', !inRoom);
}

function toast(message, ms = 2600) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function phaseLabel(phase, players) {
  if (!players) return ['空き', 'empty'];
  if (phase === 'lobby') return ['待機中', 'playing'];
  if (phase === 'word') return ['ワード入力', 'playing'];
  if (phase === 'playing') return ['対戦中', 'playing'];
  if (phase === 'result') return ['結果', 'playing'];
  return ['使用中', 'playing'];
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
    const meta = byNo.get(room) || { roomNo: room, phase: 'lobby', players: 0, targetCount: 2, theme: '' };
    const [label, cls] = phaseLabel(meta.phase, meta.players);
    const card = document.createElement('article');
    card.className = 'room-card' + (meta.players ? ' occupied' : '');
    card.innerHTML = `
      <div class="room-card-top"><span class="room-no">ROOM ${room}</span><span class="room-status ${cls}">${label}</span></div>
      <div class="room-people"><b>${meta.players || 0}</b><span>/ 10人</span></div>
      <div class="room-theme">${meta.players ? `お題：${escapeHtml(meta.theme || '未設定')}` : '参加者を待っています'}</div>
      <div class="room-actions">
        <button class="primary enter-room" data-room="${room}">${meta.players ? 'この部屋を開く' : '入室'}</button>
        <button class="room-init" data-init="${room}" ${meta.players ? '' : 'disabled'}>初期化</button>
      </div>`;
    root.append(card);
  }
  root.querySelectorAll('.enter-room').forEach(btn => btn.addEventListener('click', () => joinRoom(Number(btn.dataset.room))));
  root.querySelectorAll('.room-init').forEach(btn => btn.addEventListener('click', () => resetRoomFromLobby(Number(btn.dataset.init))));
}

async function resetRoomFromLobby(room) {
  if (!confirm(`ROOM ${room} を初期化しますか？`)) return;
  try {
    const res = await fetch(`${SERVER_URL}/room/${room}/reset?room=${room}`, { method: 'POST' });
    if (!res.ok) throw new Error();
    toast(`ROOM ${room} を初期化しました`);
    await fetchRooms();
  } catch {
    toast('部屋の初期化に失敗しました');
  }
}

function makeTargetOptions() {
  const select = $('#targetCount');
  select.innerHTML = '';
  for (let n = 2; n <= 10; n++) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = `${n}人`;
    select.append(opt);
  }
}

function getPlayerName() {
  const input = $('#playerNameInput');
  const name = input.value.trim().slice(0, 12);
  if (name) localStorage.setItem('aiue-player-name', name);
  return name;
}

function joinRoom(room) {
  const name = getPlayerName();
  if (!name) {
    toast('プレイヤー名を入力してください');
    $('#playerNameInput').focus();
    return;
  }
  closeSocket(false);
  selectedRoom = room;
  roomState = null;
  selectedKana = '';
  attackPending = false;
  intentionalClose = false;
  $('#roomLabel').textContent = `ROOM ${room}`;
  show('roomScreen');
  $('#roomGuide').textContent = '接続中…';

  const wsBase = SERVER_URL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const url = `${wsBase}/room/${room}/ws?room=${room}&clientId=${encodeURIComponent(clientId)}&name=${encodeURIComponent(name)}`;
  socket = new WebSocket(url);

  socket.addEventListener('open', () => {
    $('#serverStatus').textContent = 'オンライン接続中';
  });
  socket.addEventListener('message', e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleServerMessage(msg);
  });
  socket.addEventListener('close', () => {
    socket = null;
    if (intentionalClose) return;
    if (selectedRoom !== null) {
      toast('接続が切れました。ロビーへ戻ります');
      selectedRoom = null;
      roomState = null;
      show('lobbyScreen');
      fetchRooms();
    }
  });
  socket.addEventListener('error', () => {
    toast('部屋へ接続できませんでした');
  });
}

function handleServerMessage(msg) {
  if (msg.type === 'state') {
    roomState = msg;
    attackPending = false;
    routeFromState();
    return;
  }
  if (msg.type === 'attackEvent') {
    if (msg.eventId && msg.eventId === lastAttackEvent) return;
    lastAttackEvent = msg.eventId || '';
    showAttack(msg.attackerName, msg.kana, msg.hit);
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
    show('lobbyScreen');
    fetchRooms();
  }
}

function routeFromState() {
  if (!roomState) return;
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
  $('#themeInput').disabled = !host;
  $('#targetCount').disabled = !host;
  $('#saveConfigBtn').classList.toggle('hidden', !host);
  $('#startWordsBtn').classList.toggle('hidden', !host);

  const full = roomState.players.length === roomState.targetCount;
  $('#startWordsBtn').disabled = !full || roomState.players.length < 2;
  $('#roomGuide').textContent = host
    ? (full ? '参加者が揃いました。ワード入力を開始できます。' : `参加者を待っています（${roomState.players.length}/${roomState.targetCount}人）`)
    : 'ホストが設定して開始するまでお待ちください。';

  $('#roomPlayers').innerHTML = roomState.players.map(p => `
    <div class="online-player-row ${p.id === roomState.meId ? 'me' : ''}">
      <div class="online-player-name">${escapeHtml(p.name)}</div>
      <div class="online-player-tags">
        ${p.id === roomState.hostId ? '<span class="mini-tag host">HOST</span>' : ''}
        ${p.id === roomState.meId ? '<span class="mini-tag me">自分</span>' : ''}
        <span class="connection-dot ${p.connected ? 'on' : ''}"></span>
      </div>
    </div>`).join('');
}

function renderWordScreen() {
  if (!roomState) return;
  const me = roomState.players.find(p => p.id === roomState.meId);
  if (!me) return;
  $('#wordPlayerName').textContent = me.name;
  $('#wordTheme').textContent = roomState.theme;
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
  renderPlayers();
  renderKana();
  renderStatus();
  renderLog();
}

function renderPlayers() {
  const root = $('#players');
  root.innerHTML = roomState.players.map(p => {
    const open = p.slots.filter(ch => ch !== null).length;
    const slots = [];
    for (let i = 0; i < 10; i++) {
      if (i >= p.wordLength) slots.push('<div class="slot empty">×</div>');
      else if (p.slots[i] !== null) slots.push(`<div class="slot revealed">${escapeHtml(p.slots[i])}</div>`);
      else slots.push('<div class="slot hidden">?</div>');
    }
    const classes = [
      'player-card',
      p.id === roomState.currentId && p.alive ? 'current' : '',
      !p.alive ? 'eliminated' : '',
      p.id === roomState.meId ? 'my-player' : ''
    ].filter(Boolean).join(' ');
    return `<div class="${classes}">
      ${!p.alive ? '<div class="eliminated-tag">脱落</div>' : ''}
      <div class="player-head">
        <div class="player-name">${escapeHtml(p.name)}${p.id === roomState.meId ? '<span class="you-mark">自分</span>' : ''}</div>
        <div class="life">公開 ${open}/${p.wordLength}</div>
      </div>
      <div class="word-slots">${slots.join('')}</div>
    </div>`;
  }).join('');
}

function renderKana() {
  if (!roomState) return;
  const me = roomState.players.find(p => p.id === roomState.meId);
  const myTurn = roomState.currentId === roomState.meId && me?.alive;
  [...$('#kanaBoard').children].forEach(btn => {
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
  $('#turnLine').textContent = current ? `${current.name} のターン` : '';
  $('#attackCounter').textContent = `攻撃 ${roomState.attackNo} / 2`;
  if (!me?.alive) {
    $('#messageStrip').textContent = 'あなたは脱落しました';
    $('#messageStrip').className = 'message-strip miss';
  } else if (myTurn) {
    $('#messageStrip').textContent = roomState.attackNo === 2 ? 'HIT！ もう1回攻撃できます' : '文字を選んで「アタック」';
    $('#messageStrip').className = roomState.attackNo === 2 ? 'message-strip hit' : 'message-strip';
  } else {
    $('#messageStrip').textContent = `${current?.name || '相手'} の操作を待っています`;
    $('#messageStrip').className = 'message-strip';
  }
}

function renderLog() {
  $('#log').innerHTML = (roomState.logs || []).map(x => `<div class="log-item ${escapeHtml(x.type || '')}">${escapeHtml(x.text)}</div>`).join('');
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
  $('#attackName').textContent = name;
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

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    toast('サーバーに接続されていません');
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

function saveConfig() {
  if (!isHost()) return;
  send({
    type: 'setConfig',
    theme: $('#themeInput').value.trim() || '自由',
    targetCount: Number($('#targetCount').value)
  });
}

function startWords() {
  if (!isHost()) return;
  send({
    type: 'setConfig',
    theme: $('#themeInput').value.trim() || '自由',
    targetCount: Number($('#targetCount').value)
  });
  send({ type: 'startWords' });
}

function submitWord() {
  const word = normalizeWord($('#wordInput').value);
  if (word.length < 2 || word.length > 10) {
    toast('2〜10文字で入力してください');
    return;
  }
  if (send({ type: 'submitWord', word })) {
    $('#wordInput').value = '';
    $('#normalizedPreview').textContent = '変換後：—';
  }
}

async function resetCurrentRoom() {
  if (selectedRoom === null) return;
  if (!confirm(`ROOM ${selectedRoom} を初期化しますか？`)) return;
  try {
    const res = await fetch(`${SERVER_URL}/room/${selectedRoom}/reset?room=${selectedRoom}`, { method: 'POST' });
    if (!res.ok) throw new Error();
  } catch {
    toast('部屋の初期化に失敗しました');
  }
}

function leaveRoom() {
  if (socket?.readyState === WebSocket.OPEN) send({ type: 'leave' });
  intentionalClose = true;
  try { socket?.close(1000, 'left'); } catch {}
  socket = null;
  selectedRoom = null;
  roomState = null;
  selectedKana = '';
  attackPending = false;
  show('lobbyScreen');
  fetchRooms();
}

function closeSocket(markIntentional = true) {
  if (!socket) return;
  if (markIntentional) intentionalClose = true;
  try { socket.close(); } catch {}
  socket = null;
}

$('#saveConfigBtn').addEventListener('click', saveConfig);
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
$('#roomResetBtn').addEventListener('click', resetCurrentRoom);
$('#leaveRoomBtn').addEventListener('click', leaveRoom);
$('#againBtn').addEventListener('click', () => send({ type: 'restart' }));
$('#backLobbyBtn').addEventListener('click', leaveRoom);
$('#ruleBtn').addEventListener('click', () => {
  const d = $('#ruleDialog');
  if (d.showModal) d.showModal(); else d.setAttribute('open', '');
});
$('#closeRuleBtn').addEventListener('click', () => {
  const d = $('#ruleDialog');
  if (d.close) d.close(); else d.removeAttribute('open');
});

makeTargetOptions();
$('#playerNameInput').value = localStorage.getItem('aiue-player-name') || '';
show('lobbyScreen');
fetchRooms();
roomPollTimer = setInterval(() => {
  if (selectedRoom === null) fetchRooms();
}, 3000);
window.addEventListener('beforeunload', () => {
  try { socket?.close(); } catch {}
});
})();
