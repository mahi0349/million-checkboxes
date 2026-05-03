# million-checkboxes

A real-time, highly scalable 1 million checkbox web application built with Node.js, Express, WebSockets, Redis, and HTML5 Canvas.

## Features
- Scalable 1,000,000 checkbox grid rendered via Canvas API
- Real-time bidirectional WebSocket updates
- 125KB Redis `BITFIELD` state storage
- Redis Pub/Sub for horizontal scaling
- Custom Sliding Window Rate Limiting
- OAuth 2.0 Mock Authentication flow

## Run Locally
1. Run `docker compose up -d` to spin up Redis
2. Run `npm install`
3. Run `npm start`
4. Visit `http://localhost:3000`
