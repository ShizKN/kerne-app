class SignalingSocket {
    constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.pending = new Map();
        this.ws = null;
        this.id = null;
        this.connected = false;
        this.manual = false;
        this.retry = 0;
        this.retryTimer = null;
    }

    on(event, handler) {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event).add(handler);
        return this;
    }

    notify(event, data) {
        for (const handler of this.listeners.get(event) || []) handler(data);
    }

    connect() {
        if (this.ws && this.ws.readyState <= WebSocket.OPEN) return this;
        this.manual = false;
        clearTimeout(this.retryTimer);
        const ws = new WebSocket(this.url);
        this.ws = ws;
        ws.onmessage = ({ data }) => {
            let message;
            try { message = JSON.parse(data); } catch (_) { return; }
            if (message.event === 'connected') {
                this.id = message.data?.socketId;
                this.connected = true;
                this.retry = 0;
                this.notify('connect');
            } else if (message.event === 'ack') {
                const pending = this.pending.get(message.id);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pending.delete(message.id);
                    pending.callback(null, message.data);
                }
            } else this.notify(message.event, message.data);
        };
        ws.onclose = () => {
            if (this.ws !== ws) return;
            this.ws = null;
            this.dropConnection();
            if (!this.manual) {
                const delay = Math.min(1000 * 2 ** this.retry++, 10000);
                this.retryTimer = setTimeout(() => this.connect(), delay);
            }
        };
        ws.onerror = () => {};
        return this;
    }

    dropConnection() {
        if (this.connected) {
            this.connected = false;
            this.id = null;
            this.notify('disconnect');
        }
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.callback(new Error('Connexion interrompue'));
            this.pending.delete(id);
        }
    }

    emit(event, data) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ event, data }));
        return this;
    }

    timeout(ms) {
        return { emit: (event, callback) => {
            if (this.ws?.readyState !== WebSocket.OPEN) return callback(new Error('Hors ligne'));
            const id = crypto.randomUUID();
            const timer = setTimeout(() => {
                this.pending.delete(id);
                callback(new Error('Délai dépassé'));
            }, ms);
            this.pending.set(id, { callback, timer });
            this.ws.send(JSON.stringify({ event, id }));
        } };
    }

    disconnect() {
        this.manual = true;
        clearTimeout(this.retryTimer);
        const ws = this.ws;
        this.ws = null;
        this.dropConnection();
        if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, 'Reconnexion');
        return this;
    }
}
