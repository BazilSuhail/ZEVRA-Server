# End-to-End Encryption

ZEVRA implements a zero-knowledge architecture. The server never sees plaintext passwords, messages, or private keys.

## Cryptographic Primitives

| Primitive | Usage | Library |
|-----------|-------|---------|
| SRP-6a | Password authentication (zero-knowledge) | Custom implementation (RFC 5054, 2048-bit MODP) |
| Argon2id | Key derivation (password → KEK) | `argon2` npm package |
| X25519 | Key exchange (ECDH) | Node.js `crypto` |
| Ed25519 | Digital signatures | Node.js `crypto` |
| AES-256-GCM | Authenticated encryption | Node.js `crypto` |
| SHA-256 | Hashing (SRP, key derivation) | Node.js `crypto` |

---

## Registration Flow

```
Client                              Server
  │                                    │
  │  username, email, password         │
  │  ──────────────────────────────►   │
  │                                    │
  │  1. Generate SRP salt (random 16 bytes)
  │  2. x = SHA-256(salt + password)
  │  3. v = g^x mod N (SRP verifier)
  │  4. keySalt = random 32 bytes
  │  5. kek = Argon2id(password, keySalt)
  │  6. x25519 = generate X25519 key pair
  │  7. ed25519 = generate Ed25519 key pair
  │  8. sealedX25519 = AES-GCM(x25519.privateKey, kek)
  │  9. sealedEd25519 = AES-GCM(ed25519.privateKey, kek)
  │ 10. INSERT user (verifier + encrypted keys)
  │                                    │
  │  { user: { id, username, email } } │
  │  ◄──────────────────────────────   │
```

**What the server stores:**
- `srp_salt` — SRP salt (not secret, used in protocol)
- `srp_verifier` — g^x mod N (cannot reverse to password)
- `public_key` — X25519 public key (public)
- `encrypted_private_key` — X25519 private key sealed with KEK (ciphertext)
- `key_salt` — Argon2id salt (not secret)
- `public_key_sign` — Ed25519 public key (public)
- `encrypted_private_key_sign` — Ed25519 private key sealed with KEK (ciphertext)
- `key_salt_sign` — Argon2id salt for signing key
- `argon2_params` — Argon2id parameters (m=65536, t=3, p=4)

**What the server never sees:**
- The plaintext password
- The raw private keys
- The KEK (derived from password, never stored)

---

## Login Flow (SRP-6a)

### Step 1: Client → Server (login/start)

```
Client sends: username
Server responds: { userId, username, srpSalt, B }
```

Server generates:
- `b` = random 32 bytes (server secret ephemeral)
- `B` = (k * v + g^b) mod N (server public ephemeral)
- Stores `{ b, B }` in memory with 5-minute TTL

### Step 2: Client → Server (login/finish)

```
Client sends: { username, A, M1 }
```

Client computes (using password):
- `x` = SHA-256(salt + password)
- `A` = g^a mod N (client public ephemeral)
- `u` = SHA-256(A, B)
- `S` = (A * v^u)^a mod N (shared secret)
- `K` = SHA-256(S) (session key)
- `M1` = SHA-256(H(N) XOR H(g), H(salt), A, B, K) (client proof)

### Step 3: Server verifies

```
Server computes:
  u = SHA-256(A, B)
  S = (A * v^u)^b mod N
  K = SHA-256(S)
  expectedM1 = SHA-256(H(N) XOR H(g), H(salt), A, B, K)

  if M1 == expectedM1:
    M2 = SHA-256(A, M1, K)  (server proof)
    → Issue JWT + refresh token
    → Return { user, tokens, keys, M2 }
  else:
    → Reject (401 Unauthorized)
```

**Security properties:**
- Password never leaves the client
- Server never computes or stores the password
- The verifier `v = g^x mod N` cannot be reversed to `x` (discrete log problem)
- Both parties prove knowledge of the password without revealing it
- Session key `K` is established for potential future use

---

## Key Architecture

### Dual Key Pairs

Each user has two key pairs:

| Key Pair | Purpose | Server stores |
|----------|---------|---------------|
| X25519 | Key exchange (ECDH shared secrets) | Public + encrypted private |
| Ed25519 | Message signing (non-repudiation) | Public + encrypted private |

### Key Encryption

Private keys are encrypted with a Key Encryption Key (KEK) derived from the user's password:

