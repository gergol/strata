import { describe, it, expect } from 'vitest';
import { CircuitOpenError, RateLimiter } from '../src/limiter.js';
import type { LimiterClock } from '../src/limiter.js';

/** Deterministic virtual clock: sleep() advances time instantly. */
function makeClock(): LimiterClock & { t: () => number; advance: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    t: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

const okResponse = (): Response => new Response('ok', { status: 200 });

describe('concurrency cap (R7.3)', () => {
  it('never exceeds max_concurrent in-flight requests', async () => {
    const clock = makeClock();
    const limiter = new RateLimiter(clock);
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];
    const slowFetch = (async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      inFlight--;
      return okResponse();
    }) as unknown as typeof fetch;

    const wrapped = limiter.wrapFetch('l', { max_concurrent: 2, min_interval_ms: 0 }, slowFetch);
    const all = Promise.all(Array.from({ length: 5 }, () => wrapped('https://x.test/')));
    // Drain: release whatever is in flight until all five completed.
    while (resolvers.length < 2 && inFlight < 2) await Promise.resolve();
    for (let i = 0; i < 5; i++) {
      while (resolvers.length === 0) await Promise.resolve();
      (resolvers.shift() as () => void)();
      await Promise.resolve();
    }
    await all;
    expect(maxInFlight).toBe(2);
  });
});

describe('minimum interval (R7.3)', () => {
  it('spaces request starts by min_interval_ms', async () => {
    const clock = makeClock();
    const limiter = new RateLimiter(clock);
    const starts: number[] = [];
    const recordingFetch = (async () => {
      starts.push(clock.now());
      return okResponse();
    }) as unknown as typeof fetch;

    const wrapped = limiter.wrapFetch('l', { max_concurrent: 1, min_interval_ms: 500 }, recordingFetch);
    await wrapped('https://x.test/');
    await wrapped('https://x.test/');
    await wrapped('https://x.test/');
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(500);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(500);
  });
});

describe('transient HTTP handling (R7.6)', () => {
  it('honours Retry-After and then succeeds', async () => {
    const clock = makeClock();
    const limiter = new RateLimiter(clock);
    let calls = 0;
    const flakyFetch = (async () => {
      calls++;
      if (calls === 1) {
        return new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } });
      }
      return okResponse();
    }) as unknown as typeof fetch;

    const wrapped = limiter.wrapFetch('l', { max_concurrent: 1, min_interval_ms: 0 }, flakyFetch);
    const before = clock.now();
    const res = await wrapped('https://x.test/');
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(clock.now() - before).toBeGreaterThanOrEqual(2000); // waited the advertised 2s
  });

  it('uses exponential backoff when Retry-After is absent and gives up after maxRetries', async () => {
    const clock = makeClock();
    const limiter = new RateLimiter(clock, { maxRetries: 2, baseBackoffMs: 100 });
    let calls = 0;
    const always429 = (async () => {
      calls++;
      return new Response('nope', { status: 429 });
    }) as unknown as typeof fetch;

    const wrapped = limiter.wrapFetch('l', { max_concurrent: 1, min_interval_ms: 0 }, always429);
    const res = await wrapped('https://x.test/');
    expect(res.status).toBe(429); // returned to the caller after retries exhausted
    expect(calls).toBe(3); // initial + 2 retries
    expect(clock.t()).toBeGreaterThanOrEqual(100 + 200); // 100*2^0 + 100*2^1
  });

  it('retries an intermittent gateway timeout before returning it to the adapter', async () => {
    const clock = makeClock();
    const limiter = new RateLimiter(clock, { maxRetries: 2, baseBackoffMs: 100 });
    let calls = 0;
    const flakyGateway = (async () => {
      calls++;
      return calls === 1 ? new Response('gateway timeout', { status: 504 }) : okResponse();
    }) as unknown as typeof fetch;

    const wrapped = limiter.wrapFetch('l', { max_concurrent: 1, min_interval_ms: 0 }, flakyGateway);
    const res = await wrapped('https://x.test/');

    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(clock.t()).toBeGreaterThanOrEqual(100);
  });
});

describe('circuit breaker (R7.6)', () => {
  it('opens after repeated failures and rejects without touching the upstream', async () => {
    const clock = makeClock();
    const limiter = new RateLimiter(clock, { circuitThreshold: 3, circuitCooldownMs: 30_000, maxRetries: 0 });
    let calls = 0;
    const failingFetch = (async () => {
      calls++;
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const wrapped = limiter.wrapFetch('l', { max_concurrent: 1, min_interval_ms: 0 }, failingFetch);
    for (let i = 0; i < 3; i++) {
      await expect(wrapped('https://x.test/')).rejects.toThrow('connection refused');
    }
    expect(limiter.circuitOpen('l')).toBe(true);
    await expect(wrapped('https://x.test/')).rejects.toThrow(CircuitOpenError);
    expect(calls).toBe(3); // the rejected call never reached the upstream

    // After the cooldown a probe request is allowed through again.
    clock.advance(30_001);
    await expect(wrapped('https://x.test/')).rejects.toThrow('connection refused');
    expect(calls).toBe(4);
  });

  it('counts non-ok responses as failures but a success closes the streak', async () => {
    const clock = makeClock();
    const limiter = new RateLimiter(clock, { circuitThreshold: 3, maxRetries: 0 });
    const statuses = [500, 500, 200, 500, 500];
    let i = 0;
    const fetchSeq = (async () => new Response('x', { status: statuses[i++] ?? 200 })) as unknown as typeof fetch;

    const wrapped = limiter.wrapFetch('l', { max_concurrent: 1, min_interval_ms: 0 }, fetchSeq);
    for (let n = 0; n < 5; n++) await wrapped('https://x.test/');
    // 2 failures, reset by the 200, then only 2 more — circuit must still be closed.
    expect(limiter.circuitOpen('l')).toBe(false);
  });
});
