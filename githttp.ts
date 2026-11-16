// githttp.ts — git smart HTTP: info/refs (v0 + v2), ls-refs, fetch (v2 + v0),
// receive-pack. Implements the protocol the kit's git-client speaks, on the
// wire contract in program/env/src/git-client.ts.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  pktFlush,
  pktLine,
  readPack,
  writePack,
} from './gitobj.ts';
import type { GitObject } from './gitobj.ts';
import type { Repo, Store } from './store.ts';
import { sendBuffer, sendMessage } from './common.ts';
import type { Ctx } from './common.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const AGENT = 'github-core-clone/1.0';

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The first line of a v0 advertisement: `<oid> <ref>\0<caps>` (or the empty-repo form). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k multi_ack thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    parts.push(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`);
    for (const ref of refs) {
      parts.push(`${ref.oid} ${ref.name}\n`);
      const obj = repo.objects.get(ref.oid);
      if (ref.name.startsWith('refs/tags/') && obj?.type === 'tag') {
        const target = parseTag(obj.data).object;
        parts.push(`${target} ${ref.name}^{}\n`);
      }
    }
  }
  parts.push('flush');
  return encodePktLines(parts);
}

function v2Advertisement(service: 'git-upload-pack'): Buffer {
  const lines: Array<string | 'flush'> = [
    `# service=${service}\n`,
    'flush',
    'version 2\n',
    'fetch=shallow\n',
    'ls-refs=unborn\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ];
  return encodePktLines(lines);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(ctx: Ctx, owner: string, repoName: string): void {
  const service = ctx.url.searchParams.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendMessage(ctx, 404, 'Not Found');
    return;
  }
  const repo = ctx.store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendMessage(ctx, 404, 'Not Found');
    return;
  }
  const protocol = (ctx.req.headers['git-protocol'] ?? '').toString();
  if (service === 'git-upload-pack' && protocol.includes('version=2')) {
    sendBuffer(ctx, 200, v2Advertisement(service), UPLOAD_AD);
    return;
  }
  sendBuffer(ctx, 200, v0Advertisement(repo, service), service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD);
}

// ------------------------------------------------------------------------------------------
// ls-refs (v2)
// ------------------------------------------------------------------------------------------

