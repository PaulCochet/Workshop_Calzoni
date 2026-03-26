// =============================================================================
//  GAME.JS – Ulti-mates v3 — Three.js + Rapier (remplace p5play)
// =============================================================================

window.addEventListener('error', (event) => {
  console.error("ERREUR GLOBALE JS:", event.message, "à", event.filename, ":", event.lineno);
  const statusEl = document.getElementById('connection-status');
  if (statusEl) {
    statusEl.textContent = "ERREUR CHARGEMENT : " + event.message;
    statusEl.className = 'error';
    statusEl.style.background = '#c0392b';
    statusEl.style.display = 'block';
  }
});

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.150.1/build/three.module.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.150.1/examples/jsm/loaders/GLTFLoader.js';
import { CSS2DRenderer, CSS2DObject }
  from 'https://cdn.jsdelivr.net/npm/three@0.150.1/examples/jsm/renderers/CSS2DRenderer.js';
import RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.11.2/rapier.es.js';

// =============================================================================
//  CONSTANTES
// =============================================================================
const PLAYER_SPEED = 4;
const STUN_DURATION = 1.5;       // secondes 
const INVINCIBILITY_DURATION = 2; // secondes d'invincibilité après stun
const GAME_DURATION = 120;     // secondes
const FRISBEE_SPEED = 10;      // force d'impulsion au lancer
const FRISBEE_HEIGHT = 2;     // hauteur fixe du frisbee au-dessus du sol
const GRAB_RADIUS = 4.0;     // distance max pour attraper (augmentée)
const PUSH_DURATION = 0.3;     // secondes de recul
const THROW_COOLDOWN = 0.6;
const KNOCKBACK_FORCE = 28;      // impulsion de recul (augmentée)
const FRISBEE_DAMPING = 1;     // résistance air du frisbee
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
const CG_LOWCOL = cg(G_LOWCOL, G_PLAYER | G_FRISBEE);             // bloque joueurs + frisbee
const CG_PLAYER = cg(G_PLAYER, G_COL | G_LOWCOL);     // interagit avec col + lowcol
const CG_FRISBEE = cg(G_FRISBEE, G_COL | G_LOWCOL);                 // interagit avec col + lowcol

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
let frisbeeIdleTimer = 0;   // Temps (sec) depuis le dernier contact avec le frisbee
const spawnPoints = [];     // THREE.Vector3[] — rempli depuis la map GLB

let gamePhase = 'lobby';   // 'lobby' | 'playing' | 'ended'
let gameTimer = GAME_DURATION;
let scoreA = 0, scoreB = 0;
let pointAnim = null;
let transitionAnim = null;
let lastTimestamp = 0;

// Musique de fond
const bgMusic = new Audio('MusiqueDeFond.m4a');
bgMusic.loop = true;
bgMusic.volume = 0.15;

const throwSFX = new Audio('ThrowSFX.mp3');
throwSFX.volume = 0.10;
throwSFX.preload = 'auto';

const hitSFX = new Audio('HitSFX.mp3');
hitSFX.volume = 0.8;
hitSFX.preload = 'auto';

// =============================================================================
//  Web Audio API (Footsteps)
// =============================================================================
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let footstepBuffer = null;

fetch('footstep.mp3')
  .then(r => r.arrayBuffer())
  .then(data => audioCtx.decodeAudioData(data))
  .then(buffer => { footstepBuffer = buffer; })
  .catch(console.error);

function playFootstep(volume = 1.3) {
  if (!footstepBuffer) return;
  const source = audioCtx.createBufferSource();
  source.buffer = footstepBuffer;
  source.playbackRate.value = 0.9 + Math.random() * 0.25;
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = volume * (0.85 + Math.random() * 0.3);
  source.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  source.start();
}

document.addEventListener('pointerdown', () => {
  if (audioCtx.state === 'suspended') audioCtx.resume();
});

// Débloquer l'audio via Bouton (Anti-Autoplay des navigateurs)
let audioUnlocked = false;
let musicWanted = false; // Le joueur a activé la musique ?

const musicBtn = document.getElementById('music-toggle-btn');
if (musicBtn) {
  musicBtn.addEventListener('click', () => {
    if (!audioUnlocked) {
      // Débloquer le contexte au premier clic
      bgMusic.play().then(() => {
        bgMusic.pause();
        bgMusic.currentTime = 0;
        audioUnlocked = true;
        toggleMusicState();
      }).catch(() => { });
    } else {
      toggleMusicState();
    }
  });
}

function toggleMusicState() {
  musicWanted = !musicWanted;
  if (musicBtn) {
    musicBtn.textContent = musicWanted ? "Musique : ON" : "Musique : OFF";
    musicBtn.style.background = musicWanted ? "#27ae60" : "var(--black)";
  }
}

