import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN, type FetchObservation } from '../src/browser-access.js';
import { makeIo } from '../src/verify.js';

afterEach(() => vi.unstubAllGlobals());

describe('health runner browser request simulation', () => {
  it('sends the Pages origin before recording CORS response headers', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Origin')).toBe(APP_ORIGIN);
      return new Response('{}', {
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const observations: FetchObservation[] = [];

    const response = await makeIo(observations).fetch('https://overpass.test/api/interpreter');
    await response.body?.cancel();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(observations).toEqual([
      {
        url: 'https://overpass.test/api/interpreter',
        status: 200,
        accessControlAllowOrigin: '*',
      },
    ]);
  });
});
