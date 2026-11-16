// rest.ts — GitHub REST v3: repositories, branches, commits, contents,
// labels, issues, comments, pull requests and merges.

import { ZERO_OID, isOid, parseCommit, parseTag, parseTree } from './gitobj.ts';
import type { Issue, Label, Pull, Repo } from './store.ts';
import { FIXED_NOW } from './store.ts';
import { asBoolean, asString, isRecord, sendJson, sendMessage } from './common.ts';
import type { Ctx } from './common.ts';

// ------------------------------------------------------------------------------------------
// shapes
// ------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  const owner = repo.owner === '' ? null : repo.owner;
  return {
    id: repo.databaseId,
    node_id: `R_${repo.databaseId}`,
    name: repo.name,
    full_name: owner === null ? repo.name : `${owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: owner === null ? null : { login: owner, id: 1, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    url: `/api/v3/repos/${owner ?? ''}/${repo.name}`,
    html_url: `https://github.com/${owner ?? ''}/${repo.name}`,
    clone_url: `https://github.com/${owner ?? ''}/${repo.name}.git`,
    git_url: `git://github.com/${owner ?? ''}/${repo.name}.git`,
    ssh_url: `git@github.com:${owner ?? ''}/${repo.name}.git`,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    license: null,
    topics: [],
  };
}