let ws;

// =============================================================================
//  THREE.JS — SETUP
// =============================================================================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0x2a0a0a);
document.body.insertBefore(renderer.domElement, document.body.firstChild);

// CSS2D pour les labels joueurs (noms au-dessus des persos)
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
document.body.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a0a0a);
scene.fog = new THREE.Fog(0x2a0a0a, 20, 60);

// Caméra — vue isométrique style Overcooked
const camera = new THREE.PerspectiveCamera(57.5, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 14.5, 10);
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
const floorGeo = new THREE.PlaneGeometry(200, 200);
const floorMat = new THREE.MeshLambertMaterial({ color: 0x3a0e0e });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// =============================================================================
//  RAPIER — INIT
// =============================================================================
let world = null;
try {
  console.log("Initialisation de RAPIER...");
  await RAPIER.init();
  world = new RAPIER.World({ x: 0, y: -25, z: 0 });
  console.log("RAPIER prêt !");
} catch (e) {
  console.error("ERREUR FATALE RAPIER:", e);
  throw new Error("Impossible d'initialiser le moteur physique (Rapier).");
}

// =============================================================================
//  CHARGEMENT DE LA MAP GLB
// =============================================================================
function loadMap() {
  const loader = new GLTFLoader();
  loader.load(
    'Img/Workshop_mapV4.glb',

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
          .setRestitution(0.55)   // rebond fluide pour tous (col et lowcol)
          .setFriction(0.1);      // friction réduite pour glisser plus facilement

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
  // Mesh visuel — Groupe qui contiendra le modèle GLB
  const mesh = new THREE.Group();
  scene.add(mesh);

  const loader = new GLTFLoader();
  loader.load('Img/frisbeeV2.glb', (gltf) => {
    const model = gltf.scene;
    // Ajustements visuels du modèle
    model.scale.setScalar(0.6); // Réduire la taille de la boîte à pizza
    model.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    // Centrer le modèle sur son propre centre géométrique
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    mesh.add(model);
    console.log('Frisbee GLB chargé ✔');
  }, undefined, (err) => {
    console.error('Erreur chargement frisbee.glb, fallback visuel activé');
    const geo = new THREE.CylinderGeometry(0.28, 0.28, 0.07, 0, 24);
    const mat = new THREE.MeshLambertMaterial({ color: COLOR_FRISBEE });
    const fallback = new THREE.Mesh(geo, mat);
    mesh.add(fallback);
  });

  // Physique Rapier — corps dynamique avec CCD activé pour éviter le tunneling
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, FRISBEE_HEIGHT, 0)
    .setLinearDamping(FRISBEE_DAMPING)
    .setAngularDamping(5.0)
    .setCcdEnabled(true); // ← Continuous Collision Detection : évite que le frisbee transperce les murs
  const body = world.createRigidBody(bodyDesc);
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(0.035, 0.28)
      .setRestitution(0.95)
      .setFriction(0.1)
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
  frisbeeIdleTimer = 0;
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

  // ── Mesh joueur : modèle GLB ──
  const glbFile = team === 'A' ? 'Img/Pizzaiolo-Rouge.glb' : 'Img/Pizzaiolo-Bleu.glb';
  const mesh = new THREE.Group();
  mesh.castShadow = true;
  mesh.rotation.order = 'YXZ'; // Y (direction) d'abord, puis tilt en local

  const loader = new GLTFLoader();
  loader.load(glbFile, (gltf) => {
    const model = gltf.scene;
    model.scale.setScalar(0.5);
    // Centrer le modèle
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    model.rotation.y = -Math.PI / 2; // tourner le modèle de -90° pour aligner avec la direction

    // Easter Egg: Dinnerbone (personnage à l'envers)
    if (pseudo.toLowerCase() === 'dinnerbone') {
      model.rotation.z = Math.PI;
      model.position.y += 3.5; // Remonter nettement plus
    }

    model.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    mesh.add(model);
    console.log(`Skin GLB chargé pour ${pseudo} (${team}) ✔`);
  }, undefined, (err) => {
    console.error(`Erreur chargement skin ${glbFile}, fallback capsule`);
    const fallbackGeo = new THREE.CapsuleGeometry(0.38, 0.7, 4, 12);
    const fallbackMat = new THREE.MeshLambertMaterial({ color });
    const fallback = new THREE.Mesh(fallbackGeo, fallbackMat);
    fallback.castShadow = true;
    mesh.add(fallback);
  });

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
  const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
    .setTranslation(startX, 1.2, startZ);
  const rbody = world.createRigidBody(bodyDesc);
  const collider = world.createCollider(
    RAPIER.ColliderDesc.capsule(0.35, 0.38)
      .setFriction(0.0).setRestitution(0.0)
      .setCollisionGroups(CG_PLAYER),
    rbody
  );
  const charCtrl = world.createCharacterController(0.01);
  charCtrl.setUp({ x: 0, y: 1, z: 0 });
  charCtrl.setMaxSlopeClimbAngle(45 * Math.PI / 180);
  charCtrl.setMinSlopeSlideAngle(30 * Math.PI / 180);
  charCtrl.enableAutostep(0.3, 0.1, true);
  charCtrl.enableSnapToGround(0.3);

  players[pseudo] = {
    pseudo, team, isHost: isHost || false,
    mesh, body: rbody, label: div, aimPivot,
    vel: { x: 0, y: -0.5, z: 0 }, collider, charCtrl,
    stunned: false, stunTimer: 0,
    grabbed: false, grabTimer: 0, grabbedBy: null,
    inputDir: { x: 0, z: 0 },
    lastThrowTime: 0,
    mireAngle: 0,
    points: 0,
    invincible: false, invincibleTimer: 0,
    stepTimer: 0,
  };
}

