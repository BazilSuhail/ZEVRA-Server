import { CircuitBreakerService, CircuitState } from '../../../src/shared/circuit-breaker/circuit-breaker.service';

describe('CircuitBreakerService', () => {
  let service: CircuitBreakerService;

  beforeEach(() => {
    service = new CircuitBreakerService();
  });

  it('starts in CLOSED state', () => {
    expect(service.getState()).toBe(CircuitState.CLOSED);
  });

  it('returns operation result on success', async () => {
    const result = await service.execute(
      async () => 'ok',
      () => 'fallback',
    );
    expect(result).toBe('ok');
    expect(service.getState()).toBe(CircuitState.CLOSED);
  });

  it('returns fallback on failure', async () => {
    const result = await service.execute(
      async () => { throw new Error('fail'); },
      () => 'fallback',
    );
    expect(result).toBe('fallback');
  });

  it('opens after 5 consecutive failures', async () => {
    for (let i = 0; i < 5; i++) {
      await service.execute(
        async () => { throw new Error(`fail ${i}`); },
        () => 'fallback',
      );
    }
    expect(service.getState()).toBe(CircuitState.OPEN);
  });

  it('returns fallback immediately when OPEN without calling operation', async () => {
    for (let i = 0; i < 5; i++) {
      await service.execute(async () => { throw new Error('fail'); }, () => 'fallback');
    }

    let operationCalled = false;
    const result = await service.execute(
      async () => { operationCalled = true; return 'ok'; },
      () => 'fallback',
    );
    expect(result).toBe('fallback');
    expect(operationCalled).toBe(false);
  });

  it('transitions to HALF_OPEN then CLOSED after recovery time', async () => {
    for (let i = 0; i < 5; i++) {
      await service.execute(async () => { throw new Error('fail'); }, () => 'fallback');
    }
    expect(service.getState()).toBe(CircuitState.OPEN);

    const originalNow = Date.now;
    Date.now = () => originalNow() + 31_000;

    const result = await service.execute(
      async () => 'recovered',
      () => 'fallback',
    );
    expect(result).toBe('recovered');
    expect(service.getState()).toBe(CircuitState.CLOSED);

    Date.now = originalNow;
  });

  it('resets failure count on success (prevents premature trip)', async () => {
    // 4 failures, then success resets count
    for (let i = 0; i < 4; i++) {
      await service.execute(async () => { throw new Error('fail'); }, () => 'fallback');
    }
    await service.execute(async () => 'ok', () => 'fallback');

    // 4 more failures should still be CLOSED (count was reset)
    for (let i = 0; i < 4; i++) {
      await service.execute(async () => { throw new Error('fail'); }, () => 'fallback');
    }
    expect(service.getState()).toBe(CircuitState.CLOSED);
  });

  it('reset() returns to CLOSED from OPEN', async () => {
    for (let i = 0; i < 5; i++) {
      await service.execute(async () => { throw new Error('fail'); }, () => 'fallback');
    }
    expect(service.getState()).toBe(CircuitState.OPEN);

    service.reset();
    expect(service.getState()).toBe(CircuitState.CLOSED);
  });
});
