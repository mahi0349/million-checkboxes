const canvas = document.getElementById('gridCanvas');
const ctx = canvas.getContext('2d', { alpha: false }); // Optimize for no transparency on base

// UI Elements
const statusDot = document.getElementById('connection-status');
const statusText = document.getElementById('status-text');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const userInfo = document.getElementById('user-info');
const toastContainer = document.getElementById('toast-container');

// App State
let ws;
let isLoggedIn = false;
const GRID_COLS = 1000;
const GRID_ROWS = 1000;
const TOTAL_CHECKBOXES = GRID_COLS * GRID_ROWS;

// 1 bit per checkbox = 125,000 bytes. We'll use a Uint8Array.
let checkboxState = new Uint8Array(TOTAL_CHECKBOXES / 8);

// Camera / Viewport
let camera = { x: 0, y: 0, zoom: 1 };
const CELL_SIZE = 20; // 16px box + 4px padding
const BOX_SIZE = 16;
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let cameraStart = { x: 0, y: 0 };
let movedDuringDrag = false;

// Theme Colors
const COLORS = {
    bg: '#0f172a',
    boxOff: '#1e293b',
    boxOffBorder: '#334155',
    boxOn: '#10b981',
    boxOnBorder: '#059669',
    checkMark: '#ffffff'
};

// Resize Canvas
function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    requestAnimationFrame(draw);
}
window.addEventListener('resize', resize);
resize();

