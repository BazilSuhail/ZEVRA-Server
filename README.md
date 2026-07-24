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

ZEVRA is an end-to-end encrypted messaging server. Message content is encrypted on the client; the server stores ciphertext, IVs, auth tags and signatures. Private keys are stored only in sealed form (encrypted with an Argon2id-derived key).

It is **not fully zero-knowledge** today: at registration the client sends the password to the server (over TLS), and the server generates the user's key pairs and seals them. After registration, login uses SRP and the password is not sent again. Attachments are stored unencrypted on Cloudinary. The server also sees metadata (who talks to whom, when, message sizes, reactions).

**API reference: [API.md](API.md).** It is authoritative; the files in `docs/` are older and may disagree.

## Features & Functionality

### Core Capabilities

- **SRP-6a login** — RFC 5054 2048-bit group, SHA-256. The server stores a verifier, not a password hash. Unknown usernames get a decoy response, so login/start does not reveal whether an account exists.
- **Registration (server-side keys)** — the server receives the password once, derives the SRP verifier, generates X25519 + Ed25519 key pairs and seals them with Argon2id-derived KEKs. Moving key generation to the client is an open product decision.
- **End-to-End Encryption** — AES-256-GCM message content with per-member AES-KW key envelopes (X25519-derived); Ed25519 signatures over `${channelId}:${encryptedContent}`, verified by the server on send and by clients on receive.
- **Tokens** — 15-minute JWT access tokens (`JWT_ACCESS_TTL`), 7-day single-use refresh tokens stored as SHA-256 hashes. Logout revokes all refresh tokens.
- **Real-Time Messaging** — Socket.IO with room-based broadcasting, typing indicators (auto-stop after 6 s) and presence.
- **Multiple sessions** — a user can be connected from several devices/tabs at once. There is no forced disconnect; the user goes offline when the last socket leaves.
- **Offline Message Queue** — messages for recipients with no live socket are queued in Redis (`zevra:pending:{userId}`, 7 days). Clients fetch them with `get-pending` after connecting; the server does **not** push them automatically.
- **Read Receipts** — sequence-based watermark that never moves backwards; socket and REST mark-read both reset unread counters and emit `message:read`.
- **Multi-Node Support** — Socket.IO Redis adapter; BullMQ `message-delivery` workers run on any node.
- **Rate Limiting** — atomic Redis counters. HTTP: 300/min per user (or IP); register 5/min/IP; login start/finish 10/min per IP and per username; refresh 30/min/IP; uploads 20/min/user. Socket: 20 messages/s, 10 typing events/s, 30 fetches/s, 120 connections/min per IP.
- **Key Rotation** — `POST /keys/rotate` applies the full new key bundle synchronously, guarded by key version.
- **Sender Keys** — per-group, per-epoch encrypted keys for each member.
- **Graceful Degradation** — Redis-backed rate limits fail open; the delivery queue falls back to inline delivery.
- **Emoji Reactions** — one reaction per user per message; stored in plaintext (server-visible).
- **File & Image Uploads** — Cloudinary, type detected from file bytes, 10 MB limit. Files are **not** end-to-end encrypted.
- **Health checks** — `GET /health` (liveness) and `GET /health/ready` (DB + Redis).

### Technical Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Bun | TypeScript execution |
| Framework | NestJS 11 | Modules, DI, guards, pipes |
| Database | PostgreSQL | Persistent storage |
| ORM | Drizzle ORM | Queries and SQL migrations (`bun run db:migrate`) |
| Cache | Redis | Socket registry, presence, channel member cache, message cache, unread counters, typing, pending queue, SRP state, rate limits, call state, Socket.IO adapter, BullMQ |
| Job Queue | BullMQ | 1 queue: `message-delivery` (offline queueing + unread counters) |
| Realtime | Socket.IO v4 | WebSocket gateway with Redis adapter |
| File Storage | Cloudinary | Image and file uploads (unencrypted) |
| Auth | SRP-6a + JWT | Password proof + 15 min access tokens + 7 d single-use refresh tokens |
| Crypto | Argon2id + X25519 + Ed25519 + AES-256-GCM | KDF, key exchange, signing, authenticated encryption |
| Security | Helmet + Redis rate limiter | HTTP headers, request limits |