function handleLsRefs(ctx: Ctx, repo: Repo, lines: string[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: string[] = [];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) {
      out.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  } else {
    if (keep('HEAD') && headTip !== undefined) {
      out.push(`${headTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      const obj = repo.objects.get(ref.oid);
      if (peel && ref.name.startsWith('refs/tags/') && obj?.type === 'tag') {
        line += ` peeled:${parseTag(obj.data).object}`;
      }
      out.push(`${line}\n`);
    }
  }
  out.push('flush');
  sendBuffer(ctx, 200, encodePktLines(out), UPLOAD_RESULT);
}

// ------------------------------------------------------------------------------------------
// fetch
// ------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchLines(lines: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) req.depth = n;
    }
  }
  return req;
}

interface FetchPlan {
  sentCommits: string[];
  shallow: string[];
  unshallow: string[];
  objects: GitObject[];
}

/**
 * Work out what a fetch sends, following the kit's depth semantics:
 * - no depth: reachable(wants) minus reachable(haves);
 * - depth N: generations 0..N-1 from the wants, minus the haves themselves;
 *   the shallow boundary is the deepest sent commits, and an old shallow
 *   boundary whose parent is now sent becomes unshallow.
 */
function planFetch(store: Store, repo: Repo, req: FetchRequest): FetchPlan {
  const gens = store.commitGenerations(repo, req.wants, req.depth === null ? undefined : req.depth - 1);
  const haveSet = store.reachableCommits(repo, req.haves);
  const sent = new Set<string>();
  for (const [oid, gen] of gens) {
    if (req.depth !== null && gen > req.depth - 1) continue;
    if (req.depth === null) {
      if (haveSet.has(oid)) continue;
    } else if (req.haves.includes(oid)) {
      continue;
    }
    sent.add(oid);
  }
  // Objects: each sent commit plus its tree closure, minus objects the
  // client already has (reachable from the haves), plus tag objects for
  // tag wants.
  const objects = new Map<string, GitObject>();
  const haveObjects = new Map<string, GitObject>();
  for (const have of req.haves) {
    const commit = store.peelToCommit(repo, have);
    if (commit === undefined) continue;
    const obj = repo.objects.get(commit);
    if (obj !== undefined) haveObjects.set(commit, obj);
    const tree = parseCommit(obj?.data ?? Buffer.alloc(0)).tree;
    if (tree !== '') store.collectTreeObjects(repo, tree, haveObjects);
  }
  for (const want of req.wants) {
    const obj = repo.objects.get(want);
    if (obj?.type === 'tag' && !haveObjects.has(want)) objects.set(want, obj);
  }
  for (const oid of sent) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    objects.set(oid, obj);
    const tree = parseCommit(obj.data).tree;
    if (tree !== '') store.collectTreeObjects(repo, tree, objects);
  }
  for (const oid of haveObjects.keys()) objects.delete(oid);

  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (req.depth !== null) {
    for (const oid of sent) {
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length === 0 || parents.every((p) => !sent.has(p))) shallow.push(oid);
    }
    for (const boundary of req.shallow) {
      const obj = repo.objects.get(boundary);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      const complete = parents.length === 0 || parents.every((p) => sent.has(p) || haveSet.has(p));
      if (complete) unshallow.push(boundary);
    }
  }
  return { sentCommits: [...sent], shallow, unshallow, objects: [...objects.values()] };
}

function sendFetchResponse(ctx: Ctx, plan: FetchPlan, version: 2 | 0, prebuiltPack?: Buffer): void {
  const pack = prebuiltPack ?? writePack(plan.objects);
  const parts: Buffer[] = [];
  if (version === 2) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush());
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktFlush());
    }
    parts.push(pktLine('packfile\n'));
  } else {
    parts.push(pktLine('NAK\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  // Sideband band 1, chunked so no pkt-line exceeds ~32 KiB of pack data.
  const CHUNK = 32768;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  sendBuffer(ctx, 200, Buffer.concat(parts), UPLOAD_RESULT);
}

/** Fetch packs are deterministic per repo version + request, so identical
 * fetches (the clone workload's 50 concurrent shallow clones) reuse one. */
const packCache = new Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>();
const PACK_CACHE_MAX = 128;

function fetchCacheKey(repo: Repo, req: FetchRequest): string {
  return `${repo.owner}/${repo.name}|v${repo.version}|w=${req.wants.join(',')}|h=${req.haves.join(',')}|s=${req.shallow.join(',')}|d=${req.depth}`;
}

function handleFetch(ctx: Ctx, repo: Repo, lines: string[], version: 2 | 0): void {
  const req = parseFetchLines(lines);
  if (req.wants.length === 0) {
    // No wants: nothing to send (the client never asks this, but stay safe).
    sendFetchResponse(ctx, { sentCommits: [], shallow: [], unshallow: [], objects: [] }, version);
    return;
  }
  for (const want of req.wants) {
    if (!isOid(want)) {
      sendMessage(ctx, 400, 'bad want');
      return;
    }
  }
  const key = fetchCacheKey(repo, req);
  const cached = packCache.get(key);
  if (cached !== undefined) {
    sendFetchResponse(ctx, { sentCommits: [], shallow: cached.shallow, unshallow: cached.unshallow, objects: [] }, version, cached.pack);
    return;
  }
  const plan = planFetch(ctx.store, repo, req);
  const pack = writePack(plan.objects);
  if (packCache.size >= PACK_CACHE_MAX) packCache.clear();
  packCache.set(key, { pack, shallow: plan.shallow, unshallow: plan.unshallow });
  sendFetchResponse(ctx, plan, version, pack);
}

// ------------------------------------------------------------------------------------------
// receive-pack
// ------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(ctx: Ctx, repo: Repo): void {
  // Parse command pkt-lines up to the flush by hand: raw pack bytes follow
  // the flush and are not pkt-lines.
  const commands: PushCommand[] = [];
  let pos = 0;
  let flushed = false;
  while (pos + 4 <= ctx.body.length) {
    const head = ctx.body.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      sendMessage(ctx, 400, 'malformed pkt-line stream');
      return;
    }
    const len = parseInt(head, 16);
    if (len === 0) {
      pos += 4;
      flushed = true;
      break;
    }
    if (len < 4 || pos + len > ctx.body.length) {
      sendMessage(ctx, 400, 'malformed pkt-line stream');
      return;
    }
    let line = ctx.body.subarray(pos + 4, pos + len).toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length !== 3 || !isOid(parts[0] as string) || !isOid(parts[1] as string)) {
      sendMessage(ctx, 400, 'malformed push command');
      return;
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    pos += len;
  }
  if (!flushed || commands.length === 0) {
    sendMessage(ctx, 400, 'no push commands');
    return;
  }
  const packBytes = ctx.body.subarray(pos);
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const obj of objects.values()) ctx.store.storeObject(repo, obj.type, obj.data);
    } catch {
      sendMessage(ctx, 400, 'malformed packfile');
      return;
    }
  }

  const report: string[] = ['unpack ok\n'];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.push(`ng ${cmd.ref} remote ref does not exist\n`);
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        report.push(`ng ${cmd.ref} non-fast-forward\n`);
      } else {
        ctx.store.deleteRef(repo, cmd.ref);
        report.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    if (current === undefined) {
      if (cmd.oldOid !== ZERO_OID) {
        report.push(`ng ${cmd.ref} remote ref does not exist\n`);
        continue;
      }
    } else if (cmd.oldOid !== current) {
      report.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      report.push(`ng ${cmd.ref} object not found\n`);
      continue;
    }
    if (current !== undefined && cmd.newOid !== current && !ctx.store.isAncestor(repo, current, cmd.newOid)) {
      report.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    ctx.store.setRef(repo, cmd.ref, cmd.newOid);
    report.push(`ok ${cmd.ref}\n`);
  }

  // Report-status v1, pkt-lined inside sideband band 1.
  const inner = encodePktLines(report);
  const outer = encodePktLines([Buffer.concat([Buffer.from([1]), inner]), 'flush']);
  sendBuffer(ctx, 200, outer, RECEIVE_RESULT);
}

// ------------------------------------------------------------------------------------------
// dispatch
// ------------------------------------------------------------------------------------------

/** POST /{owner}/{repo}.git/git-upload-pack | git-receive-pack */
export function handleGitPost(ctx: Ctx, owner: string, repoName: string, service: string): void {
  const repo = ctx.store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendMessage(ctx, 404, 'Not Found');
    return;
  }
  // Receive-pack carries raw pack bytes after its flush: it parses its own body.
  if (service === 'git-receive-pack') {
    handleReceivePack(ctx, repo);
    return;
  }
  let packets;
  try {
    packets = decodePktLines(ctx.body);
  } catch {
    sendMessage(ctx, 400, 'malformed pkt-line stream');
    return;
  }
  const lines: string[] = [];
  let command: string | null = null;
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (command === null && text.startsWith('command=')) {
      command = text.slice('command='.length);
      continue;
    }
    if (seenDelim) lines.push(text);
  }
  if (service === 'git-receive-pack') {
    // Handled above, before pkt-line decoding.
    sendMessage(ctx, 400, 'bad request');
    return;
  }
  if (command === 'ls-refs') {
    handleLsRefs(ctx, repo, lines);
    return;
  }
  if (command === 'fetch') {
    handleFetch(ctx, repo, lines, 2);
    return;
  }
  // A v0 fetch has no command line: bare want/have lines.
  if (command === null) {
    handleFetch(ctx, repo, lines, 0);
    return;
  }
  sendMessage(ctx, 400, `unknown command ${command}`);
}
