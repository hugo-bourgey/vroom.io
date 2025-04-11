// Serveur WebSocket pour jeu de course multijoueur
const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');

// Configuration de l'application
const app = express();
const PORT = process.env.PORT || 3000;

console.log(`Tentative de démarrage du serveur sur le port ${PORT}...`);

// Ajouter plus de logs pour Express
app.use((req, res, next) => {
    console.log(`Requête HTTP reçue: ${req.method} ${req.url}`);
    next();
});

// Servir les fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

// Route de base pour tester si Express fonctionne
app.get('/', (req, res) => {
    console.log('Route racine appelée');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route pour tester si le serveur est en vie
app.get('/api/health', (req, res) => {
    console.log('Vérification de santé appelée');
    res.json({ status: 'ok', message: 'Server is running' });
});

// Créer le serveur HTTP
const server = http.createServer(app);

// Créer le serveur WebSocket
const wss = new WebSocket.Server({ server });
console.log('Serveur WebSocket créé');

// Variables du jeu
let players = {};
let gameState = {
    status: 'waiting', // 'waiting', 'starting', 'racing', 'finished'
    countdown: 3,
    winner: null,
    raceStartTime: null
};

// Compteur pour identifier les joueurs
let playerIdCounter = 1;

// Couleurs pour les voitures
const carColors = ['red', 'blue', 'green', 'purple', 'orange', 'cyan'];

// Gérer les connexions WebSocket
wss.on('connection', (ws) => {
    // Générer un ID unique pour ce joueur
    const playerId = `player_${playerIdCounter++}`;

    console.log(`Nouvelle connexion WebSocket: ${playerId}`);

    // Configurer la connexion WebSocket pour ce joueur
    ws.playerId = playerId;
    ws.isAlive = true;

    // Gérer les messages du client
    ws.on('message', (message) => {
        console.log(`Message reçu de ${playerId}: ${message}`);
        try {
            const data = JSON.parse(message);
            handleMessage(ws, data);
        } catch (error) {
            console.error('Erreur dans le traitement du message:', error);
        }
    });

    // Gérer la déconnexion
    ws.on('close', () => {
        console.log(`Joueur déconnecté: ${playerId}`);

        // Supprimer le joueur de la liste
        if (players[playerId]) {
            delete players[playerId];

            // Informer tous les clients de la déconnexion
            broadcastPlayersList();

            // Vérifier s'il faut annuler la course s'il n'y a pas assez de joueurs
            checkGameState();
        }
    });

    // Pong pour vérifier si la connexion est active
    ws.on('pong', () => {
        ws.isAlive = true;
    });
});

// Vérifier périodiquement les connexions actives
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping(() => { });
    });
}, 30000);

// Nettoyer l'intervalle quand le serveur se ferme
wss.on('close', () => {
    clearInterval(interval);
});

// Gérer les différents types de messages
function handleMessage(ws, data) {
    const { type, payload } = data;
    console.log(`Traitement de message de type "${type}"`, payload);

    switch (type) {
        case 'join':
            handlePlayerJoin(ws, payload);
            break;
        case 'accelerate':
            handlePlayerAccelerate(ws.playerId);
            break;
        case 'restart':
            handleGameRestart(ws.playerId);
            break;
        case 'startRace':
            handleManualStart();
            break;
        default:
            console.warn(`Type de message inconnu: ${type}`);
    }
}

function handleManualStart() {
    // Ne démarre que si on est à l'état "waiting"
    if (gameState.status !== 'waiting') return;

    console.log('Course lancée manuellement par un joueur');
    startCountdown(); // même fonction que l’auto-lancement
}


// Gérer l'arrivée d'un nouveau joueur
function handlePlayerJoin(ws, payload) {
    const { name } = payload;
    const playerId = ws.playerId;

    console.log(`Le joueur ${playerId} rejoint avec le nom "${name}"`);

    // Ajouter le joueur à la liste
    const colorIndex = Object.keys(players).length % carColors.length;

    players[playerId] = {
        id: playerId,
        name: name || `Joueur ${playerId.split('_')[1]}`,
        progress: 0,
        color: carColors[colorIndex],
        socket: ws
    };

    // Envoyer l'ID du joueur et la liste des joueurs
    sendToClient(ws, 'joined', {
        playerId,
        playerName: players[playerId].name,
        gameState
    });

    // Informer tous les clients de la mise à jour de la liste des joueurs
    broadcastPlayersList();

    // Vérifier s'il faut démarrer la course
    checkGameState();
}

