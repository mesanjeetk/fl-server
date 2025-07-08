import { Server } from 'socket.io';
import { createServer } from 'http';
import rateLimit from 'express-rate-limit';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { job } from "./cron.js"

const app = express();
const httpServer = createServer(app);
job.start();
// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: ['*'],
  credentials: true
}));
app.set('trust proxy', 1);
// Rate limiting
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 15 minutes
  max: 100, 
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});

app.use(limiter);

// Socket.IO with enhanced security
const io = new Server(httpServer, {
  cors: {
    origin: ['*'],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  maxHttpBufferSize: 1e6, // 1MB
  allowEIO3: true
});

// Enhanced room and connection management
const rooms = new Map();
const userConnections = new Map(); // Track connections per IP
const roomLimits = {
  maxRooms: 1000,
  maxPlayersPerRoom: 2,
  maxRoomsPerIP: 5
};

// Connection tracking for DDOS protection
const connectionTracker = new Map();
const CONNECTION_LIMIT = 10; // Max connections per IP
const CONNECTION_WINDOW = 60000; // 1 minute

// Utility functions
function generateRoomId() {
  return Math.random().toString(36).substring(2, 9).toUpperCase();
}

function checkWin(board) {
  const winPatterns = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
    [0, 4, 8], [2, 4, 6] // diagonals
  ];

  for (const pattern of winPatterns) {
    const [a, b, c] = pattern;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], pattern };
    }
  }

  if (board.every(cell => cell !== null)) {
    return { winner: 'draw', pattern: null };
  }

  return null;
}

function validatePlayerName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length < 1 || name.length > 20) return false;
  if (!/^[a-zA-Z0-9\s_-]+$/.test(name)) return false;
  return true;
}

function validateRoomName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length < 1 || name.length > 30) return false;
  if (!/^[a-zA-Z0-9\s_-]+$/.test(name)) return false;
  return true;
}

function getClientIP(socket) {
  return socket.handshake.headers['x-forwarded-for'] || 
         socket.handshake.address || 
         socket.conn.remoteAddress;
}

function checkConnectionLimit(ip) {
  const now = Date.now();
  const connections = connectionTracker.get(ip) || [];
  
  // Remove old connections
  const recentConnections = connections.filter(time => now - time < CONNECTION_WINDOW);
  
  if (recentConnections.length >= CONNECTION_LIMIT) {
    return false;
  }
  
  recentConnections.push(now);
  connectionTracker.set(ip, recentConnections);
  return true;
}

function findOrCreatePublicRoom(playerName, socketId, ip) {
  // Check room limits per IP
  const userRooms = Array.from(rooms.values()).filter(room => 
    room.players.some(player => userConnections.get(player.id) === ip)
  );
  
  if (userRooms.length >= roomLimits.maxRoomsPerIP) {
    throw new Error('Too many rooms created from this IP');
  }

  // Look for available public room
  for (const [roomId, room] of rooms.entries()) {
    if (!room.isPrivate && room.players.length === 1) {
      // Check if player is not already in this room
      if (!room.players.some(p => p.id === socketId)) {
        room.players.push({ name: playerName, id: socketId, symbol: 'O' });
        room.currentPlayer = room.players[0].id;
        return roomId;
      }
    }
  }

  // Create new public room
  if (rooms.size >= roomLimits.maxRooms) {
    throw new Error('Server is at capacity. Please try again later.');
  }

  const roomId = generateRoomId();
  rooms.set(roomId, {
    id: roomId,
    name: 'Public Game',
    players: [{ name: playerName, id: socketId, symbol: 'X' }],
    board: Array(9).fill(null),
    currentPlayer: null,
    gameOver: false,
    winner: null,
    isPrivate: false,
    createdAt: Date.now(),
    lastActivity: Date.now()
  });

  return roomId;
}

function createPrivateRoom(roomName, playerName, socketId, ip) {
  // Validate inputs
  if (!validateRoomName(roomName)) {
    throw new Error('Invalid room name');
  }

  // Check room limits
  const userRooms = Array.from(rooms.values()).filter(room => 
    room.players.some(player => userConnections.get(player.id) === ip)
  );
  
  if (userRooms.length >= roomLimits.maxRoomsPerIP) {
    throw new Error('Too many rooms created from this IP');
  }

  if (rooms.size >= roomLimits.maxRooms) {
    throw new Error('Server is at capacity. Please try again later.');
  }

  const roomId = generateRoomId();
  rooms.set(roomId, {
    id: roomId,
    name: roomName,
    players: [{ name: playerName, id: socketId, symbol: 'X' }],
    board: Array(9).fill(null),
    currentPlayer: null,
    gameOver: false,
    winner: null,
    isPrivate: true,
    createdAt: Date.now(),
    lastActivity: Date.now()
  });

  return roomId;
}

