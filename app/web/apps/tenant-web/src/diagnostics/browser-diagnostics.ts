import type { App } from 'vue';

type BrowserDiagnosticsConfig = {
  endpoint: string;
  sessionId: string;
  token: string;
};

type BrowserDiagnosticEvent = {
  errorCode?: string;
  level: 'error';
  message: string;
  method?: string;
  pagePath: string;
  requestId?: string;
  requestPath?: string;
  sessionId: string;
  source:
    | 'console'
    | 'http'
    | 'resource'
    | 'unhandledrejection'
    | 'vue'
    | 'window';
  stack?: string;
  statusCode?: number;
  tabId: string;
  timestamp: string;
  traceId?: string;
};

declare global {
  interface Window {
    __OES_BROWSER_DIAGNOSTICS__?: BrowserDiagnosticsConfig;
  }
}

const MAX_MESSAGE_LENGTH = 1000;
const MAX_STACK_LENGTH = 4000;
const MAX_PATH_LENGTH = 1000;
const DEDUPE_WINDOW_MS = 1500;
const SENSITIVE_KEY =
  String.raw`(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|secret|client[_-]?secret|api[_-]?key)`;
const SENSITIVE_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [
    new RegExp(
      String.raw`((?:authorization|cookie|set-cookie)\s*[:=]\s*)(["'])(?:\\.|(?!\2).)*\2`,
      'giu',
    ),
    '$1$2[REDACTED]$2',
  ],
  [
    /(authorization|cookie|set-cookie)\s*[:=]\s*[^,;\r\n}\]]+/giu,
    '$1=[REDACTED]',
  ],
  [/\b(bearer|basic)\s+[a-z0-9._~+/=-]+/giu, '$1 [REDACTED]'],
  [
    new RegExp(
      String.raw`(["']?${SENSITIVE_KEY}["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2).)*\2`,
      'giu',
    ),
    '$1$2[REDACTED]$2',
  ],
  [
    new RegExp(
      String.raw`(\b${SENSITIVE_KEY}\b\s*[:=]\s*)(?!["'])[^\s,;&#}\]\r\n]+`,
      'giu',
    ),
    '$1[REDACTED]',
  ],
  [
    new RegExp(String.raw`([?&](?:${SENSITIVE_KEY}|code)=)[^&#\s]*`, 'giu'),
    '$1[REDACTED]',
  ],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@]+(@)/giu, '$1[REDACTED]$2'],
];
type ActiveDiagnostics = {
  cleanup: () => void;
  config: BrowserDiagnosticsConfig;
  recentEvents: Map<string, number>;
  reporting: boolean;
  tabId: string;
};

let activeDiagnostics: ActiveDiagnostics | undefined;

