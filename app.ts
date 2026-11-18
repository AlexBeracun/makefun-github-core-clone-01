// app.ts — the HTTP server: one process, stdlib only. It reads each request
// body fully, parses JSON where the surface expects it, and dispatches to the
// four surfaces: git smart HTTP, REST v3, GraphQL and MCP. Every JSON reply
// carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest, type Ctx, type HeaderView } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGitHttp } from './git-http.ts';

let requestCounter = 0;

function nextRequestId(): string {
  // Counter-only: unique per process (the counter increments every request),
  // no per-request crypto call on the hot path.
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqId = nextRequestId();
    try {
      const rawBody = await readBody(req);
      const host = req.headers.host ?? '127.0.0.1';
      const url = new URL(req.url ?? '/', `http://${host}`);
      // Handlers only ever call headers.get(): a thin view over Node's
      // already-lowercased req.headers is ~10x cheaper than building a Headers.
      const headers: HeaderView = {
        get(name: string): string | null {
          const value = (req.headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
          if (value === undefined) return null;
          return Array.isArray(value) ? value.join(', ') : value;
        },
      };

      const contentType = (req.headers['content-type'] ?? '') as string;
      let body: unknown = null;
      if (rawBody.length > 0 && contentType.includes('json')) {
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          body = null;
        }
      }

      let responded = false;
      const respond = (status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void => {
        if (responded) return;
        responded = true;
        // Always send Content-Length: without it Node falls back to
        // Transfer-Encoding: chunked, and the client pays a chunk decode per
        // response (measured ~2x slower per request on the read workload).
        if (status === 204 || payload === null || payload === undefined) {
          res.writeHead(status, { 'X-GitHub-Request-Id': reqId, ...extraHeaders });
          res.end();
          return;
        }
        const bodyOut = Buffer.from(JSON.stringify(payload), 'utf8');
        res.writeHead(status, {
          'content-type': 'application/json',
          'X-GitHub-Request-Id': reqId,
          'content-length': String(bodyOut.length),
          ...extraHeaders,
        });
        res.end(bodyOut);
      };
      const respondRaw = (status: number, payload: Buffer, payloadContentType: string, extraHeaders: Record<string, string> = {}): void => {
        if (responded) return;
        responded = true;
        res.writeHead(status, {
          'content-type': payloadContentType,
          'content-length': String(payload.length),
          ...extraHeaders,
        });
        res.end(payload);
      };

      // bodyText is read by no handler today; compute it lazily (once) instead
      // of decoding every request body — push packs are kilobytes of binary.
      let bodyTextCache: string | null = null;
      const ctx: Ctx = {
        method: req.method ?? 'GET',
        url,
        headers,
        body,
        get bodyText(): string {
          if (bodyTextCache === null) bodyTextCache = rawBody.toString('utf8');
          return bodyTextCache;
        },
        rawBody,
        token,
        reqId,
        respond,
        respondRaw,
      };

      if (url.pathname === '/healthz') {
        respond(200, { status: 'ok' });
        return;
      }
      if (handleGraphQL(ctx)) return;
      if (handleRest(ctx)) return;
      if (handleMcp(ctx)) return;
      if (handleGitHttp(ctx)) return;

      // Anything else is a JSON 404, never HTML.
      if (!responded) {
        respond(404, { message: 'Not Found' });
      }
    } catch (err) {
      if (!res.headersSent) {
        const bodyOut = Buffer.from(
          JSON.stringify({ message: err instanceof Error ? err.message : 'Internal Server Error' }),
          'utf8',
        );
        res.writeHead(500, {
          'content-type': 'application/json',
          'X-GitHub-Request-Id': reqId,
          'content-length': String(bodyOut.length),
        });
        res.end(bodyOut);
      } else {
        res.end();
      }
    }
  });
  return server;
}
