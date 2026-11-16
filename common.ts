// common.ts — shared request context, JSON/binary replies, auth. Every reply
// carries a non-empty X-GitHub-Request-Id and a JSON content type for API
// routes (the protocol group's contract).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  segments: string[];
  body: Buffer;
  json: unknown;
  jsonError: boolean;
  requestId: string;
}

export const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token the suite sends; empty when the env did not set one. */
export const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function sendJson(ctx: Ctx, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...extra,
  });
  ctx.res.end(text);
}

export function sendBuffer(ctx: Ctx, status: number, buf: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': buf.length,
    'x-github-request-id': ctx.requestId,
    ...extra,
  });
  ctx.res.end(buf);
}

export function sendMessage(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/** True when the request carries the shop token (or none is configured). */
export function authorized(ctx: Ctx): boolean {
  if (SHOP_TOKEN === '') return true;
  const header = ctx.req.headers.authorization ?? '';
  return header === `Bearer ${SHOP_TOKEN}`;
}

/** Refuse an unauthenticated request with a JSON 401; returns false when refused. */
export function requireAuth(ctx: Ctx): boolean {
  if (authorized(ctx)) return true;
  sendMessage(ctx, 401, 'Bad credentials');
  return false;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Parse the raw body as JSON, recording whether it failed. */
export function parseJsonBody(ctx: Ctx): void {
  if (ctx.body.length === 0) {
    ctx.json = undefined;
    ctx.jsonError = false;
    return;
  }
  try {
    ctx.json = JSON.parse(ctx.body.toString('utf8')) as unknown;
    ctx.jsonError = false;
  } catch {
    ctx.json = undefined;
    ctx.jsonError = true;
  }
}
