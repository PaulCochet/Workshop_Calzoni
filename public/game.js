// =============================================================================
//  GAME.JS – Ulti-mates v3 — Three.js + Rapier (remplace p5play)
//
//  Architecture :
//    • Three.js  → rendu 3D (scène, caméra, lumières, meshes)
//    • Rapier    → physique et collisions (côté grand écran)
//    • Socket    → relay WebSocket inchangé (server.js intact)
//    • controller.js → intact, aucun changement
// =============================================================================

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.150.1/build/three.module.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.150.1/examples/jsm/loaders/GLTFLoader.js';
import { CSS2DRenderer, CSS2DObject }
  from 'https://cdn.jsdelivr.net/npm/three@0.150.1/examples/jsm/renderers/CSS2DRenderer.js';
import RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.11.2/rapier.es.js';

// =============================================================================
//  CONSTANTES
// =============================================================================
const PLAYER_SPEED = 8;
const STUN_DURATION = 3;       // secondes
const GAME_DURATION = 140;     // secondes
const FRISBEE_SPEED = 18;      // force d'impulsion au lancer
const FRISBEE_HEIGHT = 1;     // hauteur fixe du frisbee au-dessus du sol
const GRAB_RADIUS = 4.0;     // distance max pour attraper (augmentée)
const GRAB_DURATION = 2;       // secondes
const THROW_COOLDOWN = 0.6;
const KNOCKBACK_FORCE = 28;      // impulsion de recul (augmentée)
const FRISBEE_DAMPING = 1.8;     // résistance air du frisbee
const MAP_SCALE = 0.55;    // Échelle 

// =============================================================================
//  GROUPES DE COLLISION RAPIER
//  Encodage : (membership << 16) | filter
//
//  GROUP_COL     = 0b0001  (1)  → murs hauts, comptoirs, arbres…
//  GROUP_LOWCOL  = 0b0010  (2)  → objets bas (chaises, tables…)
//  GROUP_PLAYER  = 0b0100  (4)  → capsule joueur
//  GROUP_FRISBEE = 0b1000  (8)  → disque
//
//  Règles :
//    col     bloque joueurs ET frisbee
//    lowcol  bloque joueurs seulement
//    frisbee rebondit sur col seulement
// =============================================================================
const G_COL = 0b0001;
const G_LOWCOL = 0b0010;
const G_PLAYER = 0b0100;
const G_FRISBEE = 0b1000;

function cg(membership, filter) {
  // Rapier encode membership dans les 16 bits hauts, filter dans les 16 bas
  return (membership << 16) | filter;
}

const CG_COL = cg(G_COL, G_PLAYER | G_FRISBEE); // bloque joueurs + frisbee
const CG_LOWCOL = cg(G_LOWCOL, G_PLAYER);             // bloque joueurs seulement
const CG_PLAYER = cg(G_PLAYER, G_COL | G_LOWCOL);     // interagit avec col + lowcol
const CG_FRISBEE = cg(G_FRISBEE, G_COL);                 // interagit avec col seulement

const COLOR_A = 0x3498db;
const COLOR_B = 0xe74c3c;
const COLOR_FRISBEE = 0xFFD700;

// =============================================================================
//  ÉTAT DU JEU
// =============================================================================
const players = {};         // pseudo → { mesh, body, label, team, ... }
let frisbee = null;       // { mesh, body }
let frisbeeOwner = null;
let frisbeeLastThrower = null;
const spawnPoints = [];     // THREE.Vector3[] — rempli depuis la map GLB

let gamePhase = 'lobby';   // 'lobby' | 'playing' | 'ended'
let gameTimer = GAME_DURATION;
let scoreA = 0, scoreB = 0;
let lastTimestamp = 0;

let ws;

// =============================================================================
//  THREE.JS — SETUP
// =============================================================================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0x111111);
document.body.insertBefore(renderer.domElement, document.body.firstChild);

