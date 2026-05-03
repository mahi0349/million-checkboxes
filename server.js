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

// Trust proxy for deployments behind reverse proxies (Render, Railway, etc.)
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public')));

// Redis setup — with graceful fallback for deployment
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
let redis, pub, sub;
let redisAvailable = true;

// In-memory fallback for when Redis is not available
let inMemoryState = null;

function createRedisClient(url) {
    const client = new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
            if (times > 5) {
                console.log('Redis connection failed, using in-memory fallback');
                redisAvailable = false;
                return null; // stop retrying
            }
            return Math.min(times * 200, 2000);
        },
        lazyConnect: true,
    });
    client.on('error', (err) => {
        if (err.code !== 'ECONNREFUSED') {
            console.error('Redis error:', err.message);
        }
    });
    return client;
}

redis = createRedisClient(redisUrl);
pub = createRedisClient(redisUrl);
sub = createRedisClient(redisUrl);

// Try connecting Redis
(async () => {
    try {
        await redis.connect();
        await pub.connect();
        await sub.connect();
        console.log('✓ Redis connected');

        // Redis Pub/Sub for syncing between server instances
        sub.subscribe('checkbox_updates', (err) => {
            if (err) console.error("Failed to subscribe:", err);
        });

        sub.on('message', (channel, message) => {
            if (channel === 'checkbox_updates') {
                const update = JSON.parse(message);
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(update));
                    }
                });
            }
        });
    } catch (e) {
        console.log('⚠ Redis not available, running in-memory mode');
        redisAvailable = false;
    }
})();

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret123';
const GRID_SIZE = 1000 * 1000; // 1 million checkboxes
const BUFFER_SIZE = GRID_SIZE / 8; // 125,000 bytes

// Initialize in-memory fallback
inMemoryState = Buffer.alloc(BUFFER_SIZE);

// ─── Helper: Get checkbox state ───────────────────────
async function getCheckboxBuffer() {
    if (redisAvailable) {
        try {
            const buffer = await redis.getBuffer('checkboxes');
            return buffer || Buffer.alloc(BUFFER_SIZE);
        } catch (e) {
            return inMemoryState;
        }
    }
    return inMemoryState;
}

// ─── Helper: Set a bit ────────────────────────────────
async function setCheckboxBit(index, value) {
    const bitValue = value ? 1 : 0;
    if (redisAvailable) {
        try {
            await redis.bitfield('checkboxes', 'SET', 'u1', index, bitValue);
            return;
        } catch (e) {
            // fall through to in-memory
        }
    }
    // In-memory fallback
    const byteIndex = Math.floor(index / 8);
    const bitIndex = 7 - (index % 8);
    if (value) {
        inMemoryState[byteIndex] |= (1 << bitIndex);
    } else {
        inMemoryState[byteIndex] &= ~(1 << bitIndex);
    }
}

// ─── Custom Rate Limiting Middleware (HTTP) ────────────
const rateLimitMap = new Map();

function httpRateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowMs = 1000;
    const maxRequests = 10;

    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
        return next();
    }

    const entry = rateLimitMap.get(ip);
    if (now > entry.resetAt) {
        entry.count = 1;
        entry.resetAt = now + windowMs;
        return next();
    }

    entry.count++;
    if (entry.count > maxRequests) {
        return res.status(429).json({ error: "Too many requests" });
    }
    next();
}

// Clean up rate limit map periodically
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        if (now > entry.resetAt + 5000) {
            rateLimitMap.delete(ip);
        }
    }
}, 10000);

// ─── Authentication — Auto-login for direct access ───
app.get('/auth/login', httpRateLimit, (req, res) => {
    // Check if user already has a valid token
    const existingToken = req.cookies.auth_token;
    if (existingToken) {
        try {
            jwt.verify(existingToken, JWT_SECRET);
            return res.redirect('/');
        } catch (e) {
            // Token expired, create new one
        }
    }

    // Generate a unique anonymous user identity
    const mockUser = {
        id: Math.random().toString(36).substring(2, 10),
        name: "User_" + Math.floor(Math.random() * 9000 + 1000)
    };

    const token = jwt.sign(mockUser, JWT_SECRET, { expiresIn: '24h' });

    // Set token in HTTP-only cookie
    res.cookie('auth_token', token, {
        httpOnly: true,
        sameSite: 'lax', // 'lax' works better across deployments
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });
    res.redirect('/');
});