```
password → Argon2id(salt) → KEK (32 bytes)
private_key → AES-256-GCM(KEK) → "iv:tag:ciphertext" (base64)
```

**AES-256-GCM parameters:**
- Key: 32 bytes (from Argon2id)
- IV: 12 bytes (random per encryption)
- Tag: 16 bytes (authentication tag)
- Format: `base64(iv):base64(tag):base64(ciphertext)`

### Key Storage Layout

```
users table:
  publicKey              → X25519 public (base64)
  encryptedPrivateKey    → "iv:tag:ciphertext" (sealed with KEK)
  keySalt                → Argon2id salt for KEK (base64)
  publicKeySign          → Ed25519 public (base64)
  encryptedPrivateKeySign → "iv:tag:ciphertext" (sealed with KEK)
  keySaltSign            → Argon2id salt for signing KEK (base64)
  keyVersion             → Integer (incremented on rotation)
```

---

## Message Encryption

### Client-Side (not implemented in server)

The client:
1. Derives a shared secret with each recipient using X25519 ECDH
2. Derives a symmetric key from the shared secret
3. Encrypts the message with AES-256-GCM
4. Signs the ciphertext with Ed25519
5. Sends: `{ encryptedContent, contentIv, contentTag, signature }`

### Server-Side

The server stores only:
- `encrypted_content` — AES-256-GCM ciphertext
- `content_iv` — Initialization vector
- `content_tag` — Authentication tag
- `signature` — Ed25519 signature over `channelId:encryptedContent:sequenceNumber`

**The server never decrypts messages.** It stores ciphertext, verifies signatures, and routes encrypted payloads.

### Signature Verification

When a message is sent, the server:
1. Looks up the sender's `public_key_sign`
2. Constructs the signed payload: `channelId:encryptedContent:sequenceNumber`
3. Verifies the Ed25519 signature
4. Rejects if invalid (`400 Bad Request: Invalid message signature`)

---

## Sender Keys (Group E2EE)

For group chats, a sender key ratchet scheme is used:

| Column | Purpose |
|--------|---------|
| `group_id` | Channel or key group ID |
| `epoch` | Key rotation epoch (incremented on rotation) |
| `encrypted_key` | Symmetric key encrypted for each receiver |
| `key_signature` | Proof of key authenticity |
| `owner_id` | Who created the key |
| `receiver_id` | Who the key is for |

**Flow:**
1. Sender generates a random symmetric key for the group
2. Encrypts it for each member using X25519 ECDH
3. Uploads to `sender_keys` table
4. All subsequent messages in the group use this key
5. On key rotation: new epoch, new key, re-encrypt for all members

---

## Key Rotation

Triggered by the client via `POST /keys/rotate`.

1. Client generates new X25519 + Ed25519 key pairs
2. Client derives new KEK from password + new salt
3. Client encrypts new private keys with new KEK
4. Client sends sealed material to server
5. Server enqueues `key-rotation` BullMQ job
6. Worker updates `users` table with new keys + incremented `keyVersion`
7. Client must re-encrypt sender keys for all groups

**Tradeoff:** Key rotation is async to avoid blocking. There's a brief window where old keys are still valid — acceptable because rotation is infrequent and the window is seconds.

---

## Threat Model

| Attack | Protection |
|--------|------------|
| Database breach | All private data encrypted; SRP verifier cannot reverse to password |
| MITM | E2EE + key verification (safety numbers) |
| Stolen device | Password protects KEK; remote revocation via key rotation |
| Insider threat | Employees see only ciphertext and metadata |
| Forward secrecy | Sender keys ratchet per epoch; DM keys per-session |
| Replay attacks | Sequence numbers per channel |
| Sender forgery | Ed25519 signatures on every message |
| Government request | Server has no decryption keys |
| Credential stuffing | SRP (no password hash stored) |

---

## Server Knowledge Summary

| Data | Server sees? |
|------|-------------|
| Plaintext password | No (SRP) |
| Private keys | No (encrypted with KEK) |
| KEK | No (derived from password, never stored) |
| Plaintext messages | No (AES-256-GCM ciphertext) |
| Message metadata | Yes (sender, channel, timestamp, sequence) |
| User identity | Yes (username, email) |
| SRP verifier | Yes (cannot reverse to password) |
| Public keys | Yes (public by design) |
