import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

export interface SrpState {
  b: bigint;
  B: bigint;
  /** null when the login was started for an unknown/inactive username. */
  userId: string | null;
}

interface StoredSrpState {
  b: string;
  B: string;
  userId: string | null;
}

export const SRP_STATE_TTL_SECONDS = 120;

/**
 * SRP handshake state kept in Redis under `zevra:srp:{username}` so it works
 * across instances. Entries expire after 120s and are consumed exactly once
 * (GETDEL) when the login is finished.
 */
@Injectable()
export class SrpStateService {
  private readonly logger = new Logger(SrpStateService.name);

  constructor(private readonly redisService: RedisService) {}

  private key(username: string): string {
    return `zevra:srp:${username}`;
  }

  private client() {
    const client = this.redisService.getClient();
    if (!client) {
      throw new ServiceUnavailableException('Login is temporarily unavailable');
    }
    return client;
  }

  async set(username: string, state: SrpState): Promise<void> {
    const value: StoredSrpState = {
      b: state.b.toString(16),
      B: state.B.toString(16),
      userId: state.userId,
    };
    await this.client().set(this.key(username), JSON.stringify(value), { EX: SRP_STATE_TTL_SECONDS });
  }

  /** Returns and deletes the state atomically (single use). */
  async consume(username: string): Promise<SrpState | null> {
    const raw = await this.client().getDel(this.key(username));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(String(raw)) as StoredSrpState;
      return {
        b: BigInt('0x' + parsed.b),
        B: BigInt('0x' + parsed.B),
        userId: parsed.userId,
      };
    } catch (err) {
      this.logger.warn(`Corrupt SRP state discarded: ${(err as Error).message}`);
      return null;
    }
  }
}
