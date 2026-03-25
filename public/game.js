window._p5play_intro_image = '';

// =============================================================================
//  GAME.JS – Ulti-mates v2. CACA
// =============================================================================

// --- CONSTANTES --------------------------------------------------------------
const PLAYER_RADIUS = 20;
const PLAYER_SPEED = 6.0;
const STUN_DURATION = 3;
const GAME_DURATION = 140;
const FRISBEE_SPEED = 24;
const FRISBEE_RADIUS = 12;
const THROW_COOLDOWN = 0.6;
const FRISBEE_FRICTION = 0.98; // Frottement dans l'air pendant 4s
const GRAB_RADIUS = 55;
const GRAB_DURATION = 2;
const MIRE_SPEED = 4.5;
const KNOCKBACK_FORCE = 16; // Impulsion de recul quand on est attrapé

const COLOR_TEAM_A = [52, 152, 219];
const COLOR_TEAM_B = [231, 76, 60];

// --- ÉTAT -------------------------------------------------------------------
const players = {};
let frisbee = null;
let frisbeeOwner = null;
let frisbeeLastThrower = null;
let frisbeeTimer = 0;

let gamePhase = 'lobby'; // 'lobby' | 'playing' | 'ended'
let gameTimer = GAME_DURATION;
let scoreA = 0;
let scoreB = 0;
let ws;
let obstacles = [];

// =============================================================================
//  WEBSOCKET
// =============================================================================
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);
  ws.onopen = () => setConnectionStatus('Connecté ✔', true);
  ws.onclose = () => { setConnectionStatus('Déconnecté…', false); setTimeout(connectWebSocket, 2000); };
  ws.onmessage = (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg.type === 'spawn') handleSpawn(msg);
    else if (msg.type === 'move') handleMove(msg);
    else if (msg.type === 'throw') handleThrow(msg);
    else if (msg.type === 'grab') handleGrab(msg);
    else if (msg.type === 'startGame') startGame();
    else if (msg.type === 'getState') handleGetState();
  };
}