// CSS2D pour les labels joueurs (noms au-dessus des persos)
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
document.body.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);
scene.fog = new THREE.Fog(0x111111, 20, 60);

// Caméra — vue isométrique style Overcooked
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 14, 9);
camera.lookAt(0, 0, 0);

// Lumières
const ambient = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambient);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(8, 16, 8);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 80;
dirLight.shadow.camera.left = dirLight.shadow.camera.bottom = -20;
dirLight.shadow.camera.right = dirLight.shadow.camera.top = 20;
scene.add(dirLight);

// Lumière de remplissage douce
const fillLight = new THREE.DirectionalLight(0x8899ff, 0.3);
fillLight.position.set(-5, 5, -5);
scene.add(fillLight);

// Sol de secours (visible si la map ne charge pas)
const floorGeo = new THREE.PlaneGeometry(30, 20);
const floorMat = new THREE.MeshLambertMaterial({ color: 0x1a1a2e });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// =============================================================================
//  RAPIER — INIT (await top-level possible dans un ES module)
// =============================================================================
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -25, z: 0 });

// =============================================================================
//  CHARGEMENT DE LA MAP GLB
// =============================================================================
function loadMap() {
  const loader = new GLTFLoader();
  loader.load(
    'Img/Workshop_map_V2.glb',

    (gltf) => {
      // ── Appliquer l'échelle globale et rotation ────────────────
      gltf.scene.scale.setScalar(MAP_SCALE);
      gltf.scene.rotation.y = Math.PI / 2; // Rotation à 90 degrés

      // Forcer la mise à jour des matrices world AVANT de lire les positions
      gltf.scene.updateMatrixWorld(true);

      let colCount = 0;

      gltf.scene.traverse((child) => {

        // ── Points de spawn ─────────────────────────────────────
        // Objets nommés "Spawn 1", "Spawn 2", "Spawn 3", "Spawn 4"
        if (/^[Ss]pawn[\s_]?\d/.test(child.name)) {
          const wp = new THREE.Vector3();
          child.getWorldPosition(wp);
          spawnPoints.push(wp.clone());
          child.visible = false;
          console.log(`Spawn trouvé : ${child.name}`, wp);
          return;
        }

        if (!child.isMesh) return;

        const name = child.name.toLowerCase();
        const isCol = name.startsWith('col_');
        const isLowcol = name.startsWith('lowcol_');

        // ── Meshes visuels (ni col ni lowcol) ───────────────────
        if (!isCol && !isLowcol) {
          child.castShadow = true;
          child.receiveShadow = true;
          return;
        }

        // ── Colliders de physique → toujours invisibles ──────────
        child.visible = false;

        const geo = child.geometry;
        if (!geo.index) {
          console.warn(`${child.name} n'a pas d'index — ignoré`);
          return;
        }

        // Vertices en world space (scale MAP_SCALE déjà appliqué via updateMatrixWorld)
        const posAttr = geo.attributes.position;
        const verts = new Float32Array(posAttr.count * 3);
        const wv = new THREE.Vector3();
        for (let i = 0; i < posAttr.count; i++) {
          wv.fromBufferAttribute(posAttr, i);
          child.localToWorld(wv);
          verts[i * 3] = wv.x;
          verts[i * 3 + 1] = wv.y;
          verts[i * 3 + 2] = wv.z;
        }
        const indices = new Uint32Array(geo.index.array);

        // Trimesh Rapier avec le bon groupe de collision
        const collisionGroup = isCol ? CG_COL : CG_LOWCOL;
        const desc = RAPIER.ColliderDesc
          .trimesh(verts, indices)
          .setCollisionGroups(collisionGroup)
          .setRestitution(isCol ? 0.55 : 0.1)   // les col rebondissent, pas les lowcol
          .setFriction(0.3);

        world.createCollider(desc);
        colCount++;
        console.log(`Collider créé : ${child.name} (${isCol ? 'COL' : 'LOWCOL'})`);
      });

      scene.add(gltf.scene);

      // ── Fallbacks si rien trouvé ─────────────────────────────
      if (colCount === 0) {
        console.warn('Aucun collider trouvé — fallback activé');
        createFallbackColliders();
      }

      if (spawnPoints.length === 0) {
        console.warn('Aucun spawn trouvé — spawns par défaut');
        spawnPoints.push(
          new THREE.Vector3(-4, 1, 1.5),
          new THREE.Vector3(-4, 1, -1.5),
          new THREE.Vector3(4, 1, 1.5),
          new THREE.Vector3(4, 1, -1.5),
        );
      }

      console.log(`Map GLB chargée ✔  (${colCount} colliders, ${spawnPoints.length} spawns)`);
    },

    undefined,
    (err) => {
      console.error('Erreur chargement map :', err);
      createFallbackColliders();
    }
  );
}

function createFallbackColliders() {
  // Sol
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(15, 0.2, 10)
      .setTranslation(0, -0.2, 0)
      .setCollisionGroups(CG_COL)
  );
  // Murs périmètre
  [
    RAPIER.ColliderDesc.cuboid(0.3, 3, 10).setTranslation(-15, 1.5, 0),
    RAPIER.ColliderDesc.cuboid(0.3, 3, 10).setTranslation(15, 1.5, 0),
    RAPIER.ColliderDesc.cuboid(15, 3, 0.3).setTranslation(0, 1.5, -10),
    RAPIER.ColliderDesc.cuboid(15, 3, 0.3).setTranslation(0, 1.5, 10),
  ].forEach(d => world.createCollider(d.setCollisionGroups(CG_COL)));
}

// =============================================================================
//  FRISBEE
// =============================================================================
function createFrisbee() {
  // Mesh visuel — disque jaune
  const geo = new THREE.CylinderGeometry(0.28, 0.28, 0.07, 24);
  const mat = new THREE.MeshLambertMaterial({ color: COLOR_FRISBEE, emissive: 0x443300 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  scene.add(mesh);

  // Anneau décoratif
  const ringGeo = new THREE.TorusGeometry(0.22, 0.03, 8, 24);
  const ringMat = new THREE.MeshLambertMaterial({ color: 0xcc9900 });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  mesh.add(ring);

  // Physique Rapier — corps dynamique avec damping élevé
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, FRISBEE_HEIGHT, 0)
    .setLinearDamping(FRISBEE_DAMPING)
    .setAngularDamping(5.0);
  const body = world.createRigidBody(bodyDesc);
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(0.035, 0.28)
      .setRestitution(0.95)   // ↑ Augmenté de 0.6 à 0.95 pour un max de rebond
      .setFriction(0.1)       // ↓ Un peu moins de friction pour glisser sur les murs
      .setCollisionGroups(CG_FRISBEE),
    body
  );

  frisbee = { mesh, body };
  resetFrisbee();
}

function resetFrisbee() {
  frisbee.body.setTranslation({ x: 0, y: FRISBEE_HEIGHT, z: 0 }, true);
  frisbee.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  frisbee.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  frisbeeOwner = null;
  frisbeeLastThrower = null;
}

// =============================================================================
//  JOUEURS
// =============================================================================
function spawnPlayer(pseudo, team, isHost) {
  if (players[pseudo]) return;

  const color = team === 'A' ? COLOR_A : COLOR_B;
  const startX = team === 'A'
    ? -4 + Math.random() * 2
    : 4 - Math.random() * 2;
  const startZ = (Math.random() - 0.5) * 4;

  // ── Mesh joueur : capsule colorée ──
  const bodyGeo = new THREE.CapsuleGeometry(0.38, 0.7, 4, 12);
  const bodyMat = new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(bodyGeo, bodyMat);
  mesh.castShadow = true;

  // Yeux (petites sphères blanches pour l'expressivité)
  const eyeGeo = new THREE.SphereGeometry(0.07, 8, 8);
  const eyeMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.15, 0.25, 0.32);
  eyeR.position.set(0.15, 0.25, 0.32);
  mesh.add(eyeL, eyeR);

  scene.add(mesh);

  // ── Flèche de visée (visible uniquement quand le joueur tient la pizza) ──
  const arrowMat = new THREE.MeshLambertMaterial({
    color: 0xFFD700, emissive: 0x664400,
    transparent: true, opacity: 0.92
  });
  // Tige
  const shaftGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.1, 8);
  const shaft = new THREE.Mesh(shaftGeo, arrowMat);
  shaft.rotation.z = Math.PI / 2;
  shaft.position.x = 0.85;
  // Pointe
  const tipGeo = new THREE.ConeGeometry(0.14, 0.35, 8);
  const tip = new THREE.Mesh(tipGeo, arrowMat);
  tip.rotation.z = -Math.PI / 2;
  tip.position.x = 1.55;
  // Pivot : le groupe tourne autour du joueur sur l'axe Y
  const aimPivot = new THREE.Group();
  aimPivot.add(shaft, tip);
  aimPivot.visible = false; // masqué par défaut
  aimPivot.position.y = 0.2;
  mesh.add(aimPivot);

  // ── Label CSS2D (nom au-dessus) ──
  const div = document.createElement('div');
  div.className = 'player-label';
  div.textContent = pseudo + (isHost ? ' 👑' : '');
  div.style.cssText = `
    color: white;
    font-family: monospace;
    font-size: 13px;
    font-weight: bold;
    text-shadow: 0 1px 4px #000, 0 0 8px #000;
    pointer-events: none;
    white-space: nowrap;
  `;
  const label = new CSS2DObject(div);
  label.position.set(0, 1.2, 0);
  mesh.add(label);

  // ── Physique Rapier — capsule ──
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(startX, 1.2, startZ)
    .lockRotations();  // le perso ne tombe pas
  const rbody = world.createRigidBody(bodyDesc);
  world.createCollider(
    RAPIER.ColliderDesc.capsule(0.35, 0.38)
      .setFriction(0.5)
      .setRestitution(0.1)
      .setCollisionGroups(CG_PLAYER),  // bloqué par col + lowcol
    rbody
  );

  players[pseudo] = {
    pseudo, team, isHost: isHost || false,
    mesh, body: rbody, label: div, aimPivot,
    stunned: false, stunTimer: 0,
    grabbed: false, grabTimer: 0, grabbedBy: null,
    inputDir: { x: 0, z: 0 },
    lastThrowTime: 0,
    mireAngle: 0,
  };
}

function removePlayer(pseudo) {
  const p = players[pseudo];
  if (!p) return;
  scene.remove(p.mesh);
  world.removeRigidBody(p.body);
  if (frisbeeOwner === pseudo) frisbeeOwner = null;
  delete players[pseudo];
}

function placePlayerOnMap(p) {
  // Spawn points extraits de la map Blender :
  // Spawn 1 & 2 → Équipe A (gauche), Spawn 3 & 4 → Équipe B (droite)
  let candidates;
  if (spawnPoints.length >= 4) {
    // On suppose que les spawns sont dans l'ordre de la map :
    // index 0-1 = côté A, 2-3 = côté B
    candidates = p.team === 'A'
      ? [spawnPoints[0], spawnPoints[1]]
      : [spawnPoints[2], spawnPoints[3]];
  } else if (spawnPoints.length > 0) {
    // Moins de 4 spawns → on les répartit par équipe
    const half = Math.ceil(spawnPoints.length / 2);
    candidates = p.team === 'A'
      ? spawnPoints.slice(0, half)
      : spawnPoints.slice(half);
    if (candidates.length === 0) candidates = spawnPoints;
  } else {
    // Fallback total si la map n'a pas encore chargé
    const x = p.team === 'A' ? -4 + Math.random() * 2 : 4 - Math.random() * 2;
    p.body.setTranslation({ x, y: 1.5, z: (Math.random() - 0.5) * 4 }, true);
    p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    return;
  }

  const sp = candidates[Math.floor(Math.random() * candidates.length)];
  // +1.2 sur Y pour spawner légèrement au-dessus du point (évite d'être dans le sol)
  p.body.setTranslation({ x: sp.x, y: sp.y + 1.2, z: sp.z }, true);
  p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
}

