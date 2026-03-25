// =============================================================================
//  SERVER.JS – Ulti-mates (relay WebSocket identique au pattern prof)
// =============================================================================

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.get('/controller', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'controller.html'));
});

const os = require('os');
app.get('/api/ip', (req, res) => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return res.json({ ip: iface.address, port: 3000 });
      }
    }
  }
  res.json({ ip: 'localhost', port: 3000 });
});

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`Client connecté. Total : ${clients.size}`);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    console.log(`type="${msg.type}" pseudo="${msg.pseudo || ''}"`);

    // Store the pseudo on the socket when they spawn
    if (msg.type === 'spawn' && msg.pseudo) {
      ws.pseudo = msg.pseudo;
    }

    for (const client of clients) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(msg));
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    // Broadcast disconnect message to all other clients
    if (ws.pseudo) {
      const dropMsg = JSON.stringify({ type: 'disconnect', pseudo: ws.pseudo });
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(dropMsg);
        }
      }
    }
    console.log(`Client déconnecté (${ws.pseudo || 'anonyme'}). Total : ${clients.size}`);
  });

  ws.on('error', (err) => {
    console.error('Erreur :', err.message);
    clients.delete(ws);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log('─────────────────────────────────────────');
  console.log(`Ulti-mates démarré sur http://localhost:${PORT}`);
  console.log(`Jeu (grand écran) : http://localhost:${PORT}/`);
  console.log(`Manette           : http://localhost:${PORT}/controller`);
  console.log('─────────────────────────────────────────');
});