### Workflow Diagrams

#### Authentication (SRP-6a)

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    Note over C,S: Registration (password sent once, over TLS)
    C->>S: username, email, password
    S->>S: Generate SRP salt + verifier (g^x mod N)
    S->>S: Derive KEKs via Argon2id(password, salts)
    S->>S: Generate X25519 + Ed25519 key pairs
    S->>S: Seal private keys with KEKs (AES-256-GCM)
    S->>S: Store verifier + sealed keys
    S-->>C: { user }

    Note over C,S: Login Step 1
    C->>S: username
    S->>S: Generate server ephemeral (B, b), store in Redis (120 s)
    S-->>C: { srpSalt, B }

    Note over C,S: Login Step 2
    C->>C: Compute A, M1 from password + salt + B
    C->>S: { username, A, M1 }
    S->>S: Verify M1 (constant time)
    S->>S: Compute M2 (server proof)
    S-->>C: { accessToken, refreshToken, expiresIn, keys (sealed), M2 }
    C->>C: Verify M2, derive KEKs, unseal private keys
```

#### End-to-End Encrypted Messaging

```mermaid
sequenceDiagram
    participant A as Alice (Client)
    participant S as Server
    participant B as Bob (Client)

    Note over A,B: Alice sends a message
    A->>A: Encrypt content (AES-256-GCM), wrap key per member (AES-KW)
    A->>A: Sign channelId:encryptedContent with Ed25519
    A->>S: send-message { encryptedContent, iv, tag, signature, metadata }

    Note over S: Server processing
    S->>S: Check membership, limits, Ed25519 signature
    S->>S: Persist ciphertext (sequence number per channel)
    S->>B: message:new to channel room (live sockets, all nodes)
    S->>S: Cache in Redis (last 50 messages)
    S-->>A: ack { success, message }

    Note over S: BullMQ message-delivery job
    S->>S: Increment unread counters
    S->>S: Queue for members with no live socket (zevra:pending:{userId})

    Note over B: Bob connects later
    B->>S: get-pending (repeat while hasMore)
    S-->>B: ack { messages, hasMore }
    B->>B: Unwrap key, decrypt, verify signature
```

#### Read Receipts

```mermaid
sequenceDiagram
    participant B as Bob (Client)
    participant S as Server
    participant A as Alice (Client)

    B->>S: mark-read { channelId, messageId } (or POST /channels/mark-read)
    S->>S: Verify membership
    S->>S: Advance watermark by sequence number (never regress)
    S->>S: Reset unread count in Redis
    S->>A: message:read { userId, messageId, channelId, readAt } (if advanced)
    S-->>B: { success: true, advanced }
```

#### Key Rotation

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    C->>C: Generate new X25519 + Ed25519 key pairs
    C->>C: Derive new KEKs from password + new salts, seal private keys
    C->>S: POST /keys/rotate { full key bundle, newKeyVersion }
    S->>S: UPDATE users ... WHERE key_version < newKeyVersion
    S-->>C: 200 { success, keyVersion } (400 if version not greater)

    Note over C: Client must re-encrypt sender keys for its groups
```

No client currently performs rotation (the web keys page shows key status only).