function removePlayer(pseudo) {
  const p = players[pseudo];
  if (!p) return;
  scene.remove(p.mesh);
  world.removeCharacterController(p.charCtrl);
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
    p.body.setNextKinematicTranslation({ x, y: 1.5, z: (Math.random() - 0.5) * 4 });
    p.vel = { x: 0, y: -0.5, z: 0 };
    return;
  }

  const sp = candidates[Math.floor(Math.random() * candidates.length)];
  // +1.2 sur Y pour spawner légèrement au-dessus du point (évite d'être dans le sol)
  p.body.setNextKinematicTranslation({ x: sp.x, y: sp.y + 1.2, z: sp.z });
  p.vel = { x: 0, y: -0.5, z: 0 };
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
    else if (msg.type === 'restartGame') handleRestart();
    else if (msg.type === 'getState') handleGetState();
    else if (msg.type === 'disconnect') handleDisconnect(msg);
  };
}

function handleDisconnect(msg) {
  removePlayer(msg.pseudo);
  // Si on est dans le lobby, on rafraîchit immédiatement l'écran
  if (gamePhase === 'lobby') {
    updateLobbyUI();
  }
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

  if (audioUnlocked) {
    throwSFX.currentTime = 0;
    throwSFX.play().catch(() => { });
  }

  broadcast({ type: 'frisbeeDropped' });
  const pipContainer = document.getElementById('pip-container');
  if (pipContainer) pipContainer.style.display = 'none';
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
    if (target.stunned || target.grabbed) continue;
    const tPos = target.body.translation();
    const dist = Math.hypot(gPos.x - tPos.x, gPos.z - tPos.z);
    if (dist < closestDist) { closestDist = dist; closest = id; }
  }

  if (closest) {
    const target = players[closest];
    target.grabbed = true;
    target.grabTimer = PUSH_DURATION;
    target.grabbedBy = msg.pseudo;
    target.inputDir = { x: 0, z: 0 };
    // Supprimer l'effet de stun si le joueur vient d'être attrapé
    removeStunEffect(closest);

    // Knockback (direction opposée au grabber)
    const tPos = target.body.translation();
    const dx = tPos.x - gPos.x;
    const dz = tPos.z - gPos.z;
    const d = Math.hypot(dx, dz) || 1;
    target.vel.x = (dx / d) * KNOCKBACK_FORCE;
    target.vel.z = (dz / d) * KNOCKBACK_FORCE;

    if (frisbeeOwner === closest) {
      frisbeeOwner = null;
      broadcast({ type: 'frisbeeDropped' });
      const pipContainer = document.getElementById('pip-container');
      if (pipContainer) pipContainer.style.display = 'none';
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
  if (lobbyA) lobbyA.innerHTML = listA.map(n => `<div class="lobby-player">${escapeHtml(n)}</div>`).join('') || '<div class="lobby-empty">—</div>';
  if (lobbyB) lobbyB.innerHTML = listB.map(n => `<div class="lobby-player">${escapeHtml(n)}</div>`).join('') || '<div class="lobby-empty">—</div>';
  const count = document.getElementById('lobby-count');
  if (count) count.textContent = `${Object.keys(players).length} joueur(s) connecté(s)`;
}

// =============================================================================
//  DÉMARRER / FINIR LA PARTIE
// =============================================================================
function startGame() {
  if (gamePhase !== 'lobby') return;

  gamePhase = 'loading';
  document.getElementById('lobby-overlay').style.display = 'none';
  document.getElementById('loading-screen').style.display = 'flex';

  const progressBar = document.getElementById('loading-bar-fill');
  const DURATION = 10000; // 10 secondes de chargement
  broadcast({ type: 'loadingStarted', duration: DURATION });
  const start = performance.now();

  function animateLoading(time) {
    const elapsed = time - start;
    const progress = Math.min(elapsed / DURATION, 1);
    if (progressBar) progressBar.style.width = (progress * 100) + '%';

    if (progress < 1) {
      requestAnimationFrame(animateLoading);
    } else {
      finalizeStart();
    }
  }
  requestAnimationFrame(animateLoading);

  function finalizeStart() {
    startLoadingToGameTransition();
  }
}

function startLoadingToGameTransition() {
  const overlay = document.getElementById('transition-overlay');
  if (!transitionAnim || !overlay) {
    completeStartSequence();
    return;
  }

  overlay.style.display = "flex";
  overlay.style.pointerEvents = "auto";
  transitionAnim.goToAndPlay(0, true);

  // Switch UI au milieu de l'animation
  setTimeout(() => {
    completeStartSequence();
  }, 600);

  transitionAnim.removeEventListener('complete');
  transitionAnim.addEventListener('complete', () => {
    overlay.style.pointerEvents = "none";
    overlay.style.display = "none";
  });
}

function completeStartSequence() {
  gamePhase = 'playing';
  gameTimer = GAME_DURATION;
  scoreA = scoreB = 0;

  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('hud').style.display = 'flex';
  showIngameQR();

  for (const pseudo in players) {
    placePlayerOnMap(players[pseudo]);
  }
  resetFrisbee();
  broadcast({ type: 'gameStarted' });
  updateScoreboard();

  // Lancer la musique de fond uniquement si activée
  if (audioUnlocked && musicWanted) {
    bgMusic.currentTime = 0;
    bgMusic.play().catch(() => { });
  }
}

function triggerPointAnimation(pseudo) {
  const wrapper = document.getElementById('point-lottie-wrapper');
  const textEl = document.getElementById('point-lottie-text');
  if (!pointAnim || !wrapper || !textEl) return;

  textEl.textContent = pseudo;
  wrapper.style.display = 'flex';
  textEl.classList.add('visible');

  pointAnim.stop();
  pointAnim.setSpeed(1.0);
  pointAnim.play();

  pointAnim.removeEventListener('complete');
  pointAnim.addEventListener('complete', () => {
    textEl.classList.remove('visible');
    wrapper.style.display = 'none';
  });
}

function stunPlayer(pseudo, throwerPseudo = null) {
  const p = players[pseudo];
  if (!p || p.stunned) return;
  p.stunned = true;
  p.stunTimer = STUN_DURATION;
  p.inputDir = { x: 0, z: 0 };
  p.grabbed = false;
  // Squash immédiat au stun
  p.mesh.scale.set(1.5, 0.5, 1.5);

  if (audioUnlocked) {
    hitSFX.currentTime = 0;
    hitSFX.play().catch(() => { });
  }

  if (p.team === 'A') {
    scoreB++;
    if (throwerPseudo && players[throwerPseudo] && players[throwerPseudo].team === 'B') {
      players[throwerPseudo].points++;
      triggerPointAnimation(throwerPseudo);
    }
  } else {
    scoreA++;
    if (throwerPseudo && players[throwerPseudo] && players[throwerPseudo].team === 'A') {
      players[throwerPseudo].points++;
      triggerPointAnimation(throwerPseudo);
    }
  }

  if (frisbeeOwner === pseudo) {
    frisbeeOwner = null;
    broadcast({ type: 'frisbeeDropped' });
    const pipContainer = document.getElementById('pip-container');
    if (pipContainer) pipContainer.style.display = 'none';
  }
  broadcast({ type: 'stunned', pseudo });
  updateScoreboard();
}

function startEndGameTransition() {
  const overlay = document.getElementById('transition-overlay');
  if (!transitionAnim || !overlay) {
    showEndScreen();
    return;
  }

  overlay.style.display = "flex";
  overlay.style.pointerEvents = "auto";
  transitionAnim.goToAndPlay(0, true);

  // Switch UI au milieu de l'animation
  setTimeout(() => {
    showEndScreen();
  }, 600);

  transitionAnim.removeEventListener('complete');
  transitionAnim.addEventListener('complete', () => {
    overlay.style.pointerEvents = "none";
    overlay.style.display = "none";
  });
}

function showEndScreen() {
  const overlay = document.getElementById('end-overlay');
  const highlightEl = document.getElementById('end-winner-highlight');
  const listA = document.getElementById('end-list-a');
  const listB = document.getElementById('end-list-b');
  const headerA = document.getElementById('end-header-a');
  const headerB = document.getElementById('end-header-b');

  // Équipe gagnante
  let winnerText = "";
  let winnerScore = 0;
  if (scoreA > scoreB) {
    winnerText = "MARGHERITA";
  } else if (scoreB > scoreA) {
    winnerText = "FROMAGIO";
  } else {
    winnerText = "ÉGALITÉ";
  }

  highlightEl.innerHTML = `
    <div class="winner-label">${winnerText}</div>
  `;

  // Calcul MVP global
  let mvpPlayer = null;
  let maxPoints = 0;
  let tie = false;
  const allPlayers = Object.values(players);
  for (const p of allPlayers) {
    if (p.points > maxPoints) {
      maxPoints = p.points;
      mvpPlayer = p;
      tie = false;
    } else if (p.points === maxPoints && maxPoints > 0) {
      tie = true;
    }
  }

  // Fonction pour générer le lien HTML d'un joueur
  const renderRow = (p) => {
    const isMvp = mvpPlayer && p.pseudo === mvpPlayer.pseudo && !tie;
    return `
      <div class="end-player-row">
        <div class="p-left">
          <span class="p-name">${escapeHtml(p.pseudo)}</span>
          ${isMvp ? '<span class="mvp-tag-small">MVP</span>' : ''}
        </div>
        <span class="p-points">+${p.points}</span>
      </div>
    `;
  };

  const playersA = allPlayers.filter(p => p.team === 'A').sort((a, b) => b.points - a.points);
  const playersB = allPlayers.filter(p => p.team === 'B').sort((a, b) => b.points - a.points);

  listA.innerHTML = playersA.map(renderRow).join('') || '<div class="end-empty">Aucun joueur</div>';
  listB.innerHTML = playersB.map(renderRow).join('') || '<div class="end-empty">Aucun joueur</div>';

  const renderCamSlot = (p) => {
    const safeId = p.pseudo.replace(/\s+/g, '-');
    return `
      <div id="end-cam-slot-${safeId}" class="end-cam-slot">
        <div class="end-cam-placeholder">Caméra<br>indisponible</div>
        <video id="end-cam-vid-${safeId}" class="end-cam-video" autoplay playsinline muted></video>
        <div class="end-cam-pseudo">${escapeHtml(p.pseudo)}</div>
      </div>
    `;
  };

  const camsA = document.getElementById('end-cams-a');
  const camsB = document.getElementById('end-cams-b');
  if (camsA) camsA.innerHTML = playersA.map(renderCamSlot).join('');
  if (camsB) camsB.innerHTML = playersB.map(renderCamSlot).join('');

  if (headerA) headerA.textContent = `MARGHERITA (${scoreA})`;
  if (headerB) headerB.textContent = `FROMAGIO (${scoreB})`;

  // Notification aux manettes
  broadcast({
    type: 'gameEnded',
    winningTeam: scoreA > scoreB ? 'A' : (scoreB > scoreA ? 'B' : 'tie'),
    mvpPseudo: (mvpPlayer && !tie && maxPoints > 0) ? mvpPlayer.pseudo : null
  });

  overlay.style.display = 'flex';
  const pipContainer = document.getElementById('pip-container');
  if (pipContainer) pipContainer.style.display = 'none';
}

function handleRestart() {
  document.getElementById('end-overlay').style.display = 'none';
  document.getElementById('lobby-overlay').style.display = 'flex';
  document.getElementById('hud').style.display = 'none';
  document.getElementById('ingame-qr').style.display = 'none';
  gamePhase = 'lobby'; scoreA = scoreB = 0; gameTimer = GAME_DURATION;
  Object.keys(players).forEach(p => removePlayer(p));
  resetFrisbee();
  updateLobbyUI();
  broadcast({ type: 'returnToLobby' });
  const pipContainer = document.getElementById('pip-container');
  if (pipContainer) pipContainer.style.display = 'none';
  // Arrêter la musique
  bgMusic.pause();
  bgMusic.currentTime = 0;
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
  if (!el || !container) return;
  // Régénérer le QR à chaque fois (URL peut changer entre local et cloud)
  container.innerHTML = '';
  const controllerURL = `${window.location.protocol}//${window.location.host}/controller`;
  generateQR(container, controllerURL, 80);
  el.style.display = 'flex';
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
//  EFFETS VISUELS — particules de pas (poussière)
// =============================================================================
const footDustParticles = []; // { mesh, life, maxLife }
const DUST_POOL_MAX = 120;
const dustGeo = new THREE.SphereGeometry(0.08, 4, 4);
const dustMat = new THREE.MeshBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.85 });

