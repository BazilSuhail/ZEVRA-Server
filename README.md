<p align="center">
  <h1 align="center">ZEVRA</h1>
  <p align="center"><b>Z</b>ero-knowledge <b>E</b>vents <b>V</b>erified <b>R</b>ealtime <b>A</b>rchitecture</p>
  <p align="center">End-to-End Encrypted Messaging Server</p>
</p>

<p align="center">
  <a href="https://github.com/BazilSuhail/ZEVRA-Server">
    <img src="https://img.shields.io/badge/Server-ZEVRA--Server-black?style=for-the-badge" alt="Server Repo">
  </a>
  <a href="https://github.com/BazilSuhail/ZEVRA">
    <img src="https://img.shields.io/badge/Client-ZEVRA-blue?style=for-the-badge" alt="Client Repo">
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/NestJS-E0234E?style=flat&logo=nestjs&logoColor=white" alt="NestJS">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/PostgreSQL-4169E1?style=flat&logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Redis-DC382D?style=flat&logo=redis&logoColor=white" alt="Redis">
  <img src="https://img.shields.io/badge/BullMQ-orange?style=flat" alt="BullMQ">
  <img src="https://img.shields.io/badge/Bun-FBF0DF?style=flat&logo=bun&logoColor=black" alt="Bun">
</p>

---

## About

ZEVRA is a secure messaging platform built on the principle that **privacy is a right, not a feature**. The server never sees your password, never reads your messages, and never stores your private keys in plaintext. If the database is stolen, attackers get only encrypted gibberish.

## Features & Functionality

### Core Capabilities

- **Zero-Knowledge Authentication** — SRP-6a protocol (RFC 5054, 2048-bit MODP group). Server verifies password without ever seeing or storing it. No password hashes, no bcrypt, no plaintext.
- **End-to-End Encryption** — All message content encrypted client-side with AES-256-GCM. Server stores only ciphertext + IV + auth tag. Zero access to plaintext.
- **Dual Key Pairs** — X25519 for key exchange (ECDH shared secrets), Ed25519 for message signing (non-repudiation). Private keys sealed with Argon2id-derived KEK.
- **Real-Time Messaging** — Socket.io WebSocket gateway with room-based channel broadcasting, typing indicators, and presence tracking.
- **Async Message Delivery** — Sync persist to PostgreSQL + cache in Redis, then async fan-out via BullMQ workers. Sender gets ACK in <50ms.
- **Offline Message Queue** — Messages for offline users queued in Redis sorted sets (scored by sequence number). Delivered on reconnect.
- **Read Receipts** — Per-message read tracking with waterhead advancement (never regresses). Broadcast to senders via BullMQ + Redis PubSub.
- **Multi-Node Support** — Socket.io Redis adapter syncs rooms across instances. Redis PubSub handles cross-node fan-out. BullMQ workers run on any node.
- **Sliding Window Rate Limiting** — Redis sorted-set based. Per-route limits: 500 msg/s, 200 typing/s, 1000 fetch/s, 2000 connections/min per IP.
- **Circuit Breaker** — 5 failures → OPEN (30s) → HALF_OPEN → CLOSED. Prevents cascading downstream failures.
- **Key Rotation** — Async via BullMQ. Client generates new keys, server updates atomically. Brief window where old keys valid (acceptable for infrequent rotation).
- **Sender Key Ratchet** — Group E2EE with epoch-based key rotation. Keys re-encrypted for each member on rotation.
- **Graceful Degradation** — All Redis-backed features fail open (allow requests, return safe defaults) when Redis is unavailable.

### Technical Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Bun | Fast TypeScript execution |
| Framework | NestJS 11 | Modular architecture, DI, guards, pipes |
| Database | PostgreSQL (Neon) | Persistent storage, 9 tables, 12 foreign keys |
| ORM | Drizzle ORM | Type-safe queries, migrations, schema push |
| Cache/PubSub | Redis (Redis Labs) | 8 distinct roles: sessions, presence, cache, pub/sub, rate limits, channel members, pending msgs, Socket.io adapter |
| Job Queue | BullMQ | 3 queues: message-delivery (10 workers), read-receipt (5 workers), key-rotation (1 worker) |
| Realtime | Socket.io v4 | WebSocket gateway with Redis adapter for multi-node |
| Auth | SRP-6a + JWT | Zero-knowledge password proof + 15min access tokens + 7d refresh tokens |
| Crypto | Argon2id + X25519 + Ed25519 + AES-256-GCM | KDF, key exchange, signing, authenticated encryption |
| Security | Helmet + Rate Limiter + Circuit Breaker | HTTP headers, sliding window limits, failure isolation |