// Gérer l'accélération d'un joueur
function handlePlayerAccelerate(playerId) {
    // Vérifier si la course est en cours
    if (gameState.status !== 'racing' || !players[playerId]) return;

    // Augmenter la progression du joueur
    players[playerId].progress += 5;
    console.log(`Le joueur ${playerId} accélère à ${players[playerId].progress}%`);

    // Vérifier si le joueur a gagné
    if (players[playerId].progress >= 100) {
        players[playerId].progress = 100;
        gameState.status = 'finished';
        gameState.winner = playerId;

        console.log(`Le joueur ${playerId} a gagné la course!`);

        // Annoncer le gagnant
        broadcastGameState();
    } else {
        // Informer tous les clients de la nouvelle progression
        broadcastPlayerProgress(playerId);
    }
}

// Gérer la demande de redémarrage du jeu
function handleGameRestart(playerId) {
    // Vérifier si le jeu est terminé
    if (gameState.status !== 'finished') return;

    console.log(`Le joueur ${playerId} a demandé un redémarrage`);

    // Réinitialiser l'état du jeu
    gameState.status = 'waiting';
    gameState.winner = null;
    gameState.countdown = 3;

    // Réinitialiser la progression de tous les joueurs
    Object.keys(players).forEach(id => {
        players[id].progress = 0;
    });

    // Informer tous les clients du redémarrage
    broadcastGameState();
    broadcastPlayersList();

    // Vérifier s'il faut démarrer une nouvelle course
    checkGameState();
}

// Vérifier l'état du jeu et démarrer la course si nécessaire
function checkGameState() {
    const playerCount = Object.keys(players).length;

    console.log(`Vérification de l'état - ${playerCount} joueurs, statut: ${gameState.status}`);

    // S'il n'y a pas assez de joueurs, attendre
    if (playerCount < 1) {
        gameState.status = 'waiting';
        broadcastGameState();
        return;
    }

    // S'il y a suffisamment de joueurs et que le jeu est en attente, démarrer le compte à rebours
    // if (playerCount >= 1 && gameState.status === 'waiting') {
    //     startCountdown();
    // }
}

// Démarrer le compte à rebours avant la course
function startCountdown() {
    console.log('Démarrage du compte à rebours');

    gameState.status = 'starting';
    gameState.countdown = 3;

    broadcastGameState();

    // Compte à rebours
    const countdownInterval = setInterval(() => {
        gameState.countdown -= 1;

        console.log(`Compte à rebours: ${gameState.countdown}`);

        broadcastGameState();

        if (gameState.countdown <= 0) {
            clearInterval(countdownInterval);
            startRace();
        }
    }, 1000);
}

// Démarrer la course
function startRace() {
    console.log('La course commence!');

    gameState.status = 'racing';
    gameState.raceStartTime = Date.now();

    broadcastGameState();
}

// Envoyer un message à un client spécifique
function sendToClient(ws, type, payload) {
    if (ws.readyState === WebSocket.OPEN) {
        const message = JSON.stringify({ type, payload });
        console.log(`Envoi au client ${ws.playerId}: ${type}`);
        ws.send(message);
    }
}

// Diffuser à tous les clients connectés
function broadcast(type, payload) {
    console.log(`Diffusion à tous les clients: ${type}`);

    let clientCount = 0;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type, payload }));
            clientCount++;
        }
    });

    console.log(`Message diffusé à ${clientCount} clients`);
}

// Diffuser la liste des joueurs à tous les clients
function broadcastPlayersList() {
    // Créer une liste de joueurs sans la propriété socket
    const playersList = {};
    Object.keys(players).forEach(id => {
        const { name, progress, color } = players[id];
        playersList[id] = { id, name, progress, color };
    });

    broadcast('playersList', playersList);
}

// Diffuser la progression d'un joueur spécifique
function broadcastPlayerProgress(playerId) {
    if (!players[playerId]) return;

    const { id, progress } = players[playerId];
    broadcast('playerProgress', { id, progress });
}

// Diffuser l'état du jeu à tous les clients
function broadcastGameState() {
    // Créer une copie de l'état du jeu pour la diffusion
    const stateCopy = { ...gameState };

    // Si un gagnant est défini, inclure son nom
    if (stateCopy.winner && players[stateCopy.winner]) {
        stateCopy.winnerName = players[stateCopy.winner].name;
    }

    broadcast('gameState', stateCopy);
}

// Démarrer le serveur
server.listen(PORT, () => {
    console.log(`✅ Serveur démarré avec succès sur le port ${PORT}`);
    console.log(`- Interface web disponible à http://localhost:${PORT}`);
    console.log(`- WebSocket disponible à ws://localhost:${PORT}`);
});

// Gérer les erreurs de démarrage du serveur
server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`❌ ERREUR: Le port ${PORT} est déjà utilisé par une autre application.`);
        console.log('Essayez de changer le port dans le code ou de fermer l\'application qui utilise ce port.');
    } else {
        console.error('❌ ERREUR lors du démarrage du serveur:', error);
    }
});