function spawnFootDust(pos) {
  if (footDustParticles.length >= DUST_POOL_MAX) return;
  const p = new THREE.Mesh(dustGeo, dustMat.clone());
  p.position.set(
    pos.x + (Math.random() - 0.5) * 0.3,
    pos.y - 0.8,
    pos.z + (Math.random() - 0.5) * 0.3
  );
  const scale = 1.0 + Math.random() * 1.0;
  p.scale.setScalar(scale);
  scene.add(p);
  footDustParticles.push({ mesh: p, life: 0.4 + Math.random() * 0.2, maxLife: 0.5 });
}

function updateFootDust(dt) {
  for (let i = footDustParticles.length - 1; i >= 0; i--) {
    const d = footDustParticles[i];
    d.life -= dt;
    d.mesh.position.y += dt * 0.3;
    d.mesh.material.opacity = Math.max(0, (d.life / d.maxLife) * 0.85);
    if (d.life <= 0) {
      scene.remove(d.mesh);
      d.mesh.material.dispose();
      footDustParticles.splice(i, 1);
    }
  }
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
      startEndGameTransition();
    }
    if (Math.round(timestamp / 1000) % 1 === 0) updateScoreboard();
  }

  // ── Mise à jour joueurs ───────────────────────────────────────
  for (const pseudo in players) {
    const p = players[pseudo];
    const pos = p.body.translation();

    // Mire qui tourne automatiquement (vitesse réduite)
    p.mireAngle += 2.2 * dt;

    if (p.stunned) {
      p.stunTimer -= dt;
      if (p.stunTimer <= 0) {
        p.stunned = false;
        removeStunEffect(pseudo);
        // Activer l'invincibilité post-stun
        p.invincible = true;
        p.invincibleTimer = INVINCIBILITY_DURATION;
        broadcast({ type: 'recovered', pseudo });
      } else {
        // Ralentissement progressif
        p.vel.x *= 0.8;
        p.vel.z *= 0.8;
        createStunEffect(pseudo);
        updateStunEffect(pseudo, pos);
      }

    } else if (p.grabbed) {
      p.grabTimer -= dt;
      if (p.grabTimer <= 0) {
        p.grabbed = false;
        p.grabbedBy = null;
        broadcast({ type: 'released', pseudo });
      }
      p.vel.x *= 0.85;
      p.vel.z *= 0.85;

    } else if (gamePhase === 'playing') {
      // Mouvement normal uniquement en jeu
      const speed = (frisbeeOwner === pseudo) ? PLAYER_SPEED * 0.65 : PLAYER_SPEED;
      p.vel.x = p.inputDir.x * speed;
      p.vel.z = p.inputDir.z * speed;
    }

    const spdPlay = Math.hypot(p.vel.x, p.vel.z);
    const isMoving = spdPlay > 0.8 && !p.stunned && !p.grabbed;
    if (isMoving) {
      const stepInterval = 0.37 - (spdPlay / PLAYER_SPEED) * 0.12;
      p.stepTimer -= dt;
      if (p.stepTimer <= 0) {
        playFootstep(1.3);
        p.stepTimer = stepInterval;
      }
    } else {
      p.stepTimer = 0;
    }

    // Timer d'invincibilité
    if (p.invincible) {
      p.invincibleTimer -= dt;
      if (p.invincibleTimer <= 0) {
        p.invincible = false;
        // Remettre l'opacité normale
        p.mesh.traverse(c => { if (c.isMesh && c.material) c.material.opacity = 1; });
      } else {
        // Clignotement : alterner visible/semi-transparent
        const blink = Math.sin(p.invincibleTimer * 12) > 0;
        p.mesh.traverse(c => {
          if (c.isMesh && c.material) {
            c.material.transparent = true;
            c.material.opacity = blink ? 1.0 : 0.3;
          }
        });
      }
    }

    if (!p.stunned && !p.grabbed && gamePhase !== 'playing') {
      // Pas de mouvement pendant le chargement ou menu
      p.vel.x = 0;
      p.vel.z = 0;
    }

    // Gravité
    p.vel.y = Math.max(p.vel.y - 20 * dt, -20);

    // Mouvement avec CharacterController
    const desired = { x: p.vel.x * dt, y: p.vel.y * dt, z: p.vel.z * dt };
    p.charCtrl.computeColliderMovement(p.collider, desired);
    const moved = p.charCtrl.computedMovement();
    if (p.charCtrl.computedGrounded()) p.vel.y = 0;

    const newPos = { x: pos.x + moved.x, y: pos.y + moved.y, z: pos.z + moved.z };
    p.body.setNextKinematicTranslation(newPos);
    p.mesh.position.set(newPos.x, newPos.y, newPos.z);

    // Squash & Stretch
    const spdSS = Math.hypot(p.vel.x, p.vel.z) / PLAYER_SPEED;
    const targetScaleY = 1 + spdSS * 0.12;
    const targetScaleXZ = 1 - spdSS * 0.06;
    p.mesh.scale.y += (targetScaleY - p.mesh.scale.y) * 0.2;
    p.mesh.scale.x += (targetScaleXZ - p.mesh.scale.x) * 0.2;
    p.mesh.scale.z += (targetScaleXZ - p.mesh.scale.z) * 0.2;

    // Orientation du perso vers la direction du mouvement
    const spd = Math.hypot(p.inputDir.x, p.inputDir.z);
    if (spd > 0.1) {
      const targetAngle = Math.atan2(p.inputDir.x, p.inputDir.z);
      p.mesh.rotation.y += (targetAngle - p.mesh.rotation.y) * 0.2;
      // Particules de pas
      if (Math.random() < 0.3) spawnFootDust(newPos);
    }

    // Tilt directionnel (en espace local grâce à l'ordre YXZ)
    const moveSpd = Math.hypot(p.inputDir.x, p.inputDir.z);
    const tiltX = moveSpd * 0.18; // pencher vers l'avant
    p.mesh.rotation.x += (tiltX - p.mesh.rotation.x) * 0.15;
    p.mesh.rotation.z += (0 - p.mesh.rotation.z) * 0.15;

    // Indicateur frisbee (halo doré) + flèche de visée
    if (frisbeeOwner === pseudo) {
      p.mesh.traverse(c => { if (c.isMesh && c.material && c.material.emissive) c.material.emissive.setHex(0x332200); });
      // Flèche visible, rotation absolue sur Y = -p.mireAngle
      if (p.aimPivot) {
        p.aimPivot.visible = true;
        // On soustrait la rotation du parent (p.mesh.rotation.y) pour qu'elle soit globale
        p.aimPivot.rotation.y = -p.mireAngle - p.mesh.rotation.y;
      }
    } else {
      p.mesh.traverse(c => { if (c.isMesh && c.material && c.material.emissive) c.material.emissive.setHex(0x000000); });
      if (p.aimPivot) p.aimPivot.visible = false;
    }
  }

  // ── Mise à jour frisbee ───────────────────────────────────────
  updateFrisbee(dt);

  // ── Mise à jour particules de pas ─────────────────────────────
  updateFootDust(dt);

  // ── Rendu ─────────────────────────────────────────────────────
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

