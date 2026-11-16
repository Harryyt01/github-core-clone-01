// store.ts — the forge's in-memory state: repositories, git objects, refs,
// issues, pull requests, labels. Deterministic: fixed timestamps, counters
// from 1, no clocks, no randomness.
//
// Viewer learning: the shop token does not encode the viewer login, so the
// server learns it lazily from the first owner-naming request. Repositories
// created before learning (POST /user/repos names no owner) are kept
// "unclaimed" and adopted by the first owner the server learns.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  oidOf,
  parseCommit,
  parseTag,
  parseTree,
} from './gitobj.ts';
import type { GitObject, ObjType, TreeEntry } from './gitobj.ts';

/** Fixed timestamp for every created_at / updated_at / merged_at. */
export const FIXED_NOW = '2026-11-14T00:00:00Z';
/** Fixed commit epoch (seconds). From MAKEFUN_TRIAL_NOW when it parses. */
export const COMMIT_EPOCH: number = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const ms = raw === '' ? Number.NaN : Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
})();

export const COMMIT_AUTHOR = `Muse <muse@make.fun> ${COMMIT_EPOCH} +0000`;

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  restId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Pull {
  number: number;
  restId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  name: string;
  /** Owner login, or '' while unclaimed (created before the viewer was learned). */
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  databaseId: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  issueSeq: number;
  prSeq: number;
  commentSeq: number;
  /** Bumps on every object/ref mutation; fetch packs are cached against it. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Opaque, stable GraphQL global ids (base64url of a typed identity string). */
export function globalId(kind: string, identity: string): string {
  return Buffer.from(`${kind}:${identity}`, 'utf8').toString('base64url');
}

export function repoGlobalId(owner: string, name: string): string {
  return globalId('Repository', `${owner}/${name}`);
}

export function issueGlobalId(owner: string, repo: string, number: number): string {
  return globalId('Issue', `${owner}/${repo}:${number}`);
}

export function pullGlobalId(owner: string, repo: string, number: number): string {
  return globalId('PullRequest', `${owner}/${repo}:${number}`);
}

export function commentGlobalId(owner: string, repo: string, issueNumber: number, commentId: number): string {
  return globalId('IssueComment', `${owner}/${repo}:${issueNumber}:${commentId}`);
}

/** Decode a global id back to {kind, identity}, or null when it is not one. */
export function parseGlobalId(id: string): { kind: string; identity: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), identity: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  viewerLogin: string | null = null;
  nextDatabaseId = 1;
  nextIssueRestId = 1;
  nextPullRestId = 1;
  private seqCounter = 0;

  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  /** Learn the viewer login from an owner-naming request; adopt unclaimed repos. */
  learnViewer(owner: string): void {
    if (owner === '') return;
    if (this.viewerLogin === null) {
      this.viewerLogin = owner;
      for (const repo of this.repos.values()) {
        if (repo.owner === '') {
          this.repos.delete(`/${repo.name}`);
          repo.owner = owner;
          this.repos.set(`${owner}/${repo.name}`, repo);
        }
      }
    }
  }

  /** Resolve a repo by owner+name, learning the viewer when the repo is unclaimed. */
  getRepo(owner: string, name: string): Repo | undefined {
    const direct = this.repos.get(`${owner}/${name}`);
    if (direct !== undefined) return direct;
    const unclaimed = this.repos.get(`/${name}`);
    if (unclaimed !== undefined) {
      // The first owner that names an existing unclaimed repo is the viewer.
      this.learnViewer(owner);
      return this.repos.get(`${owner}/${name}`);
    }
    return undefined;
  }

  /** The viewer's repos (claimed ones only), in creation order. */
  viewerRepos(): Repo[] {
    if (this.viewerLogin === null) return [...this.repos.values()].filter((r) => r.owner === '');
    return [...this.repos.values()].filter((r) => r.owner === this.viewerLogin);
  }

  createRepo(name: string, opts: { isPrivate?: boolean; description?: string; owner?: string }): Repo | null {
    const owner = opts.owner ?? this.viewerLogin ?? '';
    if (this.repos.has(`${owner}/${name}`)) return null;
    const repo: Repo = {
      name,
      owner,
      isPrivate: opts.isPrivate ?? false,
      description: opts.description ?? '',
      defaultBranch: 'main',
      databaseId: this.nextDatabaseId,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      issueSeq: 0,
      prSeq: 0,
      commentSeq: 0,
      version: 0,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    this.nextDatabaseId += 1;
    this.repos.set(`${owner}/${name}`, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(`${repo.owner}/${repo.name}`);
  }

  // ------------------------------------------------------------------------------------------
  // git object helpers (all scoped to one repo)
  // ------------------------------------------------------------------------------------------

  storeObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = oidOf(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.version += 1;
    }
    return oid;
  }

  /** Set a ref (bumps the repo version so cached fetch packs invalidate). */
  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.version += 1;
  }

  /** Delete a ref (bumps the repo version). */
  deleteRef(repo: Repo, ref: string): void {
    repo.refs.delete(ref);
    repo.version += 1;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Resolve a ref name to an oid, following HEAD. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') return this.resolveRef(repo, `refs/heads/${repo.defaultBranch}`);
    return repo.refs.get(ref);
  }

  makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const data = buildCommit(tree, parents, COMMIT_AUTHOR, COMMIT_AUTHOR, message);
    return this.storeObject(repo, 'commit', data);
  }

  /** All commit oids reachable from `tips` (tags are peeled first). */
  reachableCommits(repo: Repo, tips: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const stack: string[] = [];
    for (const tip of tips) {
      const peeled = this.peelToCommit(repo, tip);
      if (peeled !== undefined) stack.push(peeled);
    }
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      out.add(oid);
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return out;
  }

  /** Peel a tag (possibly chained) to its commit, or return the oid when it is one. */
  peelToCommit(repo: Repo, oid: string): string | undefined {
    let current = oid;
    for (let i = 0; i < 10; i += 1) {
      const obj = repo.objects.get(current);
      if (obj === undefined) return undefined;
      if (obj.type === 'commit') return current;
      if (obj.type === 'tag') {
        current = parseTag(obj.data).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  /**
   * Generation (distance from the nearest tip) for every commit reachable from
   * tips. With `maxGen` set, the walk stops expanding parents of commits at
   * that generation (a depth-limited fetch never needs deeper generations).
   */
  commitGenerations(repo: Repo, tips: Iterable<string>, maxGen?: number): Map<string, number> {
    const gens = new Map<string, number>();
    const queue: Array<[string, number]> = [];
    for (const tip of tips) {
      const peeled = this.peelToCommit(repo, tip);
      if (peeled !== undefined) queue.push([peeled, 0]);
    }
    while (queue.length > 0) {
      const [oid, gen] = queue.shift() as [string, number];
      const prev = gens.get(oid);
      if (prev !== undefined && prev <= gen) continue;
      gens.set(oid, gen);
      if (maxGen !== undefined && gen >= maxGen) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queue.push([parent, gen + 1]);
    }
    return gens;
  }

  /** True when `ancestor` is reachable from `descendant` (or they are equal). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    if (ancestor === ZERO_OID) return true;
    return this.reachableCommits(repo, [descendant]).has(ancestor);
  }

  /** First common ancestor of two commits, walking the base side's chain. */
  mergeBase(repo: Repo, head: string, base: string): string | null {
    const headAncestors = this.reachableCommits(repo, [head]);
    let current: string | undefined = base;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      if (headAncestors.has(current)) return current;
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'commit') return null;
      const parents = parseCommit(obj.data).parents;
      current = parents[0];
    }
    return null;
  }

  /** Flat file map (path -> {oid, mode}) for a tree, recursing into subtrees. */
  treeFiles(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /**
   * Set (or delete, when `blobOid` is null) one file in a tree, returning the
   * new root tree oid. Intermediate trees are created as needed.
   */
  updateTree(repo: Repo, rootTreeOid: string | null, segments: string[], blobOid: string | null): string {
    const update = (treeOid: string | null, depth: number): string => {
      const entries: TreeEntry[] = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
      const name = segments[depth] as string;
      const isLeaf = depth === segments.length - 1;
      if (isLeaf) {
        const kept = entries.filter((e) => e.name !== name);
        if (blobOid !== null) kept.push({ mode: '100644', name, oid: blobOid });
        return this.storeObject(repo, 'tree', buildTree(kept));
      }
      const child = entries.find((e) => e.name === name && e.mode === '40000');
      const childOid = update(child?.oid ?? null, depth + 1);
      const childEntries = parseTree(repo.objects.get(childOid)?.data ?? Buffer.alloc(0));
      const kept = entries.filter((e) => e.name !== name);
      if (childEntries.length > 0) kept.push({ mode: '40000', name, oid: childOid });
      return this.storeObject(repo, 'tree', buildTree(kept));
    };
    return update(rootTreeOid, 0);
  }

  /** All objects (commit + trees + blobs) reachable from a commit's tree. */
  collectTreeObjects(repo: Repo, treeOid: string, into: Map<string, GitObject>): void {
    const walk = (oid: string): void => {
      const obj = repo.objects.get(oid);
      if (obj === undefined || into.has(oid)) return;
      into.set(oid, obj);
      if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) walk(entry.oid);
      }
    };
    walk(treeOid);
  }

  // ------------------------------------------------------------------------------------------
  // diffs and merges
  // ------------------------------------------------------------------------------------------

  /** Line diff between two blobs (LCS over lines); binary-safe enough for the suite. */
  static lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
    const a = oldText === '' ? [] : oldText.split('\n');
    const b = newText === '' ? [] : newText.split('\n');
    if (a.length > 0 && a[a.length - 1] === '') a.pop();
    if (b.length > 0 && b[b.length - 1] === '') b.pop();
    const n = a.length;
    const m = b.length;
    // LCS lengths, two rows.
    let prev = new Array<number>(m + 1).fill(0);
    let cur = new Array<number>(m + 1).fill(0);
    for (let i = 1; i <= n; i += 1) {
      for (let j = 1; j <= m; j += 1) {
        cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      [prev, cur] = [cur, prev];
      cur.fill(0);
    }
    const lcs = prev[m];
    return { additions: m - lcs, deletions: n - lcs };
  }

  /** Paths changed between two trees, with per-file change counts. */
  diffTrees(
    repo: Repo,
    oldTree: string | null,
    newTree: string,
  ): Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> {
    const oldFiles = oldTree === null ? new Map() : this.treeFiles(repo, oldTree);
    const newFiles = this.treeFiles(repo, newTree);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> = [];
    const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
    for (const path of [...paths].sort()) {
      const oldEntry = oldFiles.get(path);
      const newEntry = newFiles.get(path);
      if (oldEntry === undefined && newEntry !== undefined) {
        const text = repo.objects.get(newEntry.oid)?.data.toString('utf8') ?? '';
        const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        out.push({ path, status: 'added', additions: lines, deletions: 0 });
      } else if (oldEntry !== undefined && newEntry === undefined) {
        const text = repo.objects.get(oldEntry.oid)?.data.toString('utf8') ?? '';
        const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        out.push({ path, status: 'removed', additions: 0, deletions: lines });
      } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
        const oldText = repo.objects.get(oldEntry.oid)?.data.toString('utf8') ?? '';
        const newText = repo.objects.get(newEntry.oid)?.data.toString('utf8') ?? '';
        const { additions, deletions } = Store.lineDiff(oldText, newText);
        out.push({ path, status: 'modified', additions, deletions });
      }
    }
    return out;
  }

  /**
   * Three-way merge conflict test for a pull request: a path is conflicted when
   * head and base both changed it differently against the merge-base.
   */
  mergeConflict(repo: Repo, pull: Pull): { conflict: boolean; paths: string[] } {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return { conflict: false, paths: [] };
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === null) return { conflict: true, paths: [] };
    const baseTree = parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
    const headTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
    const baseTipTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
    const baseFiles = this.treeFiles(repo, baseTree);
    const headFiles = this.treeFiles(repo, headTree);
    const baseTipFiles = this.treeFiles(repo, baseTipTree);
    const conflicted: string[] = [];
    const paths = new Set([...headFiles.keys(), ...baseTipFiles.keys(), ...baseFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path)?.oid;
      const h = headFiles.get(path)?.oid;
      const t = baseTipFiles.get(path)?.oid;
      const headChanged = h !== b;
      const baseChanged = t !== b;
      if (headChanged && baseChanged && h !== t) conflicted.push(path);
    }
    return { conflict: conflicted.length > 0, paths: conflicted };
  }
}
