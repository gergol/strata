/**
 * Per-layer politeness enforcement (R7.3, R7.6): concurrency cap, minimum
 * request interval, 429/Retry-After handling with exponential backoff, and a
 * circuit breaker so a repeatedly failing layer stops being hammered instead
 * of retrying into a ban.
 *
 * The limiter wraps the `fetch` handed to adapters (plan §4.1) — adapters
 * never see it and cannot bypass it. Time is injected (now/sleep) so tests
 * run deterministically without real timers.
 */

export interface LimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface LimiterOptions {
  /** Consecutive failures that open the circuit. */
  circuitThreshold?: number;
  /** How long an open circuit rejects before allowing a probe request. */
  circuitCooldownMs?: number;
  /** Retries on 429/503 before giving up (per request). */
  maxRetries?: number;
  /** Base backoff when no Retry-After header is present; doubles per attempt. */
  baseBackoffMs?: number;
}

export interface LayerRateConfig {
  max_concurrent: number;
  min_interval_ms: number;
}

export class CircuitOpenError extends Error {
  constructor(layerId: string, retryAtMs: number) {
    super(`circuit open for layer '${layerId}' until t+${retryAtMs}ms after repeated failures (R7.6)`);
    this.name = 'CircuitOpenError';
  }
}

interface LayerState {
  active: number;
  queue: Array<() => void>;
  nextAllowedStart: number;
  consecutiveFailures: number;
  openUntil: number;
}

const realClock: LimiterClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class RateLimiter {
  private readonly states = new Map<string, LayerState>();
  private readonly clock: LimiterClock;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;

  constructor(clock: LimiterClock = realClock, opts: LimiterOptions = {}) {
    this.clock = clock;
    this.threshold = opts.circuitThreshold ?? 5;
    this.cooldownMs = opts.circuitCooldownMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.baseBackoffMs = opts.baseBackoffMs ?? 250;
  }

  private state(layerId: string): LayerState {
    let s = this.states.get(layerId);
    if (!s) {
      s = { active: 0, queue: [], nextAllowedStart: 0, consecutiveFailures: 0, openUntil: 0 };
      this.states.set(layerId, s);
    }
    return s;
  }

  /** Visible for the status endpoint / tests. */
  circuitOpen(layerId: string): boolean {
    return this.clock.now() < this.state(layerId).openUntil;
  }

  wrapFetch(layerId: string, cfg: LayerRateConfig, fetchImpl: typeof fetch): typeof fetch {
    const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const s = this.state(layerId);

      // Circuit gate. Past openUntil the next request is the probe that either
      // closes the circuit (success) or re-opens it (failure).
      if (this.clock.now() < s.openUntil) {
        throw new CircuitOpenError(layerId, s.openUntil);
      }

      // Concurrency slot.
      if (s.active >= cfg.max_concurrent) {
        await new Promise<void>((resolve) => s.queue.push(resolve));
      }
      s.active++;
      try {
        // Minimum spacing between request starts.
        const wait = s.nextAllowedStart - this.clock.now();
        if (wait > 0) await this.clock.sleep(wait);
        s.nextAllowedStart = Math.max(this.clock.now(), s.nextAllowedStart) + cfg.min_interval_ms;

        let attempt = 0;
        for (;;) {
          let response: Response;
          try {
            response = await fetchImpl(input, init);
          } catch (e) {
            this.recordFailure(s);
            throw e;
          }
          if ((response.status === 429 || response.status === 503) && attempt < this.maxRetries) {
            const retryAfter = response.headers.get('Retry-After');
            const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
            const delay = Number.isFinite(seconds)
              ? seconds * 1000
              : this.baseBackoffMs * 2 ** attempt;
            attempt++;
            await this.clock.sleep(delay);
            continue;
          }
          if (response.ok) {
            s.consecutiveFailures = 0;
          } else {
            this.recordFailure(s);
          }
          return response;
        }
      } finally {
        s.active--;
        const next = s.queue.shift();
        if (next) next();
      }
    };
    return wrapped as typeof fetch;
  }

  private recordFailure(s: LayerState): void {
    s.consecutiveFailures++;
    if (s.consecutiveFailures >= this.threshold) {
      s.openUntil = this.clock.now() + this.cooldownMs;
      s.consecutiveFailures = 0;
    }
  }
}