### Workflow Diagrams

#### Zero-Knowledge Authentication (SRP-6a)

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    Note over C,S: Registration
    C->>S: username, email, password
    S->>S: Generate SRP salt + verifier (g^x mod N)
    S->>S: Derive KEK via Argon2id(password, salt)
    S->>S: Generate X25519 + Ed25519 key pairs
    S->>S: Encrypt private keys with KEK (AES-256-GCM)
    S->>S: Store: verifier + encrypted keys (never plaintext)
    S-->>C: { user }

    Note over C,S: Login Step 1
    C->>S: username
    S->>S: Generate server ephemeral (B, b)
    S-->>C: { srpSalt, B }

    Note over C,S: Login Step 2
    C->>C: Compute M1 from password + salt + A + B
    C->>S: { A, M1 }
    S->>S: Verify M1 (never sees password)
    S->>S: Compute M2 (server proof)
    S-->>C: { JWT, refreshToken, encryptedKeys, M2 }
    C->>C: Verify M2, derive KEK, decrypt private keys
```

#### End-to-End Encrypted Messaging

```mermaid
sequenceDiagram
    participant A as Alice (Client)
    participant S as Server
    participant B as Bob (Client)

    Note over A,B: Alice sends a message
    A->>A: Encrypt with channel key (AES-256-GCM)
    A->>A: Sign with Ed25519 private key
    A->>S: { encryptedContent, iv, tag, signature }

    Note over S: Server processing
    S->>S: Verify Ed25519 signature
    S->>S: Persist ciphertext to PostgreSQL
    S->>S: Cache in Redis (last 50 messages)
    S->>S: Enqueue to BullMQ (message-delivery)

    Note over S: Async fan-out (BullMQ worker)
    S->>S: Get channel members (Redis → Postgres)
    S->>S: Check online status (Redis)

    alt Bob is online
        S->>B: message:new (via Socket.io)
    else Bob is offline
        S->>S: Queue to Redis sorted set (pending:{userId})
    end

    S->>S: Increment unread count (Redis INCR)
    S->>S: Broadcast to channel room
    S->>S: Publish to Redis PubSub (cross-node)

    Note over B: Bob reconnects
    B->>S: get-pending
    S->>B: messages:pending (queued messages)
    B->>B: Decrypt with X25519 shared secret
```

#### Read Receipts

```mermaid
sequenceDiagram
    participant B as Bob (Client)
    participant S as Server
    participant A as Alice (Client)

    B->>S: mark-read { channelId, messageId }
    S->>S: Verify membership
    S->>S: Only advance forward (never regress)
    S->>S: DB Transaction: UPDATE membership + INSERT readReceipt
    S->>S: Reset unread count in Redis
    S->>S: Enqueue to BullMQ (read-receipt)

    Note over S: Async broadcast (BullMQ worker)
    S->>S: Cache receipt in Redis hash
    S->>S: Broadcast to channel room
    S->>S: Publish to Redis PubSub (cross-node)

    S-->>B: { success: true, advanced: true }
    S->>A: message:read { userId, messageId, readAt }
```

#### Key Rotation

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant Q as BullMQ Worker

    C->>C: Generate new X25519 + Ed25519 key pairs
    C->>C: Derive new KEK from password + new salt
    C->>C: Encrypt new private keys with new KEK
    C->>S: POST /keys/rotate { newKeys, newVersion }

    S->>Q: Enqueue key-rotation job

    Note over Q: Async (BullMQ worker)
    Q->>S: UPDATE users SET publicKey, encryptedKeys, version

    S-->>C: { queued: true }

    Note over C: Client must re-encrypt sender keys for all groups
```

