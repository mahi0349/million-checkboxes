const canvas = document.getElementById('gridCanvas');
const ctx = canvas.getContext('2d', { alpha: false });

// UI Elements
const statusDot = document.getElementById('connection-status');
const statusText = document.getElementById('status-text');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const userInfo = document.getElementById('user-info');
const toastContainer = document.getElementById('toast-container');
const checkedCountEl = document.getElementById('checked-count');
const zoomLevelEl = document.getElementById('zoom-level');
const coordDisplay = document.getElementById('coord-display');
const welcomeOverlay = document.getElementById('welcome-overlay');

// App State
let ws;
let isLoggedIn = false;
const GRID_COLS = 1000;
const GRID_ROWS = 1000;
const TOTAL_CHECKBOXES = GRID_COLS * GRID_ROWS;

// 1 bit per checkbox = 125,000 bytes
let checkboxState = new Uint8Array(TOTAL_CHECKBOXES / 8);

// Camera / Viewport
let camera = { x: 0, y: 0, zoom: 1 };
const CELL_SIZE = 20;
const BOX_SIZE = 16;
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let cameraStart = { x: 0, y: 0 };
let movedDuringDrag = false;

// ─── Classic Black & Crimson Theme Colors ─────────────
const COLORS = {
    bg: '#050505',
    // Unchecked box
    boxOff: '#111111',
    boxOffBorder: '#1e1e1e',
    // Checked box — crimson glow
    boxOn: '#dc143c',
    boxOnBorder: '#a00020',
    boxOnLight: '#ff2850',
    // Checkmark
    checkMark: '#ffffff',
    // Hover highlight
    hoverFill: 'rgba(220, 20, 60, 0.12)',
    hoverBorder: 'rgba(220, 20, 60, 0.3)',
    // Grid subtle lines
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

// ─── Auto-Login Flow ──────────────────────────────────
// Users get direct access — auto-login silently via API
async function ensureAuth() {
    try {
        // Check if already logged in
        const res = await fetch('/api/me');
        const data = await res.json();

        if (data.loggedIn) {
            isLoggedIn = true;
            loginBtn.classList.add('hidden');
            logoutBtn.classList.remove('hidden');
            userInfo.classList.remove('hidden');
            userInfo.textContent = data.user.name;
            return;
        }

        // Not logged in — auto-login silently via API (no redirect)
        const loginRes = await fetch('/auth/auto-login');
        const loginData = await loginRes.json();

        if (loginData.success) {
            isLoggedIn = true;
            loginBtn.classList.add('hidden');
            logoutBtn.classList.remove('hidden');
            userInfo.classList.remove('hidden');
            userInfo.textContent = loginData.user.name;
        }
    } catch (e) {
        console.error("Auth flow failed, falling back to manual login");
        loginBtn.classList.remove('hidden');
    }
}

// Initial auth — but don't block the app
ensureAuth();

// ─── WebSocket Setup ──────────────────────────────────
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        statusDot.className = 'status-dot connected';
        statusText.textContent = 'Live';
    };

    ws.onclose = () => {
        statusDot.className = 'status-dot disconnected';
        statusText.textContent = 'Reconnecting…';
        setTimeout(connectWebSocket, 2000);
    };

    ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
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
                if (data.error) {
                    showToast(data.error, 'error');
                    return;
                }
                const { index, state } = data;
                setBit(index, state);
                updateCheckedCount();
                requestAnimationFrame(draw);
            } catch (e) { }
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
        // Brian Kernighan's bit counting algorithm
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
    // Deep black background
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    // Visible range calculation
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

            // Draw box
            ctx.beginPath();
            ctx.roundRect(x, y, BOX_SIZE, BOX_SIZE, boxRadius);

            if (isOn) {
                // Crimson checked state with subtle gradient feel
                ctx.fillStyle = COLORS.boxOn;
                ctx.fill();
                ctx.strokeStyle = COLORS.boxOnBorder;
                ctx.lineWidth = 1;
                ctx.stroke();

                // Subtle inner glow for checked boxes
                if (camera.zoom >= 0.8) {
                    ctx.fillStyle = 'rgba(255, 40, 80, 0.15)';
                    ctx.beginPath();
                    ctx.roundRect(x + 2, y + 2, BOX_SIZE - 4, BOX_SIZE / 2 - 2, 2);
                    ctx.fill();
                }

                // Draw Checkmark
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

// ─── Mouse Interaction ────────────────────────────────
canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    movedDuringDrag = false;
    dragStart = { x: e.clientX, y: e.clientY };
    cameraStart = { x: camera.x, y: camera.y };
});

window.addEventListener('mousemove', (e) => {
    // Update hover position
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
    if (!isDragging) return;
    isDragging = false;

    if (!movedDuringDrag) {
        handleClick(e.clientX, e.clientY);
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

// ─── Click Handler ────────────────────────────────────
function handleClick(clientX, clientY) {
    // Auto-login handles auth — if still not logged in, trigger login
    if (!isLoggedIn) {
        // Try silent auto-login one more time
        fetch('/auth/auto-login')
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    isLoggedIn = true;
                    loginBtn.classList.add('hidden');
                    logoutBtn.classList.remove('hidden');
                    userInfo.classList.remove('hidden');
                    userInfo.textContent = data.user.name;
                    showToast('Welcome! You can now toggle checkboxes', 'success');
                    // Retry the click
                    handleClick(clientX, clientY);
                } else {
                    showToast('Unable to authenticate. Please refresh.', 'error');
                }
            })
            .catch(() => {
                showToast('Connection issue. Please refresh.', 'error');
            });
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
    camera.zoom = 1;
    updateZoomDisplay();
    requestAnimationFrame(draw);
});

// ─── Init Camera ──────────────────────────────────────
camera.x = (GRID_COLS * CELL_SIZE) / 2;
camera.y = (GRID_ROWS * CELL_SIZE) / 2;
updateZoomDisplay();
