// gitobj.ts — the git object layer: pkt-lines, object hashing, tree/commit/tag
// codecs, and packfile read/write. Stdlib only (node:crypto, node:zlib).
// Everything here is deterministic: no clocks, no randomness.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflate, deflateSync as zlibDeflate } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 object id: sha1("<type> <size>\0" + data). */
export function oidOf(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ------------------------------------------------------------------------------------------
// pkt-lines
// ------------------------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** One pkt-line framing `payload` (string or bytes). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

/** Encode a list of lines plus 'flush' / 'delim' markers into one buffer. */
export function encodePktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode a whole buffer of pkt-lines. Throws on a malformed length prefix, a
 * truncated line, or a length below 4 — the caller turns that into a 400.
 */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line length');
    const head = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// trees, commits, tags
// ------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) throw new Error('bad tree entry');
    const mode = data.subarray(pos, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('bad tree entry');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Build a tree object. Entries are sorted git-style (dirs compare as name + '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return Buffer.compare(Buffer.from(ka, 'utf8'), Buffer.from(kb, 'utf8'));
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const out: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

/** Build a commit object. `message` is stored with a trailing newline. */
export function buildCommit(
  tree: string,
  parents: string[],
  author: string,
  committer: string,
  message: string,
): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8');
}

export interface ParsedTag {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const out: ParsedTag = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) out.tag = line.slice(4);
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// packfiles
// ------------------------------------------------------------------------------------------

function readPackVarint(buf: Buffer, pos: number): [number, number] {
  let value = buf[pos] ?? 0;
  let p = pos + 1;
  let shift = 4;
  // First byte: low 4 bits are the size, bits 4-6 the type; handled by the caller.
  value = value & 0x0f;
  let b = buf[pos] ?? 0;
  while (b & 0x80) {
    b = buf[p] ?? 0;
    value |= (b & 0x7f) << shift;
    shift += 7;
    p += 1;
  }
  return [value, p];
}

function readDeltaVarint(buf: Buffer, pos: number): [number, number] {
  let value = 0;
  let p = pos;
  let b = 0;
  do {
    b = buf[p] ?? 0;
    value = (value << 7) | (b & 0x7f);
    p += 1;
  } while (b & 0x80);
  return [value, p];
}

/** Apply a delta to a base object, returning the reconstructed bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const [baseSize, p1] = readDeltaVarint(delta, p);
  p = p1;
  const [resultSize, p2] = readDeltaVarint(delta, p);
  p = p2;
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  while (p < delta.length) {
    const op = delta[p] ?? 0;
    p += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[p] ?? 0, p += 1;
      if (op & 0x02) offset |= (delta[p] ?? 0) << 8, p += 1;
      if (op & 0x04) offset |= (delta[p] ?? 0) << 16, p += 1;
      if (op & 0x08) offset |= (delta[p] ?? 0) << 24, p += 1;
      if (op & 0x10) size = delta[p] ?? 0, p += 1;
      if (op & 0x20) size |= (delta[p] ?? 0) << 8, p += 1;
      if (op & 0x40) size |= (delta[p] ?? 0) << 16, p += 1;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      parts.push(base.subarray(offset, offset + size));
    } else if (op !== 0) {
      parts.push(delta.subarray(p, p + op));
      p += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(parts);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

/**
 * Inflate a zlib stream that starts at `buf[0]` and is followed by more bytes.
 * The stream's exact end is found by binary search: the smallest prefix that
 * inflates to `expectedSize` bytes. Returns the data and bytes consumed.
 */
function inflatePrefix(buf: Buffer, expectedSize: number): { data: Buffer; consumed: number } {
  if (buf.length === 0) throw new Error('empty zlib stream');
  const ok = (len: number): boolean => {
    try {
      return zlibInflate(buf.subarray(0, len)).length === expectedSize;
    } catch {
      return false;
    }
  };
  if (!ok(buf.length)) throw new Error('zlib stream does not inflate to the expected size');
  let lo = 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return { data: zlibInflate(buf.subarray(0, lo)), consumed: lo };
}

interface PackEntry {
  type: ObjType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  startPos: number;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a packfile (version 2), resolving OFS_DELTA and REF_DELTA entries.
 * `resolveBase` looks up a base object the pack itself does not carry.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): PackReadResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  for (let i = 0; i < count; i += 1) {
    const startPos = pos;
    const first = pack[pos] ?? 0;
    const typeCode = (first >> 4) & 0x07;
    const [size, afterSize] = readPackVarint(pack, pos);
    pos = afterSize;
    let type: PackEntry['type'];
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      type = 'ofs-delta';
      let b = pack[pos] ?? 0;
      pos += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos] ?? 0;
        pos += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = startPos - offset;
    } else if (typeCode === 7) {
      type = 'ref-delta';
      baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else {
      const mapped = CODE_TYPES[typeCode];
      if (mapped === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      type = mapped;
    }
    const { data, consumed } = inflatePrefix(pack.subarray(pos), size);
    pos += consumed;
    const entry: PackEntry = { type, data, baseOffset, baseOid, startPos };
    entries.push(entry);
    byOffset.set(startPos, entry);
  }
  // Trailer: SHA-1 of everything before it. Verified when present.
  if (pos + 20 <= pack.length) {
    const expect = createHash('sha1').update(pack.subarray(0, pos)).digest('hex');
    const actual = pack.subarray(pos, pos + 20).toString('hex');
    if (expect !== actual) throw new Error('pack trailer checksum mismatch');
  }

  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  const resolve = (entry: PackEntry, seen: Set<PackEntry>): GitObject => {
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      deltaCount += 1;
      if (seen.has(entry)) throw new Error('delta cycle');
      seen.add(entry);
      let base: GitObject | undefined;
      if (entry.type === 'ofs-delta') {
        const baseEntry = byOffset.get(entry.baseOffset ?? -1);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing');
        base = resolve(baseEntry, seen);
      } else {
        const oid = entry.baseOid ?? '';
        const found = objects.get(oid) ?? resolveBase?.(oid);
        if (found === undefined) throw new Error(`ref-delta base ${oid} missing`);
        base = found;
      }
      const data = applyDelta(base.data, entry.data);
      const obj: GitObject = { type: base.type, data };
      objects.set(oidOf(obj.type, obj.data), obj);
      return obj;
    }
    const obj: GitObject = { type: entry.type as ObjType, data: entry.data };
    objects.set(oidOf(obj.type, obj.data), obj);
    return obj;
  };
  for (const entry of entries) resolve(entry, new Set());
  return { objects, deltaCount };
}

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const first = (code << 4) | (size & 0x0f);
  const rest: number[] = [];
  let remaining = size >> 4;
  let byte = first;
  while (remaining > 0) {
    rest.push(byte | 0x80);
    byte = remaining & 0x7f;
    remaining >>= 7;
  }
  rest.push(byte);
  return Buffer.from(rest);
}

/** Build a packfile (version 2, plain objects, no deltas) from objects. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [Buffer.alloc(12)];
  parts[0]?.write('PACK', 0, 'ascii');
  parts[0]?.writeUInt32BE(2, 4);
  parts[0]?.writeUInt32BE(list.length, 8);
  for (const obj of list) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(zlibDeflate(obj.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}