// Auto-login API endpoint for AJAX requests (no redirect)
app.get('/auth/auto-login', httpRateLimit, (req, res) => {
    const existingToken = req.cookies.auth_token;
    if (existingToken) {
        try {
            const user = jwt.verify(existingToken, JWT_SECRET);
            return res.json({ success: true, user });
        } catch (e) {
            // Token expired, create new one
        }
    }

    const mockUser = {
        id: Math.random().toString(36).substring(2, 10),
        name: "User_" + Math.floor(Math.random() * 9000 + 1000)
    };

    const token = jwt.sign(mockUser, JWT_SECRET, { expiresIn: '24h' });

    res.cookie('auth_token', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000
    });

    res.json({ success: true, user: mockUser });
});

app.get('/auth/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.redirect('/');
});

app.get('/api/me', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.json({ loggedIn: false });

    try {
        const user = jwt.verify(token, JWT_SECRET);
        res.json({ loggedIn: true, user });
    } catch (e) {
        res.json({ loggedIn: false });
    }
});

// Initial state fetch API
app.get('/api/checkboxes', httpRateLimit, async (req, res) => {
    try {
        const buffer = await getCheckboxBuffer();
        res.send(buffer);
    } catch (err) {
        res.status(500).send("Error fetching state");
    }
});

// ─── Health check endpoint (for deployment platforms) ──
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        redis: redisAvailable ? 'connected' : 'in-memory-fallback',
        uptime: process.uptime()
    });
});

// ─── WebSocket Connection Management ──────────────────
const wsRateLimits = new Map();

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

    // Auto-assign identity for WS if no token (direct access support)
    if (!user) {
        user = {
            id: Math.random().toString(36).substring(2, 10),
            name: "Anon_" + Math.floor(Math.random() * 9000 + 1000)
        };
    }

    ws.user = user;

    // Send initial state as binary on connection
    try {
        const buffer = await getCheckboxBuffer();
        ws.send(buffer);
    } catch (e) {
        console.error("Failed to send initial buffer", e);
        ws.send(Buffer.alloc(BUFFER_SIZE));
    }

    ws.on('message', async (message) => {
        // Rate Limiting (WebSocket) — in-memory
        const now = Date.now();
        if (!wsRateLimits.has(ip)) {
            wsRateLimits.set(ip, { count: 1, resetAt: now + 1000 });
        } else {
            const entry = wsRateLimits.get(ip);
            if (now > entry.resetAt) {
                entry.count = 1;
                entry.resetAt = now + 1000;
            } else {
                entry.count++;
                if (entry.count > 20) {
                    ws.send(JSON.stringify({ error: "Rate limit exceeded" }));
                    return;
                }
            }
        }

        try {
            const data = JSON.parse(message);

            // Validate payload
            if (typeof data.index !== 'number' || data.index < 0 || data.index >= GRID_SIZE) return;
            if (typeof data.state !== 'boolean') return;

            // Allow all connected users to toggle (direct access)
            await setCheckboxBit(data.index, data.state);

            // Broadcast the update
            const updateMsg = JSON.stringify({
                index: data.index,
                state: data.state
            });

            if (redisAvailable) {
                try {
                    pub.publish('checkbox_updates', updateMsg);
                } catch (e) {
                    // Fallback: broadcast directly
                    broadcastDirect(updateMsg);
                }
            } else {
                broadcastDirect(updateMsg);
            }

        } catch (e) {
            // Invalid message
        }
    });

    ws.on('close', () => {
        // cleanup if necessary
    });
});

function broadcastDirect(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Clean up WS rate limits periodically
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of wsRateLimits) {
        if (now > entry.resetAt + 5000) {
            wsRateLimits.delete(ip);
        }
    }
}, 10000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ✓ Million Checkboxes running on port ${PORT}`);
    console.log(`  ✓ Redis: ${redisAvailable ? 'connected' : 'in-memory fallback'}`);
    console.log(`  ✓ Open: http://localhost:${PORT}\n`);
});
