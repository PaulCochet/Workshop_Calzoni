const WebSocket = require('ws');

const wsGame = new WebSocket('ws://localhost:3000');
const wsCtrl = new WebSocket('ws://localhost:3000');

wsGame.on('open', () => {
  console.log('Game connected');
});

wsGame.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log('Game received:', msg);
  if (msg.type === 'spawn') {
    wsGame.send(JSON.stringify({ type: 'lobbyState', players: [{pseudo: msg.pseudo, team: msg.team}] }));
  }
});

wsCtrl.on('open', () => {
  console.log('Controller connected');
  setTimeout(() => {
    console.log('Controller sending spawn...');
    wsCtrl.send(JSON.stringify({ type: 'spawn', pseudo: 'testUser', team: 'A', isHost: false }));
  }, 500);
});

wsCtrl.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log('Controller received:', msg);
  process.exit(0);
});

setTimeout(() => {
  console.log('Timeout');
  process.exit(1);
}, 2000);
