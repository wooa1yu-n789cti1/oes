import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BROWSER_LOG_ENDPOINT,
  createBrowserLogPlugin,
  DEFAULT_BROWSER_LOG_PATH,
} from './browser-log.plugin';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'oes-browser-log-'));
  temporaryDirectories.push(directory);
  const logPath = join(directory, 'browser.log');
  await writeFile(logPath, 'previous run\n', 'utf8');
  const plugin = createBrowserLogPlugin({
    logPath,
    now: () => new Date('2026-09-13T09:00:00.000Z'),
    sessionId: 'session-test',
    token: 'token-test',
  });
  let handler: any;
  const use = vi.fn((path: string, candidate: any) => {
    expect(path).toBe(BROWSER_LOG_ENDPOINT);
    handler = candidate;
  });
  await (plugin.configureServer as any)({ middlewares: { use } });
  return { handler, logPath, plugin };
}

async function send(
  handler: any,
  payload: unknown,
  headers?: Record<string, string>,
) {
  const request = new PassThrough() as any;
  request.headers = headers ?? {
    'content-type': 'application/json',
    host: 'localhost:5771',
    origin: 'http://localhost:5771',
    'x-oes-browser-log-token': 'token-test',
  };
  request.method = 'POST';
  let complete!: (statusCode: number) => void;
  const completed = new Promise<number>((resolve) => {
    complete = resolve;
  });
  const response = {
    setHeader: vi.fn(),
    statusCode: 0,
    writableEnded: false,
    end() {
      this.writableEnded = true;
      complete(this.statusCode);
    },
  };
  handler(request, response);
  request.end(Buffer.from(JSON.stringify(payload)));
  return completed;
}

// Verifies the development receiver owns the fixed log and persists only its strict diagnostic schema.
describe('tenant-web browser log Vite receiver', () => {
  it('overwrites the previous run and appends one sanitized JSONL event', async () => {
    const { handler, logPath } = await fixture();
    expect(await readFile(logPath, 'utf8')).toBe('');

    expect(
      await send(handler, {
        body: { password: 'must-not-be-written' },
        cookie: 'must-not-be-written',
        headers: { authorization: 'must-not-be-written' },
        level: 'warn',
        message: 'request failed; Authorization: Bearer private-value',
        pagePath: '/admin/devices?token=private#section',
        requestId: 'request-1',
        requestPath: '/api/v1/devices?password=private#fragment',
        sessionId: 'forged-session',
        source: 'http',
        statusCode: 500,
        tabId: 'tab-1',
        timestamp: '2026-09-13T08:59:59.000Z',
        traceId: 'trace-1',
      }),
    ).toBe(204);

    const line = await readFile(logPath, 'utf8');
    const event = JSON.parse(line.trim());
    expect(event).toEqual({
      level: 'error',
      message: 'request failed; Authorization=[REDACTED]',
      pagePath: '/admin/devices',
      receivedAt: '2026-09-13T09:00:00.000Z',
      requestId: 'request-1',
      requestPath: '/api/v1/devices',
      sessionId: 'session-test',
      source: 'http',
      statusCode: 500,
      tabId: 'tab-1',
      timestamp: '2026-09-13T08:59:59.000Z',
      traceId: 'trace-1',
    });
    expect(line).not.toContain('must-not-be-written');
    expect(line).not.toContain('private-value');
    expect(line).not.toContain('private#');
  });

  it('requires same-origin JSON with the per-start token and deduplicates identical events', async () => {
    const { handler, logPath } = await fixture();
    const payload = {
      message: 'same error',
      pagePath: '/admin',
      source: 'window',
      tabId: 'tab-1',
      timestamp: '2026-09-13T08:59:59.000Z',
    };

    expect(
      await send(handler, payload, {
        'content-type': 'application/json',
        host: 'localhost:5771',
        origin: 'http://evil.example',
        'x-oes-browser-log-token': 'token-test',
      }),
    ).toBe(403);
    expect(await send(handler, payload)).toBe(204);
    expect(await send(handler, payload)).toBe(204);
    const persisted = await readFile(logPath, 'utf8');
    expect(persisted.trim().split('\n')).toHaveLength(1);
  });

  it('is serve-only and injects the ephemeral receiver configuration', async () => {
    const { plugin } = await fixture();
    expect(plugin.apply).toBe('serve');
    expect(DEFAULT_BROWSER_LOG_PATH).toMatch(
      /\.local\/state\/oes\/logs\/browser\.log$/u,
    );
    const tags = (plugin.transformIndexHtml as any)();
    expect(tags[0].children).toContain(BROWSER_LOG_ENDPOINT);
    expect(tags[0].children).toContain('session-test');
    expect(tags[0].children).toContain('token-test');
  });
});
