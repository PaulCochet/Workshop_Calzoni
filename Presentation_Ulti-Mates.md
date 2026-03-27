# 🍕 Ulti-Mates : Édition Pizza

**Ulti-Mates** est un jeu multijoueur "Party Game" hybride et asymétrique. Il se joue sur un écran principal partagé (ordinateur, TV, ou projecteur) tandis que les joueurs utilisent leurs propres smartphones comme manettes pour contrôler leur personnage en 3D. 

Dans cette édition spéciale "Pizza", les joueurs incarnent des pizzaiolos qui s'affrontent dans une arène pour garder le contrôle d'une délicieuse pizza le plus longtemps possible.

---

## 🎮 Concept & Règles du Jeu

L'objectif est simple : accumuler le plus de points pour son équipe avant la fin du temps imparti (généralement 60 secondes).

*   **Équipes** : Les joueurs sont divisés en deux équipes (MARGHERITA 🔴 vs FROMAGIO 🔵).
*   **Gagner des points** : Pour marquer des points, un joueur de l'équipe doit attraper et garder la pizza. Le score monte chaque seconde où la pizza est conservée.
*   **La Passe** : Garder la pizza offre un avantage, mais ralentit le porteur ! Il est donc primordial de lancer la pizza à ses coéquipiers pour esquiver les adversaires.
*   **Le Plaquage (Pousser)** : Les joueurs de l'équipe adverse n'ont pas la pizza. Leur seul but est d'intercepter la pizza ou de tacler (pousser) le porteur pour lui faire lâcher.

---

## ✨ Features Principales

### 1. 📱 Le Système de Manettes Smartphones (WebSockets)
Pas besoin d'installer d'application ou de posséder des manettes classiques. Le jeu génère dynamiquement un QR Code sur l'écran principal.
*   Les joueurs scannent le QR Code et arrivent sur une interface web mobile (`controller.html`).
*   La page web mobile force l'orientation paysage et agit comme une véritable manette : un joystick virtuel à gauche pour les déplacements, et un gros bouton contextuel à droite (Pousser / Lancer).
*   Toute la communication (mouvements, actions, vibrations, retour haptique) transite par WebSocket (`server.js`) avec une latence minimale.

### 2. 🎥 La Caméra En Direct (WebRTC / PeerJS)
C'est la feature signature et hilarante du jeu :
*   **Le Picture-in-Picture (PiP)** : Dès qu'un joueur attrape la pizza, sa vraie caméra en mode selfie est diffusée en direct sur l'écran principal ! Le visage du joueur s'affiche dans un cadre jaune surmonté d'une toque de chef.
*   **L'Écran de Fin** : Lorsque la partie est terminée, le tableau des scores apparaît et *toutes* les caméras des joueurs se rallument simultanément. L'écran compile les visages des 6 joueurs répartis par équipe de chaque côté de l'écran pour voir les réactions de victoire/défaite en temps réel.

### 3. 🏃‍♂️ Moteur Physique & Game Feel (Three.js + Rapier)
L'agilité en jeu a été extrêmement polie pour un rendu fluide et amusant :
*   **Physique 3D** : Utilisation du moteur physique Rapier pour gérer les collisions, la gravité et les expulsions (Knockback).
*   **Squash & Stretch** : Les personnages se déforment cartoonement (ils s'étirent quand ils courent, s'écrasent quand ils tombent ou se font étourdir).
*   **Animations & Feedback** : 
    *   Particules d'étoiles tournoyantes (Stun) au-dessus de la tête d'un joueur qui vient de se faire tacler.
    *   Sillage de poussière aux pieds des personnages selon la vitesse.
    *   Flèche de visée dynamique qui tourne autour du joueur qui possède la pizza.
    *   Animations Lottie 2D fluides projetées par-dessus la 3D pour l'attribution des points et les transitions d'écrans.

### 4. 🔊 Conception Sonore Immersive (Web Audio API)
*   Musique de fond de type "Pizzeria italienne frénétique".
*   Génération en temps réel de bruits de pas synchronisés à la vitesse exacte (`playFootstep`), la vélocité et le mouvement du personnage.
*   Effets spéciaux (SFX) de lancer (woosh) et d'impact lors d'un gros plaquage.

---

## 🚀 L'Évolution du Projet & Les Défis Techniques Pliés

Tout au long du développement (Workshop), de nombreuses problématiques complexes ont été abordées et résolues pour aboutir à un produit robuste :

1.  **Fiabilité Réseau (WebRTC Storms)**
    *   *Le Défi* : Faire s'afficher la webcam de 6 téléphones simultanément sur un seul écran à la fin de la partie saturait les liaisons P2P.
    *   *La Solution* : Ajout d'un jitter (délai aléatoire anti-collision) qui décale l'appel de chaque téléphone sur un créneau de 0 à 4 secondes pour préserver le signaling de `PeerJS`.
2.  **Gestion de l'Autoplay Audio**
    *   *Le Défi* : Les navigateurs modernes (Safari, Chrome) bloquent le son si l'utilisateur n'a pas cliqué sur la page.
    *   *La Solution* : Mise en place d'un bouton de validation sur le lobby permettant de débloquer le contexte audio (`AudioContext`) de façon transparente.
3.  **Infrastructures Locales & Cloud (Railway / Localtunnel)**
    *   *Le Défi* : Les téléphones bloquent l'accès à la caméra si le site n'est pas sécurisé (HTTPS).
    *   *La Solution* : Adaptabilité totale du code réseau avec `x-forwarded-host` et une assignation dynamique (`wss://` vs `ws://`). Le système permet d'héberger le jeu sur Railway et de faire router les manettes proprement.
4.  **Débogage de Chronologie Complexe**
    *   *Le Défi* : Des joueurs "fantômes" ou coincés. Par exemple, frapper un joueur au moment exact où il était en train de tomber en arrêtant net le chronomètre.
    *   *La Solution* : Un nettoyage intraitable du tableau des entités WebSockets (`handleDisconnect`) et une gestion des états conditionnelle très stricte séparant l'aspect "étourdi" de l'aspect "repoussé".

---

## 🛠 Stack Technique
*   **Frontend (Jeu Principal)** : HTML5, CSS3, `Three.js` (Rendu 3D), `Rapier.js` (Physique), `Lottie-web` (Animations UI).
*   **Frontend (Manettes)** : Interface HTML/CSS mobile First, `nipple.js` (pour le Joystick), API de Vibration Mobile.
*   **Backend / Signalling** : `Node.js`, `Express`, Serveur WebSocket natif (`ws`).
*   **Streaming Vidéo** : `PeerJS` (surcouche WebRTC pour transmettre les flux caméra des téléphones vers l'ordinateur avec un système de Metadata pseudo/team).
