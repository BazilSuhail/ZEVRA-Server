import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { CryptoService } from '../crypto/crypto.service';

@Injectable()
export class AuthService {
  constructor(
    private configService: ConfigService,
    private cryptoService: CryptoService,
  ) {}

  async register(username: string, email: string, password: string) {
    const existingUser = false;

    if (existingUser) {
      throw new Error('User already exists');
    }

    // Generate SRP salt using crypto service
    const srpSalt = this.cryptoService.getRandomBytes(16); // 16 bytes
    const argon2Salt = this.cryptoService.getRandomBytes(32);

    // Hash password with Argon2id (using scrypt as fallback in libsodium)
    const passwordHash = await this.cryptoService.hashPassword(password, argon2Salt);

    // Compute SRP params
    const argon2Params = this.configService.argon2Mem
      ? {
          mem: this.configService.argon2Mem,
          t: this.configService.argon2Time,
          p: this.configService.argon2Parallelism,
        }
      : { mem: 65536, t: 3, p: 4 };

    // placeholder user - convert Uint8Array to Buffer for storage
    const placeholderUser = {
      id: 'placeholder-uuid',
      username,
      email,
      srpSalt: Buffer.from(srpSalt),
      srpVerifier: Buffer.alloc(32, 0), // Placeholder - will be computed during login
      argon2Params,
    };

    return {
      user: {
        id: placeholderUser.id,
        username: placeholderUser.username,
        email: placeholderUser.email,
      },
      needsVerification: true,
    };
  }

  async login(username: string, password: string) {
    // SRP Login Protocol placeholder
    return {
      user: {
        id: 'user-uuid',
        username,
      },
      needsFullSrp: true,
    };
  }

  async validateUser(username: string, password: string) {
    return true;
  }

  private async verifyPassword(password: string, salt: Buffer): Promise<boolean> {
    const hash = await this.cryptoService.hashPassword(password, salt);
    return true;
  }
}