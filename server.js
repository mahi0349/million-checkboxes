require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Redis = require('ioredis');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

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

// Initial state fetch API
app.get('/api/checkboxes', async (req, res) => {
    try {
        const buffer = await getCheckboxBuffer();
        res.send(buffer);
    } catch (err) {
        res.status(500).send("Error fetching state");
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        redis: redisAvailable ? 'connected' : 'in-memory-fallback',
        uptime: process.uptime()
    });
});

// ─── WebSocket Connection Management ──────────────────
// Very strict Token Bucket Rate Limiting for WebSockets
const wsRateLimits = new Map();

// Token bucket parameters
const BURST_CAPACITY = 20; // Max messages allowed in a quick burst
const REFILL_RATE = 10;    // Tokens refilled per second
const MAX_VIOLATIONS = 5;  // How many times can they hit the limit before a cooldown
const COOLDOWN_TIME = 5000; // Cooldown time in ms if they are too aggressive

wss.on('connection', async (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Send initial state as binary on connection
    try {
        const buffer = await getCheckboxBuffer();
        ws.send(buffer);
    } catch (e) {
        console.error("Failed to send initial buffer", e);
        ws.send(Buffer.alloc(BUFFER_SIZE));
    }

    ws.on('message', async (message) => {
        // --- Rate Limiting Logic ---
        const now = Date.now();
        let limitState = wsRateLimits.get(ip);
        
        if (!limitState) {
            limitState = {
                tokens: BURST_CAPACITY,
                lastRefill: now,
                violations: 0,
                cooldownUntil: 0
            };
            wsRateLimits.set(ip, limitState);
        }

        // Check if in cooldown
        if (now < limitState.cooldownUntil) {
            // Drop message entirely
            return;
        }

        // Refill tokens
        const elapsed = (now - limitState.lastRefill) / 1000;
        limitState.tokens = Math.min(BURST_CAPACITY, limitState.tokens + (elapsed * REFILL_RATE));
        limitState.lastRefill = now;

        // Check if enough tokens
        if (limitState.tokens >= 1) {
            // Consume token and proceed
            limitState.tokens -= 1;
            // Decay violations slowly if they are behaving
            if (limitState.violations > 0 && Math.random() < 0.1) {
                limitState.violations -= 1;
            }
        } else {
            // Rate limit exceeded
            limitState.violations++;
            
            if (limitState.violations >= MAX_VIOLATIONS) {
                // Aggressive behavior - impose a cooldown
                limitState.cooldownUntil = now + COOLDOWN_TIME;
                limitState.violations = Math.max(0, limitState.violations - 2); // reset some violations after punishment
                ws.send(JSON.stringify({ error: "You are clicking too fast! Cooldown activated." }));
            } else {
                ws.send(JSON.stringify({ error: "Rate limit exceeded. Slow down." }));
            }
            return; // Stop processing
        }
        // -----------------------------

        try {
            const data = JSON.parse(message);

            // Validate payload strictly
            if (typeof data.index !== 'number' || data.index < 0 || data.index >= GRID_SIZE) return;
            if (typeof data.state !== 'boolean') return;

            // Update state
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
                    broadcastDirect(updateMsg);
                }
            } else {
                broadcastDirect(updateMsg);
            }

        } catch (e) {
            // Invalid message
        }
    });
});

function broadcastDirect(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Periodically clean up rate limit map
setInterval(() => {
    const now = Date.now();
    for (const [ip, state] of wsRateLimits.entries()) {
        if (now - state.lastRefill > 60000 && now > state.cooldownUntil) {
            wsRateLimits.delete(ip);
        }
    }
}, 60000);

// Periodically broadcast online user count
setInterval(() => {
    const onlineCount = wss.clients.size;
    const msg = JSON.stringify({ online: onlineCount });
    broadcastDirect(msg);
}, 2000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ✓ Million Checkboxes running on port ${PORT}`);
    console.log(`  ✓ Redis: ${redisAvailable ? 'connected' : 'in-memory fallback'}`);
    console.log(`  ✓ Open: http://localhost:${PORT}\n`);
});