// =============================================================================
//  WEBSOCKET — identique à l'original
// =============================================================================
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);
  ws.onopen = () => setConnectionStatus('Connecté ✔', true);
  ws.onclose = () => {
    setConnectionStatus('Déconnecté…', false);
    setTimeout(connectWebSocket, 2000);
  };
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
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
//  HANDLERS (logique inchangée, adaptée 3D)
// =============================================================================
function handleSpawn(msg) {
  if (players[msg.pseudo]) return;
  spawnPlayer(msg.pseudo, msg.team, msg.isHost);
  if (gamePhase === 'playing') {
    placePlayerOnMap(players[msg.pseudo]);
    broadcast({ type: 'gameStarted' });
  } else {
    broadcastLobbyState();
  }
}

function handleMove(msg) {
  const p = players[msg.pseudo];
  if (!p || p.stunned || p.grabbed) return;
  // dir.x → X monde, dir.y du joystick → Z monde (profondeur)
  p.inputDir.x = msg.dir.x;
  p.inputDir.z = msg.dir.y;
}

function handleThrow(msg) {
  const p = players[msg.pseudo];
  if (!p || p.stunned) return;
  if (frisbeeOwner !== msg.pseudo) return;

  const now = performance.now() / 1000;
  if (now - p.lastThrowTime < THROW_COOLDOWN) return;
  p.lastThrowTime = now;

  frisbeeLastThrower = msg.pseudo;
  frisbeeOwner = null;

  // Lancer dans la direction de la mire (XZ)
  const pos = p.body.translation();
  const vx = Math.cos(p.mireAngle) * FRISBEE_SPEED;
  const vz = Math.sin(p.mireAngle) * FRISBEE_SPEED;

  frisbee.body.setTranslation({ x: pos.x + Math.cos(p.mireAngle) * 0.8, y: FRISBEE_HEIGHT, z: pos.z + Math.sin(p.mireAngle) * 0.8 }, true);
  frisbee.body.setLinvel({ x: vx, y: 0, z: vz }, true);

  broadcast({ type: 'frisbeeDropped' });
}

function handleGrab(msg) {
  const grabber = players[msg.pseudo];
  if (!grabber || grabber.stunned || grabber.grabbed) return;
  if (frisbeeOwner === msg.pseudo) return;

  let closest = null;
  let closestDist = GRAB_RADIUS;
  const gPos = grabber.body.translation();

  for (const id in players) {
    if (id === msg.pseudo) continue;
    const target = players[id];
    if (target.team === grabber.team) continue;
    if (target.stunned || target.grabbed) continue;
    const tPos = target.body.translation();
    const dist = Math.hypot(gPos.x - tPos.x, gPos.z - tPos.z);
    if (dist < closestDist) { closestDist = dist; closest = id; }
  }

  if (closest) {
    const target = players[closest];
    target.grabbed = true;
    target.grabTimer = GRAB_DURATION;
    target.grabbedBy = msg.pseudo;
    target.inputDir = { x: 0, z: 0 };

    // Knockback (direction opposée au grabber)
    const tPos = target.body.translation();
    const dx = tPos.x - gPos.x;
    const dz = tPos.z - gPos.z;
    const d = Math.hypot(dx, dz) || 1;
    target.body.setLinvel({
      x: (dx / d) * KNOCKBACK_FORCE,
      y: 0,
      z: (dz / d) * KNOCKBACK_FORCE
    }, true);

    if (frisbeeOwner === closest) {
      frisbeeOwner = null;
      broadcast({ type: 'frisbeeDropped' });
    }
    broadcast({ type: 'grabbed', pseudo: closest, by: msg.pseudo });
  }
}

