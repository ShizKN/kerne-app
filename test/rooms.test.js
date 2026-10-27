const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const fs = require('node:fs');
const vm = require('node:vm');
const { io } = require('socket.io-client');

function nextEvent(socket, event, ms = 2000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`Timeout: ${event}`)); }, ms);
        function handler(data) { clearTimeout(timer); resolve(data); }
        socket.once(event, handler);
    });
}

async function freePort() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

test('les scripts des pages sont valides', () => {
    for (const file of ['public/index.html', 'public/room.html']) {
        const html = fs.readFileSync(file, 'utf8');
        const scripts = [...html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)];
        assert.ok(scripts.length, `script absent : ${file}`);
        scripts.forEach((match, index) => new vm.Script(match[1], { filename: `${file}:${index}` }));
        assert.ok(!html.includes('give-freely-root'), 'Extension de navigateur restée dans la page');
    }
});

test('salles privées, signalisation, chat, tableau et reconnexion', async () => {
    const port = await freePort();
    const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
    const sockets = [];
    const url = `http://127.0.0.1:${port}`;
    try {
        for (let i = 0; i < 40; i++) {
            try { if ((await fetch(`${url}/api/health`)).ok) break; } catch (_) {}
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal((await fetch(`${url}/api/health`)).status, 200);
        assert.equal((await fetch(`${url}/vendor/simplepeer.min.js`)).status, 200);
        assert.equal((await fetch(`${url}/socket.io/socket.io.js`)).status, 200);
        assert.equal((await fetch(`${url}/manifest.json`)).status, 200);
        assert.equal((await fetch(`${url}/sw.js`)).status, 200);

        async function join(name, code) {
            const socket = io(url, { transports: ['websocket'], autoConnect: false, reconnection: false });
            sockets.push(socket);
            const connected = nextEvent(socket, 'connect');
            socket.connect();
            await connected;
            const joined = nextEvent(socket, 'room-joined');
            socket.emit('join-room', { name, level: 'Lycée', peerId: socket.id, userId: `id-${name}`, privateRoomCode: code });
            return { socket, room: await joined };
        }

        const a = await join('Alice', '837491');
        const aSeesB = nextEvent(a.socket, 'user-joined');
        const b = await join('Bruno', '837491');
        assert.equal((await aSeesB).name, 'Bruno');
        assert.equal(a.room.roomId, b.room.roomId);
        assert.equal(b.room.users.length, 2);
        const c = await join('Chloe', '111111');
        assert.notEqual(c.room.roomId, a.room.roomId);
        const d = await join('David');
        assert.ok(d.room.roomId.startsWith('room-mixed-'));

        const signal = nextEvent(b.socket, 'signal');
        a.socket.emit('signal', { to: b.socket.id, signal: { test: 1 } });
        assert.equal((await signal).signal.test, 1);
        let leaked = false;
        c.socket.once('signal', () => { leaked = true; });
        a.socket.emit('signal', { to: c.socket.id, signal: { test: 2 } });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(leaked, false);

        const chat = nextEvent(b.socket, 'chat-message');
        a.socket.emit('chat-message', { roomId: a.room.roomId, message: 'Bonjour' });
        assert.equal((await chat).message, 'Bonjour');
        const board = nextEvent(b.socket, 'wb-create');
        a.socket.emit('wb-create', { roomId: a.room.roomId, id: 'board-1', name: 'Notes', data: [] });
        assert.equal((await board).id, 'board-1');

        const ice = await new Promise((resolve, reject) => {
            a.socket.timeout(2000).emit('request-ice-servers', (error, response) => error ? reject(error) : resolve(response));
        });
        assert.equal(ice.turnEnabled, false);
        assert.ok(ice.iceServers[0].urls.startsWith('stun:'));

        const left = nextEvent(a.socket, 'user-left');
        const oldSocketId = b.socket.id;
        b.socket.disconnect();
        assert.equal((await left).socketId, oldSocketId);
        const rejoined = nextEvent(a.socket, 'user-joined');
        const b2 = await join('Bruno', '837491');
        assert.equal((await rejoined).name, 'Bruno');
        assert.equal(b2.room.users.length, 2);
        await join('Eva', '837491');
        await join('Farid', '837491');
        const full = io(url, { transports: ['websocket'], autoConnect: false, reconnection: false });
        sockets.push(full);
        const connected = nextEvent(full, 'connect');
        full.connect();
        await connected;
        const rejected = nextEvent(full, 'error');
        full.emit('join-room', { name: 'Gina', level: 'Lycée', peerId: full.id, privateRoomCode: '837491' });
        assert.match((await rejected).message, /pleine/);
    } finally {
        sockets.forEach(socket => socket.disconnect());
        server.kill();
        await once(server, 'exit');
    }
});
