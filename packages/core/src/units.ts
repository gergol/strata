/**
 * Unit scaling (R6.3). Raw upstream values are in the descriptor's native `unit`
 * and are multiplied by `scale_factor` exactly once, in the query pipeline —
 * never inside adapters, never in the UI. Nodata sentinels must be filtered
 * before scaling; scaling a sentinel would manufacture a plausible-looking value,
 * which is precisely the silent error class R6.3 exists to prevent.
 */

export function isNodata(raw: number, nodata: number | undefined): boolean {
  return nodata !== undefined && raw === nodata;
}

export function applyScale(raw: number, scaleFactor: number): number {
  if (!Number.isFinite(raw)) throw new RangeError(`cannot scale non-finite value ${raw}`);
  if (!Number.isFinite(scaleFactor)) throw new RangeError(`non-finite scale_factor ${scaleFactor}`);
  return raw * scaleFactor;
}

/** Scales an array, dropping nodata sentinels. Returns only valid scaled values. */
export function applyScaleAll(
  raw: readonly number[],
  scaleFactor: number,
  nodata?: number,
): number[] {
  const out: number[] = [];
  for (const v of raw) {
    if (isNodata(v, nodata)) continue;
    out.push(applyScale(v, scaleFactor));
  }
  return out;
}

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses descriptor durations ("30d", "12h", "90s", "500ms") to milliseconds. */
export function parseDuration(input: string): number {
  const m = DURATION_RE.exec(input);
  if (!m) {
    throw new RangeError(`invalid duration '${input}', expected e.g. "30d", "12h", "5m", "90s", "500ms"`);
  }
  return Number(m[1]) * (UNIT_MS[m[2] as string] as number);
}

export function isValidDuration(input: string): boolean {
  return DURATION_RE.test(input);
}
