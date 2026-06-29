import { Injectable } from '@nestjs/common';

interface SrpState {
  b: bigint;
  B: bigint;
  createdAt: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class SrpStateService {
  private store = new Map<string, SrpState>();

  set(userId: string, state: Omit<SrpState, 'createdAt'>): void {
    this.store.set(userId, { ...state, createdAt: Date.now() });
  }

  get(userId: string): SrpState | null {
    const state = this.store.get(userId);
    if (!state) return null;

    if (Date.now() - state.createdAt > TTL_MS) {
      this.store.delete(userId);
      return null;
    }

    return state;
  }

  delete(userId: string): void {
    this.store.delete(userId);
  }
}
