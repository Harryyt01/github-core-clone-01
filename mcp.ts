// mcp.ts — Model Context Protocol over Streamable HTTP (modern era
// 2026-07-28): server/discover, initialize, notifications/initialized,
// tools/list, tools/call. The six tools act on the same store as REST, so a
// repository or issue created over MCP reads back over /api/v3 unchanged.

import { parseCommit } from './gitobj.ts';
import type { Issue, Pull, Repo } from './store.ts';
import { FIXED_NOW } from './store.ts';
import { isRecord, sendJson } from './common.ts';
import type { Ctx } from './common.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, string>>;
    required: string[];
  };
}

/** The six tools, built from a constant so two tools/list calls are identical. */
const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        owner: { type: 'string', description: 'Owner login' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function okResult(result: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function strArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueShape(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.restId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function runTool(ctx: Ctx, name: string, args: Record<string, unknown>): ToolResult {
  const store = ctx.store;
  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name');
      if (repoName === undefined || repoName === '') return errorResult('name is required');
      const owner = strArg(args, 'owner');
      if (owner !== undefined) store.learnViewer(owner);
      const repo = store.createRepo(repoName, {
        owner: owner ?? store.viewerLogin ?? undefined,
        description: strArg(args, 'description') ?? '',
        isPrivate: args.private === true,
      });
      if (repo === null) return errorResult('Repository already exists');
      return okResult(repoShape(repo));
    }
    case 'get_repo': {
      const owner = strArg(args, 'owner') ?? '';
      const repoName = strArg(args, 'repo') ?? '';
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult('Not Found');
      return okResult(repoShape(repo));
    }
    case 'create_issue': {
      const owner = strArg(args, 'owner') ?? '';
      const repoName = strArg(args, 'repo') ?? '';
      const title = strArg(args, 'title');
      if (title === undefined || title === '') return errorResult('title is required');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult('Not Found');
      repo.issueSeq += 1;
      const issue: Issue = {
        number: repo.issueSeq,
        restId: store.nextIssueRestId,
        title,
        body: strArg(args, 'body') ?? '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        seq: store.nextSeq(),
      };
      store.nextIssueRestId += 1;
      repo.issues.push(issue);
      return okResult(issueShape(repo, issue));
    }
    case 'list_issues': {
      const owner = strArg(args, 'owner') ?? '';
      const repoName = strArg(args, 'repo') ?? '';
      const state = strArg(args, 'state') ?? 'open';
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult('Not Found');
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => a.seq - b.seq);
      return okResult(list.map((i) => issueShape(repo, i)));
    }
    case 'create_pull_request': {
      const owner = strArg(args, 'owner') ?? '';
      const repoName = strArg(args, 'repo') ?? '';
      const title = strArg(args, 'title');
      const head = strArg(args, 'head');
      const base = strArg(args, 'base');
      if (title === undefined || head === undefined || base === undefined) {
        return errorResult('title, head and base are required');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult('Not Found');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return errorResult('head or base branch not found');
      repo.prSeq += 1;
      const pull: Pull = {
        number: repo.prSeq,
        restId: store.nextPullRestId,
        title,
        body: strArg(args, 'body') ?? '',
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
        seq: store.nextSeq(),
      };
      store.nextPullRestId += 1;
      repo.pulls.push(pull);
      return okResult({
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: 'open',
        head: { ref: head, sha: headSha },
        base: { ref: base, sha: baseSha },
      });
    }
    case 'merge_pull_request': {
      const owner = strArg(args, 'owner') ?? '';
      const repoName = strArg(args, 'repo') ?? '';
      const rawNumber = args.pull_number;
      const number = typeof rawNumber === 'number' ? rawNumber : Number.parseInt(String(rawNumber ?? ''), 10);
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult('Not Found');
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return errorResult('Not Found');
      if (pull.merged) return errorResult('Pull request already merged');
      if (store.mergeConflict(repo, pull).conflict) return errorResult('Merge conflict');
      const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
      const mergeSha = store.makeCommit(repo, headTree, [pull.baseSha], pull.title);
      ctx.store.setRef(repo, `refs/heads/${pull.baseRef}`, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = FIXED_NOW;
      pull.mergeCommitSha = mergeSha;
      pull.updatedAt = FIXED_NOW;
      return okResult({ number: pull.number, merged: true, state: 'closed', sha: mergeSha });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

function rpcResult(ctx: Ctx, id: unknown, result: unknown): void {
  sendJson(ctx, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(ctx: Ctx, status: number, id: unknown, code: number, message: string): void {
  sendJson(ctx, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

export function handleMcp(ctx: Ctx): boolean {
  if (ctx.segments.join('/') !== 'mcp') return false;
  if ((ctx.req.method ?? 'POST') !== 'POST') {
    ctx.res.writeHead(405, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return true;
  }
  if (ctx.jsonError || !isRecord(ctx.json)) {
    rpcError(ctx, 400, null, -32700, 'Parse error');
    return true;
  }
  const body = ctx.json as Record<string, unknown>;
  const method = typeof body.method === 'string' ? body.method : '';
  const id = body.id ?? null;
  const params = isRecord(body.params) ? body.params : {};

  // Notifications carry no id and get no JSON-RPC response.
  if (method.startsWith('notifications/')) {
    ctx.res.writeHead(202, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return true;
  }

  switch (method) {
    case 'server/discover': {
      rpcResult(ctx, id, {
        supportedVersions: [MODERN_REVISION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
      return true;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      rpcResult(ctx, id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return true;
    }
    case 'ping': {
      rpcResult(ctx, id, {});
      return true;
    }
    case 'tools/list': {
      rpcResult(ctx, id, { tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const tool = TOOLS.find((t) => t.name === toolName);
      if (tool === undefined) {
        rpcError(ctx, 200, id, -32602, `Unknown tool: ${toolName}`);
        return true;
      }
      const missing = tool.inputSchema.required.filter((prop) => args[prop] === undefined || args[prop] === null);
      if (missing.length > 0) {
        rpcResult(ctx, id, errorResult(`missing required argument: ${missing.join(', ')}`));
        return true;
      }
      rpcResult(ctx, id, runTool(ctx, toolName, args));
      return true;
    }
    default: {
      rpcError(ctx, 200, id, -32601, `Method not found: ${method}`);
      return true;
    }
  }
}
