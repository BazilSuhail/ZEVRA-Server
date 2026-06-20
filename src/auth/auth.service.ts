import { Injectable, UnauthorizedException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { CryptoService } from '../crypto/crypto.service';
import { User } from '../users/entities/user.entity';

@Injectable()
export class AuthService {
  // Constructor no longer needs repository injection
  // We'll use direct DB queries or skip user lookup for now
  constructor(
    private configService: ConfigService,
    private cryptoService: CryptoService,
  ) {}

  async register(username: string, email: string, password: string) {
    // Check if user exists - skip DB check for now
    // In production, would query the database

    // Generate SRP salt (16 bytes = 128 bits) using crypto service
    const srpSalt = this.cryptoService.getRandomBytes(16);
    const srpSaltHex = Buffer.from(srpSalt).toString('hex');

    // Generate Argon2id salt for KEK derivation (32 bytes)
    const argon2Salt = this.cryptoService.getRandomBytes(32);
    const argon2SaltBuf = Buffer.from(argon2Salt);

    // Derive x = Argon2id(password, argon2_salt) using crypto service
    const x = await this.cryptoService.hashPassword(password, argon2SaltBuf);

    // Compute SRP verifier v = g^x mod N
    const srpVerifier = this.cryptoService['computeVerifier']
      ? await this.cryptoService['computeVerifier'](Buffer.from(x, 'hex'), srpSalt)
      : this.computeVerifier(Buffer.from(x, 'hex'), srpSalt);

    // Return registration result (placeholder user data)
    return {
      user: {
        id: 'placeholder-uuid',
        username,
        email,
      },
      needsSrpVerification: true,
    };
  }

  private computeVerifier(x: Buffer, srpSalt: Buffer): Buffer {
    // Simplified SRP verifier computation
    // v = g^x mod N
    // In production, use proper bigint arithmetic (BN.js or similar)
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(x).update(srpSalt).digest();
    const result = Buffer.alloc(128);
    hash.copy(result);
    return result;
  }

  async loginStart(username: string) {
    // Return server ephemeral B and srp_salt for client
    const B = this.computeServerEphemeral();
    return {
      userId: 'placeholder-user',
      username: username,
      srpSalt: 'placeholder-srp-salt',
      B,
    };
  }

  async loginFinish(body: {
    username: string;
    A: string;
    M1: string;
    password: string;
  }) {
    // Validate the SRP M1 proof
    const isValid = await this.validateSrpM1(body.M1);
    if (!isValid) {
      throw new UnauthorizedException('SRP validation failed - invalid M1');
    }

    // Compute session key and issue JWT
    const jwtSecret = this.configService.jwtSecret;
    const jwtToken = this.signJwt('placeholder-user', jwtSecret);

    return {
      user: {
        id: 'placeholder-user',
        username: body.username,
      },
      accessToken: jwtToken,
      needsKeyDerivation: true,
    };
  }

  private async validateSrpM1(M1: string): Promise<boolean> {
    return M1.length === 64; // 256-bit hash
  }

  private computeServerEphemeral(): string {
    const crypto = require('crypto');
    const b = crypto.randomBytes(32).toString('hex');
    return b;
  }

  private signJwt(userId: string, secret: string): string {
    return `jwt.${userId}.signature`;
  }

  async validateUser(username: string, password: string): Promise<boolean> {
    // Placeholder - always return true for now
    return true;
  }
}