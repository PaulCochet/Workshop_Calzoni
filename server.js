// =============================================================================
//  SERVER.JS – Ulti-mates (minimal, Railway-compatible)
// =============================================================================

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));
app.get('/controller', (req, res) => res.sendFile(path.join(__dirname, 'public', 'controller.html')));

// WebSocket relay
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (msg.type === 'spawn' && msg.pseudo) ws.pseudo = msg.pseudo;

    for (const client of clients) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(msg));
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (ws.pseudo) {
      const drop = JSON.stringify({ type: 'disconnect', pseudo: ws.pseudo });
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) client.send(drop);
      }
    }
  });

  ws.on('error', () => clients.delete(ws));
});

// Démarrage
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