function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  const index = [...repo.labels.values()].findIndex((l) => l.name === label.name);
  return {
    id: index + 1,
    node_id: `L_${repo.databaseId}_${index + 1}`,
    name: label.name,
    color: label.color,
    description: '',
    default: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.restId,
    node_id: `I_${repo.databaseId}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: repo.owner, id: 1, type: 'User' },
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((l): l is Label => l !== undefined)
      .map((l) => labelJson(repo, l)),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${repo.databaseId}_${issue.number}_${comment.id}`,
    body: comment.body,
    user: { login: repo.owner, id: 1, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

function pullJson(repo: Repo, pull: Pull, mergeable: boolean): Record<string, unknown> {
  return {
    id: pull.restId,
    node_id: `P_${repo.databaseId}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: { login: repo.owner, id: 1, type: 'User' },
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: repo.owner, id: 1, type: 'User' },
      repo: { name: repo.name },
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: repo.owner, id: 1, type: 'User' },
      repo: { name: repo.name },
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
  };
}

// ------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------

function paginate<T>(ctx: Ctx, items: T[]): { page: T[]; link: string | null } {
  const perPageRaw = Number.parseInt(ctx.url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.max(1, Math.min(100, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(ctx.url.searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(ctx.url.href);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    link = `<${next.href}>; rel="next"`;
  }
  return { page: slice, link };
}

function sendPage<T>(ctx: Ctx, items: T[]): void {
  const { page, link } = paginate(ctx, items);
  sendJson(ctx, 200, page, link === null ? {} : { link });
}

/** Resolve /repos/{owner}/{name}; 404s (learning the viewer when unclaimed). */
function findRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    sendMessage(ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}

function commitListJson(repo: Repo, tip: string): Array<Record<string, unknown>> {
  // Tip-first depth-first walk (parents in order): newest first.
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    const ident = (line: string): { name: string; email: string; date: string } => {
      const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
      if (match === null) return { name: line, email: '', date: FIXED_NOW };
      return {
        name: match[1] as string,
        email: match[2] as string,
        date: new Date(Number(match[3]) * 1000).toISOString(),
      };
    };
    const author = ident(parsed.author);
    const committer = ident(parsed.committer);
    out.push({
      sha: oid,
      commit: {
        message: parsed.message.replace(/\n$/, ''),
        author,
        committer,
        tree: { sha: parsed.tree },
      },
      author: null,
      committer: null,
      parents: parsed.parents.map((sha) => ({ sha })),
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    });
    for (let i = parsed.parents.length - 1; i >= 0; i -= 1) stack.push(parsed.parents[i] as string);
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// contents
// ------------------------------------------------------------------------------------------

function resolveContentRef(ctx: Ctx, repo: Repo): string | null {
  const ref = ctx.url.searchParams.get('ref');
  if (ref === undefined || ref === null || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  if (byBranch !== undefined) return byBranch;
  return null;
}

function handleContents(ctx: Ctx, repo: Repo, segments: string[]): void {
  const method = ctx.req.method ?? 'GET';
  const path = segments.join('/');
  if (method === 'PUT') {
    if (!isRecord(ctx.json)) {
      sendMessage(ctx, 400, 'Problems parsing JSON');
      return;
    }
    const message = asString(ctx.json.message) ?? '';
    const contentB64 = asString(ctx.json.content);
    const branch = asString(ctx.json.branch) ?? repo.defaultBranch;
    const sha = asString(ctx.json.sha);
    if (contentB64 === undefined) {
      sendMessage(ctx, 422, 'content is required');
      return;
    }
    let blob: Buffer;
    try {
      blob = Buffer.from(contentB64, 'base64');
    } catch {
      sendMessage(ctx, 422, 'content is not valid base64');
      return;
    }
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    const treeOid = tip === undefined ? null : parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
    const files = treeOid === null ? new Map() : ctx.store.treeFiles(repo, treeOid);
    const existing = files.get(path);
    if (existing !== undefined && sha !== existing.oid) {
      sendMessage(ctx, 409, 'sha does not match');
      return;
    }
    const blobOid = ctx.store.storeObject(repo, 'blob', blob);
    const newTree = ctx.store.updateTree(repo, treeOid, segments, blobOid);
    const parents = tip === undefined ? [] : [tip];
    const commitSha = ctx.store.makeCommit(repo, newTree, parents, message);
    ctx.store.setRef(repo, refName, commitSha);
    sendJson(ctx, existing === undefined ? 201 : 200, {
      content: { sha: blobOid, encoding: 'base64', name: segments[segments.length - 1], path, size: blob.length },
      commit: { sha: commitSha },
    });
    return;
  }
  if (method === 'DELETE') {
    const refName = `refs/heads/${repo.defaultBranch}`;
    const tip = repo.refs.get(refName);
    if (tip === undefined) {
      sendMessage(ctx, 404, 'Not Found');
      return;
    }
    const treeOid = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
    const files = ctx.store.treeFiles(repo, treeOid);
    if (!files.has(path)) {
      sendMessage(ctx, 404, 'Not Found');
      return;
    }
    const message = isRecord(ctx.json) ? asString(ctx.json.message) ?? 'Delete file' : 'Delete file';
    const newTree = ctx.store.updateTree(repo, treeOid, segments, null);
    const commitSha = ctx.store.makeCommit(repo, newTree, [tip], message);
    ctx.store.setRef(repo, refName, commitSha);
    sendJson(ctx, 200, { commit: { sha: commitSha } });
    return;
  }
  // GET
  const tip = resolveContentRef(ctx, repo);
  if (tip === undefined || tip === null) {
    sendMessage(ctx, 404, 'Not Found');
    return;
  }
  const commit = ctx.store.peelToCommit(repo, tip);
  if (commit === undefined) {
    sendMessage(ctx, 404, 'Not Found');
    return;
  }
  const treeOid = parseCommit(repo.objects.get(commit)?.data ?? Buffer.alloc(0)).tree;
  if (path === '') {
    // Root listing.
    const entries = treeOid === '' ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
    sendJson(
      ctx,
      200,
      entries.map((e) => ({
        type: e.mode === '40000' ? 'dir' : 'file',
        name: e.name,
        path: e.name,
        sha: e.oid,
        size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
      })),
    );
    return;
  }
  const files = ctx.store.treeFiles(repo, treeOid);
  const file = files.get(path);
  if (file !== undefined) {
    const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
    sendJson(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      content: data.toString('base64'),
      sha: file.oid,
      size: data.length,
      name: segments[segments.length - 1],
      path,
    });
    return;
  }
  // Directory listing: the path names a subtree.
  let dirOid: string | null = treeOid === '' ? null : treeOid;
  for (const segment of segments) {
    if (dirOid === null) break;
    const entries = parseTree(repo.objects.get(dirOid)?.data ?? Buffer.alloc(0));
    const child = entries.find((e) => e.name === segment && e.mode === '40000');
    dirOid = child?.oid ?? null;
  }
  if (dirOid === null) {
    sendMessage(ctx, 404, 'Not Found');
    return;
  }
  const entries = parseTree(repo.objects.get(dirOid)?.data ?? Buffer.alloc(0));
  sendJson(
    ctx,
    200,
    entries.map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: `${path}/${e.name}`,
      sha: e.oid,
      size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
    })),
  );
}

// ------------------------------------------------------------------------------------------
// dispatch
// ------------------------------------------------------------------------------------------

/** Handle any /api/v3 route. Returns true when the route was handled. */
export function handleRest(ctx: Ctx): boolean {
  const seg = ctx.segments;
  if (seg[0] !== 'api' || seg[1] !== 'v3') return false;
  const method = ctx.req.method ?? 'GET';
  const rest = seg.slice(2);

  // API root.
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    sendMessage(ctx, 404, 'Not Found');
    return true;
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method === 'GET') sendJson(ctx, 200, { installed_version: '1.0.0' });
    else sendMessage(ctx, 404, 'Not Found');
    return true;
  }

  // /user and /user/repos
  if (rest[0] === 'user') {
    if (rest.length === 1) {
      if (method !== 'GET') {
        sendMessage(ctx, 404, 'Not Found');
        return true;
      }
      if (ctx.store.viewerLogin === null) {
        sendMessage(ctx, 404, 'Not Found');
        return true;
      }
      sendJson(ctx, 200, { login: ctx.store.viewerLogin, id: 1, type: 'User' });
      return true;
    }
    if (rest[1] === 'repos') {
      if (method === 'POST') {
        if (ctx.jsonError || !isRecord(ctx.json)) {
          sendMessage(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const name = asString(ctx.json.name);
        if (name === undefined || name === '') {
          sendMessage(ctx, 422, 'name is required');
          return true;
        }
        const repo = ctx.store.createRepo(name, {
          isPrivate: asBoolean(ctx.json.private) ?? false,
          description: asString(ctx.json.description) ?? '',
        });
        if (repo === null) {
          sendMessage(ctx, 422, 'Repository already exists');
          return true;
        }
        sendJson(ctx, 201, repoJson(repo));
        return true;
      }
      if (method === 'GET') {
        sendPage(ctx, ctx.store.viewerRepos().map((r) => repoJson(r)));
        return true;
      }
      sendMessage(ctx, 404, 'Not Found');
      return true;
    }
    sendMessage(ctx, 404, 'Not Found');
    return true;
  }

  // /repos/{owner}/{name}/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const tail = rest.slice(3);

    // Malformed JSON on any repo write is a 400.
    if ((method === 'POST' || method === 'PATCH' || method === 'PUT') && ctx.jsonError) {
      sendMessage(ctx, 400, 'Problems parsing JSON');
      return true;
    }

    if (tail.length === 0) {
      const repo = findRepo(ctx, owner, name);
      if (repo === null) return true;
      if (method === 'GET') {
        sendJson(ctx, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (!isRecord(ctx.json)) {
          sendMessage(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const description = asString(ctx.json.description);
        if (description !== undefined) repo.description = description;
        const isPrivate = asBoolean(ctx.json.private);
        if (isPrivate !== undefined) repo.isPrivate = isPrivate;
        sendJson(ctx, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(repo);
        ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
        ctx.res.end();
        return true;
      }
      sendMessage(ctx, 404, 'Not Found');
      return true;
    }

    // git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const repo = findRepo(ctx, owner, name);
        if (repo === null) return true;
        if (!isRecord(ctx.json)) {
          sendMessage(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const ref = asString(ctx.json.ref);
        const sha = asString(ctx.json.sha);
        if (ref === undefined || sha === undefined || !isOid(sha)) {
          sendMessage(ctx, 422, 'ref and sha are required');
          return true;
        }
        if (!repo.objects.has(sha)) {
          sendMessage(ctx, 422, 'object not found');
          return true;
        }
        ctx.store.setRef(repo, ref, sha);
        sendJson(ctx, 201, { ref, object: { sha } });
        return true;
      }
      if (method === 'GET' && tail.length >= 3) {
        const repo = findRepo(ctx, owner, name);
        if (repo === null) return true;
        const ref = `refs/${tail.slice(2).join('/')}`;
        const oid = repo.refs.get(ref);
        if (oid === undefined) {
          sendMessage(ctx, 404, 'Not Found');
          return true;
        }
        sendJson(ctx, 200, { ref, object: { sha: oid } });
        return true;
      }
      sendMessage(ctx, 404, 'Not Found');
      return true;
    }

    // branches
    if (tail[0] === 'branches') {
      const repo = findRepo(ctx, owner, name);
      if (repo === null) return true;
      if (method === 'GET' && tail.length === 1) {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(ctx, 200, branches);
        return true;
      }
      if (method === 'GET' && tail.length === 2) {
        const oid = repo.refs.get(`refs/heads/${tail[1] as string}`);
        if (oid === undefined) {
          sendMessage(ctx, 404, 'Not Found');
          return true;
        }
        sendJson(ctx, 200, { name: tail[1], commit: { sha: oid } });
        return true;
      }
      sendMessage(ctx, 404, 'Not Found');
      return true;
    }

    // commits
    if (tail[0] === 'commits') {
      const repo = findRepo(ctx, owner, name);
      if (repo === null) return true;
      if (method === 'GET' && tail.length === 1) {
        const ref = ctx.url.searchParams.get('sha');
        let tip: string | undefined;
        if (ref === null || ref === '') {
          tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        } else if (isOid(ref)) {
          tip = repo.objects.has(ref) ? ref : undefined;
        } else {
          tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
        }
        if (tip === undefined) {
          sendJson(ctx, 200, []);
          return true;
        }
        sendJson(ctx, 200, commitListJson(repo, tip));
        return true;
      }
      sendMessage(ctx, 404, 'Not Found');
      return true;
    }

    // contents
    if (tail[0] === 'contents') {
      const repo = findRepo(ctx, owner, name);
      if (repo === null) return true;
      handleContents(ctx, repo, tail.slice(1));
      return true;
    }

    // labels
    if (tail[0] === 'labels') {
      const repo = findRepo(ctx, owner, name);
      if (repo === null) return true;
      if (method === 'POST' && tail.length === 1) {
        if (!isRecord(ctx.json)) {
          sendMessage(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const labelName = asString(ctx.json.name);
        const color = asString(ctx.json.color) ?? '000000';
        if (labelName === undefined || labelName === '') {
          sendMessage(ctx, 422, 'name is required');
          return true;
        }
        if (repo.labels.has(labelName)) {
          sendMessage(ctx, 422, 'Label already exists');
          return true;
        }
        const label: Label = { name: labelName, color };
        repo.labels.set(labelName, label);
        sendJson(ctx, 201, labelJson(repo, label));
        return true;
      }
      sendMessage(ctx, 404, 'Not Found');
      return true;
    }

    // issues
    if (tail[0] === 'issues') {
      const repo = findRepo(ctx, owner, name);
      if (repo === null) return true;
      if (tail.length === 1) {
        if (method === 'POST') {
          if (!isRecord(ctx.json)) {
            sendMessage(ctx, 400, 'Problems parsing JSON');
            return true;
          }
          const title = asString(ctx.json.title);
          if (title === undefined || title === '') {
            sendMessage(ctx, 422, 'title is required');
            return true;
          }
          const labelNames: string[] = Array.isArray(ctx.json.labels)
            ? (ctx.json.labels as unknown[]).map((l) => (typeof l === 'string' ? l : isRecord(l) ? asString(l.name) : undefined)).filter((l): l is string => l !== undefined)
            : [];
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) {
              sendMessage(ctx, 422, `Label '${labelName}' does not exist`);
              return true;
            }
          }
          repo.issueSeq += 1;
          const issue: Issue = {
            number: repo.issueSeq,
            restId: ctx.store.nextIssueRestId,
            title,
            body: asString(ctx.json.body) ?? '',
            state: 'open',
            labels: labelNames,
            comments: [],
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
            seq: ctx.store.nextSeq(),
          };
          ctx.store.nextIssueRestId += 1;
          repo.issues.push(issue);
          sendJson(ctx, 201, issueJson(repo, issue));
          return true;
        }
        if (method === 'GET') {
          const state = ctx.url.searchParams.get('state') ?? 'open';
          const sort = ctx.url.searchParams.get('sort') ?? 'created';
          const direction = ctx.url.searchParams.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          sendPage(ctx, list.map((i) => issueJson(repo, i)));
          return true;
        }
        sendMessage(ctx, 404, 'Not Found');
        return true;
      }
      const number = Number.parseInt(tail[1] as string, 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (tail.length === 2) {
        if (issue === undefined) {
          sendMessage(ctx, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(ctx, 200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          if (!isRecord(ctx.json)) {
            sendMessage(ctx, 400, 'Problems parsing JSON');
            return true;
          }
          const state = asString(ctx.json.state);
          if (state === 'closed' || state === 'open') issue.state = state;
          const title = asString(ctx.json.title);
          if (title !== undefined) issue.title = title;
          const body = asString(ctx.json.body);
          if (body !== undefined) issue.body = body;
          issue.updatedAt = FIXED_NOW;
          sendJson(ctx, 200, issueJson(repo, issue));
          return true;
        }
        sendMessage(ctx, 404, 'Not Found');
        return true;
      }
      if (tail[2] === 'comments') {
        if (issue === undefined) {
          sendMessage(ctx, 404, 'Not Found');
          return true;
        }
        if (method === 'POST') {
          if (!isRecord(ctx.json)) {
            sendMessage(ctx, 400, 'Problems parsing JSON');
            return true;
          }
          const body = asString(ctx.json.body);
          if (body === undefined) {
            sendMessage(ctx, 422, 'body is required');
            return true;
          }
          repo.commentSeq += 1;
          const comment = { id: repo.commentSeq, body, createdAt: FIXED_NOW };
          issue.comments.push(comment);
          sendJson(ctx, 201, commentJson(repo, issue, comment));
          return true;
        }
        if (method === 'GET') {
          sendJson(ctx, 200, issue.comments.map((c) => commentJson(repo, issue, c)));
          return true;
        }
        sendMessage(ctx, 404, 'Not Found');
        return true;
      }
      sendMessage(ctx, 404, 'Not Found');
      return true;
    }

    // pulls
    if (tail[0] === 'pulls') {
      const repo = findRepo(ctx, owner, name);
      if (repo === null) return true;
      if (tail.length === 1) {
        if (method === 'POST') {
          if (!isRecord(ctx.json)) {
            sendMessage(ctx, 400, 'Problems parsing JSON');
            return true;
          }
          const title = asString(ctx.json.title);
          const head = asString(ctx.json.head);
          const base = asString(ctx.json.base) ?? repo.defaultBranch;
          if (title === undefined || head === undefined) {
            sendMessage(ctx, 422, 'title and head are required');
            return true;
          }
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (headSha === undefined || baseSha === undefined) {
            sendMessage(ctx, 422, 'head or base branch not found');
            return true;
          }
          repo.prSeq += 1;
          const pull: Pull = {
            number: repo.prSeq,
            restId: ctx.store.nextPullRestId,
            title,
            body: asString(ctx.json.body) ?? '',
            state: 'open',
            headRef: head,
            baseRef: base,
            headSha,
            baseSha,
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
            seq: ctx.store.nextSeq(),
          };
          ctx.store.nextPullRestId += 1;
          repo.pulls.push(pull);
          sendJson(ctx, 201, pullJson(repo, pull, !ctx.store.mergeConflict(repo, pull).conflict));
          return true;
        }
        if (method === 'GET') {
          const state = ctx.url.searchParams.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          sendPage(
            ctx,
            list.map((p) => pullJson(repo, p, !ctx.store.mergeConflict(repo, p).conflict)),
          );
          return true;
        }
        sendMessage(ctx, 404, 'Not Found');
        return true;
      }
      const number = Number.parseInt(tail[1] as string, 10);
      const pull = repo.pulls.find((p) => p.number === number);
      if (tail.length === 2) {
        if (pull === undefined) {
          sendMessage(ctx, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(ctx, 200, pullJson(repo, pull, !ctx.store.mergeConflict(repo, pull).conflict));
          return true;
        }
        sendMessage(ctx, 404, 'Not Found');
        return true;
      }
      if (tail[2] === 'files' && method === 'GET') {
        if (pull === undefined) {
          sendMessage(ctx, 404, 'Not Found');
          return true;
        }
        const base = ctx.store.mergeBase(repo, pull.headSha, pull.baseSha);
        const baseTree = base === null ? null : parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
        const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
        const files = ctx.store.diffTrees(repo, baseTree, headTree).map((f) => ({
          filename: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.additions + f.deletions,
        }));
        sendJson(ctx, 200, files);
        return true;
      }
      if (tail[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) {
          sendMessage(ctx, 404, 'Not Found');
          return true;
        }
        if (pull.merged) {
          sendMessage(ctx, 405, 'Pull request already merged');
          return true;
        }
        const conflict = ctx.store.mergeConflict(repo, pull);
        if (conflict.conflict) {
          sendMessage(ctx, 405, 'Merge conflict');
          return true;
        }
        const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
        const mergeSha = ctx.store.makeCommit(repo, headTree, [pull.baseSha], pull.title);
        ctx.store.setRef(repo, `refs/heads/${pull.baseRef}`, mergeSha);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = FIXED_NOW;
        pull.mergeCommitSha = mergeSha;
        pull.updatedAt = FIXED_NOW;
        sendJson(ctx, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
      sendMessage(ctx, 404, 'Not Found');
      return true;
    }

    sendMessage(ctx, 404, 'Not Found');
    return true;
  }

  sendMessage(ctx, 404, 'Not Found');
  return true;
}
