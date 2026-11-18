// app.ts — the HTTP server: one process, stdlib only. It reads each request
// body fully, parses JSON where the surface expects it, and dispatches to the
// four surfaces: git smart HTTP, REST v3, GraphQL and MCP. Every JSON reply
// carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { handleRest, type Ctx } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGitHttp } from './git-http.ts';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}-${randomBytes(4).toString('hex')}`;
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
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) headers.set(name, value.join(', '));
        else if (value !== undefined) headers.set(name, value);
      }

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
        const headersOut: Record<string, string> = {
          'content-type': 'application/json',
          'X-GitHub-Request-Id': reqId,
          ...extraHeaders,
        };
        res.writeHead(status, headersOut);
        if (status === 204 || payload === null || payload === undefined) {
          res.end();
        } else {
          res.end(JSON.stringify(payload));
        }
      };
      const respondRaw = (status: number, payload: Buffer, payloadContentType: string, extraHeaders: Record<string, string> = {}): void => {
        if (responded) return;
        responded = true;
        res.writeHead(status, { 'content-type': payloadContentType, ...extraHeaders });
        res.end(payload);
      };

      const ctx: Ctx = {
        method: req.method ?? 'GET',
        url,
        headers,
        body,
        bodyText: rawBody.toString('utf8'),
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
        res.writeHead(500, { 'content-type': 'application/json', 'X-GitHub-Request-Id': reqId });
        res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'Internal Server Error' }));
      } else {
        res.end();
      }
    }
  });
  return server;
}
