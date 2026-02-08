const express = require('express');
const { Server } = require('socket.io');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const Filter = require('bad-words');
const { RateLimiterMemory } = require('rate-limiter-flexible');

const app = express();
const PORT = process.env.PORT || 3000;
const filter = new Filter();

app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const rateLimiter = new RateLimiterMemory({
    points: 15,
    duration: 1,
});

const server = app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════╗
║   📚 KERNE - SERVEUR ACTIF                        ║
║   📡 Port: ${PORT}                                ║
║   🌐 Local: http://localhost:${PORT}              ║
║   🎯 Salles mélangées (4 personnes max)           ║
╚═══════════════════════════════════════════════════╝
  `);
});

const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000,
    upgradeTimeout: 10000,
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    perMessageDeflate: {
        threshold: 1024
    },
    maxHttpBufferSize: 1e8,
    connectTimeout: 45000
});

const rooms = new Map();
const bannedUsers = new Map();
const userReports = new Map();
const MAX_ROOM_SIZE = 4;

function validateName(name) {
    name = name.trim();

    if (name.length < 2 || name.length > 20) {
        return { valid: false, reason: 'Le nom doit faire entre 2 et 20 caractères' };
    }

    if (!/^[a-zA-ZÀ-ÿ0-9\s\-_]+$/.test(name)) {
        return { valid: false, reason: 'Caractères non autorisés dans le nom' };
    }

    if (filter.isProfane(name.toLowerCase())) {
        return { valid: false, reason: 'Ce nom contient des mots inappropriés' };
    }

    const trollPatterns = [
        { regex: /(.)\1{4,}/, msg: 'Ce nom semble invalide (trop de répétitions)' },
        { regex: /^(test|admin|mod|bot|fake|user|guest|troll)\d*$/i, msg: 'Utilise ton vrai prénom ou un vrai pseudo' },
        { regex: /^[0-9]+$/, msg: 'Ton nom ne peut pas être que des chiffres' },
        { regex: /^[^a-zA-Z]+$/, msg: 'Ton nom doit contenir au moins une lettre' },
        { regex: /^(a+|b+|x+|z+|e+)$/i, msg: 'Ce nom semble invalide' },
        { regex: /^(lol|mdr|xd|wtf|omg|bruh)+$/i, msg: 'Utilise un vrai prénom ou pseudo' },
        { regex: /^\s+|\s+$/g, msg: 'Pas d\'espaces au début ou fin' },
        { regex: /^(qwerty|azerty|1234|abcd)+$/i, msg: 'Ce nom semble invalide' }
    ];

    for (const pattern of trollPatterns) {
        if (pattern.regex.test(name)) {
            return { valid: false, reason: pattern.msg };
        }
    }

    return { valid: true };
}

function isUserBanned(userId) {
    const banInfo = bannedUsers.get(userId);
    if (!banInfo) return false;

    const now = Date.now();
    if (now < banInfo.until) {
        return true;
    }

    bannedUsers.delete(userId);
    return false;
}

function banUser(userId, reason) {
    const until = Date.now() + (3 * 24 * 60 * 60 * 1000); // 3 jours
    bannedUsers.set(userId, {
        reason,
        until,
        bannedAt: new Date()
    });

    console.log(`🚫 User ${userId} banni jusqu'à ${new Date(until).toLocaleString()}`);
}

function reportUser(roomId, reportedUserId, reporterUserId) {
    const room = rooms.get(roomId);
    if (!room) return { success: false, reason: 'Room non trouvée' };

    if (!userReports.has(reportedUserId)) {
        userReports.set(reportedUserId, []);
    }

    const reports = userReports.get(reportedUserId);
    const now = Date.now();
    const FIVE_MINUTES = 5 * 60 * 1000;

    const recentReports = reports.filter(r => now - r.timestamp < FIVE_MINUTES);

    if (recentReports.some(r => r.reporterId === reporterUserId)) {
        return { success: false, reason: 'Vous avez déjà signalé cet utilisateur' };
    }

    recentReports.push({
        reporterId: reporterUserId,
        timestamp: now,
        roomId
    });

    userReports.set(reportedUserId, recentReports);

    console.log(`⚠️  Report: ${reportedUserId} (${recentReports.length}/3 en 5min)`);

    if (recentReports.length >= 3) {
        return {
            success: true,
            action: 'kick',
            message: '3 signalements reçus - expulsion automatique'
        };
    }

    return {
        success: true,
        action: 'reported',
        count: recentReports.length
    };
}

