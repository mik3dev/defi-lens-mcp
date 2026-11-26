import { createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type express from 'express';
import type { AppContext } from '../context.js';
import { buildServer } from '../server.js';

const BODY_LIMIT = '1mb';

function readVersion(): string {
  const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };
  return pkg.version;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function presentedToken(header: string | undefined): string | undefined {
  const match = /^Bearer (.*)$/i.exec(header ?? '');
  return match?.[1];
}

/**
 * Bearer-token gate. Compares SHA-256 digests (fixed length) with timingSafeEqual against every
 * configured token, so neither token content nor length leaks through timing. Every failure
 * (missing header, wrong scheme, wrong token) produces the same response.
 */
export function bearerAuth(tokens: string[]): express.RequestHandler {
  const expected = tokens.map(digest);
  return (req, res, next) => {
    const token = presentedToken(req.headers.authorization);
    const presented = digest(token ?? '');
    const matches = expected.map((candidate) => timingSafeEqual(candidate, presented));
    if (token !== undefined && matches.some(Boolean)) {
      next();
      return;
    }
    res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' });
  };
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, error: { code, message }, id: null };
}

function methodNotAllowed(_req: express.Request, res: express.Response): void {
  res.status(405).set('Allow', 'POST').json(jsonRpcError(-32000, 'Method not allowed'));
}

function handlePost(ctx: AppContext, version: string): express.RequestHandler {
  return async (req, res) => {
    const server = buildServer(ctx, version);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      ctx.logger.error('mcp request failed', { error: e });
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
    }
  };
}

function errorHandler(ctx: AppContext): express.ErrorRequestHandler {
  return (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = (err as { status?: number } | null)?.status;
    if (status === 413) {
      res.status(413).json(jsonRpcError(-32600, 'Request body too large'));
    } else if (status === 400) {
      res.status(400).json(jsonRpcError(-32700, 'Invalid JSON'));
    } else {
      ctx.logger.error('http request failed', { error: err });
      res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
    }
  };
}

/** Express app: unauthenticated /healthz, then bearer-protected stateless MCP on /mcp. */
export function createHttpApp(ctx: AppContext): express.Express {
  const app = createMcpExpressApp({ host: ctx.config.host, jsonLimit: BODY_LIMIT });
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/mcp', bearerAuth(ctx.config.authTokens));
  app.post('/mcp', handlePost(ctx, readVersion()));
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
  app.use(errorHandler(ctx));
  return app;
}

/** Listens on config.host:config.port (port 0 picks a free one) and resolves once bound. */
export function startHttp(ctx: AppContext): Promise<{ port: number; close(): Promise<void> }> {
  const app = createHttpApp(ctx);
  return new Promise((resolve, reject) => {
    const httpServer = app.listen(ctx.config.port, ctx.config.host, () => {
      const { port } = httpServer.address() as AddressInfo;
      ctx.logger.info('http transport listening', { host: ctx.config.host, port });
      resolve({
        port,
        close: () =>
          new Promise<void>((done, fail) => {
            httpServer.close((e) => (e ? fail(e) : done()));
            httpServer.closeAllConnections();
          }),
      });
    });
    httpServer.once('error', reject);
  });
}
