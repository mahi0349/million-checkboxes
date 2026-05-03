/* ═══════════════════════════════════════════════════════
   Million Checkboxes — Frontend App
   Classic Black & Crimson Edition — No Auth, Multi-User
   ═══════════════════════════════════════════════════════ */

const canvas = document.getElementById('gridCanvas');
const ctx = canvas.getContext('2d', { alpha: false });

// UI Elements
const statusDot = document.getElementById('connection-status');
const statusText = document.getElementById('status-text');
const toastContainer = document.getElementById('toast-container');
const checkedCountEl = document.getElementById('checked-count');
const onlineCountEl = document.getElementById('online-count');
const zoomLevelEl = document.getElementById('zoom-level');
const coordDisplay = document.getElementById('coord-display');
const welcomeOverlay = document.getElementById('welcome-overlay');

// App State
let ws;
const GRID_COLS = 1000;
const GRID_ROWS = 1000;
const TOTAL_CHECKBOXES = GRID_COLS * GRID_ROWS;

// 1 bit per checkbox = 125,000 bytes
let checkboxState = new Uint8Array(TOTAL_CHECKBOXES / 8);

// Camera / Viewport — default 2× zoom for visibility
let camera = { x: 0, y: 0, zoom: 2 };
const CELL_SIZE = 20;
const BOX_SIZE = 16;
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let cameraStart = { x: 0, y: 0 };
let movedDuringDrag = false;
let isCtrlPressed = false;

// ─── Client-Side Rate Limiter ─────────────────────────
// Prevents spamming clicks (90ms gap required)
const rateLimiter = {
    lastClickTime: 0,
    canSend() {
        const now = Date.now();
        if (now - this.lastClickTime < 90) {
            return false;
        }
        this.lastClickTime = now;
        return true;
    }
};

// ─── Classic Black & Crimson Theme Colors ─────────────
const COLORS = {
    bg: '#050505',
    boxOff: '#111111',
    boxOffBorder: '#1e1e1e',
    boxOn: '#dc143c',
    boxOnBorder: '#a00020',
    boxOnLight: '#ff2850',
    checkMark: '#ffffff',
    hoverFill: 'rgba(220, 20, 60, 0.12)',
    hoverBorder: 'rgba(220, 20, 60, 0.3)',
    gridLine: '#0d0d0d'
};

// Track hovered cell
let hoveredCell = { col: -1, row: -1 };

// ─── Canvas Resize ────────────────────────────────────
function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    requestAnimationFrame(draw);
}
window.addEventListener('resize', resize);
resize();

// ─── Toast Notifications ──────────────────────────────
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 3000);
}

// ─── WebSocket Setup ──────────────────────────────────
let reconnectDelay = 1000;

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        statusDot.className = 'status-dot connected';
        statusText.textContent = 'Live';
        reconnectDelay = 1000; // reset on success
    };

    ws.onclose = () => {
        statusDot.className = 'status-dot disconnected';
        statusText.textContent = 'Reconnecting…';
        // Exponential backoff reconnect
        setTimeout(connectWebSocket, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    };

    ws.onerror = () => {
        // onclose will fire after this
    };

    ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            // Initial full state load
            checkboxState = new Uint8Array(event.data);
            updateCheckedCount();
            requestAnimationFrame(draw);

            // Dismiss welcome overlay
            if (welcomeOverlay) {
                welcomeOverlay.style.animation = 'welcomeFade 0.5s ease forwards';
                setTimeout(() => {
                    welcomeOverlay.style.display = 'none';
                }, 600);
            }
        } else {
            try {
                const data = JSON.parse(event.data);

                // Server rate limit warning
                if (data.error) {
                    showToast(data.error, 'error');
                    return;
                }

                // Online count broadcast
                if (typeof data.online === 'number') {
                    if (onlineCountEl) onlineCountEl.textContent = data.online;
                    return;
                }

                // Checkbox toggle update
                const { index, state } = data;
                if (typeof index === 'number' && typeof state === 'boolean') {
                    setBit(index, state);
                    updateCheckedCount();
                    requestAnimationFrame(draw);
                }
            } catch (e) {}
        }
    };
}
connectWebSocket();

// ─── Bit Manipulation ─────────────────────────────────
function getBit(index) {
    const byteIndex = Math.floor(index / 8);
    const bitIndex = 7 - (index % 8);
    return (checkboxState[byteIndex] & (1 << bitIndex)) !== 0;
}