function updateFrisbee(dt) {
  if (!frisbee) return;

  if (frisbeeOwner) {
    frisbeeIdleTimer = 0; // Le frisbee est touché
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

      // Une fois prise, la pizza ne tourne plus et se fixe sur la flèche
      frisbee.mesh.rotation.y = -p.mireAngle;
    } else {
      frisbeeOwner = null;
    }
  } else {
    // Forcer Y fixe pour que le frisbee glisse à hauteur constante
    const fPos = frisbee.body.translation();
    const fVel = frisbee.body.linvel();
    frisbee.body.setTranslation({ x: fPos.x, y: FRISBEE_HEIGHT, z: fPos.z }, true);
    frisbee.body.setLinvel({ x: fVel.x, y: 0, z: fVel.z }, true);

    const speed = Math.hypot(fVel.x, fVel.z);

    // Rotation visuelle du frisbee
    if (frisbeeLastThrower === null) {
      // Quand la boite apparait, elle tourne à vitesse constante jusqu'à être prise
      frisbee.mesh.rotation.y += dt * 5;
    } else {
      // Une fois lancée, elle tourne en fonction de sa vitesse et s'arrête en fin de course
      frisbee.mesh.rotation.y -= dt * speed * 0.6; // On tourne dans le sens du lancer (ou inverse selon rendu)
    }

    // Retour au spawn si inactif pdt 5 sec
    frisbeeIdleTimer += dt;
    if (frisbeeIdleTimer >= 5) {
      resetFrisbee();
      broadcast({ type: 'frisbeeDropped' });
      const pipContainer = document.getElementById('pip-container');
      if (pipContainer) pipContainer.style.display = 'none';
      return;
    }

    // ── Détection collision frisbee ↔ joueurs ──
    const spd = Math.hypot(fVel.x, fVel.z);
    for (const pseudo in players) {
      const p = players[pseudo];
      if (p.stunned || p.grabbed) continue;
      const pPos = p.body.translation();
      const dist = Math.hypot(fPos.x - pPos.x, fPos.z - pPos.z);

      if (dist < 1.5) {
        // Frisbee lancé par un ennemi → stun
        if (spd > 3.2 && frisbeeLastThrower && frisbeeLastThrower !== pseudo && !p.invincible) {
          const thrower = players[frisbeeLastThrower];
          if (thrower && thrower.team !== p.team) {
            stunPlayer(pseudo, frisbeeLastThrower);
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

// QR code lobby (Auto-détection de l'URL pour Railway/Local)
const lobbyQrEl = document.getElementById('lobby-qr-code');
if (lobbyQrEl) {
  const protocol = window.location.protocol;
  const host = window.location.host;
  const url = `${protocol}//${host}/controller`;
  console.log("QR Code généré pour :", url);
  generateQR(lobbyQrEl, url, 200);
}

// Permettre de cliquer sur le QR Code pour le mettre à jour avec Localtunnel
if (lobbyQrEl) {
  lobbyQrEl.style.cursor = 'pointer';
  lobbyQrEl.title = "Cliquez pour changer l'URL (Localtunnel)";
  lobbyQrEl.addEventListener('click', () => {
    const newUrl = prompt("Entrez votre URL Localtunnel (HTTPS) pour la caméra :", "https://xyz.loca.lt/controller");
    if (newUrl && newUrl.includes('https://')) {
      generateQR(lobbyQrEl, newUrl, 200);
      alert("QR Code mis à jour avec le lien sécurisé !");
    }
  });
}

// =============================================================================
//  WebRTC Picture-in-Picture (PiP)
// =============================================================================
let peer = null;

function initPeer() {
  console.log('Jeu : Init PeerJS sur le CLOUD');

  // Utilise le cloud PeerJS (0.peerjs.com) par défaut pour plus de fiabilité
  peer = new Peer('GRAND_ECRAN_PIZZA_ULTIMATES');

  peer.on('open', id => {
    console.log('PeerJS (Game) ouvert sur le Cloud avec ID:', id);
  });

  peer.on('open', id => {
    console.log('PeerJS (Game) ouvert avec ID:', id);
    // Optionnel : afficher à l'écran pour débug
  });

  peer.on('error', err => {
    console.error('PeerJS Erreur (Game):', err);
    // On tente de réinitialiser si c'est une erreur fatale
  });

  peer.on('call', (call) => {
    call.answer();

    const team = call.metadata ? call.metadata.team : 'A';
    const isEndScreen = call.metadata ? call.metadata.endScreen : false;
    const pseudo = call.metadata ? call.metadata.pseudo : null;
    const borderColor = team === 'A' ? '#e74c3c' : '#3498db';

    call.on('stream', (remoteStream) => {
      if (isEndScreen && pseudo) {
        const safeId = pseudo.replace(/\s+/g, '-');
        const vid = document.getElementById(`end-cam-vid-${safeId}`);
        const slot = document.getElementById(`end-cam-slot-${safeId}`);
        if (vid && slot) {
          vid.srcObject = remoteStream;
          vid.onloadedmetadata = () => { vid.play().catch(e => console.error("Erreur lecture vidéo de fin:", e)); };
          slot.style.borderColor = borderColor;
        }
      } else {
        const pipContainer = document.getElementById('pip-container');
        const pipVideo = document.getElementById('pip-video');
        if (pipContainer && pipVideo) {
          if (pipVideo.srcObject !== remoteStream) {
            pipVideo.srcObject = remoteStream;
            pipVideo.onloadedmetadata = () => {
              pipVideo.play().catch(e => console.error("Erreur lecture vidéo:", e));
            };
          }
          pipContainer.style.borderColor = borderColor;
          pipContainer.style.backgroundColor = '#000'; // Fond noir pour cacher la transparence
          pipContainer.style.display = 'block';
        }
      }
    });

    call.on('close', () => {
      if (isEndScreen && pseudo) {
        const safeId = pseudo.replace(/\s+/g, '-');
        const vid = document.getElementById(`end-cam-vid-${safeId}`);
        if (vid) vid.srcObject = null;
      } else {
        const pipContainer = document.getElementById('pip-container');
        const pipVideo = document.getElementById('pip-video');
        if (pipContainer && pipVideo) {
          pipContainer.style.display = 'none';
          pipVideo.srcObject = null;
        }
      }
    });
  });
}

initPeer();

// Initialisation Lottie
if (typeof lottie !== 'undefined') {
  pointAnim = lottie.loadAnimation({
    container: document.getElementById('point-lottie-container'),
    renderer: 'svg',
    loop: false,
    autoplay: false,
    path: 'exemple/lottie_clean.json'
  });

  transitionAnim = lottie.loadAnimation({
    container: document.getElementById('transition-lottie-container'),
    renderer: 'svg',
    loop: false,
    autoplay: false,
    path: 'exemple/my-animation.json',
    rendererSettings: {
      preserveAspectRatio: 'xMidYMid slice'
    }
  });
}

connectWebSocket();
requestAnimationFrame(gameLoop);
