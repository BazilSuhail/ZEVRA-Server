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
  <img src="https://img.shields.io/badge/Supabase-3FCF8E?style=flat&logo=supabase&logoColor=white" alt="Supabase">
  <img src="https://img.shields.io/badge/Redis-DC382D?style=flat&logo=redis&logoColor=white" alt="Redis">
  <img src="https://img.shields.io/badge/BullMQ-orange?style=flat" alt="BullMQ">
  <img src="https://img.shields.io/badge/Bun-FBF0DF?style=flat&logo=bun&logoColor=black" alt="Bun">
</p>

---

## About

ZEVRA is a secure messaging platform built on the principle that **privacy is a right, not a feature**. The server never sees your password, never reads your messages, and never stores your private keys in plaintext. If the database is stolen, attackers get only encrypted gibberish.

---

## How It Works

```mermaid
graph LR
    A[Client] -->|1. Password| B[Argon2id]
    B -->|2. KEK| C[Encrypt Private Key]
    C -->|3. Encrypted Blob| D[(Supabase PostgreSQL)]
    A -->|4. SRP Proof| E[NestJS Server]
    E -->|5. Verify| F[JWT Token]
    F -->|6. Authenticated| G[REST API]
    G -->|7. Encrypted Message| D
    D -->|8. Realtime Push| H[Supabase Realtime]
    H -->|9. Live Update| A
    G -->|10. Job Queue| I[(Redis + BullMQ)]
    I -->|11. Workers| D
```

### Registration Flow

```mermaid
graph LR
    A[User] -->|1. username + email + password| B[Server]
    B -->|2. Generate SRP salt| C[Compute Verifier]
    B -->|3. Derive KEK via Argon2id| D[Generate X25519 + Ed25519 Keys]
    D -->|4. Encrypt private keys with KEK| E[Store: verifier + encrypted keys]
    E -->|5. Return success| A
```

### Login Flow (SRP-6a)

```mermaid
graph LR
    A[User] -->|1. username| B[Server]
    B -->|2. SRP salt + B| C[Client computes M1]
    A -->|3. password| C
    C -->|4. A + M1| B
    B -->|5. Verify M1| D{Valid?}
    D -->|Yes| E[Issue JWT + encrypted keys]
    D -->|No| F[Reject]
    E -->|6. Return to client| A
    A -->|7. Derive KEK| G[Decrypt private keys locally]
```

### Message Flow (E2EE)