function setBit(index, value) {
    const byteIndex = Math.floor(index / 8);
    const bitIndex = 7 - (index % 8);
    if (value) {
        checkboxState[byteIndex] |= (1 << bitIndex);
    } else {
        checkboxState[byteIndex] &= ~(1 << bitIndex);
    }
}

// ─── Stats ────────────────────────────────────────────
function updateCheckedCount() {
    let count = 0;
    for (let i = 0; i < checkboxState.length; i++) {
        let byte = checkboxState[i];
        while (byte) {
            count++;
            byte &= byte - 1;
        }
    }
    if (checkedCountEl) {
        checkedCountEl.textContent = count.toLocaleString();
    }
}

function updateZoomDisplay() {
    if (zoomLevelEl) {
        zoomLevelEl.textContent = camera.zoom.toFixed(1) + '×';
    }
}

// ─── Rendering ────────────────────────────────────────
function draw() {
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    const viewLeft = camera.x - (canvas.width / 2) / camera.zoom;
    const viewRight = camera.x + (canvas.width / 2) / camera.zoom;
    const viewTop = camera.y - (canvas.height / 2) / camera.zoom;
    const viewBottom = camera.y + (canvas.height / 2) / camera.zoom;

    const startCol = Math.max(0, Math.floor(viewLeft / CELL_SIZE));
    const endCol = Math.min(GRID_COLS - 1, Math.ceil(viewRight / CELL_SIZE));
    const startRow = Math.max(0, Math.floor(viewTop / CELL_SIZE));
    const endRow = Math.min(GRID_ROWS - 1, Math.ceil(viewBottom / CELL_SIZE));

    const boxRadius = 3;

    for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
            const index = r * GRID_COLS + c;
            const isOn = getBit(index);
            const isHovered = (c === hoveredCell.col && r === hoveredCell.row);

            const x = c * CELL_SIZE;
            const y = r * CELL_SIZE;

            ctx.beginPath();
            ctx.roundRect(x, y, BOX_SIZE, BOX_SIZE, boxRadius);

            if (isOn) {
                ctx.fillStyle = COLORS.boxOn;
                ctx.fill();
                ctx.strokeStyle = COLORS.boxOnBorder;
                ctx.lineWidth = 1;
                ctx.stroke();

                // Subtle inner glow at reasonable zoom
                if (camera.zoom >= 0.8) {
                    ctx.fillStyle = 'rgba(255, 40, 80, 0.15)';
                    ctx.beginPath();
                    ctx.roundRect(x + 2, y + 2, BOX_SIZE - 4, BOX_SIZE / 2 - 2, 2);
                    ctx.fill();
                }

                // Checkmark
                ctx.strokeStyle = COLORS.checkMark;
                ctx.lineWidth = 2;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.beginPath();
                ctx.moveTo(x + 4, y + 8);
                ctx.lineTo(x + 7, y + 11);
                ctx.lineTo(x + 12, y + 4);
                ctx.stroke();
            } else if (isHovered) {
                ctx.fillStyle = COLORS.hoverFill;
                ctx.fill();
                ctx.strokeStyle = COLORS.hoverBorder;
                ctx.lineWidth = 1;
                ctx.stroke();
            } else {
                ctx.fillStyle = COLORS.boxOff;
                ctx.fill();
                ctx.strokeStyle = COLORS.boxOffBorder;
                ctx.lineWidth = 0.5;
                ctx.stroke();
            }
        }
    }

    ctx.restore();
}

// ─── Mouse Interaction & Cursor ───────────────────────
function updateCursor() {
    if (isCtrlPressed) {
        canvas.style.cursor = isDragging ? 'grabbing' : 'grab';
    } else {
        canvas.style.cursor = 'crosshair';
    }
}

window.addEventListener('keydown', (e) => {
    if (e.key === 'Control') {
        isCtrlPressed = true;
        updateCursor();
    }
});

window.addEventListener('keyup', (e) => {
    if (e.key === 'Control') {
        isCtrlPressed = false;
        isDragging = false; // Stop dragging if ctrl is released
        updateCursor();
    }
});

canvas.addEventListener('mousedown', (e) => {
    if (isCtrlPressed) {
        isDragging = true;
        movedDuringDrag = false;
        dragStart = { x: e.clientX, y: e.clientY };
        cameraStart = { x: camera.x, y: camera.y };
        updateCursor();
    } else {
        // Normal click behavior (no dragging)
        handleClick(e.clientX, e.clientY);
    }
});

