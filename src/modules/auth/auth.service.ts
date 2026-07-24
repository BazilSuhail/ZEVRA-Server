import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Logger,
  Inject,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users, refreshTokens, auditLog } from '../../database/schema';
import { eq, and, lt, or } from 'drizzle-orm';
import { CryptoService } from '../../shared/crypto/crypto.service';
import { SrpService } from './srp.service';
import { SrpStateService } from './srp-state.service';
import { RedisSessionService } from '../../redis/redis-session.service';
import { getAccessTokenTtl } from '../../common/config';
import * as crypto from 'node:crypto';

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVALID_CREDENTIALS = 'Invalid username or password';
const INVALID_REFRESH = 'Invalid or expired refresh token';

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DB) private db: NodePgDatabase,
    private crypto: CryptoService,
    private jwt: JwtService,
    private srp: SrpService,
    private srpState: SrpStateService,
    private sessionService: RedisSessionService,
  ) {}

  // ─── Registration ─────────────────────────────────────────────────────────

  async register(username: string, email: string, password: string) {
    const [existing] = await this.db
      .select({ id: users.id, username: users.username, email: users.email })
      .from(users)
      .where(or(eq(users.username, username), eq(users.email, email)));

    if (existing) {
      throw new ConflictException(
        existing.username === username
          ? 'Username already taken'
          : 'Email already registered',
      );
    }

    // 1. SRP verifier
    const srpSalt = this.crypto.randomHex(16);
    const xHash = crypto
      .createHash('sha256')
      .update(srpSalt + password)
      .digest();
    const x = BigInt('0x' + xHash.toString('hex'));
    const srpVerifier = this.srp.computeVerifier(x);

    // 2. KEK from Argon2id
    const keySalt = this.crypto.randomBytes(32).toString('base64');
    const kek = await this.crypto.deriveKEK(password, Buffer.from(keySalt, 'base64'));

    const keySaltSign = this.crypto.randomBytes(32).toString('base64');
    const kekSign = await this.crypto.deriveKEK(password, Buffer.from(keySaltSign, 'base64'));

    // 3. Generate keypairs
    const x25519 = this.crypto.generateX25519KeyPair();
    const sealedX25519 = this.crypto.sealPrivateKey(x25519.privateKey, kek);

    const ed25519 = this.crypto.generateEd25519KeyPair();
    const sealedEd25519 = this.crypto.sealPrivateKey(ed25519.privateKey, kekSign);

    // 4. Insert user (a concurrent duplicate surfaces as a 23505 → 409)
    const [user] = await this.db
      .insert(users)
      .values({
        username,
        email,
        srpSalt,
        srpVerifier: bigintToHex(srpVerifier),
        argon2Params: { m: 65536, t: 3, p: 4 },
        publicKey: x25519.publicKey.toString('base64'),
        encryptedPrivateKey: sealedX25519,
        keySalt,
        publicKeySign: ed25519.publicKey.toString('base64'),
        encryptedPrivateKeySign: sealedEd25519,
        keySaltSign,
        keyVersion: 1,
      })
      .returning({
        id: users.id,
        username: users.username,
        email: users.email,
        createdAt: users.createdAt,
      });

    await this.audit('REGISTER', user.id);

    this.logger.log(`User registered: ${user.id}`);
    return { user };
  }

  // ─── SRP Login Start ─────────────────────────────────────────────────────

  /**
   * Unknown or inactive usernames get a deterministic decoy salt and a fresh
   * B computed from a decoy verifier, so the response is indistinguishable
   * from a real account. login/finish then fails with the generic error.
   */
  async loginStart(username: string) {
    const [user] = await this.db
      .select({
        id: users.id,
        username: users.username,
        srpSalt: users.srpSalt,
        srpVerifier: users.srpVerifier,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.username, username));

    let srpSalt: string;
    let verifier: bigint;
    let userId: string | null;
    if (user && user.isActive) {
      srpSalt = user.srpSalt;
      verifier = BigInt('0x' + user.srpVerifier);
      userId = user.id;
    } else {
      const decoy = this.srp.decoyCredentials(username, process.env.JWT_SECRET ?? '');
      srpSalt = decoy.srpSalt;
      verifier = decoy.verifier;
      userId = null;
    }

    const { B, b } = this.srp.generateServerEphemeral(verifier);
    await this.srpState.set(username, { b, B, userId });

    return {
      username,
      srpSalt,
      B: bigintToHex(B),
    };
  }

  // ─── SRP Login Finish ────────────────────────────────────────────────────

  async loginFinish(params: {
    username: string;
    A: string;
    M1: string;
    ip?: string;
  }) {
    const state = await this.srpState.consume(params.username);
    if (!state) {
      throw new UnauthorizedException('Login session expired. Please try again.');
    }

    const A = this.srp.parseClientEphemeral(params.A);
    if (A === null) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const [user] = state.userId
      ? await this.db.select().from(users).where(eq(users.id, state.userId))
      : [];

    if (!user || !user.isActive || user.username !== params.username) {
      // Spend comparable work on the decoy path to avoid a timing oracle.
      const decoy = this.srp.decoyCredentials(params.username, process.env.JWT_SECRET ?? '');
      this.srp.verifyClientProof({
        A,
        M1: params.M1,
        b: state.b,
        B: state.B,
        v: decoy.verifier,
        srpSalt: decoy.srpSalt,
        username: params.username,
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const result = this.srp.verifyClientProof({
      A,
      M1: params.M1,
      b: state.b,
      B: state.B,
      v: BigInt('0x' + user.srpVerifier),
      srpSalt: user.srpSalt,
      username: user.username,
    });

    if (!result.valid) {
      await this.audit('LOGIN_FAILED', user.id, { reason: 'Invalid SRP proof' }, params.ip);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const tokens = await this.issueTokens(user.id);

    await this.db
      .update(users)
      .set({ lastLoginAt: new Date(), status: 'ONLINE' })
      .where(eq(users.id, user.id));

    await this.sessionService.setOnline(user.id);

    const keys = {
      publicKey: user.publicKey,
      publicKeySign: user.publicKeySign,
      encryptedPrivateKey: user.encryptedPrivateKey,
      keySalt: user.keySalt,
      encryptedPrivateKeySign: user.encryptedPrivateKeySign,
      keySaltSign: user.keySaltSign,
      argon2Params: user.argon2Params,
      keyVersion: user.keyVersion,
    };

    await this.audit('LOGIN', user.id, undefined, params.ip);

    this.logger.log(`User logged in: ${user.id}`);
    return {
      user: { id: user.id, username: user.username, email: user.email },
      ...tokens,
      keys,
      M2: result.M2,
    };
  }

  // ─── Token Management ────────────────────────────────────────────────────

  async issueTokens(userId: string) {
    const expiresIn = getAccessTokenTtl();
    const accessToken = await this.jwt.signAsync({ sub: userId }, { expiresIn });
    const refreshToken = this.crypto.randomHex(32);
    const now = Date.now();

    // Opportunistically prune this user's expired refresh tokens.
    await this.db
      .delete(refreshTokens)
      .where(and(eq(refreshTokens.userId, userId), lt(refreshTokens.expiresAt, new Date(now))));

    await this.db.insert(refreshTokens).values({
      tokenHash: hashRefreshToken(refreshToken),
      userId,
      expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
    });

    return { accessToken, refreshToken, expiresIn };
  }

  /**
   * Rotates a refresh token. The old token is deleted in the same statement
   * that looks it up, so a token can be redeemed at most once even under
   * concurrent requests.
   */
  async refreshTokens(refreshToken: string) {
    const [record] = await this.db
      .delete(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(refreshToken)))
      .returning({ userId: refreshTokens.userId, expiresAt: refreshTokens.expiresAt });

    if (!record || record.expiresAt < new Date()) {
      throw new UnauthorizedException(INVALID_REFRESH);
    }

    const [user] = await this.db
      .select({ isActive: users.isActive })
      .from(users)
      .where(eq(users.id, record.userId));
    if (!user || !user.isActive) {
      await this.db.delete(refreshTokens).where(eq(refreshTokens.userId, record.userId));
      throw new UnauthorizedException(INVALID_REFRESH);
    }

    return this.issueTokens(record.userId);
  }

  // ─── Profile ─────────────────────────────────────────────────────────────

  async getProfile(userId: string) {
    const [user] = await this.db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        status: users.status,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
        keyVersion: users.keyVersion,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) throw new UnauthorizedException('Authentication required');
    return user;
  }

  // ─── Logout ──────────────────────────────────────────────────────────────

  async logout(userId: string) {
    await this.audit('LOGOUT', userId);
    await this.db.update(users).set({ status: 'OFFLINE' }).where(eq(users.id, userId));
    await this.db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
    await this.sessionService.setOffline(userId);
  }

  // ─── Audit ───────────────────────────────────────────────────────────────

  private async audit(
    action: string,
    userId?: string,
    details?: Record<string, unknown>,
    ip?: string,
  ) {
    try {
      await this.db.insert(auditLog).values({
        action,
        userId: userId ?? null,
        details: details ?? null,
        ipAddress: ip ?? null,
      });
    } catch (err) {
      this.logger.warn(`Audit log failed: ${(err as Error).message}`);
    }
  }
}

function bigintToHex(n: bigint): string {
  return n.toString(16).padStart(2, '0');
}