#### Single-Device Session with Heartbeat

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant R as Redis

    C->>S: Connect (JWT in handshake)
    S->>R: Check existing session
    alt Session exists
        S->>S: Emit forced-disconnect to old socket
        S->>S: Disconnect old socket
    end
    S->>R: Register session (10min TTL)
    S->>R: Set presence online (30s TTL)
    S-->>C: connected { userId, socketId }

    loop Every 30 seconds
        S->>R: Renew session TTL → 10min
        S->>R: Renew presence TTL → 30s
        S-->>C: heartbeat-ack
    end

    Note over C,S: If heartbeat stops
    S->>R: Session expires (10min)
    S->>R: Presence expires (30s)
    Note over S: User appears offline
```

#### Multi-Node Architecture

```mermaid
graph TB
    subgraph Node1["Server Node 1"]
        GW1[Socket Gateway]
        W1[BullMQ Workers]
    end

    subgraph Node2["Server Node 2"]
        GW2[Socket Gateway]
        W2[BullMQ Workers]
    end

    subgraph Redis["Redis"]
        AD[Socket.io Adapter]
        PS[PubSub]
        Cache[Cache/Session]
        Q[BullMQ Queues]
    end

    subgraph PG["PostgreSQL"]
        DB[(Database)]
    end

    GW1 <--> AD
    GW2 <--> AD
    W1 <--> Q
    W2 <--> Q
    W1 <--> PS
    W2 <--> PS
    GW1 <--> Cache
    GW2 <--> Cache
    W1 --> DB
    W2 --> DB

    AD -.->|sync rooms| GW1
    AD -.->|sync rooms| GW2
    PS -.->|fan-out| GW1
    PS -.->|fan-out| GW2
```

#### System Overview

```mermaid
graph LR
    subgraph Client
        A[SRP Auth] --> B[E2EE Encrypt]
        B --> C[Sign Message]
    end

    subgraph Server
        D[JWT Verify] --> E[Rate Limit]
        E --> F[Persist to PG]
        F --> G[Cache in Redis]
        G --> H[Enqueue BullMQ]
        H --> I[Worker Fan-out]
    end

    subgraph Delivery
        I --> J{Online?}
        J -->|Yes| K[Socket.io Push]
        J -->|No| L[Pending Queue]
        I --> M[Redis PubSub]
        M --> N[Cross-node Broadcast]
    end

    C --> D
    K --> O[Client Decrypt]
    L --> P[Reconnect → Get Pending]
    P --> O
```

## Quick Start

```bash
# Install
bun install

# Configure
cp .env.example .env   # Add your Neon + Redis credentials

# Push schema
bunx drizzle-kit push

# Run
bun run start:dev
```

Server runs at `http://localhost:3000`.

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System overview, module map, request lifecycle, design tradeoffs |
| [Database](docs/database.md) | Schema reference, 9 tables, relationships, migrations |
| [REST API](docs/api-rest.md) | All HTTP endpoints, request/response formats, rate limits |
| [WebSocket API](docs/api-websocket.md) | Socket.io events, connection lifecycle, all client/server events |
| [Redis](docs/redis.md) | 8 Redis roles, key patterns, TTLs, data structures |
| [BullMQ](docs/bullmq.md) | 3 job queues, worker flows, retry config |
| [E2EE](docs/e2ee.md) | SRP-6a auth, key management, sender keys, encryption flow |
| [Security](docs/security.md) | Rate limiting, circuit breaker, Helmet, JWT lifecycle |
| [Deployment](docs/deployment.md) | Setup, env vars, Neon/Redis config, production build |

## Security Guarantees

| Threat | Protection |
|--------|------------|
| Database breach | All private data encrypted; SRP verifier cannot reverse to password |
| MITM | E2EE + key verification |
| Stolen device | Password protects KEK; remote revocation via key rotation |
| Insider threat | Employees see only ciphertext and metadata |
| Forward secrecy | Sender keys ratchet per epoch |
| Replay attacks | Sequence numbers per channel |
| Sender forgery | Ed25519 signatures on every message |
| Credential stuffing | SRP (no password hash stored) |

## License

MIT
