// =============================================================================
//  CONTROLLER.JS – Ulti-mates v2
// =============================================================================
//
//  Messages envoyés :
//    { type: 'spawn',     pseudo, team, isHost }
//    { type: 'move',      pseudo, dir: {x,y} }
//    { type: 'throw',     pseudo, angle }
//    { type: 'grab',      pseudo }           → attraper un joueur adverse
//    { type: 'startGame', pseudo }           → host seulement
//
//  Messages reçus :
//    { type: 'lobbyState', players }
//    { type: 'gameStarted' }
//    { type: 'hasFrisbee', pseudo }
//    { type: 'frisbeeDropped' }
//    { type: 'stunned',    pseudo }
//    { type: 'recovered',  pseudo }
//    { type: 'grabbed',    pseudo, by }
//    { type: 'released',   pseudo }
//    { type: 'returnToLobby' }
// =============================================================================

let ws;
let pseudo    = '';
let team      = '';
let isHost    = false;
let hasFrisbee  = false;
let isStunned   = false;
let isGrabbed   = false;
let gameStarted = false;
let grabCooldown = false;
let grabCooldownInterval = null;

// Joystick
let joystickActive = false;
let joystickOrigin = { x: 0, y: 0 };
let joystickDelta  = { x: 0, y: 0 };
const JOYSTICK_MAX      = 50;
const JOYSTICK_DEADZONE = 5;

// Éléments DOM
const screenLogin   = document.getElementById('login-screen');
const screenTeam    = document.getElementById('team-screen');
const screenLobby   = document.getElementById('lobby-screen');
const screenControl = document.getElementById('control-screen');
const statusEl      = document.getElementById('status');

// =============================================================================
//  WEBSOCKET
// =============================================================================
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);
  ws.onopen  = () => setStatus('Connecté ✔', true);
  ws.onclose = () => { setStatus('Déconnecté…', false); setTimeout(connectWebSocket, 2000); };
  ws.onmessage = (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch (e) { return; }

    if (msg.type === 'lobbyState')   updateLobbyDisplay(msg.players);
    if (msg.type === 'gameStarted' && !gameStarted && pseudo && team) enterGame();
    if (msg.type === 'returnToLobby') returnToLobby();

    if (msg.type === 'hasFrisbee' && msg.pseudo === pseudo) {
      hasFrisbee = true; updateActionButtons();
    }
    if (msg.type === 'frisbeeDropped' && hasFrisbee) {
      hasFrisbee = false; updateActionButtons();
    }
    if (msg.type === 'stunned' && msg.pseudo === pseudo) {
      isStunned = true; hasFrisbee = false; updateActionButtons(); showStunFeedback();
    }
    if (msg.type === 'recovered' && msg.pseudo === pseudo) {
      isStunned = false; updateActionButtons();
    }
    if (msg.type === 'grabbed' && msg.pseudo === pseudo) {
      isGrabbed = true; updateActionButtons();
      document.getElementById('grab-feedback').style.display = 'block';
    }
    if (msg.type === 'released' && msg.pseudo === pseudo) {
      isGrabbed = false; updateActionButtons();
      document.getElementById('grab-feedback').style.display = 'none';
    }
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className   = ok ? 'status connected' : 'status disconnected';
}

// =============================================================================
//  ÉCRANS
// =============================================================================

// Étape 1 : pseudo
document.getElementById('pseudo-btn').addEventListener('click', () => {
  const val = document.getElementById('pseudo-input').value.trim();
  if (!val) return;
  pseudo = val;
  const hp = document.getElementById('hello-pseudo');
  if (hp) hp.innerHTML = `Hello <span style="color: var(--shadows);">${pseudo}</span>`;
  screenLogin.style.display = 'none';
  screenTeam.style.display  = 'flex';
});
document.getElementById('pseudo-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('pseudo-btn').click();
});

// Étape 2 : choix équipe + option host
document.getElementById('btn-team-a').addEventListener('click', () => joinTeam('A'));
document.getElementById('btn-team-b').addEventListener('click', () => joinTeam('B'));

function joinTeam(t) {
  team   = t;
  isHost = false;
  send({ type: 'spawn', pseudo, team, isHost });
  screenTeam.style.display  = 'none';
  screenLobby.style.display = 'flex';
  document.getElementById('lobby-pseudo').textContent = pseudo + ' — Équipe ' + team;
  document.getElementById('start-btn-wrapper').style.display = 'block';
  const waitingText = document.querySelector('.lobby-waiting');
  if (waitingText) waitingText.style.display = 'none';
}

// Lobby → lancer la partie (tout le monde)
document.getElementById('start-game-btn').addEventListener('click', () => {
  send({ type: 'startGame', pseudo });
});

function updateLobbyDisplay(playersList) {
  const listA = playersList.filter(p => p.team === 'A').map(p => p.pseudo);
  const listB = playersList.filter(p => p.team === 'B').map(p => p.pseudo);
  const elA = document.getElementById('lobby-list-a');
  const elB = document.getElementById('lobby-list-b');
  if (elA) elA.innerHTML = listA.map(n => `<div class="lobby-entry">🔵 ${n}</div>`).join('') || '<div class="lobby-empty">—</div>';
  if (elB) elB.innerHTML = listB.map(n => `<div class="lobby-entry">🔴 ${n}</div>`).join('') || '<div class="lobby-empty">—</div>';
  const cnt = document.getElementById('lobby-player-count');
  if (cnt) cnt.textContent = `${playersList.length} joueur(s)`;
}

function enterGame() {
  gameStarted = true;
  screenLobby.style.display   = 'none';
  screenControl.style.display = 'flex';
  document.body.classList.add('in-game');
  document.getElementById('player-name').textContent = pseudo + ' — Équipe ' + team;
  setupJoystick();
  startMoveLoop();
  updateActionButtons();
}