function bounded(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return undefined;
  let sanitized = value;
  for (const [pattern, replacement] of SENSITIVE_VALUE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  const normalized = sanitized.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function randomId(prefix: string) {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function pathOnly(value: unknown) {
  const raw = bounded(value, MAX_PATH_LENGTH);
  if (!raw) return undefined;
  try {
    return (
      new URL(raw, window.location.origin).pathname.slice(0, MAX_PATH_LENGTH) ||
      '/'
    );
  } catch {
    const path = raw.split(/[?#]/u, 1)[0];
    return path?.startsWith('/') ? path.slice(0, MAX_PATH_LENGTH) : undefined;
  }
}

function currentPagePath() {
  return pathOnly(window.location.pathname) ?? '/';
}

function errorDetails(value: unknown) {
  if (value instanceof Error) {
    return {
      message:
        bounded(value.message || value.name, MAX_MESSAGE_LENGTH) ??
        'Unknown error',
      stack: bounded(value.stack, MAX_STACK_LENGTH),
    };
  }
  return {
    message: bounded(value, MAX_MESSAGE_LENGTH) ?? 'Unknown error',
  };
}

function consoleMessage(values: unknown[]) {
  const parts = values.map((value) => {
    if (value instanceof Error) return value.message || value.name;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return String(value);
    }
    return '[object omitted]';
  });
  return bounded(parts.join(' '), MAX_MESSAGE_LENGTH) ?? 'console.error';
}

function eventKey(event: BrowserDiagnosticEvent) {
  return [
    event.source,
    event.message,
    event.pagePath,
    event.requestPath,
    event.method,
    event.statusCode,
    event.errorCode,
    event.requestId,
    event.traceId,
  ].join('|');
}

// Reports one bounded, body-free diagnostic event without surfacing collector failures to the application.
function report(
  event: Omit<
    BrowserDiagnosticEvent,
    'level' | 'pagePath' | 'sessionId' | 'tabId' | 'timestamp'
  >,
) {
  const state = activeDiagnostics;
  if (!state || state.reporting) return;
  state.reporting = true;
  try {
    const diagnosticEvent: BrowserDiagnosticEvent = {
      ...event,
      level: 'error',
      pagePath: currentPagePath(),
      sessionId: state.config.sessionId,
      tabId: state.tabId,
      timestamp: new Date().toISOString(),
    };
    const key = eventKey(diagnosticEvent);
    const now = Date.now();
    const previous = state.recentEvents.get(key);
    state.recentEvents.set(key, now);
    for (const [candidate, recordedAt] of state.recentEvents) {
      if (now - recordedAt > DEDUPE_WINDOW_MS)
        state.recentEvents.delete(candidate);
    }
    if (previous !== undefined && now - previous <= DEDUPE_WINDOW_MS) return;

    void fetch(state.config.endpoint, {
      body: JSON.stringify(diagnosticEvent),
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-OES-Browser-Log-Token': state.config.token,
      },
      keepalive: true,
      method: 'POST',
    }).catch(() => undefined);
  } catch {
    // Diagnostic collection is best-effort and must never recurse into application error handling.
  } finally {
    state.reporting = false;
  }
}

function resourcePath(target: EventTarget | null) {
  if (!target || target === window) return undefined;
  const source =
    (target as any).currentSrc ?? (target as any).src ?? (target as any).href;
  return pathOnly(source);
}

// Installs tenant-web's earliest browser-level diagnostic capture in development only.
export function installBrowserDiagnostics() {
  const config = window.__OES_BROWSER_DIAGNOSTICS__;
  if (
    !import.meta.env.DEV ||
    !config?.endpoint ||
    !config.sessionId ||
    !config.token
  ) {
    return () => undefined;
  }
  if (activeDiagnostics) return activeDiagnostics.cleanup;

  const originalConsoleError = console.error;
  const handleError = (event: ErrorEvent | Event) => {
    const failedResource = resourcePath(event.target);
    if (failedResource) {
      report({
        message: `Resource failed to load: ${failedResource}`,
        requestPath: failedResource,
        source: 'resource',
      });
      return;
    }
    const errorEvent = event as ErrorEvent;
    const details = errorDetails(errorEvent.error ?? errorEvent.message);
    report({ ...details, source: 'window' });
  };
  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    report({ ...errorDetails(event.reason), source: 'unhandledrejection' });
  };
  const patchedConsoleError = (...values: unknown[]) => {
    originalConsoleError.apply(console, values);
    const error = values.find((value) => value instanceof Error) as
      | Error
      | undefined;
    report({
      message: consoleMessage(values),
      source: 'console',
      ...(error?.stack
        ? { stack: bounded(error.stack, MAX_STACK_LENGTH) }
        : {}),
    });
  };

  window.addEventListener('error', handleError, true);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);
  console.error = patchedConsoleError;

  const cleanup = () => {
    window.removeEventListener('error', handleError, true);
    window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    if (console.error === patchedConsoleError)
      console.error = originalConsoleError;
    activeDiagnostics = undefined;
  };
  activeDiagnostics = {
    cleanup,
    config,
    recentEvents: new Map(),
    reporting: false,
    tabId: randomId('tab'),
  };
  return cleanup;
}

// Connects Vue render and lifecycle failures to the already-installed browser diagnostics sink.
export function installVueBrowserDiagnostics(app: App) {
  if (!activeDiagnostics) return;
  const previousHandler = app.config.errorHandler;
  app.config.errorHandler = (error, instance, info) => {
    const details = errorDetails(error);
    report({
      ...details,
      message:
        bounded(`${details.message} (${info})`, MAX_MESSAGE_LENGTH) ??
        details.message,
      source: 'vue',
    });
    previousHandler?.(error, instance, info);
  };
}

function responseHeader(headers: any, name: string) {
  const value =
    headers?.get?.(name) ?? headers?.[name] ?? headers?.[name.toLowerCase()];
  return bounded(Array.isArray(value) ? value[0] : value, 256);
}

function responseMetadata(error: any, field: 'requestId' | 'traceId') {
  const headerName = field === 'requestId' ? 'x-request-id' : 'x-trace-id';
  return (
    responseHeader(error?.response?.headers, headerName) ??
    bounded(error?.response?.data?.[field], 256)
  );
}

// Records one Axios failure using only status, correlation, code, method, and path metadata.
export function recordHttpRequestError(error: any) {
  if (!activeDiagnostics || error?.code === 'ERR_CANCELED') return;
  const statusCode = Number.isInteger(error?.response?.status)
    ? error.response.status
    : undefined;
  const timeout =
    error?.code === 'ECONNABORTED' ||
    /timeout/iu.test(`${error?.message ?? ''}`);
  let message = 'HTTP network error';
  if (statusCode) message = `HTTP ${statusCode}`;
  else if (timeout) message = 'HTTP request timed out';
  const requestPath = pathOnly(error?.config?.url);
  const method = bounded(error?.config?.method, 16)?.toUpperCase();
  const errorCode = bounded(
    error?.response?.data?.code ?? error?.response?.data?.errorCode,
    128,
  );
  const requestId = responseMetadata(error, 'requestId');
  const traceId = responseMetadata(error, 'traceId');

  report({
    message,
    source: 'http',
    ...(requestPath ? { requestPath } : {}),
    ...(method ? { method } : {}),
    ...(statusCode ? { statusCode } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(requestId ? { requestId } : {}),
    ...(traceId ? { traceId } : {}),
  });
}