function findOrCreateRoom() {
    for (const [roomId, room] of rooms.entries()) {
        if (room.users.length < MAX_ROOM_SIZE) {
            return roomId;
        }
    }

    const newRoomId = `room-mixed-${Date.now()}`;
    rooms.set(newRoomId, {
        users: [],
        createdAt: new Date(),
        lastActivity: new Date(),
        kickedUsers: new Set(),
        userStates: new Map()
    });

    console.log(`🏗️  Room créée: ${newRoomId} (Salle mélangée)`);
    return newRoomId;
}

io.on('connection', (socket) => {
    console.log(`✅ Connexion: ${socket.id}`);

    let currentRoom = null;
    let userData = null;

    socket.on('join-room', ({ name, level, peerId, userId }) => {
        if (!name || !level || !peerId) {
            socket.emit('error', { message: 'Données manquantes' });
            return;
        }

        const idToTest = userId || socket.id;

        if (isUserBanned(idToTest)) {
            const banInfo = bannedUsers.get(idToTest);
            const timeLeft = Math.ceil((banInfo.until - Date.now()) / (60 * 60 * 1000));
            socket.emit('banned', {
                message: `Tu es banni pour ${timeLeft}h. Raison: ${banInfo.reason}`,
                until: banInfo.until
            });
            return;
        }

        const nameValidation = validateName(name);
        if (!nameValidation.valid) {
            socket.emit('name-invalid', { message: nameValidation.reason });
            return;
        }

        const roomId = findOrCreateRoom();
        const room = rooms.get(roomId);

        if (room.kickedUsers.has(idToTest)) {
            socket.emit('error', { message: 'Tu as été expulsé de cette salle' });
            return;
        }

        userData = {
            socketId: socket.id,
            userId: idToTest,
            peerId: socket.id,
            name: name,
            level: level,
            joinedAt: new Date(),
            kickCount: 0
        };

        room.users.push(userData);
        room.lastActivity = new Date();
        currentRoom = roomId;

        socket.join(roomId);

        console.log(`👤 ${name} (${level}) → ${roomId} (${room.users.length}/${MAX_ROOM_SIZE})`);

        room.userStates.set(socket.id, { cam: true });

        socket.emit('room-joined', {
            roomId,
            users: room.users,
            yourPeerId: socket.id,
            userStates: Array.from(room.userStates.entries()).map(([pId, state]) => ({ peerId: pId, state }))
        });

        socket.to(roomId).emit('user-joined', userData);
    });

    // SimplePeer signaling
    socket.on('signal', ({ to, signal }) => {
        io.to(to).emit('signal', {
            from: socket.id,
            signal: signal
        });
    });

    socket.on('report-user', ({ roomId, reportedUserId }) => {
        if (!currentRoom || currentRoom !== roomId || !userData) return;

        const result = reportUser(roomId, reportedUserId, userData.userId);

        if (result.success && result.action === 'kick') {
            const room = rooms.get(roomId);
            const reportedUser = room.users.find(u => u.userId === reportedUserId);

            if (reportedUser) {
                reportedUser.kickCount = (reportedUser.kickCount || 0) + 1;

                if (reportedUser.kickCount >= 2) {
                    banUser(reportedUserId, 'Expulsé 2 fois pour comportement inapproprié');
                    io.to(reportedUser.socketId).emit('banned', {
                        message: 'Tu as été banni pour 3 jours suite à de multiples expulsions',
                        until: bannedUsers.get(reportedUserId).until
                    });
                } else {
                    io.to(reportedUser.socketId).emit('kicked', {
                        message: result.message,
                        isBanned: false
                    });
                }

                room.kickedUsers.add(reportedUserId);
                room.users = room.users.filter(u => u.userId !== reportedUserId);

                io.to(roomId).emit('user-kicked', {
                    userId: reportedUserId,
                    socketId: reportedUser.socketId,
                    reason: 'Signalements multiples'
                });

                console.log(`🚫 ${reportedUser.name} expulsé de ${roomId} (kick #${reportedUser.kickCount})`);
            }
        }
        socket.emit('report-result', result);
    });

    socket.on('chat-message', async ({ roomId, message }) => {
        if (!currentRoom || currentRoom !== roomId || !userData) return;

        try {
            await rateLimiter.consume(socket.id);
        } catch (err) {
            socket.emit('rate-limited', { message: 'Trop de messages, ralentis !' });
            return;
        }

        const cleanMessage = filter.clean(message);

        io.to(roomId).emit('chat-message', {
            from: userData.name,
            userId: userData.userId,
            message: cleanMessage,
            timestamp: Date.now()
        });

        const room = rooms.get(roomId);
        if (room) room.lastActivity = new Date();
    });

    socket.on('state-change', ({ roomId, peerId, state }) => {
        if (!currentRoom || currentRoom !== roomId || !userData) return;

        const room = rooms.get(roomId);
        if (room) {
            const currentState = room.userStates.get(socket.id) || { cam: true };
            room.userStates.set(socket.id, { ...currentState, ...state });
        }

        io.to(roomId).emit('state-change', {
            peerId: socket.id,
            state: state
        });
    });

    socket.on('disconnect', () => {
        console.log(`❌ Déconnexion: ${socket.id}`);

        if (!currentRoom) return;

        const room = rooms.get(currentRoom);
        if (!room) return;

        room.users = room.users.filter(u => u.socketId !== socket.id);
        room.userStates.delete(socket.id);

        socket.to(currentRoom).emit('user-left', {
            socketId: socket.id,
            peerId: socket.id,
            userId: userData?.userId
        });

        if (room.users.length === 0) {
            setTimeout(() => {
                const roomCheck = rooms.get(currentRoom);
                if (roomCheck && roomCheck.users.length === 0) {
                    rooms.delete(currentRoom);
                    console.log(`🗑️  Room supprimée: ${currentRoom}`);
                }
            }, 5 * 60 * 1000);
        }
    });
});

