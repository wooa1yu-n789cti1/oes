/* @vitest-environment happy-dom */

import type { App } from 'vue';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installBrowserDiagnostics,
  installVueBrowserDiagnostics,
  recordHttpRequestError,
} from './browser-diagnostics';

let cleanup: () => void = () => undefined;

function postedEvents(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
}

beforeEach(() => {
  window.history.replaceState({}, '', '/admin/devices?secret=value#section');
  window.__OES_BROWSER_DIAGNOSTICS__ = {
    endpoint: '/__oes_dev/browser-log',
    sessionId: 'session-test',
    token: 'token-test',
  };
});

afterEach(() => {
  cleanup();
  cleanup = () => undefined;
  delete window.__OES_BROWSER_DIAGNOSTICS__;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Verifies Axios diagnostics retain correlation metadata without retaining headers, query strings, or bodies.
describe('tenant-web browser diagnostics', () => {
  it('records bounded HTTP failure metadata without request or response contents', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    cleanup = installBrowserDiagnostics();

    recordHttpRequestError({
      config: {
        data: { password: 'request-private' },
        headers: { Authorization: 'Bearer request-private' },
        method: 'get',
        url: '/api/v1/devices?access_token=request-private#fragment',
      },
      response: {
        data: {
          code: 'DEVICE_LOOKUP_FAILED',
          payload: 'response-private',
          requestId: 'request-body-id',
          traceId: 'trace-body-id',
        },
        headers: {
          'x-request-id': 'request-header-id',
          'x-trace-id': 'trace-header-id',
        },
        status: 500,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [event] = postedEvents(fetchMock);
    expect(event).toMatchObject({
      errorCode: 'DEVICE_LOOKUP_FAILED',
      level: 'error',
      message: 'HTTP 500',
      method: 'GET',
      pagePath: '/admin/devices',
      requestId: 'request-header-id',
      requestPath: '/api/v1/devices',
      sessionId: 'session-test',
      source: 'http',
      statusCode: 500,
      traceId: 'trace-header-id',
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('request-private');
    expect(serialized).not.toContain('response-private');
    expect(serialized).not.toContain('Authorization');
  });

  it('captures console, window, rejected-promise, and resource failures while ignoring console.warn', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    cleanup = installBrowserDiagnostics();

    console.error('console failed with Bearer private-value', {
      body: 'private-object',
    });
    console.warn('ordinary warning');
    window.dispatchEvent(
      new ErrorEvent('error', { error: new Error('window failed') }),
    );
    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(rejection, 'reason', {
      value: new Error('promise failed'),
    });
    window.dispatchEvent(rejection);
    const image = document.createElement('img');
    image.src = '/asset.png?token=private#fragment';
    document.body.append(image);
    image.dispatchEvent(new Event('error'));

    const events = postedEvents(fetchMock);
    expect(events.map((event) => event.source)).toEqual([
      'console',
      'window',
      'unhandledrejection',
      'resource',
    ]);
    expect(events[0].message).toBe(
      'console failed with Bearer [REDACTED] [object omitted]',
    );
    expect(events[3].requestPath).toBe('/asset.png');
    expect(JSON.stringify(events)).not.toContain('private-value');
    expect(JSON.stringify(events)).not.toContain('private-object');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('redacts structured and free-form credential values before posting diagnostics', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cleanup = installBrowserDiagnostics();

    console.error(
      'login failed {"password":"hunter2"} secret: hunter3 token: abc.def.ghi apiKey=private client_secret="private-client" postgres://user:db-pass@localhost/db',
    );

    const serialized = JSON.stringify(postedEvents(fetchMock));
    expect(serialized).toContain('[REDACTED]');
    for (const secret of [
      'hunter2',
      'hunter3',
      'abc.def.ghi',
      'private-client',
      'db-pass',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('captures Vue failures and suppresses short-window duplicates', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    cleanup = installBrowserDiagnostics();
    const previousHandler = vi.fn();
    const app = { config: { errorHandler: previousHandler } } as unknown as App;
    installVueBrowserDiagnostics(app);

    app.config.errorHandler?.(
      new Error('render failed'),
      null,
      'render function',
    );
    app.config.errorHandler?.(
      new Error('render failed'),
      null,
      'render function',
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(postedEvents(fetchMock)[0]).toMatchObject({
      message: 'render failed (render function)',
      source: 'vue',
    });
    expect(previousHandler).toHaveBeenCalledTimes(2);
  });

  it('stays inert when the development receiver configuration is absent', () => {
    delete window.__OES_BROWSER_DIAGNOSTICS__;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const originalConsoleError = console.error;

    cleanup = installBrowserDiagnostics();
    recordHttpRequestError({ response: { status: 500 } });

    expect(console.error).toBe(originalConsoleError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