function broadcast(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setConnectionStatus(text, ok) {
  const el = document.getElementById('connection-status');
  el.textContent = text;
  el.className = ok ? 'connected' : 'disconnected';
}

// =============================================================================
//  HANDLERS
// =============================================================================
function handleSpawn(msg) {
  if (players[msg.pseudo]) return;
  spawnPlayer(msg.pseudo, msg.team, msg.isHost);
  if (gamePhase === 'playing') {
    // Late join: place the player on the map immediately and notify them
    placePlayerOnMap(players[msg.pseudo]);
    broadcast({ type: 'gameStarted' });
  } else {
    broadcastLobbyState();
  }
}

function handleMove(msg) {
  const p = players[msg.pseudo];
  if (!p || p.stunned || p.grabbed) return;
  p.inputDir = { x: msg.dir.x, y: msg.dir.y };
}

function handleThrow(msg) {
  const p = players[msg.pseudo];
  if (!p || p.stunned) return;
  if (frisbeeOwner !== msg.pseudo) return;
  if ((millis() / 1000) - p.lastThrowTime < THROW_COOLDOWN) return;

  frisbeeLastThrower = msg.pseudo;
  frisbeeOwner = null;
  frisbee.collider = 'dynamic';
  const throwRadius = PLAYER_RADIUS * 2;
  frisbee.x = p.sprite.x + cos(p.mireAngle) * (throwRadius + FRISBEE_RADIUS + 2);
  frisbee.y = p.sprite.y + sin(p.mireAngle) * (throwRadius + FRISBEE_RADIUS + 2);
  frisbee.vel.x = cos(p.mireAngle) * FRISBEE_SPEED;
  frisbee.vel.y = sin(p.mireAngle) * FRISBEE_SPEED;
  p.lastThrowTime = millis() / 1000;
  frisbeeTimer = 2.0; // Vole exactement pendant 2 secondes maximum
  broadcast({ type: 'frisbeeDropped' });
}


function handleGrab(msg) {
  const grabber = players[msg.pseudo];
  if (!grabber || grabber.stunned || grabber.grabbed) return;
  if (frisbeeOwner === msg.pseudo) return;

  let closest = null;
  let closestDist = GRAB_RADIUS;

  for (const id in players) {
    const target = players[id];
    if (id === msg.pseudo) continue;
    if (target.team === grabber.team) continue;
    if (target.stunned || target.grabbed) continue;
    const dist = Math.hypot(grabber.sprite.x - target.sprite.x, grabber.sprite.y - target.sprite.y);
    if (dist < closestDist) { closestDist = dist; closest = id; }
  }

  if (closest) {
    const target = players[closest];
    target.grabbed = true;
    target.grabTimer = GRAB_DURATION;
    target.grabbedBy = msg.pseudo;
    target.inputDir = { x: 0, y: 0 };

    // Calcul du vecteur de recul (direction opposée au grabber)
    const dx = target.sprite.x - grabber.sprite.x;
    const dy = target.sprite.y - grabber.sprite.y;
    const dist = Math.hypot(dx, dy) || 1;
    target.sprite.vel.x = (dx / dist) * KNOCKBACK_FORCE;
    target.sprite.vel.y = (dy / dist) * KNOCKBACK_FORCE;

    if (frisbeeOwner === closest) { frisbeeOwner = null; frisbee.collider = 'dynamic'; broadcast({ type: 'frisbeeDropped' }); }
    broadcast({ type: 'grabbed', pseudo: closest, by: msg.pseudo });
  }
}

// =============================================================================
//  LOBBY
// =============================================================================
function broadcastLobbyState() {
  const lobbyData = Object.values(players).map(p => ({ pseudo: p.pseudo, team: p.team, isHost: p.isHost || false }));
  broadcast({ type: 'lobbyState', players: lobbyData });
  updateLobbyUI();
}

function updateLobbyUI() {
  const listA = Object.values(players).filter(p => p.team === 'A').map(p => p.pseudo);
  const listB = Object.values(players).filter(p => p.team === 'B').map(p => p.pseudo);
  const lobbyA = document.getElementById('lobby-team-a');
  const lobbyB = document.getElementById('lobby-team-b');
  if (lobbyA) lobbyA.innerHTML = listA.map(n => `<div class="lobby-player">🔵 ${escapeHtml(n)}</div>`).join('') || '<div class="lobby-empty">—</div>';
  if (lobbyB) lobbyB.innerHTML = listB.map(n => `<div class="lobby-player">🔴 ${escapeHtml(n)}</div>`).join('') || '<div class="lobby-empty">—</div>';
  const count = document.getElementById('lobby-count');
  if (count) count.textContent = `${Object.keys(players).length} joueur(s) connecté(s)`;
}

function handleGetState() {
  // Respond to a controller that just connected mid-game
  if (gamePhase === 'playing') {
    broadcast({ type: 'gameStarted' });
  }
}

function startGame() {
  if (gamePhase === 'playing') return;
  gamePhase = 'playing';
  gameTimer = GAME_DURATION;
  scoreA = scoreB = 0;

  document.getElementById('lobby-overlay').style.display = 'none';
  document.getElementById('hud').style.display = 'flex';
  showIngameQR();

  for (const pseudo in players) placePlayerOnMap(players[pseudo]);

  frisbee.x = width / 2; frisbee.y = height / 2;
  frisbee.vel.x = 0; frisbee.vel.y = 0;
  frisbeeOwner = null; frisbeeLastThrower = null;
  frisbeeTimer = 0;
  frisbee.collider = 'dynamic';

  broadcast({ type: 'gameStarted' });
  updateScoreboard();
}

function showIngameQR() {
  const el = document.getElementById('ingame-qr');
  const container = document.getElementById('ingame-qr-code');
  if (!el || !container) return;
  // Only generate once
  if (container.childElementCount > 0) { el.style.display = 'flex'; return; }
  fetch('/api/ip')
    .then(r => r.json())
    .then(data => {
      const url = `http://${data.ip}:${data.port}/controller`;
      new QRCode(container, {
        text: url,
        width: 80,
        height: 80,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.L
      });
      el.style.display = 'flex';
    })
    .catch(console.error);
}

function placePlayerOnMap(p) {
  const isA = p.team === 'A';
  p.sprite.x = isA ? random(80, width * 0.35) : random(width * 0.65, width - 80);
  p.sprite.y = random(100, height - 100);
  p.sprite.vel.x = 0; p.sprite.vel.y = 0;
}

// =============================================================================
//  JOUEURS
// =============================================================================
function spawnPlayer(pseudo, team, isHost) {
  if (players[pseudo]) return;
  const col = team === 'A' ? color(...COLOR_TEAM_A) : color(...COLOR_TEAM_B);
  const sx = team === 'A' ? random(80, width * 0.35) : random(width * 0.65, width - 80);
  const sy = random(100, height - 100);

  const ball = new Sprite(sx, sy, PLAYER_RADIUS * 2, 'dynamic');
  ball.color = col; ball.stroke = color(255, 255, 255, 160);
  ball.strokeWeight = 2; ball.bounciness = 0.3;
  ball.friction = 0.1; ball.mass = 1; ball.rotationLock = true;

  players[pseudo] = {
    pseudo, team, isHost: isHost || false, sprite: ball, color: col,
    stunned: false, stunTimer: 0,
    grabbed: false, grabTimer: 0, grabbedBy: null,
    inputDir: { x: 0, y: 0 }, lastThrowTime: 0,
    mireAngle: 0
  };
}

function removePlayer(pseudo) {
  const p = players[pseudo];
  if (!p) return;
  if (frisbeeOwner === pseudo) frisbeeOwner = null;
  p.sprite.remove();
  delete players[pseudo];
}

function stunPlayer(pseudo) {
  const p = players[pseudo];
  if (!p || p.stunned) return;
  p.stunned = true; p.stunTimer = STUN_DURATION;
  p.inputDir = { x: 0, y: 0 }; p.grabbed = false;
  if (p.team === 'A') scoreB++; else scoreA++;
  if (frisbeeOwner === pseudo) { frisbeeOwner = null; frisbee.collider = 'dynamic'; broadcast({ type: 'frisbeeDropped' }); }
  broadcast({ type: 'stunned', pseudo });
  updateScoreboard();
}

// =============================================================================
//  FRISBEE
// =============================================================================
function createFrisbee() {
  frisbee = new Sprite(width / 2, height / 2, FRISBEE_RADIUS * 2, 'dynamic');
  frisbee.color = color(255, 220, 50); frisbee.stroke = color(200, 160, 0);
  frisbee.strokeWeight = 2; frisbee.bounciness = 0.55;
  frisbee.friction = 0.04; frisbee.mass = 0.3; frisbee.rotationLock = false;

  frisbee.draw = function () {
    push();
    fill(255, 220, 50); stroke(200, 160, 0); strokeWeight(2);
    circle(0, 0, FRISBEE_RADIUS * 2);
    rotate(frameCount * 0.06);
    noFill(); stroke(200, 160, 0, 160); strokeWeight(1.5);
    arc(0, 0, FRISBEE_RADIUS * 1.3, FRISBEE_RADIUS * 1.3, 0, PI * 1.3);
    pop();
  };
}

function updateFrisbee(dt) {
  if (!frisbee) return;
  if (frisbeeOwner) {
    const p = players[frisbeeOwner];
    if (p) { frisbee.x = p.sprite.x; frisbee.y = p.sprite.y; frisbee.vel.x = 0; frisbee.vel.y = 0; }
    else frisbeeOwner = null;
    return;
  }

  if (frisbeeTimer > 0) {
    frisbeeTimer -= dt;
    frisbee.vel.x *= FRISBEE_FRICTION;
    frisbee.vel.y *= FRISBEE_FRICTION;

    if (frisbeeTimer <= 0) {
      frisbeeTimer = 0;
      frisbee.vel.x = 0;
      frisbee.vel.y = 0;
    }
  } else {
    frisbee.vel.x = 0;
    frisbee.vel.y = 0;
  }

  // Collision with boundaries -> STOP dead
  if (frisbee.x < FRISBEE_RADIUS) { frisbee.x = FRISBEE_RADIUS; frisbee.vel.x = 0; frisbee.vel.y = 0; frisbeeTimer = 0; }
  if (frisbee.x > width - FRISBEE_RADIUS) { frisbee.x = width - FRISBEE_RADIUS; frisbee.vel.x = 0; frisbee.vel.y = 0; frisbeeTimer = 0; }
  if (frisbee.y < FRISBEE_RADIUS) { frisbee.y = FRISBEE_RADIUS; frisbee.vel.y = 0; frisbee.vel.y = 0; frisbeeTimer = 0; }
  if (frisbee.y > height - FRISBEE_RADIUS) { frisbee.y = height - FRISBEE_RADIUS; frisbee.vel.y = 0; frisbee.vel.y = 0; frisbeeTimer = 0; }

  // Collision with static obstacles -> STOP dead
  for (let obs of obstacles) {
    if (frisbee.colliding(obs)) {
      frisbee.vel.x = 0; frisbee.vel.y = 0;
      frisbeeTimer = 0;
    }
  }

  const spd = Math.hypot(frisbee.vel.x, frisbee.vel.y);

  for (const pseudo in players) {
    const p = players[pseudo];
    if (p.stunned || p.grabbed) continue;
    const dx = p.sprite.x - frisbee.x;
    const dy = p.sprite.y - frisbee.y;
    const dist = Math.hypot(dx, dy);
    const currentRadius = p.sprite.d / 2;
    if (dist < currentRadius + FRISBEE_RADIUS + 4) {
      // 1. Check if hit by a fast-moving enemy throw
      if (spd > 3 && frisbeeLastThrower && frisbeeLastThrower !== pseudo) {
        const thrower = players[frisbeeLastThrower];
        if (thrower && thrower.team !== p.team) {
          stunPlayer(pseudo);
          frisbee.collider = 'dynamic';
          frisbee.vel.x = 0;
          frisbee.vel.y = 0;
          frisbeeTimer = 0;
          continue; // Successfully stunned, move to next player
        }
      }

      // 2. Otherwise auto-pickup if not currently owned // Add a 0.5s cooldown so the thrower doesn't instantly pick it up again
      if (!frisbeeOwner && (frisbeeLastThrower !== pseudo || (millis() / 1000) - p.lastThrowTime > 0.5)) {
        frisbeeOwner = pseudo;
        frisbee.collider = 'none';
        frisbee.vel.x = 0;
        frisbee.vel.y = 0;
        frisbeeTimer = 0;
        broadcast({ type: 'hasFrisbee', pseudo: pseudo });
      }
    }
  }
}

// =============================================================================
//  MAP
// =============================================================================
function createMap() {
  world.gravity.y = 0; world.gravity.x = 0;
  const walls = [
    new Sprite(width / 2, -10, width + 40, 20, 'static'),
    new Sprite(width / 2, height + 10, width + 40, 20, 'static'),
    new Sprite(-10, height / 2, 20, height + 40, 'static'),
    new Sprite(width + 10, height / 2, 20, height + 40, 'static'),
  ];
  walls.forEach(w => { w.visible = false; w.bounciness = 0.6; });
  const obsDefs = [
    { x: width * 0.5, y: height * 0.22, w: 90, h: 90 },
    { x: width * 0.5, y: height * 0.78, w: 90, h: 90 },
    { x: width * 0.22, y: height * 0.5, w: 70, h: 130 },
    { x: width * 0.78, y: height * 0.5, w: 70, h: 130 },
  ];
  obsDefs.forEach(def => {
    const s = new Sprite(def.x, def.y, def.w, def.h, 'static');
    s.color = color(50, 55, 75, 40); s.stroke = color(90, 100, 130, 0); s.strokeWeight = 0; s.bounciness = 0.4;
    s.visible = false; // Hide the 2D rectangle so the 3D model is seen instead
    obstacles.push(s);
  });
}

// =============================================================================
//  SCOREBOARD
// =============================================================================
function updateScoreboard() {
  const mins = Math.floor(gameTimer / 60);
  const secs = Math.floor(gameTimer % 60);
  const timerEl = document.getElementById('timer');
  timerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  timerEl.className = gameTimer <= 10 ? 'danger' : '';
  document.getElementById('score-a').textContent = scoreA;
  document.getElementById('score-b').textContent = scoreB;
  const listA = Object.values(players).filter(p => p.team === 'A').map(p => p.pseudo);
  const listB = Object.values(players).filter(p => p.team === 'B').map(p => p.pseudo);
  document.getElementById('players-a').textContent = listA.join(', ') || '—';
  document.getElementById('players-b').textContent = listB.join(', ') || '—';
}

function escapeHtml(t) {
  const d = document.createElement('div'); d.appendChild(document.createTextNode(t)); return d.innerHTML;
}

// =============================================================================
//  SETUP
// =============================================================================
function setup() {
  new Canvas(windowWidth, windowHeight);
  angleMode(RADIANS);
  world.gravity.y = 0;
  createMap();
  createFrisbee();
  document.getElementById('lobby-overlay').style.display = 'flex';
  document.getElementById('hud').style.display = 'none';
  connectWebSocket();

  fetch('/api/ip')
    .then(r => r.json())
    .then(data => {
      // On utilise l'IP locale (data.ip) pour que les potes puissent se connecter
      const controllerUrl = `http://${data.ip}:${data.port}/controller`;
      document.getElementById('lobby-url-text').textContent = controllerUrl;

      const qrContainer = document.getElementById('lobby-qr-container');
      const oldImg = document.getElementById('lobby-qr-code');
      if (oldImg) oldImg.remove();

      const qrDiv = document.createElement('div');
      qrDiv.id = 'lobby-qr-code';
      qrDiv.style.background = 'white';
      qrDiv.style.padding = '8px';
      qrDiv.style.borderRadius = '8px';
      qrDiv.style.display = 'inline-block';
      qrContainer.insertBefore(qrDiv, document.getElementById('lobby-url-text'));

      // Génération locale garantie 100% sans bug d'API
      new QRCode(qrDiv, {
        text: controllerUrl,
        width: 140,
        height: 140,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.L
      });
    })
    .catch(console.error);
}

// =============================================================================
//  DRAW
// =============================================================================
function draw() {
  clear(); // make the canvas transparent
  const dt = deltaTime / 1000;
  drawArena();

  if (gamePhase === 'playing') {
    gameTimer -= dt;
    if (gameTimer <= 0) { gameTimer = 0; gamePhase = 'ended'; showEndScreen(); }
    if (frameCount % 30 === 0) updateScoreboard();
  }

  for (const pseudo in players) {
    const p = players[pseudo];

    // Dynamic scale (200% when holding boomerang)
    const targetRadius = (frisbeeOwner === pseudo) ? PLAYER_RADIUS * 2 : PLAYER_RADIUS;
    if (p.sprite.d !== targetRadius * 2) {
      p.sprite.d += (targetRadius * 2 - p.sprite.d) * 0.15; // Smooth scaling
    }

    if (p.stunned) {
      p.stunTimer -= dt;
      if (p.stunTimer <= 0) { p.stunned = false; broadcast({ type: 'recovered', pseudo }); }
      p.sprite.vel.x *= 0.75; p.sprite.vel.y *= 0.75;
    } else if (p.grabbed) {
      p.grabTimer -= dt;
      if (p.grabTimer <= 0) { p.grabbed = false; p.grabbedBy = null; broadcast({ type: 'released', pseudo }); }
      // Amortissement doux : laisse le knockback se dissiper naturellement
      p.sprite.vel.x *= 0.88;
      p.sprite.vel.y *= 0.88;
    } else {
      // Simulate aiming angle
      p.mireAngle += MIRE_SPEED * dt;

      const dx = p.inputDir.x; const dy = p.inputDir.y;
      const currentMaxSpeed = PLAYER_SPEED * (frisbeeOwner === pseudo ? 0.70 : 1.0);

      const targetVelX = dx * currentMaxSpeed;
      const targetVelY = dy * currentMaxSpeed;

      // Interpolate for extremely fluid movement
      p.sprite.vel.x += (targetVelX - p.sprite.vel.x) * 0.25;
      p.sprite.vel.y += (targetVelY - p.sprite.vel.y) * 0.25;
    }

    push();
    const r = p.sprite.d / 2;
    if (p.stunned) {
      noFill(); stroke(255, 200, 0, 180); strokeWeight(3);
      arc(p.sprite.x, p.sprite.y, r * 2 + 14, r * 2 + 14, 0, TWO_PI * (p.stunTimer / STUN_DURATION));
      fill(255, 220, 0); noStroke();
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TWO_PI + (millis() / 300);
        circle(p.sprite.x + cos(a) * (r + 12), p.sprite.y + sin(a) * (r + 12), 6);
      }
    }
    if (p.grabbed) {
      noFill(); stroke(255, 80, 80, 200); strokeWeight(3);
      arc(p.sprite.x, p.sprite.y, r * 2 + 14, r * 2 + 14, 0, TWO_PI * (p.grabTimer / GRAB_DURATION));
    }
    if (frisbeeOwner === pseudo) {
      noFill(); stroke(255, 220, 50, 220); strokeWeight(3);
      circle(p.sprite.x, p.sprite.y, r * 2 + 14);
    }

    // Draw aim arrow dynamically ONLY if they own the frisbee
    if (p.mireAngle !== undefined && !p.stunned && !p.grabbed && frisbeeOwner === pseudo) {
      push();
      translate(p.sprite.x, p.sprite.y);
      rotate(p.mireAngle);
      stroke(255, 220, 50, 220);
      fill(255, 220, 50, 220);
      strokeWeight(4);
      const arrowBase = r + 5;
      const arrowTip = r + 40;
      line(arrowBase, 0, arrowTip, 0);
      noStroke();
      triangle(arrowTip + 4, 0, arrowTip - 8, -7, arrowTip - 8, 7);
      pop();
    }

    fill(255); noStroke(); textAlign(CENTER, BOTTOM); textSize(13);
    text(pseudo + (p.isHost ? ' 👑' : ''), p.sprite.x, p.sprite.y - r - 10);
    pop();
  }

  updateFrisbee(dt);

  push();
  fill(70); noStroke(); textAlign(LEFT, BOTTOM); textSize(12);
  text('Manette : ' + location.origin + '/controller', 10, height - 8);
  pop();
}

function drawArena() {
  // Empty: Map is entirely handled by the background 3D model
}

// =============================================================================
//  FIN DE PARTIE
// =============================================================================
function showEndScreen() {
  document.getElementById('final-a').textContent = scoreA;
  document.getElementById('final-b').textContent = scoreB;
  document.getElementById('end-winner').textContent =
    scoreA > scoreB ? '🏆 Équipe A gagne !' : scoreB > scoreA ? '🏆 Équipe B gagne !' : '🤝 Égalité !';
  document.getElementById('end-overlay').style.display = 'flex';
  document.getElementById('restart-btn').onclick = () => {
    document.getElementById('end-overlay').style.display = 'none';
    document.getElementById('lobby-overlay').style.display = 'flex';
    document.getElementById('hud').style.display = 'none';
    document.getElementById('ingame-qr').style.display = 'none';
    gamePhase = 'lobby'; scoreA = scoreB = 0; gameTimer = GAME_DURATION;
    for (const p in players) removePlayer(p);
    frisbee.x = width / 2; frisbee.y = height / 2;
    frisbeeOwner = null; frisbeeLastThrower = null;
    updateLobbyUI();
    broadcast({ type: 'returnToLobby' });
  };
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }
