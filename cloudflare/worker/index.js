import { DurableObject } from 'cloudflare:workers';

const MAX_ROOM_SIZE = 4;
const LEVELS = new Set(['Collège', 'Lycée', 'Prépa', 'Licence', 'Master', 'Doctorat']);
const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }];

function send(ws, event, data, id) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ event, data, ...(id ? { id } : {}) })); } catch (_) {}
}

function isAllowedOrigin(origin) {
    if (!origin) return false;
    try {
        const url = new URL(origin);
        return url.hostname === 'kerne.apospace.com' ||
            url.hostname === 'kernee.pages.dev' ||
            url.hostname.endsWith('.kernee.pages.dev') ||
            (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.protocol === 'http:';
    } catch (_) { return false; }
}

export class KerneRooms extends DurableObject {
    async fetch(request) {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
            return new Response('WebSocket requis', { status: 426 });
        }
        const [client, server] = Object.values(new WebSocketPair());
        const socketId = crypto.randomUUID();
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ socketId, roomId: null, ip: request.headers.get('CF-Connecting-IP') || 'unknown' });
        send(server, 'connected', { socketId });
        return new Response(null, { status: 101, webSocket: client });
    }

    sockets(roomId) {
        return this.ctx.getWebSockets().filter(ws =>
            ws.readyState === WebSocket.OPEN && ws.deserializeAttachment()?.roomId === roomId
        );
    }

    broadcast(roomId, event, data, except) {
        for (const ws of this.sockets(roomId)) if (ws !== except) send(ws, event, data);
    }

    async webSocketMessage(ws, raw) {
        if (typeof raw !== 'string' || raw.length > 1_000_000) return;
        let message;
        try { message = JSON.parse(raw); } catch (_) { return; }
        const { event, data = {}, id } = message || {};
        const state = ws.deserializeAttachment();
        if (!state || typeof event !== 'string') return;

        if (event === 'join-room') {
            if (state.roomId) return;
            const { name, level, privateRoomCode } = data || {};
            if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 20 ||
                !/^[a-zA-ZÀ-ÿ0-9\s\-_]+$/.test(name) || !LEVELS.has(level)) {
                send(ws, 'error', { message: 'Nom ou niveau invalide' });
                return;
            }
            if (privateRoomCode && !/^\d{6}$/.test(privateRoomCode)) {
                send(ws, 'error', { message: 'Code de salle invalide' });
                return;
            }
            let roomId;
            if (privateRoomCode) roomId = `private-${privateRoomCode}`;
            else {
                const counts = new Map();
                for (const peer of this.ctx.getWebSockets()) {
                    const peerRoom = peer.deserializeAttachment()?.roomId;
                    if (peer.readyState === WebSocket.OPEN && peerRoom?.startsWith('public-')) counts.set(peerRoom, (counts.get(peerRoom) || 0) + 1);
                }
                roomId = [...counts].find(([, count]) => count < MAX_ROOM_SIZE)?.[0] || `public-${crypto.randomUUID()}`;
            }
            const existing = this.sockets(roomId);
            if (existing.length >= MAX_ROOM_SIZE) {
                send(ws, 'error', { message: 'La salle est pleine' });
                return;
            }
            const user = {
                socketId: state.socketId, peerId: state.socketId,
                userId: typeof data.userId === 'string' ? data.userId.slice(0, 80) : state.socketId,
                name: name.trim(), level, joinedAt: Date.now()
            };
            ws.serializeAttachment({ ...state, ...user, roomId, mediaState: { cam: true } });
            const users = [...existing, ws].map(peer => {
                const p = peer.deserializeAttachment();
                return { socketId: p.socketId, peerId: p.socketId, userId: p.userId, name: p.name, level: p.level, joinedAt: p.joinedAt };
            });
            const userStates = [...existing, ws].map(peer => {
                const p = peer.deserializeAttachment();
                return { peerId: p.socketId, state: p.mediaState || {} };
            });
            const screenShares = existing.map(peer => peer.deserializeAttachment()).filter(p => p.screenStreamId)
                .map(p => ({ peerId: p.socketId, streamId: p.screenStreamId }));
            send(ws, 'room-joined', { roomId, users, yourPeerId: state.socketId, userStates, screenShares });
            this.broadcast(roomId, 'user-joined', user, ws);
            return;
        }

        if (!state.roomId) return;
        if (event === 'request-ice-servers') {
            const ice = await this.iceServers(ws, state);
            send(ws, 'ack', ice, id);
            return;
        }
        if (event === 'signal') {
            const target = this.sockets(state.roomId).find(peer => peer.deserializeAttachment()?.socketId === data?.to);
            if (target && data?.signal) send(target, 'signal', { from: state.socketId, signal: data.signal });
            return;
        }
        if (event === 'chat-message') {
            if (data.roomId !== state.roomId || typeof data.message !== 'string') return;
            const text = data.message.trim().slice(0, 1000);
            if (text) this.broadcast(state.roomId, 'chat-message', {
                from: state.name, userId: state.userId, message: text, timestamp: Date.now()
            });
            return;
        }
        if (event === 'state-change') {
            if (data.roomId !== state.roomId || !data.state || typeof data.state !== 'object') return;
            const mediaState = { ...state.mediaState };
            for (const key of ['cam', 'mic', 'sound']) if (typeof data.state[key] === 'boolean') mediaState[key] = data.state[key];
            ws.serializeAttachment({ ...state, mediaState });
            this.broadcast(state.roomId, 'state-change', { peerId: state.socketId, state: mediaState });
            return;
        }
        if (event === 'screen-share-started' && typeof data?.streamId === 'string' && data.streamId.length <= 120) {
            if (this.sockets(state.roomId).some(peer => peer !== ws && peer.deserializeAttachment()?.screenStreamId)) {
                send(ws, 'screen-share-denied', { message: 'Un écran est déjà partagé dans cette salle' });
                return;
            }
            ws.serializeAttachment({ ...state, screenStreamId: data.streamId });
            this.broadcast(state.roomId, 'screen-share-started', { peerId: state.socketId, streamId: data.streamId }, ws);
            return;
        }
        if (event === 'screen-share-stopped') {
            ws.serializeAttachment({ ...state, screenStreamId: null });
            this.broadcast(state.roomId, 'screen-share-stopped', { peerId: state.socketId }, ws);
            return;
        }
        if (event.startsWith('wb-') && data?.roomId === state.roomId) {
            const key = `boards:${state.roomId}`;
            const boards = (await this.ctx.storage.get(key)) || [];
            if (event === 'wb-get-state') {
                send(ws, 'wb-send-state', { boards });
                return;
            }
            if (event === 'wb-create') {
                if (boards.length >= 20 || typeof data.id !== 'string' || boards.some(b => b.id === data.id)) return;
                const board = { id: data.id.slice(0, 80), name: String(data.name || 'Tableau').slice(0, 80), owner: state.name, data: [] };
                boards.push(board);
                await this.ctx.storage.put(key, boards);
                this.broadcast(state.roomId, 'wb-create', board, ws);
                return;
            }
            const board = boards.find(b => b.id === data.boardId);
            if (!board) return;
            if (event === 'wb-draw' && data.data && board.data.length < 2000) {
                board.data.push(data.data);
                await this.ctx.storage.put(key, boards);
                this.broadcast(state.roomId, 'wb-draw', { boardId: board.id, data: data.data }, ws);
            } else if (event === 'wb-undo-redo' && Array.isArray(data.data) && data.data.length <= 2000) {
                board.data = data.data;
                await this.ctx.storage.put(key, boards);
                this.broadcast(state.roomId, 'wb-undo-redo', { boardId: board.id, data: board.data }, ws);
            } else if (event === 'wb-delete') {
                await this.ctx.storage.put(key, boards.filter(b => b.id !== board.id));
                this.broadcast(state.roomId, 'wb-delete', board.id, ws);
            }
        }
    }

    async iceServers(ws, state) {
        const now = Date.now();
        if (state.cachedIce && state.iceExpiresAt > now) return state.cachedIce;
        let result = { iceServers: STUN, turnEnabled: false };
        if (this.env.TURN_KEY_ID && this.env.TURN_KEY_API_TOKEN) {
            try {
                const response = await fetch(
                    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
                    { method: 'POST', headers: {
                        Authorization: `Bearer ${this.env.TURN_KEY_API_TOKEN}`,
                        'Content-Type': 'application/json'
                    }, body: JSON.stringify({ ttl: 7200 }), signal: AbortSignal.timeout(7000) }
                );
                if (!response.ok) throw new Error(`TURN HTTP ${response.status}`);
                const body = await response.json();
                if (!Array.isArray(body.iceServers)) throw new Error('Réponse TURN invalide');
                result = { iceServers: body.iceServers, turnEnabled: true };
            } catch (error) { console.error('Cloudflare TURN indisponible', error.message); }
        }
        ws.serializeAttachment({ ...state, cachedIce: result, iceExpiresAt: now + 60 * 60 * 1000 });
        return result;
    }

    async webSocketClose(ws, code, reason) {
        const state = ws.deserializeAttachment();
        if (state?.roomId) {
            this.broadcast(state.roomId, 'user-left', {
                socketId: state.socketId, peerId: state.socketId, userId: state.userId
            }, ws);
            if (!this.sockets(state.roomId).some(peer => peer !== ws)) {
                await this.ctx.storage.delete(`boards:${state.roomId}`);
            }
        }
        try { ws.close(code, reason); } catch (_) {}
    }

    async webSocketError(ws) {
        await this.webSocketClose(ws, 1011, 'Connexion interrompue');
    }
}

export default {
    async fetch(request, env) {
        const path = new URL(request.url).pathname;
        if (path === '/health') return Response.json({ status: 'ok', service: 'kerne-rooms' });
        if (path !== '/ws' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Not found', { status: 404 });
        if (!isAllowedOrigin(request.headers.get('Origin'))) return new Response('Origin interdit', { status: 403 });
        return env.ROOMS.get(env.ROOMS.idFromName('kerne-global')).fetch(request);
    }
};