function handleGetState() {
  if (gamePhase === 'playing') broadcast({ type: 'gameStarted' });
}

// =============================================================================
//  LOBBY
// =============================================================================
function broadcastLobbyState() {
  const lobbyData = Object.values(players).map(p => ({
    pseudo: p.pseudo, team: p.team, isHost: p.isHost
  }));
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

// =============================================================================
//  DÉMARRER / FINIR LA PARTIE
// =============================================================================
function startGame() {
  if (gamePhase === 'playing') return;
  gamePhase = 'playing';
  gameTimer = GAME_DURATION;
  scoreA = scoreB = 0;

  document.getElementById('lobby-overlay').style.display = 'none';
  document.getElementById('hud').style.display = 'flex';
  showIngameQR();

  for (const pseudo in players) placePlayerOnMap(players[pseudo]);
  resetFrisbee();
  broadcast({ type: 'gameStarted' });
  updateScoreboard();
}

function stunPlayer(pseudo) {
  const p = players[pseudo];
  if (!p || p.stunned) return;
  p.stunned = true;
  p.stunTimer = STUN_DURATION;
  p.inputDir = { x: 0, z: 0 };
  p.grabbed = false;
  if (p.team === 'A') scoreB++; else scoreA++;
  if (frisbeeOwner === pseudo) {
    frisbeeOwner = null;
    broadcast({ type: 'frisbeeDropped' });
  }
  broadcast({ type: 'stunned', pseudo });
  updateScoreboard();
}

function showEndScreen() {
  document.getElementById('final-a').textContent = scoreA;
  document.getElementById('final-b').textContent = scoreB;
  document.getElementById('end-winner').textContent =
    scoreA > scoreB ? '🏆 Équipe A gagne !'
      : scoreB > scoreA ? '🏆 Équipe B gagne !'
        : '🤝 Égalité !';
  document.getElementById('end-overlay').style.display = 'flex';

  document.getElementById('restart-btn').onclick = () => {
    document.getElementById('end-overlay').style.display = 'none';
    document.getElementById('lobby-overlay').style.display = 'flex';
    document.getElementById('hud').style.display = 'none';
    document.getElementById('ingame-qr').style.display = 'none';
    gamePhase = 'lobby'; scoreA = scoreB = 0; gameTimer = GAME_DURATION;
    for (const p in players) removePlayer(p);
    resetFrisbee();
    updateLobbyUI();
    broadcast({ type: 'returnToLobby' });
  };
}

// =============================================================================
//  SCOREBOARD
// =============================================================================
function updateScoreboard() {
  const mins = Math.floor(gameTimer / 60);
  const secs = Math.floor(gameTimer % 60);
  const timerEl = document.getElementById('timer');
  if (timerEl) {
    timerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    timerEl.className = gameTimer <= 10 ? 'danger' : '';
  }
  const elA = document.getElementById('score-a');
  const elB = document.getElementById('score-b');
  if (elA) elA.textContent = scoreA;
  if (elB) elB.textContent = scoreB;
  const listA = Object.values(players).filter(p => p.team === 'A').map(p => p.pseudo);
  const listB = Object.values(players).filter(p => p.team === 'B').map(p => p.pseudo);
  const pA = document.getElementById('players-a');
  const pB = document.getElementById('players-b');
  if (pA) pA.textContent = listA.join(', ') || '—';
  if (pB) pB.textContent = listB.join(', ') || '—';
}

// =============================================================================
//  QR CODE
// =============================================================================
function generateQR(container, url, size) {
  if (!container) return;
  container.innerHTML = '';
  /* global QRCode */
  new QRCode(container, {
    text: url, width: size, height: size,
    colorDark: '#000000', colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.L
  });
}

function showIngameQR() {
  const el = document.getElementById('ingame-qr');
  const container = document.getElementById('ingame-qr-code');
  if (!el || !container || container.childElementCount > 0) {
    if (el) el.style.display = 'flex';
    return;
  }
  fetch('/api/ip')
    .then(r => r.json())
    .then(data => {
      generateQR(container, `http://${data.ip}:${data.port}/controller`, 80);
      el.style.display = 'flex';
    })
    .catch(console.error);
}

// =============================================================================
//  EFFETS VISUELS — particules de stun
// =============================================================================
const stunParticles = {}; // pseudo → THREE.Points

function createStunEffect(pseudo) {
  if (stunParticles[pseudo]) return;
  const geo = new THREE.BufferGeometry();
  const count = 8;
  const pos = new Float32Array(count * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xFFD700, size: 0.15 });
  const points = new THREE.Points(geo, mat);
  scene.add(points);
  stunParticles[pseudo] = { points, t: 0 };
}