```mermaid
graph LR
    A[Alice] -->|1. Encrypt with channel key| B[Encrypted Message]
    B -->|2. POST /messages| C[NestJS Server]
    C -->|3. Validate membership| D[(PostgreSQL)]
    C -->|4. Store ciphertext| D
    C -->|5. Broadcast| E[Supabase Realtime]
    E -->|6. Push| F[Bob]
    F -->|7. Decrypt with channel key| G[Plaintext Message]
```

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Runtime | [Bun](https://bun.sh) | Fast TypeScript runtime |
| Framework | [NestJS](https://nestjs.com) | Server architecture |
| Language | [TypeScript](https://typescriptlang.org) | Type safety |
| ORM | [Drizzle ORM](https://orm.drizzle.team) | Database queries |
| Database | [Supabase PostgreSQL](https://supabase.com) | Persistent storage |
| Cache/Queue | [Redis](https://redis.io) + [BullMQ](https://docs.bullmq.io) | Job queues, presence, typing |
| Realtime | [Supabase Realtime](https://supabase.com/docs/guides/realtime) | Live message broadcasting |
| Auth | [SRP-6a](https://www.ietf.org/rfc/rfc5054.txt) | Zero-knowledge authentication |
| Crypto | Argon2id + X25519 + Ed25519 | Key derivation, exchange, signing |
| Encryption | AES-256-GCM | Message and key encryption |

---

## Features

### Security

- **SRP-6a Authentication** - Server never stores or sees your password
- **Argon2id Key Derivation** - Memory-hard KDF resistant to GPU/ASIC attacks
- **X25519 ECDH** - Elliptic curve Diffie-Hellman for key exchange
- **Ed25519 Signatures** - Every message is signed, forgery impossible
- **AES-256-GCM** - Authenticated encryption for messages and private keys
- **Rate Limiting** - Brute-force protection on auth endpoints
- **Security Headers** - CSP, HSTS, X-Frame via Helmet

### Messaging

- **E2EE Messages** - Encrypted content, IV, and auth tag stored on server
- **Sequence Numbers** - Replay attack prevention per channel
- **Sender Keys** - Group message encryption with epoch-based key rotation
- **Read Receipts** - Mark messages as read, broadcast to sender
- **Soft Delete** - Messages hidden but not permanently removed

### Architecture

- **BullMQ Workers** - Async job processing for messages, key rotation, read receipts
- **Presence System** - Online/offline status via Redis
- **Typing Indicators** - Real-time typing status per channel
- **Supabase Realtime** - Server-push to connected clients

### Audit

- **Security Event Logging** - Login, register, key rotation tracked
- **Failed Login Tracking** - Brute-force detection by IP
- **Audit Query API** - Filter by action, date, user

---

## Project Structure

```
src/
├── auth/               # SRP authentication
│   ├── auth.service.ts     # Register, login, tokens
│   ├── auth.controller.ts  # REST endpoints
│   ├── srp.service.ts      # SRP-6a implementation
│   ├── srp-state.service.ts # In-memory SRP state
│   └── dto/                # Request validation
├── messages/           # E2EE messages
│   ├── messages.service.ts
│   ├── messages.controller.ts
│   └── dto/
├── channels/           # Direct + group channels
│   ├── channels.service.ts
│   ├── channels.controller.ts
│   └── dto/
├── keys/               # Key management
│   ├── keys.service.ts
│   ├── keys.controller.ts
│   └── dto/
├── crypto/             # Argon2id, X25519, Ed25519, AES-GCM
├── database/           # Drizzle schema + module
├── redis/              # Redis connection
├── queues/             # BullMQ workers
├── presence/           # Online/offline status
├── typing/             # Typing indicators
├── realtime/           # Supabase broadcast
├── audit/              # Security event logging
└── common/             # Decorators, filters, guards
```

---

## Setup Guide

### Prerequisites

- [Bun](https://bun.sh) installed
- [Supabase](https://supabase.com) project (PostgreSQL + Realtime)
- [Redis Cloud](https://redis.com/redis-enterprise-cloud) instance

### 1. Clone and Install

```bash
git clone https://github.com/BazilSuhail/ZEVRA-Server.git
cd ZEVRA-Server
bun install
```

### 2. Environment Variables

Create `.env`:

```env
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Database (Drizzle uses standard pg driver)
DATABASE_URL="postgresql://postgres.your-ref:your-password@aws-0-your-region.pooler.supabase.com:5432/postgres"

# JWT
JWT_SECRET=your-strong-random-secret
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# Redis Cloud
REDIS_URL=redis://default:your-password@your-host:port

# App
NEXT_PUBLIC_APP_NAME="ZEVRA"
NODE_ENV=development
```

> [!TIP]
> The DATABASE_URL uses the **pooler** connection (port 5432), not the direct connection. This is required for Drizzle ORM with Supabase.

### 3. Database Setup

Push schema to Supabase:

```bash
bunx drizzle-kit push
```

Generate migration:

```bash
bunx drizzle-kit generate
```

### 4. Run Server

```bash
# Development
bun run start:dev

# Production
bun run build
bun run start
```

Server runs on `http://localhost:3000`

---

## Security Guarantees

| Threat | Protection |
|--------|------------|
| Database breach | All private data encrypted; SRP verifier cannot reverse to password |
| MITM attack | E2EE + key verification (safety numbers) |
| Stolen device | Password + 2FA protects KEK; remote revocation |
| Insider threat | Employees see only ciphertext and metadata |
| Forward secrecy | Sender keys ratchet per epoch; DM keys per-session |
| Replay attacks | Sequence numbers per channel |
| Sender forgery | Ed25519 signatures on every message |
| Government request | Server has no decryption keys |
| Credential stuffing | SRP (no password hash stored) |

---

## API Endpoints

### Auth

| Method | Endpoint | Description | Rate Limit |
|--------|----------|-------------|------------|
| POST | `/api/auth/register` | Create account | 5 / 5 min |
| POST | `/api/auth/login/start` | SRP login step 1 | 10 / min |
| POST | `/api/auth/login/finish` | SRP login step 2 | 10 / min |
| GET | `/api/auth/me` | Get current user | - |
| POST | `/api/auth/logout` | Logout | - |
| POST | `/api/auth/refresh` | Refresh tokens | 20 / min |

### Messages

| Method | Endpoint | Description | Rate Limit |
|--------|----------|-------------|------------|
| POST | `/messages` | Send encrypted message | 60 / min |
| GET | `/messages/channel/:id` | Get messages (paginated) | 60 / min |
| GET | `/messages/unread` | Unread counts | 60 / min |
| POST | `/messages/channel/:id/read/:msgId` | Mark as read | 60 / min |
| DELETE | `/messages/:id` | Delete message | 60 / min |

### Channels

| Method | Endpoint | Description | Rate Limit |
|--------|----------|-------------|------------|
| POST | `/channels` | Create channel | 60 / min |
| GET | `/channels` | Get inbox | 60 / min |
| GET | `/channels/:id` | Get channel info | 60 / min |
| POST | `/channels/:id/members` | Add member | 60 / min |
| DELETE | `/channels/:id/members/:userId` | Remove member | 60 / min |
| POST | `/channels/:id/archive` | Archive channel | 60 / min |

### Keys

| Method | Endpoint | Description | Rate Limit |
|--------|----------|-------------|------------|
| GET | `/keys/me` | Get own keys | 60 / min |
| PUT | `/keys/me` | Upload keys | 60 / min |
| POST | `/keys/rotate` | Rotate keys | 60 / min |
| GET | `/keys/public?userIds=` | Get public keys | 60 / min |
| POST | `/keys/sender-keys` | Upload sender keys | 60 / min |
| GET | `/keys/sender-keys/:groupId` | Get sender keys | 60 / min |

### Users

| Method | Endpoint | Description | Rate Limit |
|--------|----------|-------------|------------|
| GET | `/api/users/me` | Get profile | 60 / min |
| GET | `/api/users/search?q=` | Search users | 60 / min |
| GET | `/api/users/:id` | Get user by ID | 60 / min |

### Audit

| Method | Endpoint | Description | Rate Limit |
|--------|----------|-------------|------------|
| GET | `/api/audit/logs` | Get audit logs | 30 / min |
| GET | `/api/audit/security` | Get security events | 10 / min |

Full details: [API.md](./API.md)

---

## License

MIT