window.addEventListener('mousemove', (e) => {
    const worldX = (e.clientX - canvas.width / 2) / camera.zoom + camera.x;
    const worldY = (e.clientY - canvas.height / 2) / camera.zoom + camera.y;
    const col = Math.floor(worldX / CELL_SIZE);
    const row = Math.floor(worldY / CELL_SIZE);

    if (col >= 0 && col < GRID_COLS && row >= 0 && row < GRID_ROWS) {
        hoveredCell = { col, row };
        if (coordDisplay) {
            coordDisplay.textContent = `${col}, ${row}`;
        }
    } else {
        hoveredCell = { col: -1, row: -1 };
    }

    if (!isDragging) {
        requestAnimationFrame(draw);
        return;
    }

    const dx = (e.clientX - dragStart.x) / camera.zoom;
    const dy = (e.clientY - dragStart.y) / camera.zoom;

    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        movedDuringDrag = true;
    }

    camera.x = cameraStart.x - dx;
    camera.y = cameraStart.y - dy;

    const maxBound = GRID_COLS * CELL_SIZE;
    camera.x = Math.max(0, Math.min(maxBound, camera.x));
    camera.y = Math.max(0, Math.min(maxBound, camera.y));

    requestAnimationFrame(draw);
});

window.addEventListener('mouseup', (e) => {
    if (isDragging) {
        isDragging = false;
        updateCursor();
    }
});

// ─── Touch Support ────────────────────────────────────
canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
        isDragging = true;
        movedDuringDrag = false;
        dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        cameraStart = { x: camera.x, y: camera.y };
    }
});

window.addEventListener('touchmove', (e) => {
    if (isDragging && e.touches.length === 1) {
        const dx = (e.touches[0].clientX - dragStart.x) / camera.zoom;
        const dy = (e.touches[0].clientY - dragStart.y) / camera.zoom;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) movedDuringDrag = true;
        camera.x = cameraStart.x - dx;
        camera.y = cameraStart.y - dy;
        requestAnimationFrame(draw);
    }
});

window.addEventListener('touchend', (e) => {
    if (isDragging && !movedDuringDrag && e.changedTouches.length === 1) {
        handleClick(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    }
    isDragging = false;
});

// ─── Click Handler (No auth needed) ───────────────────
function handleClick(clientX, clientY) {
    // Client-side rate limiting (90ms gap)
    if (!rateLimiter.canSend()) {
        // Do not show toast for 90ms gap, just silently drop to feel responsive
        return;
    }

    const worldX = (clientX - canvas.width / 2) / camera.zoom + camera.x;
    const worldY = (clientY - canvas.height / 2) / camera.zoom + camera.y;

    const col = Math.floor(worldX / CELL_SIZE);
    const row = Math.floor(worldY / CELL_SIZE);

    if (col >= 0 && col < GRID_COLS && row >= 0 && row < GRID_ROWS) {
        const index = row * GRID_COLS + col;

        const boxX = col * CELL_SIZE;
        const boxY = row * CELL_SIZE;
        if (worldX >= boxX && worldX <= boxX + BOX_SIZE &&
            worldY >= boxY && worldY <= boxY + BOX_SIZE) {

            const currentState = getBit(index);
            const newState = !currentState;

            // Optimistic UI update
            setBit(index, newState);
            updateCheckedCount();
            requestAnimationFrame(draw);

            // Send to server
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ index, state: newState }));
            }
        }
    }
}

// ─── Zoom ─────────────────────────────────────────────
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = 0.1;
    if (e.deltaY < 0) {
        camera.zoom = Math.min(5, camera.zoom + zoomFactor);
    } else {
        camera.zoom = Math.max(0.15, camera.zoom - zoomFactor);
    }
    updateZoomDisplay();
    requestAnimationFrame(draw);
}, { passive: false });

document.getElementById('zoom-in').addEventListener('click', () => {
    camera.zoom = Math.min(5, camera.zoom + 0.5);
    updateZoomDisplay();
    requestAnimationFrame(draw);
});

document.getElementById('zoom-out').addEventListener('click', () => {
    camera.zoom = Math.max(0.15, camera.zoom - 0.5);
    updateZoomDisplay();
    requestAnimationFrame(draw);
});

document.getElementById('reset-view').addEventListener('click', () => {
    camera.x = (GRID_COLS * CELL_SIZE) / 2;
    camera.y = (GRID_ROWS * CELL_SIZE) / 2;
    camera.zoom = 3;
    updateZoomDisplay();
    requestAnimationFrame(draw);
});

// ─── Init Camera — centered at 3× zoom ───────────────
camera.x = (GRID_COLS * CELL_SIZE) / 2;
camera.y = (GRID_ROWS * CELL_SIZE) / 2;
camera.zoom = 3;
updateZoomDisplay();
updateCursor();