function joinPrivateRoom(roomId, playerName, socketId) {
  const room = rooms.get(roomId);
  
  if (!room) {
    return { success: false, error: 'Room not found' };
  }

  if (room.players.length >= roomLimits.maxPlayersPerRoom) {
    return { success: false, error: 'Room is full' };
  }

  // Check if player is already in room
  if (room.players.some(p => p.id === socketId)) {
    return { success: false, error: 'Already in this room' };
  }

  room.players.push({ name: playerName, id: socketId, symbol: 'O' });
  room.currentPlayer = room.players[0].id;
  room.lastActivity = Date.now();

  return { success: true, roomId };
}

// Cleanup inactive rooms
setInterval(() => {
  const now = Date.now();
  const ROOM_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  for (const [roomId, room] of rooms.entries()) {
    if (now - room.lastActivity > ROOM_TIMEOUT) {
      rooms.delete(roomId);
      console.log(`Cleaned up inactive room: ${roomId}`);
    }
  }

  // Clean up old connection tracking data
  for (const [ip, connections] of connectionTracker.entries()) {
    const recentConnections = connections.filter(time => now - time < CONNECTION_WINDOW);
    if (recentConnections.length === 0) {
      connectionTracker.delete(ip);
    } else {
      connectionTracker.set(ip, recentConnections);
    }
  }
}, 5 * 60 * 1000); // Run every 5 minutes

