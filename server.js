require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Redis = require('ioredis');
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Redis setup
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(redisUrl); // State & General use
const pub = new Redis(redisUrl);   // Pub/Sub - Publisher
const sub = new Redis(redisUrl);   // Pub/Sub - Subscriber

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret123';
const GRID_SIZE = 1000 * 1000; // 1 million checkboxes

// Redis Pub/Sub for syncing between potential multiple server instances
sub.subscribe('checkbox_updates', (err) => {
    if (err) console.error("Failed to subscribe:", err);
});

sub.on('message', (channel, message) => {
    if (channel === 'checkbox_updates') {
        const update = JSON.parse(message);
        // Broadcast to all connected WebSockets
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(update));
            }
        });
    }
});

// Custom Rate Limiting Middleware (HTTP)
async function httpRateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const key = `rl:http:${ip}`;
    try {
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, 1); // 1 second window
        if (count > 5) {
            return res.status(429).json({ error: "Too many requests" });
        }
        next();
    } catch (err) {
        next();
    }
}

// Authentication Flow (Mock OAuth2 / OIDC)
app.get('/auth/login', httpRateLimit, (req, res) => {
    // In a real OIDC flow, this redirects to the Authorization Server.
    // Here we'll just mock a successful login by returning a mock "Google" user token.
    const mockUser = {
        id: Math.random().toString(36).substring(2, 10),
        name: "User_" + Math.floor(Math.random() * 1000)
    };
    
    const token = jwt.sign(mockUser, JWT_SECRET, { expiresIn: '1h' });
    
    // Set token in HTTP-only cookie
    res.cookie('auth_token', token, { httpOnly: true, sameSite: 'strict' });
    res.redirect('/');
});

app.get('/auth/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.redirect('/');
});

app.get('/api/me', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ loggedIn: false });
    
    try {
        const user = jwt.verify(token, JWT_SECRET);
        res.json({ loggedIn: true, user });
    } catch (e) {
        res.status(401).json({ loggedIn: false });
    }
});

// Initial state fetch API (optional, we send via WS on connect)
// But a REST endpoint can be good for initial load
app.get('/api/checkboxes', httpRateLimit, async (req, res) => {
    try {
        // Fetch the entire bitfield string buffer. 1M bits = 125,000 bytes
        const buffer = await redis.getBuffer('checkboxes');
        if (!buffer) {
            return res.send(Buffer.alloc(GRID_SIZE / 8));
        }
        res.send(buffer);
    } catch (err) {
        res.status(500).send("Error fetching state");
    }
});

// WebSocket Connection Management
wss.on('connection', async (ws, req) => {
    const ip = req.socket.remoteAddress;
    
    // Extract token from cookie headers for WS auth
    let user = null;
    if (req.headers.cookie) {
        const tokenMatch = req.headers.cookie.match(/auth_token=([^;]+)/);
        if (tokenMatch) {
            try {
                user = jwt.verify(tokenMatch[1], JWT_SECRET);
            } catch (e) { /* ignore */ }
        }
    }
    
    ws.user = user;

    // Send initial state as binary on connection
    try {
        const buffer = await redis.getBuffer('checkboxes');
        if (buffer) {
            ws.send(buffer); // Sends as binary ArrayBuffer to client
        } else {
            ws.send(Buffer.alloc(GRID_SIZE / 8));
        }
    } catch (e) {
        console.error("Failed to send initial buffer", e);
    }

    ws.on('message', async (message) => {
        // Custom Rate Limiting (WebSocket)
        const limitKey = `rl:ws:${ip}`;
        const count = await redis.incr(limitKey);
        if (count === 1) await redis.expire(limitKey, 1); // 1 second window
        
        // Let's say max 20 checkbox toggles per second per connection
        if (count > 20) {
            ws.send(JSON.stringify({ error: "Rate limit exceeded" }));
            return;
        }

        try {
            const data = JSON.parse(message);
            
            // Validate payload
            if (typeof data.index !== 'number' || data.index < 0 || data.index >= GRID_SIZE) return;
            if (typeof data.state !== 'boolean') return;
            
            // Optional: enforce authentication to toggle
            // We'll allow anonymous read-only, but logged in users to toggle.
            if (!ws.user) {
                ws.send(JSON.stringify({ error: "Authentication required to toggle checkboxes" }));
                return;
            }

            const bitValue = data.state ? 1 : 0;

            // Use Redis BITFIELD to atomically set the specific bit
            // bit offset is data.index, type is u1
            await redis.bitfield('checkboxes', 'SET', 'u1', data.index, bitValue);

            // Broadcast the update to other instances via Pub/Sub
            pub.publish('checkbox_updates', JSON.stringify({
                index: data.index,
                state: data.state
            }));

        } catch (e) {
            // Invalid message
        }
    });

    ws.on('close', () => {
        // cleanup if necessary
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
