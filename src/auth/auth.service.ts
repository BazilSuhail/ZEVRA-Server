import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Logger,
  Inject,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DB } from '../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users, refreshTokens, auditLog } from '../database/schema';
import { eq, and, lt } from 'drizzle-orm';
import { CryptoService } from '../crypto/crypto.service';
import { SrpService } from './srp.service';
import { SrpStateService } from './srp-state.service';
import * as crypto from 'node:crypto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DB) private db: NodePgDatabase,
    private crypto: CryptoService,
    private jwt: JwtService,
    private srp: SrpService,
    private srpState: SrpStateService,
  ) {}

  // ─── Registration ─────────────────────────────────────────────────────────

  async register(username: string, email: string, password: string) {
    const [existing] = await this.db
      .select({ id: users.id, username: users.username, email: users.email })
      .from(users)
      .where(
        or(eq(users.username, username), eq(users.email, email)) as any,
      );

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

    // 4. Insert user
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

    this.logger.log(`User registered: ${user.username}`);
    return { user };
  }

  // ─── SRP Login Start ─────────────────────────────────────────────────────

  async loginStart(username: string) {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.username, username));
    if (!user) throw new UnauthorizedException('User not found');

    const v = BigInt('0x' + user.srpVerifier);
    const { B, b } = this.srp.generateServerEphemeral(v);

    this.srpState.set(user.id, { b, B });

    return {
      userId: user.id,
      username: user.username,
      srpSalt: user.srpSalt,
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
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.username, params.username));
    if (!user) throw new UnauthorizedException('User not found');

    const state = this.srpState.get(user.id);
    if (!state) {
      throw new UnauthorizedException('Session expired. Please start login again.');
    }

    const A = BigInt('0x' + params.A);
    const v = BigInt('0x' + user.srpVerifier);

    const result = this.srp.verifyClientProof({
      A,
      M1: params.M1,
      b: state.b,
      B: state.B,
      v,
      srpSalt: user.srpSalt,
      username: user.username,
    });

    this.srpState.delete(user.id);

    if (!result.valid) {
      await this.audit('LOGIN_FAILED', user.id, { reason: 'Invalid SRP proof' }, params.ip);
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.issueTokens(user.id);

    await this.db
      .update(users)
      .set({ lastLoginAt: new Date(), status: 'ONLINE' })
      .where(eq(users.id, user.id));

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

    this.logger.log(`User logged in: ${user.username}`);
    return {
      user: { id: user.id, username: user.username, email: user.email },
      ...tokens,
      keys,
      M2: result.M2,
    };
  }

  // ─── Token Management ────────────────────────────────────────────────────

  async issueTokens(userId: string) {
    const payload = { sub: userId };
    const accessToken = await this.jwt.signAsync(payload);
    const refreshToken = this.crypto.randomHex(32);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.db.insert(refreshTokens).values({
      token: refreshToken,
      userId,
      expiresAt,
    });

    return { accessToken, refreshToken };
  }

  async refreshTokens(refreshToken: string) {
    const [record] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.token, refreshToken));

    if (!record || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    await this.db.delete(refreshTokens).where(eq(refreshTokens.id, record.id));
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
    return user;
  }

  // ─── Logout ──────────────────────────────────────────────────────────────

  async logout(userId: string) {
    await this.db.update(users).set({ status: 'OFFLINE' }).where(eq(users.id, userId));
    await this.db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  }

  // ─── Audit ───────────────────────────────────────────────────────────────

  private async audit(
    action: string,
    userId?: string,
    details?: object,
    ip?: string,
  ) {
    try {
      await this.db.insert(auditLog).values({
        action,
        userId: userId ?? null,
        details: (details as any) ?? null,
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

function or(...conditions: any[]) {
  return conditions.reduce((a, b) => ({ or: [a, b] }));
}
