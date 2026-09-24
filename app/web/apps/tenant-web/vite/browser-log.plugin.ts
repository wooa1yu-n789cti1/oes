import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const BROWSER_LOG_ENDPOINT = '/__oes_dev/browser-log';
const DEFAULT_BROWSER_LOG_PATH = join(
  homedir(),
  '.local/state/oes/logs/browser.log',
);
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_STACK_LENGTH = 4000;
const MAX_PATH_LENGTH = 1000;
const MAX_IDENTIFIER_LENGTH = 256;
const DEDUPE_WINDOW_MS = 1500;
const ALLOWED_SOURCES = new Set([
  'console',
  'http',
  'resource',
  'unhandledrejection',
  'vue',
  'window',
]);
const SENSITIVE_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization|cookie|set-cookie)\s*[:=]\s*[^,;\r\n]+/giu, '$1=[REDACTED]'],
  [/bearer\s+[a-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]'],
  [
    /([?&](?:access_token|refresh_token|token|code|password|secret)=)[^&#\s]*/giu,
    '$1[REDACTED]',
  ],
];

type BrowserLogPluginOptions = {
  logPath?: string;
  now?: () => Date;
  sessionId?: string;
  token?: string;
};

type BrowserLogEvent = {
  errorCode?: string;
  level: 'error';
  message: string;
  method?: string;
  pagePath: string;
  receivedAt: string;
  requestId?: string;
  requestPath?: string;
  sessionId: string;
  source: string;
  stack?: string;
  statusCode?: number;
  tabId: string;
  timestamp: string;
  traceId?: string;
};

function boundedString(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function boundedDiagnosticText(value: unknown, maxLength: number) {
  const text = boundedString(value, maxLength * 2);
  if (!text) return undefined;
  let sanitized = text;
  for (const [pattern, replacement] of SENSITIVE_TEXT_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized.slice(0, maxLength);
}

function normalizedPath(value: unknown) {
  const path = boundedString(value, MAX_PATH_LENGTH);
  if (!path?.startsWith('/')) return undefined;
  return path.split(/[?#]/u, 1)[0]?.slice(0, MAX_PATH_LENGTH) || '/';
}

// Accepts only the bounded diagnostic schema and deliberately drops every unrecognized field.
function normalizeBrowserLogEvent(
  value: unknown,
  sessionId: string,
  receivedAt: string,
): BrowserLogEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const source = boundedString((value as any).source, 32);
  const message = boundedDiagnosticText(
    (value as any).message,
    MAX_MESSAGE_LENGTH,
  );
  const pagePath = normalizedPath((value as any).pagePath);
  const tabId = boundedString((value as any).tabId, MAX_IDENTIFIER_LENGTH);
  if (
    !source ||
    !ALLOWED_SOURCES.has(source) ||
    !message ||
    !pagePath ||
    !tabId
  ) {
    return undefined;
  }

  const suppliedTimestamp = boundedString((value as any).timestamp, 64);
  const parsedTimestamp = suppliedTimestamp
    ? Date.parse(suppliedTimestamp)
    : Number.NaN;
  const timestamp = Number.isFinite(parsedTimestamp)
    ? new Date(parsedTimestamp).toISOString()
    : receivedAt;
  const rawStatusCode = (value as any).statusCode;
  const statusCode =
    Number.isInteger(rawStatusCode) &&
    rawStatusCode >= 100 &&
    rawStatusCode <= 599
      ? rawStatusCode
      : undefined;
  const method = boundedString((value as any).method, 16)?.toUpperCase();

  return {
    level: 'error',
    message,
    pagePath,
    receivedAt,
    sessionId,
    source,
    tabId,
    timestamp,
    ...(boundedDiagnosticText((value as any).stack, MAX_STACK_LENGTH)
      ? { stack: boundedDiagnosticText((value as any).stack, MAX_STACK_LENGTH) }
      : {}),
    ...(normalizedPath((value as any).requestPath)
      ? { requestPath: normalizedPath((value as any).requestPath) }
      : {}),
    ...(method ? { method } : {}),
    ...(statusCode ? { statusCode } : {}),
    ...(boundedString((value as any).errorCode, 128)
      ? { errorCode: boundedString((value as any).errorCode, 128) }
      : {}),
    ...(boundedString((value as any).requestId, MAX_IDENTIFIER_LENGTH)
      ? {
          requestId: boundedString(
            (value as any).requestId,
            MAX_IDENTIFIER_LENGTH,
          ),
        }
      : {}),
    ...(boundedString((value as any).traceId, MAX_IDENTIFIER_LENGTH)
      ? {
          traceId: boundedString((value as any).traceId, MAX_IDENTIFIER_LENGTH),
        }
      : {}),
  };
}

function dedupeKey(event: BrowserLogEvent) {
  return [
    event.tabId,
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

function sameOrigin(request: IncomingMessage) {
  const origin = boundedString(request.headers.origin, 1000);
  const host = boundedString(request.headers.host, 1000);
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function respond(response: ServerResponse, statusCode: number) {
  response.statusCode = statusCode;
  response.setHeader('Cache-Control', 'no-store');
  response.end();
}

// Creates a development-only Vite receiver that owns one fixed, per-start browser JSONL log.
export function createBrowserLogPlugin(
  options: BrowserLogPluginOptions = {},
): Plugin {
  const logPath = options.logPath ?? DEFAULT_BROWSER_LOG_PATH;
  const now = options.now ?? (() => new Date());
  const sessionId = options.sessionId ?? randomUUID();
  const token = options.token ?? randomBytes(32).toString('base64url');
  const recentEvents = new Map<string, number>();
  let writeQueue = Promise.resolve();

  const append = (event: BrowserLogEvent) => {
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(() => appendFile(logPath, `${JSON.stringify(event)}\n`, 'utf8'));
    return writeQueue;
  };

  return {
    apply: 'serve',
    name: 'oes-browser-diagnostic-log',
    async configureServer(server) {
      await mkdir(dirname(logPath), { recursive: true });
      await writeFile(logPath, '', { encoding: 'utf8', mode: 0o600 });
      await chmod(logPath, 0o600);

      server.middlewares.use(BROWSER_LOG_ENDPOINT, (request, response) => {
        if (request.method !== 'POST') {
          respond(response, 405);
          return;
        }
        if (
          !sameOrigin(request) ||
          request.headers['x-oes-browser-log-token'] !== token ||
          !`${request.headers['content-type'] ?? ''}`
            .toLowerCase()
            .startsWith('application/json')
        ) {
          respond(response, 403);
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let rejected = false;
        request.on('data', (chunk: Buffer) => {
          if (rejected) return;
          totalBytes += chunk.length;
          if (totalBytes > MAX_REQUEST_BYTES) {
            rejected = true;
            respond(response, 413);
            return;
          }
          chunks.push(chunk);
        });
        request.on('error', () => {
          if (!response.writableEnded) respond(response, 400);
        });
        request.on('end', () => {
          if (rejected || response.writableEnded) return;
          let input: unknown;
          try {
            input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            respond(response, 400);
            return;
          }

          const receivedAt = now().toISOString();
          const event = normalizeBrowserLogEvent(input, sessionId, receivedAt);
          if (!event) {
            respond(response, 400);
            return;
          }

          const key = dedupeKey(event);
          const currentTime = now().getTime();
          const previousTime = recentEvents.get(key);
          recentEvents.set(key, currentTime);
          for (const [candidate, recordedAt] of recentEvents) {
            if (currentTime - recordedAt > DEDUPE_WINDOW_MS)
              recentEvents.delete(candidate);
          }
          if (
            previousTime !== undefined &&
            currentTime - previousTime <= DEDUPE_WINDOW_MS
          ) {
            respond(response, 204);
            return;
          }

          void append(event).then(
            () => respond(response, 204),
            () => respond(response, 500),
          );
        });
      });
    },
    transformIndexHtml() {
      const runtimeConfig = JSON.stringify({
        endpoint: BROWSER_LOG_ENDPOINT,
        sessionId,
        token,
      }).replaceAll('<', String.raw`\u003c`);
      return [
        {
          children: `window.__OES_BROWSER_DIAGNOSTICS__=Object.freeze(${runtimeConfig});`,
          injectTo: 'head-prepend',
          tag: 'script',
        },
      ];
    },
  };
}

export {
  BROWSER_LOG_ENDPOINT,
  DEFAULT_BROWSER_LOG_PATH,
  normalizeBrowserLogEvent,
};