app.get('/api/stats', (req, res) => {
    const allRooms = [...rooms.entries()];
    res.json({
        totalRooms: allRooms.length,
        totalUsers: allRooms.reduce((sum, [, room]) => sum + room.users.length, 0),
        bannedUsers: bannedUsers.size,
        rooms: allRooms.map(([id, room]) => ({
            id,
            users: room.users.length,
            createdAt: room.createdAt
        }))
    });
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        rooms: rooms.size,
        bannedUsers: bannedUsers.size
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Nettoyage régulier (toutes les heures)
setInterval(() => {
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;

    for (const [roomId, room] of rooms.entries()) {
        if (now - room.lastActivity.getTime() > ONE_HOUR && room.users.length === 0) {
            rooms.delete(roomId);
            console.log(`🧹 Nettoyage room: ${roomId}`);
        }
    }

    for (const [userId, reports] of userReports.entries()) {
        const recentReports = reports.filter(r => now - r.timestamp < 5 * 60 * 1000);
        if (recentReports.length === 0) {
            userReports.delete(userId);
        } else {
            userReports.set(userId, recentReports);
        }
    }

    for (const [userId, banInfo] of bannedUsers.entries()) {
        if (now >= banInfo.until) {
            bannedUsers.delete(userId);
            console.log(`✅ Ban expiré: ${userId}`);
        }
    }
}, 60 * 60 * 1000);

const shutdown = () => {
    console.log('⚠️  Fermeture du serveur...');
    server.close(() => {
        console.log('✅ Serveur fermé');
        process.exit(0);
    });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);