#### Sessions and Heartbeat (multiple sockets per user)

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant R as Redis

    C->>S: Connect (auth.token = access JWT)
    S->>S: Verify JWT (HS256), user active
    S->>S: Join user:{id} + every channel:{id} room
    S->>R: ZADD zevra:sockets:{userId} socketId (TTL 120 s)
    S->>R: Set zevra:presence:{userId} (TTL 90 s)
    S-->>C: connected { userId, username, socketId }
    C->>S: get-pending, get-unread

    loop Every 30 seconds
        S->>S: Check JWT exp (TOKEN_EXPIRED → error + disconnect)
        S->>R: Refresh socket score + presence TTL
    end

    Note over C,S: Disconnect
    S->>R: Remove socketId
    Note over S: Offline (user:left) only when no live sockets remain
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
        Cache[Cache/Session/Rate limits]
        Q[BullMQ Queue]
    end

    subgraph PG["PostgreSQL"]
        DB[(Database)]
    end

    GW1 <--> AD
    GW2 <--> AD
    W1 <--> Q
    W2 <--> Q
    GW1 <--> Cache
    GW2 <--> Cache
    W1 <--> Cache
    W2 <--> Cache
    GW1 --> DB
    GW2 --> DB

    AD -.->|cross-node emits| GW1
    AD -.->|cross-node emits| GW2
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
        E --> F[Verify signature + persist to PG]
        F --> K[Emit message:new to channel room]
        F --> G[Cache in Redis]
        F --> H[Enqueue BullMQ delivery job]
    end

    subgraph Delivery
        H --> J{Live socket in room?}
        J -->|No| L[Pending Queue]
        H --> U[Unread counters]
    end

    C --> D
    K --> O[Client Decrypt]
    L --> P[Client calls get-pending]
    P --> O
```

## Quick Start

```bash
# Install
bun install

# Configure: create .env with at least
#   DATABASE_URL=postgres://...
#   JWT_SECRET=<32+ random characters>
#   REDIS_URL=redis://...
# Full list in API.md → Environment variables.

# Apply migrations (do NOT use drizzle-kit push)
bun run db:migrate

# Run
bun run start:dev
```

Server runs at `http://localhost:3000` (`PORT`). Checks: `bun run typecheck`, `bun run build`, `bun test`.

`drizzle-kit push` must not be used on an existing database: migration `0003` hashes existing refresh tokens into `token_hash`, and `push` would drop the column instead.

## Documentation

**[API.md](API.md) is the authoritative reference** (endpoints, socket events, error codes, Redis keys, env vars, deploy). The files below predate the fix pass; where they differ from API.md, API.md is correct.

| Document | Description |
|----------|-------------|
| [API.md](API.md) | Current REST + Socket.IO API, errors, rate limits, Redis keys, env vars, migrations |
| [Architecture](docs/architecture.md) | System overview, module map (older) |
| [Database](docs/database.md) | Schema reference (older) |
| [REST API](docs/api-rest.md) | HTTP endpoints (older; see API.md) |
| [WebSocket API](docs/api-websocket.md) | Socket.IO events (older; see API.md) |
| [Redis](docs/redis.md) | Redis usage (older; see API.md) |
| [BullMQ](docs/bullmq.md) | Job queues (older; only `message-delivery` remains) |
| [E2EE](docs/e2ee.md) | SRP-6a auth, key management, sender keys |
| [Security](docs/security.md) | Rate limiting, Helmet, JWT lifecycle (older) |
| [Deployment](docs/deployment.md) | Setup and production build (older) |

## Security Properties and Limits

| Threat | Protection | Limit |
|--------|------------|-------|
| Database breach | Message content is ciphertext; private keys are sealed with Argon2id-derived keys; SRP verifier, not a password hash; refresh tokens stored hashed | Metadata, reactions and Cloudinary attachment URLs are readable; a weak password can be brute-forced offline against the verifier/sealed keys |
| Malicious or compromised server | Server never receives plaintext messages after registration | The server receives the password and generates the keys at registration, so a compromised server at that moment can capture them |
| MITM | TLS + E2EE | No out-of-band key verification (safety numbers) |
| Stolen device | Mobile keys in the OS secure store; access tokens in memory only | Logout revokes refresh tokens; there is no remote device revocation |
| Sender forgery | Ed25519 signature over `channelId:encryptedContent`, checked by server and clients | |
| Credential stuffing / enumeration | Rate limits per IP and per username; decoy SRP responses for unknown users | |
| Forward secrecy | Not provided — no ratchet; long-term X25519 keys wrap message keys | |

## License

MIT