function returnToLobby() {
  gameStarted = false; hasFrisbee = false; isStunned = false; isGrabbed = false;
  screenControl.style.display = 'none';
  screenLobby.style.display   = 'flex';
  document.body.classList.remove('in-game');
  send({ type: 'spawn', pseudo, team, isHost });
}

// =============================================================================
//  JOYSTICK
// =============================================================================
function setupJoystick() {
  const zone = document.getElementById('joystick-zone');
  if (!zone) return;

  zone.addEventListener('touchstart', e => {
    e.preventDefault();
    if (e.targetTouches.length === 0) return;
    const t = e.targetTouches[0];
    const r = zone.getBoundingClientRect();
    joystickOrigin = { x: t.clientX - r.left, y: t.clientY - r.top };
    joystickActive = true; updateKnob(0, 0);
  }, { passive: false });

  zone.addEventListener('touchmove', e => {
    e.preventDefault();
    if (!joystickActive || e.targetTouches.length === 0) return;
    const t = e.targetTouches[0];
    const r = zone.getBoundingClientRect();
    let dx = (t.clientX - r.left) - joystickOrigin.x;
    let dy = (t.clientY - r.top)  - joystickOrigin.y;
    const dist = Math.hypot(dx, dy);
    if (dist > JOYSTICK_MAX) { dx = dx/dist*JOYSTICK_MAX; dy = dy/dist*JOYSTICK_MAX; }
    joystickDelta = { x: dx, y: dy };
    updateKnob(dx, dy);
  }, { passive: false });

  zone.addEventListener('touchend', () => {
    joystickActive = false; joystickDelta = { x: 0, y: 0 }; updateKnob(0, 0);
  });
}

function updateKnob(dx, dy) {
  const knob = document.getElementById('joystick-knob');
  if (knob) knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
}

let isMoving = false;
function startMoveLoop() {
  setInterval(() => {
    if (!pseudo || isStunned || isGrabbed || !gameStarted) return;
    const dist = Math.hypot(joystickDelta.x, joystickDelta.y);
    if (dist < JOYSTICK_DEADZONE) {
      if (isMoving) {
        send({ type: 'move', pseudo, dir: { x: 0, y: 0 } });
        isMoving = false;
      }
      return;
    }
    isMoving = true;
    send({ type: 'move', pseudo, dir: { x: joystickDelta.x/JOYSTICK_MAX, y: joystickDelta.y/JOYSTICK_MAX } });
  }, 33);
}

// =============================================================================
//  BOUTONS ACTION
// =============================================================================

// Force Landscape / Ignore Portrait
document.getElementById('force-landscape-btn')?.addEventListener('click', () => {
  document.body.classList.add('ignore-portrait');
  try {
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(()=>{});
    }
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(()=>{});
    }
  } catch(e) {}
});

// LANCER / POUSSER (bouton unique contextuel)
document.getElementById('action-btn').addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (isStunned || isGrabbed) return;
  if (hasFrisbee) {
    // État LANCER
    send({ type: 'throw', pseudo });
  } else {
    // État POUSSER
    if (grabCooldown) return;
    send({ type: 'grab', pseudo });
    startGrabCooldown();
  }
});

// Fallback click pour tests desktop
document.getElementById('action-btn').addEventListener('click', (e) => {
  if (isStunned || isGrabbed) return;
  if (hasFrisbee) {
    send({ type: 'throw', pseudo });
  } else {
    if (grabCooldown) return;
    send({ type: 'grab', pseudo });
    startGrabCooldown();
  }
});

function startGrabCooldown() {
  const COOLDOWN = 5;
  grabCooldown = true;
  let remaining = COOLDOWN;
  updateActionButtons();
  grabCooldownInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(grabCooldownInterval);
      grabCooldownInterval = null;
      grabCooldown = false;
      updateActionButtons();
    } else {
      updateActionButtons(remaining);
    }
  }, 1000);
  updateActionButtons(remaining);
}

function updateActionButtons(cooldownRemaining) {
  const btn       = document.getElementById('action-btn');
  const label     = btn ? btn.querySelector('.btn-label') : null;
  const statusDiv = document.getElementById('action-status');

  const blocked = isStunned || isGrabbed;

  if (btn) {
    btn.classList.remove('mode-push', 'mode-throw', 'mode-stunned', 'mode-cooldown');

    if (blocked) {
      btn.classList.add('mode-stunned');
      if (label) label.textContent = isStunned ? '😵 Étourdi' : '🤝 Attrapé';
    } else if (hasFrisbee) {
      btn.classList.add('mode-throw');
      if (label) label.textContent = 'Lancer';
    } else if (grabCooldown) {
      btn.classList.add('mode-cooldown');
      if (label) label.textContent = `⏳ ${cooldownRemaining ?? ''}s`;
    } else {
      btn.classList.add('mode-push');
      if (label) label.textContent = 'Pousser';
    }
  }

  if (statusDiv) {
    if (isStunned)          statusDiv.textContent = '😵 ÉTOURDI…';
    else if (isGrabbed)     statusDiv.textContent = '🤝 ATTRAPÉ !';
    else if (grabCooldown)  statusDiv.textContent = `⏳ Cooldown… (${cooldownRemaining ?? ''}s)`;
    else if (hasFrisbee)    statusDiv.textContent = '🥏 Tu as le frisbee !';
    else                    statusDiv.textContent = '';
  }
}

function showStunFeedback() {
  const el = document.getElementById('stun-overlay');
  if (!el) return;
  el.style.display = 'flex';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// =============================================================================
//  INIT
// =============================================================================
connectWebSocket();