function updateStunEffect(pseudo, playerPos) {
  const ef = stunParticles[pseudo];
  if (!ef) return;
  ef.t += 0.05;
  const pos = ef.points.geometry.attributes.position;
  const count = pos.count;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + ef.t;
    pos.setXYZ(i,
      playerPos.x + Math.cos(angle) * 0.8,
      playerPos.y + 1.5,
      playerPos.z + Math.sin(angle) * 0.8
    );
  }
  pos.needsUpdate = true;
}

function removeStunEffect(pseudo) {
  const ef = stunParticles[pseudo];
  if (!ef) return;
  scene.remove(ef.points);
  delete stunParticles[pseudo];
}

// =============================================================================
//  BOUCLE DE JEU PRINCIPALE
// =============================================================================
function gameLoop(timestamp) {
  requestAnimationFrame(gameLoop);

  const dt = Math.min((timestamp - lastTimestamp) / 1000, 0.05); // cap à 50ms
  lastTimestamp = timestamp;

  // ── Step physique Rapier ──────────────────────────────────────
  world.step();

  // ── Timer de partie ──────────────────────────────────────────
  if (gamePhase === 'playing') {
    gameTimer -= dt;
    if (gameTimer <= 0) {
      gameTimer = 0;
      gamePhase = 'ended';
      showEndScreen();
    }
    if (Math.round(timestamp / 1000) % 1 === 0) updateScoreboard();
  }

  // ── Mise à jour joueurs ───────────────────────────────────────
  for (const pseudo in players) {
    const p = players[pseudo];
    const pos = p.body.translation();

    // Mire qui tourne automatiquement
    p.mireAngle += 4.5 * dt;

    if (p.stunned) {
      p.stunTimer -= dt;
      if (p.stunTimer <= 0) {
        p.stunned = false;
        removeStunEffect(pseudo);
        broadcast({ type: 'recovered', pseudo });
      }
      // Ralentissement progressif
      const v = p.body.linvel();
      p.body.setLinvel({ x: v.x * 0.8, y: v.y, z: v.z * 0.8 }, true);
      createStunEffect(pseudo);
      updateStunEffect(pseudo, pos);

    } else if (p.grabbed) {
      p.grabTimer -= dt;
      if (p.grabTimer <= 0) {
        p.grabbed = false;
        p.grabbedBy = null;
        broadcast({ type: 'released', pseudo });
      }
      const v = p.body.linvel();
      p.body.setLinvel({ x: v.x * 0.85, y: v.y, z: v.z * 0.85 }, true);

    } else {
      // Mouvement normal
      const speed = (frisbeeOwner === pseudo) ? PLAYER_SPEED * 0.65 : PLAYER_SPEED;
      const v = p.body.linvel();
      p.body.setLinvel({
        x: p.inputDir.x * speed,
        y: v.y,            // gravité conservée
        z: p.inputDir.z * speed
      }, true);
    }

    // Sync mesh → position physique
    p.mesh.position.set(pos.x, pos.y, pos.z);

    // Orientation du perso vers la direction du mouvement
    const spd = Math.hypot(p.inputDir.x, p.inputDir.z);
    if (spd > 0.1) {
      const targetAngle = Math.atan2(p.inputDir.x, p.inputDir.z);
      p.mesh.rotation.y += (targetAngle - p.mesh.rotation.y) * 0.2;
    }

    // Indicateur frisbee (halo doré) + flèche de visée
    if (frisbeeOwner === pseudo) {
      p.mesh.material.emissive.setHex(0x332200);
      // Flèche visible, rotation sur Y selon mireAngle
      if (p.aimPivot) {
        p.aimPivot.visible = true;
        p.aimPivot.rotation.y = -p.mireAngle; // négatif car le mesh regarde +X par défaut
      }
    } else {
      p.mesh.material.emissive.setHex(0x000000);
      if (p.aimPivot) p.aimPivot.visible = false;
    }
  }

  // ── Mise à jour frisbee ───────────────────────────────────────
  updateFrisbee(dt);

  // ── Rendu ─────────────────────────────────────────────────────
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

function updateFrisbee(dt) {
  if (!frisbee) return;

  if (frisbeeOwner) {
    const p = players[frisbeeOwner];
    if (p) {
      const pos = p.body.translation();
      // Frisbee collé au porteur, légèrement en avant
      frisbee.body.setTranslation({
        x: pos.x + Math.cos(p.mireAngle) * 0.6,
        y: FRISBEE_HEIGHT,
        z: pos.z + Math.sin(p.mireAngle) * 0.6
      }, true);
      frisbee.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    } else {
      frisbeeOwner = null;
    }
  } else {
    // Forcer Y fixe pour que le frisbee glisse à hauteur constante
    const fPos = frisbee.body.translation();
    const fVel = frisbee.body.linvel();
    frisbee.body.setTranslation({ x: fPos.x, y: FRISBEE_HEIGHT, z: fPos.z }, true);
    frisbee.body.setLinvel({ x: fVel.x, y: 0, z: fVel.z }, true);

    // Rotation visuelle du frisbee
    frisbee.mesh.rotation.y += dt * 5;

    // ── Détection collision frisbee ↔ joueurs ──
    const spd = Math.hypot(fVel.x, fVel.z);
    for (const pseudo in players) {
      const p = players[pseudo];
      if (p.stunned || p.grabbed) continue;
      const pPos = p.body.translation();
      const dist = Math.hypot(fPos.x - pPos.x, fPos.z - pPos.z);

      if (dist < 0.8) {
        // Frisbee lancé par un ennemi → stun
        if (spd > 2 && frisbeeLastThrower && frisbeeLastThrower !== pseudo) {
          const thrower = players[frisbeeLastThrower];
          if (thrower && thrower.team !== p.team) {
            stunPlayer(pseudo);
            frisbee.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            continue;
          }
        }

        // Ramassage automatique
        const now = performance.now() / 1000;
        const cooldownOk = frisbeeLastThrower !== pseudo || (now - p.lastThrowTime > 0.5);
        if (!frisbeeOwner && cooldownOk) {
          frisbeeOwner = pseudo;
          frisbee.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          broadcast({ type: 'hasFrisbee', pseudo });
        }
      }
    }
  }

  // Sync mesh frisbee
  const fPos = frisbee.body.translation();
  frisbee.mesh.position.set(fPos.x, fPos.y, fPos.z);
}

// =============================================================================
//  UTILITAIRES
// =============================================================================
function escapeHtml(t) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(t));
  return d.innerHTML;
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

// =============================================================================
//  INIT
// =============================================================================
loadMap();
createFrisbee();

document.getElementById('lobby-overlay').style.display = 'flex';
document.getElementById('hud').style.display = 'none';
document.getElementById('end-overlay').style.display = 'none';

// QR code lobby
fetch('/api/ip')
  .then(r => r.json())
  .then(data => {
    const url = `http://${data.ip}:${data.port}/controller`;
    // document.getElementById('lobby-url-text').textContent = url; // Supprimé car n'existe plus dans HTML
    generateQR(document.getElementById('lobby-qr-code'), url, 200);
  })
  .catch(console.error);

connectWebSocket();
requestAnimationFrame(gameLoop);
