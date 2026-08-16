/**
 * The query engine host: LocalQueryEngine running in a Web Worker, answering
 * the QueryEngine interface over postMessage. Everything crossing this
 * boundary is plain JSON — the same property that would let a proxy replace
 * this worker without touching the UI (plan §4.5).
 */
import { LocalQueryEngine, defaultAdapters, loadDescriptorsYaml } from '@strata/core';
import { IdbCache } from './idb-cache';

const STATUS_URL = 'https://raw.githubusercontent.com/gergol/strata/main/data/status/status.json';

const engine = new LocalQueryEngine(
  __LAYER_YAMLS__.flatMap((yaml) => loadDescriptorsYaml(yaml)),
  {
    io: {
      fetch: (input, init) => fetch(input, init),
      cache: new IdbCache(() => Date.now()),
      now: () => Date.now(),
    },
    adapters: defaultAdapters(),
  },
);

// Degraded flags from the committed health-runner status (R8.3); best effort —
// the file may not exist yet and the app must work without it.
void (async () => {
  try {
    const res = await fetch(STATUS_URL, { cache: 'no-cache' });
    if (!res.ok) return;
    const status = (await res.json()) as { layers?: Record<string, { ok: boolean }> };
    for (const [id, s] of Object.entries(status.layers ?? {})) {
      try {
        engine.setDegraded(id, !s.ok);
      } catch {
        // status file may mention layers this build doesn't have
      }
    }
  } catch {
    /* offline or file absent — fine */
  }
})();

interface Call {
  id: number;
  method: 'point' | 'tile' | 'layers';
  args: unknown[];
}

self.onmessage = async (event: MessageEvent<Call>) => {
  const { id, method, args } = event.data;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (engine[method] as (...a: unknown[]) => Promise<unknown>)(...args);
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
