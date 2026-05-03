# 1 Million Checkboxes

## Project Overview
This project is a high-performance, real-time web application allowing multiple users to concurrently view and toggle a massive grid containing **1,000,000 checkboxes**. Inspired by the original "1 Million Checkboxes" concept, this application is built entirely from scratch with a focus on solving extreme scaling challenges—such as rendering limits in the browser, bandwidth-efficient state synchronization, horizontal scaling, and anti-spam measures.

## Tech Stack
- **Frontend**: HTML5, Vanilla JavaScript, CSS3 (Glassmorphism design)
- **Rendering Engine**: HTML5 Canvas API (Viewport Culling & Camera Panning)
- **Backend Server**: Node.js, Express
- **Real-Time Layer**: WebSockets (`ws` package)
- **State Storage & Cache**: Redis (`ioredis`)

## Features Implemented
- **Infinite Canvas Grid**: Bypasses the DOM's rendering limitations by drawing an interactable 1000x1000 grid natively onto a GPU-accelerated Canvas.
- **Ultra-Compact State Storage**: Stores exactly 1,000,000 bits inside a Redis `BITFIELD`, bringing server RAM footprint down to a flat **125 KB**.
- **Real-Time Synchronization**: Changes made by any user instantly reflect on all other active clients via WebSockets.
- **Horizontal Scaling capability**: Uses Redis Pub/Sub (`subscribe`/`publish`) so multiple backend instances can stay perfectly in sync.
- **Custom Rate Limiting**: Built entirely from scratch using Redis time-to-live (`EXPIRE`) and counters (`INCR`) to stop spam scripts from overloading the application.
- **OAuth 2.0 / OIDC Flow**: Secure user sessions using HttpOnly JSON Web Tokens (JWT) protecting unauthorized socket writes.

## How to Run Locally

1. **Clone the Repository**
   ```bash
   git clone https://github.com/mahi0349/million-checkboxes.git
   cd million-checkboxes
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Start the Database**
   (See the *Redis Setup Instructions* section below)

4. **Start the Application**
   ```bash
   npm start
   ```

5. **Access the App**
   Open your browser and navigate to `http://localhost:3000`.

## Environment Variables Required
Create a `.env` file in the root of the project:

```env
# The port the Express/WebSocket server binds to
PORT=3000

# The connection string for your Redis database
REDIS_URL=redis://localhost:6379

# The secret key used to sign your JSON Web Tokens
JWT_SECRET=supersecret123
```

## Redis Setup Instructions
This application requires Redis to function. You can easily spin it up using the included `docker-compose.yml` file. This docker setup also maps a volume to your local drive and enables `appendonly yes` so your checkbox state survives reboots.

```bash
docker compose up -d
```
*(Ensure you have Docker Desktop installed if running on Windows).*

## Auth Flow Explanation
The application mimics a standard **OIDC / OAuth 2.0** flow. 
1. When a user clicks **Login**, they are taken to the `/auth/login` endpoint.
2. The server simulates an Identity Provider (IdP) completing a callback, generating a secure payload containing a unique ID and Username.
3. This payload is signed into a **JWT** using the `.env` secret.
4. The backend securely attaches this JWT to an `HttpOnly` cookie and redirects the user to the frontend.
5. On the frontend, WebSockets automatically pass cookies during their HTTP Upgrade Handshake. The server parses the cookie, validates the JWT, and binds the authorized user strictly to their active socket (`ws.user = user`).

## WebSocket Flow Explanation
**Connection & Bootstrapping**: Sending 1,000,000 JSON objects to every new user would annihilate server bandwidth. Instead, when a WebSocket connects, the server performs a `getBuffer` on the Redis bitfield. It sends the raw 125 KB binary chunk directly over the wire. The client converts this `ArrayBuffer` straight into a native `Uint8Array`.

**Delta Updates**: When a user clicks a box, they don't resend the entire grid. They send a tiny packet: `{ index: 450, state: true }`. The backend updates that single bit in Redis, then broadcasts that tiny JSON packet to all other connected sockets.

## Rate Limiting Logic Explanation
I opted to build custom rate limiters natively into the backend without relying on packages like `express-rate-limit`.
- **HTTP Protection**: Before hitting endpoints like `/auth/login`, the middleware tracks the client's IP. It increments a Redis key (`rl:http:<IP>`) and sets a 1-second TTL (`EXPIRE`). If the count exceeds 5, it blocks the request.
- **WebSocket Protection**: WebSocket frames don't pass through standard HTTP middleware. Inside the `ws.on('message')` handler, an identical logic checks `rl:ws:<IP>`. If an IP tries to toggle more than 20 checkboxes per second, the socket drops the messages, effectively neutralizing auto-clickers without impacting server performance.

## Screenshots / Demo
*(Placeholder: Add your screenshots here by dragging and dropping images onto GitHub!)*
