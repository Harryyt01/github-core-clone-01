// app.ts — the forge's HTTP server: reads each request body, then routes it
// to the git smart-HTTP, REST v3, GraphQL v4, or MCP handlers. Every reply
// carries a non-empty X-GitHub-Request-Id; every API route except /healthz
// requires the shop bearer token.
//
// main.ts owns the entry <-> env lifecycle (bind, register, poll done); this
// file is the server it listens with.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGitPost, handleInfoRefs } from './githttp.ts';
import { parseJsonBody, requireAuth, sendJson, sendMessage } from './common.ts';
import type { Ctx } from './common.ts';

let requestCounter = 0;

/** URL path segments, percent-decoded, with empty segments dropped. */
function segmentsOf(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

function handleRequest(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const host = req.headers.host ?? 'entry';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${host}`);
  } catch {
    url = new URL('/', `http://${host}`);
  }
  const store = (req as unknown as { __store?: Store }).__store as Store;
  const ctx: Ctx = {
    store,
    req,
    res,
    url,
    path: url.pathname,
    segments: segmentsOf(url.pathname),
    body,
    json: undefined,
    jsonError: false,
    requestId: `req-${(requestCounter += 1)}`,
  };
  try {
    const method = req.method ?? 'GET';
    const seg = ctx.segments;

    // The env's boot check calls this twice: 200 {"ok":true}, no token.
    if (method === 'GET' && ctx.path === '/healthz') {
      sendJson(ctx, 200, { ok: true });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    if (seg.length >= 2 && (seg[1] as string).endsWith('.git')) {
      if (!requireAuth(ctx)) return;
      const owner = seg[0] as string;
      const repoName = (seg[1] as string).slice(0, -'.git'.length);
      if (method === 'GET' && seg[2] === 'info' && seg[3] === 'refs') {
        handleInfoRefs(ctx, owner, repoName);
        return;
      }
      if (method === 'POST' && seg[2] === 'git-upload-pack') {
        handleGitPost(ctx, owner, repoName, 'git-upload-pack');
        return;
      }
      if (method === 'POST' && seg[2] === 'git-receive-pack') {
        handleGitPost(ctx, owner, repoName, 'git-receive-pack');
        return;
      }
      sendMessage(ctx, 404, 'Not Found');
      return;
    }

    // GitHub REST v3.
    if (seg[0] === 'api' && seg[1] === 'v3') {
      if (!requireAuth(ctx)) return;
      parseJsonBody(ctx);
      handleRest(ctx);
      return;
    }

    // GitHub GraphQL v4.
    if (seg[0] === 'api' && seg[1] === 'graphql') {
      if (!requireAuth(ctx)) return;
      parseJsonBody(ctx);
      handleGraphQL(ctx);
      return;
    }

    // Model Context Protocol.
    if (seg[0] === 'mcp') {
      if (!requireAuth(ctx)) return;
      parseJsonBody(ctx);
      handleMcp(ctx);
      return;
    }

    // Everything else: GitHub's 404 body.
    sendMessage(ctx, 404, 'Not Found');
  } catch (err) {
    // A handler must never take the server down: answer 500 and stay up.
    process.stderr.write(`[entry] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
    if (!res.writableEnded) {
      try {
        sendMessage(ctx, 500, 'Internal Server Error');
      } catch {
        // The response is already gone; nothing more to do.
      }
    }
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // Stash the store on the request object so handleRequest can reach it.
    (req as unknown as { __store?: Store }).__store = store;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    req.on('end', () => {
      handleRequest(req, res, Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (!res.writableEnded) {
        try {
          res.writeHead(400);
          res.end();
        } catch {
          // Nothing more to do.
        }
      }
    });
  });
}