// Toast Notifications
function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.className = `toast ${isError ? 'error' : ''}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 3000);
}

// Authentication Check
async function checkAuth() {
    try {
        const res = await fetch('/api/me');
        const data = await res.json();
        isLoggedIn = data.loggedIn;
        if (isLoggedIn) {
            loginBtn.classList.add('hidden');
            logoutBtn.classList.remove('hidden');
            userInfo.classList.remove('hidden');
            userInfo.textContent = `Hello, ${data.user.name}`;
        }
    } catch (e) {
        console.error("Auth check failed");
    }
}
checkAuth();

// WebSocket Setup
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        statusDot.className = 'status-dot connected';
        statusText.textContent = 'Connected';
    };

    ws.onclose = () => {
        statusDot.className = 'status-dot disconnected';
        statusText.textContent = 'Disconnected - Reconnecting...';
        setTimeout(connectWebSocket, 2000);
    };

    ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            // Initial Full State Load
            checkboxState = new Uint8Array(event.data);
            requestAnimationFrame(draw);
            showToast("Grid synchronized!");
        } else {
            // Incremental Update
            try {
                const data = JSON.parse(event.data);
                if (data.error) {
                    showToast(data.error, true);
                    return;
                }
                const { index, state } = data;
                setBit(index, state);
                requestAnimationFrame(draw);
            } catch (e) {}
        }
    };
}
connectWebSocket();

// Bit Manipulation Helpers
function getBit(index) {
    const byteIndex = Math.floor(index / 8);
    const bitIndex = 7 - (index % 8); // Redis bitfield is big-endian bit order usually
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

// Rendering
function draw() {
    // Fill background
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    // Calculate visible range to only draw what's on screen
    const viewLeft = camera.x - (canvas.width / 2) / camera.zoom;
    const viewRight = camera.x + (canvas.width / 2) / camera.zoom;
    const viewTop = camera.y - (canvas.height / 2) / camera.zoom;
    const viewBottom = camera.y + (canvas.height / 2) / camera.zoom;

    const startCol = Math.max(0, Math.floor(viewLeft / CELL_SIZE));
    const endCol = Math.min(GRID_COLS - 1, Math.ceil(viewRight / CELL_SIZE));
    const startRow = Math.max(0, Math.floor(viewTop / CELL_SIZE));
    const endRow = Math.min(GRID_ROWS - 1, Math.ceil(viewBottom / CELL_SIZE));

    ctx.lineWidth = 1.5;

    for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
            const index = r * GRID_COLS + c;
            const isOn = getBit(index);
            
            const x = c * CELL_SIZE;
            const y = r * CELL_SIZE;

            if (isOn) {
                ctx.fillStyle = COLORS.boxOn;
                ctx.strokeStyle = COLORS.boxOnBorder;
            } else {
                ctx.fillStyle = COLORS.boxOff;
                ctx.strokeStyle = COLORS.boxOffBorder;
            }

            // Draw Box
            ctx.beginPath();
            ctx.roundRect(x, y, BOX_SIZE, BOX_SIZE, 4);
            ctx.fill();
            ctx.stroke();

            // Draw Checkmark
            if (isOn) {
                ctx.strokeStyle = COLORS.checkMark;
                ctx.lineWidth = 2;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.beginPath();
                ctx.moveTo(x + 4, y + 8);
                ctx.lineTo(x + 7, y + 11);
                ctx.lineTo(x + 12, y + 4);
                ctx.stroke();
                ctx.lineWidth = 1.5; // reset
            }
        }
    }
    
    ctx.restore();
}

// Interaction
canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    movedDuringDrag = false;
    dragStart = { x: e.clientX, y: e.clientY };
    cameraStart = { x: camera.x, y: camera.y };
});

window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    
    const dx = (e.clientX - dragStart.x) / camera.zoom;
    const dy = (e.clientY - dragStart.y) / camera.zoom;
    
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        movedDuringDrag = true;
    }
    
    camera.x = cameraStart.x - dx;
    camera.y = cameraStart.y - dy;
    
    // Bounds checking
    const maxBound = (GRID_COLS * CELL_SIZE);
    camera.x = Math.max(0, Math.min(maxBound, camera.x));
    camera.y = Math.max(0, Math.min(maxBound, camera.y));
    
    requestAnimationFrame(draw);
});

window.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    
    // If we didn't drag, treat as a click
    if (!movedDuringDrag) {
        handleClick(e.clientX, e.clientY);
    }
});

// Touch Support
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


function handleClick(clientX, clientY) {
    if (!isLoggedIn) {
        showToast("Please login to toggle checkboxes", true);
        return;
    }

    // Convert screen coordinates to world coordinates
    const worldX = (clientX - canvas.width / 2) / camera.zoom + camera.x;
    const worldY = (clientY - canvas.height / 2) / camera.zoom + camera.y;

    const col = Math.floor(worldX / CELL_SIZE);
    const row = Math.floor(worldY / CELL_SIZE);

    if (col >= 0 && col < GRID_COLS && row >= 0 && row < GRID_ROWS) {
        const index = row * GRID_COLS + col;
        
        // Check if click was within the actual box, not padding
        const boxX = col * CELL_SIZE;
        const boxY = row * CELL_SIZE;
        if (worldX >= boxX && worldX <= boxX + BOX_SIZE &&
            worldY >= boxY && worldY <= boxY + BOX_SIZE) {
            
            const currentState = getBit(index);
            const newState = !currentState;
            
            // Optimistic UI update
            setBit(index, newState);
            requestAnimationFrame(draw);
            
            // Send to server
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ index, state: newState }));
            }
        }
    }
}

// Zoom functionality
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = 0.1;
    if (e.deltaY < 0) {
        camera.zoom = Math.min(5, camera.zoom + zoomFactor);
    } else {
        camera.zoom = Math.max(0.2, camera.zoom - zoomFactor);
    }
    requestAnimationFrame(draw);
});

document.getElementById('zoom-in').addEventListener('click', () => {
    camera.zoom = Math.min(5, camera.zoom + 0.5);
    requestAnimationFrame(draw);
});

document.getElementById('zoom-out').addEventListener('click', () => {
    camera.zoom = Math.max(0.2, camera.zoom - 0.5);
    requestAnimationFrame(draw);
});

document.getElementById('reset-view').addEventListener('click', () => {
    // Center view
    camera.x = (GRID_COLS * CELL_SIZE) / 2;
    camera.y = (GRID_ROWS * CELL_SIZE) / 2;
    camera.zoom = 1;
    requestAnimationFrame(draw);
});

// Init Camera to Center
camera.x = (GRID_COLS * CELL_SIZE) / 2;
camera.y = (GRID_ROWS * CELL_SIZE) / 2;