// Socket connection handling
io.on('connection', (socket) => {
  const clientIP = getClientIP(socket);
  
  // Check connection limits
  if (!checkConnectionLimit(clientIP)) {
    console.log(`Connection limit exceeded for IP: ${clientIP}`);
    socket.emit('error', 'Too many connections from your IP. Please try again later.');
    socket.disconnect(true);
    return;
  }

  console.log(`User connected: ${socket.id} from ${clientIP}`);
  userConnections.set(socket.id, clientIP);

  // Rate limiting for socket events
  const eventLimiter = new Map();
  const EVENT_LIMIT = 10; // Max events per minute
  const EVENT_WINDOW = 60000; // 1 minute

  function checkEventLimit(eventType) {
    const now = Date.now();
    const key = `${socket.id}-${eventType}`;
    const events = eventLimiter.get(key) || [];
    
    const recentEvents = events.filter(time => now - time < EVENT_WINDOW);
    
    if (recentEvents.length >= EVENT_LIMIT) {
      return false;
    }
    
    recentEvents.push(now);
    eventLimiter.set(key, recentEvents);
    return true;
  }

  socket.on('join-public-game', ({ playerName }) => {
    if (!checkEventLimit('join-public-game')) {
      socket.emit('error', 'Too many requests. Please slow down.');
      return;
    }

    try {
      if (!validatePlayerName(playerName)) {
        socket.emit('error', 'Invalid player name');
        return;
      }

      const roomId = findOrCreatePublicRoom(playerName, socket.id, clientIP);
      const room = rooms.get(roomId);
      
      socket.join(roomId);
      socket.roomId = roomId;
      room.lastActivity = Date.now();

      if (room.players.length === 2) {
        io.to(roomId).emit('game-start', {
          room: {
            id: roomId,
            name: room.name,
            players: room.players,
            board: room.board,
            currentPlayer: room.currentPlayer,
            isPrivate: room.isPrivate
          }
        });
      } else {
        socket.emit('waiting-for-opponent', {
          room: {
            id: roomId,
            name: room.name,
            players: room.players,
            board: room.board,
            isPrivate: room.isPrivate
          }
        });
      }
    } catch (error) {
      socket.emit('error', error.message);
    }
  });

  socket.on('create-private-room', ({ roomName, playerName }) => {
    if (!checkEventLimit('create-private-room')) {
      socket.emit('error', 'Too many requests. Please slow down.');
      return;
    }

    try {
      if (!validatePlayerName(playerName)) {
        socket.emit('error', 'Invalid player name');
        return;
      }

      const roomId = createPrivateRoom(roomName, playerName, socket.id, clientIP);
      const room = rooms.get(roomId);
      
      socket.join(roomId);
      socket.roomId = roomId;

      socket.emit('room-created', {
        room: {
          id: roomId,
          name: room.name,
          players: room.players,
          board: room.board,
          isPrivate: room.isPrivate
        }
      });
    } catch (error) {
      socket.emit('error', error.message);
    }
  });

  socket.on('join-private-room', ({ roomId, playerName }) => {
    if (!checkEventLimit('join-private-room')) {
      socket.emit('error', 'Too many requests. Please slow down.');
      return;
    }

    try {
      if (!validatePlayerName(playerName)) {
        socket.emit('error', 'Invalid player name');
        return;
      }

      if (!roomId || typeof roomId !== 'string' || roomId.length !== 7) {
        socket.emit('error', 'Invalid room ID');
        return;
      }

      const result = joinPrivateRoom(roomId.toUpperCase(), playerName, socket.id);
      
      if (!result.success) {
        socket.emit('join-room-error', { error: result.error });
        return;
      }

      const room = rooms.get(roomId.toUpperCase());
      socket.join(roomId.toUpperCase());
      socket.roomId = roomId.toUpperCase();

      if (room.players.length === 2) {
        io.to(roomId.toUpperCase()).emit('game-start', {
          room: {
            id: roomId.toUpperCase(),
            name: room.name,
            players: room.players,
            board: room.board,
            currentPlayer: room.currentPlayer,
            isPrivate: room.isPrivate
          }
        });
      }
    } catch (error) {
      socket.emit('error', error.message);
    }
  });

  socket.on('make-move', ({ roomId, position }) => {
    if (!checkEventLimit('make-move')) {
      socket.emit('error', 'Too many requests. Please slow down.');
      return;
    }

    try {
      const room = rooms.get(roomId);
      
      if (!room || room.gameOver || socket.id !== room.currentPlayer) {
        return;
      }

      if (typeof position !== 'number' || position < 0 || position > 8) {
        return;
      }

      if (room.board[position] !== null) {
        return;
      }

      const player = room.players.find(p => p.id === socket.id);
      if (!player) return;

      room.board[position] = player.symbol;
      room.lastActivity = Date.now();

      const result = checkWin(room.board);
      if (result) {
        room.gameOver = true;
        room.winner = result.winner;
        
        io.to(roomId).emit('game-over', {
          board: room.board,
          winner: result.winner,
          winPattern: result.pattern
        });
      } else {
        const otherPlayer = room.players.find(p => p.id !== socket.id);
        room.currentPlayer = otherPlayer.id;

        io.to(roomId).emit('move-made', {
          board: room.board,
          currentPlayer: room.currentPlayer,
          position,
          symbol: player.symbol
        });
      }
    } catch (error) {
      socket.emit('error', 'Failed to make move');
    }
  });

  socket.on('play-again', ({ roomId }) => {
    if (!checkEventLimit('play-again')) {
      socket.emit('error', 'Too many requests. Please slow down.');
      return;
    }

    try {
      const room = rooms.get(roomId);
      if (!room) return;

      room.board = Array(9).fill(null);
      room.gameOver = false;
      room.winner = null;
      room.currentPlayer = room.players[0].id;
      room.lastActivity = Date.now();

      io.to(roomId).emit('game-reset', {
        board: room.board,
        currentPlayer: room.currentPlayer
      });
    } catch (error) {
      socket.emit('error', 'Failed to restart game');
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    
    userConnections.delete(socket.id);
    
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        
        if (room.players.length === 0) {
          rooms.delete(socket.roomId);
        } else {
          room.lastActivity = Date.now();
          io.to(socket.roomId).emit('opponent-disconnected');
        }
      }
    }
  });

  // Handle socket errors
  socket.on('error', (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });
});

app.get('/', (req, res) => {
  res.send('Hello, world!');
});
// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    rooms: rooms.size,
    connections: io.engine.clientsCount,
    uptime: process.uptime()
  });
});

// Server stats endpoint (for monitoring)
app.get('/stats', (req, res) => {
  const stats = {
    totalRooms: rooms.size,
    activeConnections: io.engine.clientsCount,
    publicRooms: Array.from(rooms.values()).filter(r => !r.isPrivate).length,
    privateRooms: Array.from(rooms.values()).filter(r => r.isPrivate).length,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage()
  };
  res.json(stats);
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📈 Stats: http://localhost:${PORT}/stats`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  httpServer.close(() => {
    console.log('Process terminated');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  httpServer.close(() => {
    console.log('Process terminated');
  });
});