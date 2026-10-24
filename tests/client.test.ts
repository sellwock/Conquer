import { describe, expect, it } from 'vitest';
import { DataError, getJson, requestCount, setFetch } from '../src/data/espn/client';

describe('ESPN client', () => {
  it('retries rate limits and server errors, then succeeds', async () => {
    const statuses = [429, 503, 200];
    setFetch((async () => {
      const status = statuses.shift()!;
      return new Response(status === 200 ? '{"ok":true}' : 'busy', { status });
    }) as typeof fetch);
    const before = requestCount();
    await expect(getJson('site', '/retry-test')).resolves.toEqual({ ok: true });
    expect(requestCount() - before).toBe(3);
  });

  it('gives up on client errors without retrying', async () => {
    let calls = 0;
    setFetch((async () => {
      calls++;
      return new Response('nope', { status: 404 });
    }) as typeof fetch);
    await expect(getJson('site', '/missing')).rejects.toBeInstanceOf(DataError);
    expect(calls).toBe(1);
  });
});
