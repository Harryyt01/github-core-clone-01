// graphql.ts — a small GraphQL executor for the documents the suite sends
// (the 18 documents in program/env/src/checks-graphql.ts). It parses the
// query text, resolves variables, executes against the shared store, and
// answers unknown fields with a 200 + errors array naming the field.

import { parseCommit } from './gitobj.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';
import { FIXED_NOW, commentGlobalId, issueGlobalId, parseGlobalId, pullGlobalId, repoGlobalId } from './store.ts';
import { asString, isRecord, sendJson, sendMessage } from './common.ts';
import type { Ctx } from './common.ts';

// ------------------------------------------------------------------------------------------
// tokenizer + parser
// ------------------------------------------------------------------------------------------

type Token = { kind: 'name' | 'string' | 'number' | 'punct' | 'spread'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += src[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

export interface FieldSel {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selections: Selection[];
}

export interface FragmentSel {
  kind: 'fragment';
  type: string;
  selections: Selection[];
}

export type Selection = FieldSel | FragmentSel;

export interface Operation {
  opType: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const tok = this.tokens[this.pos];
    if (tok === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected ${value}, got ${tok.value}`);
  }

  private expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`expected a name, got ${tok.value}`);
    return tok.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) ops.push(this.parseOperation());
    return ops;
  }

  parseOperation(): Operation {
    let opType: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first !== undefined && first.kind === 'punct' && first.value === '{') {
      return { opType, name, variables: [], selections: this.parseSelectionSet() };
    }
    const keyword = this.next();
    if (keyword.kind !== 'name' || (keyword.value !== 'query' && keyword.value !== 'mutation')) {
      throw new Error(`expected query or mutation, got ${keyword.value}`);
    }
    opType = keyword.value;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName.kind === 'name') name = this.next().value;
    const variables: string[] = [];
    const maybeParen = this.peek();
    if (maybeParen !== undefined && maybeParen.kind === 'punct' && maybeParen.value === '(') {
      this.next();
      while (true) {
        const tok = this.next();
        if (tok.kind === 'punct' && tok.value === ')') break;
        if (tok.kind === 'punct' && tok.value === '$') {
          variables.push(this.expectName());
          // Skip the type annotation up to the next ',' or ')'.
          let depth = 0;
          while (true) {
            const t = this.next();
            if (t.kind === 'punct' && t.value === '(') depth += 1;
            if (t.kind === 'punct' && t.value === ')') {
              if (depth === 0) {
                this.pos -= 1;
                break;
              }
              depth -= 1;
            }
            if (t.kind === 'punct' && t.value === ',' && depth === 0) break;
            if (t.kind === 'punct' && t.value === '=' && depth === 0) {
              // Default value: skip one value.
              this.parseValue();
              const after = this.peek();
              if (after !== undefined && after.kind === 'punct' && after.value === ',') {
                this.next();
                break;
              }
              if (after !== undefined && after.kind === 'punct' && after.value === ')') break;
            }
            if (t.kind === 'punct' && t.value === ')') {
              this.pos -= 1;
              break;
            }
          }
          const after = this.peek();
          if (after !== undefined && after.kind === 'punct' && after.value === ')') {
            this.next();
            break;
          }
          continue;
        }
        if (tok.kind === 'punct' && tok.value === ',') continue;
        throw new Error(`unexpected token in variable definitions: ${tok.value}`);
      }
    }
    return { opType, name, variables, selections: this.parseSelectionSet() };
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (true) {
      const tok = this.next();
      if (tok.kind === 'punct' && tok.value === '}') break;
      if (tok.kind === 'spread') {
        const on = this.next();
        if (on.kind !== 'name' || on.value !== 'on') throw new Error('only inline fragments are supported');
        const type = this.expectName();
        selections.push({ kind: 'fragment', type, selections: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind !== 'name') throw new Error(`expected a field name, got ${tok.value}`);
      let alias: string | null = null;
      let name = tok.value;
      const maybeColon = this.peek();
      if (maybeColon !== undefined && maybeColon.kind === 'punct' && maybeColon.value === ':') {
        this.next();
        alias = name;
        name = this.expectName();
      }
      const args: Record<string, GqlValue> = {};
      const maybeParen = this.peek();
      if (maybeParen !== undefined && maybeParen.kind === 'punct' && maybeParen.value === '(') {
        this.next();
        while (true) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === ')') break;
          if (t.kind !== 'name') throw new Error(`expected an argument name, got ${t.value}`);
          this.expectPunct(':');
          args[t.value] = this.parseValue();
          const after = this.peek();
          if (after !== undefined && after.kind === 'punct' && after.value === ',') this.next();
        }
      }
      let sub: Selection[] = [];
      const maybeBrace = this.peek();
      if (maybeBrace !== undefined && maybeBrace.kind === 'punct' && maybeBrace.value === '{') {
        sub = this.parseSelectionSet();
      }
      selections.push({ kind: 'field', alias, name, args, selections: sub });
    }
    return selections;
  }

  parseValue(): GqlValue {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'var', name: this.expectName() };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'number') return { kind: 'number', value: Number(tok.value) };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: GqlValue[] = [];
      while (true) {
        const t = this.peek();
        if (t !== undefined && t.kind === 'punct' && t.value === ']') {
          this.next();
          break;
        }
        items.push(this.parseValue());
        const after = this.peek();
        if (after !== undefined && after.kind === 'punct' && after.value === ',') this.next();
      }
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Record<string, GqlValue> = {};
      while (true) {
        const t = this.next();
        if (t.kind === 'punct' && t.value === '}') break;
        if (t.kind !== 'name') throw new Error(`expected an object field name, got ${t.value}`);
        this.expectPunct(':');
        fields[t.value] = this.parseValue();
        const after = this.peek();
        if (after !== undefined && after.kind === 'punct' && after.value === ',') this.next();
      }
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'bool', value: true };
      if (tok.value === 'false') return { kind: 'bool', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`unexpected value token ${tok.value}`);
  }
}

// ------------------------------------------------------------------------------------------
// execution
// ------------------------------------------------------------------------------------------

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type AnyObj = Record<string, unknown> & { __typename: string };

function wrap(typename: string, fields: Record<string, unknown>): AnyObj {
  return { __typename: typename, ...fields };
}

function resolveValue(value: GqlValue, exec: ExecCtx): unknown {
  switch (value.kind) {
    case 'var':
      return exec.variables[value.name];
    case 'string':
      return value.value;
    case 'number':
      return value.value;
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, exec));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value.fields)) out[key] = resolveValue(field, exec);
      return out;
    }
  }
}

function arg<T>(field: FieldSel, name: string, exec: ExecCtx): T | undefined {
  const raw = field.args[name];
  if (raw === undefined) return undefined;
  return resolveValue(raw, exec) as T;
}

function gqlState(state: 'open' | 'closed', merged: boolean): string {
  if (merged) return 'MERGED';
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObj(repo: Repo, issue: Issue): AnyObj {
  return wrap('Issue', {
    id: issueGlobalId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  });
}

function pullObj(repo: Repo, pull: Pull, store: Store): AnyObj {
  const conflict = store.mergeConflict(repo, pull).conflict;
  return wrap('PullRequest', {
    repo,
    pull,
    id: pullGlobalId(repo.owner, repo.name, pull.number),
    number: pull.number,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: conflict ? 'CONFLICTING' : 'MERGEABLE',
    state: gqlState(pull.state, pull.merged),
    merged: pull.merged,
  });
}

function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function pageInfo(hasNextPage: boolean, endCursor: string | null): AnyObj {
  return wrap('PageInfo', { hasNextPage, endCursor });
}

function issuesConnection(repo: Repo, field: FieldSel, exec: ExecCtx): AnyObj {
  const first = arg<number>(field, 'first', exec) ?? 10;
  const after = decodeCursor(arg<string>(field, 'after', exec));
  const states = arg<string[]>(field, 'states', exec);
  const orderBy = arg<{ field?: string; direction?: string }>(field, 'orderBy', exec);
  let list = [...repo.issues];
  if (states !== undefined && states.length > 0) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  if (orderBy?.field === 'CREATED_AT') {
    list.sort((a, b) => (orderBy.direction === 'DESC' ? b.number - a.number : a.number - b.number));
  } else {
    list.sort((a, b) => a.number - b.number);
  }
  let start = 0;
  if (after !== null) {
    const afterNumber = Number.parseInt(after.replace('issue:', ''), 10);
    if (Number.isFinite(afterNumber)) {
      const index = list.findIndex((i) => i.number === afterNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const page = list.slice(start, start + first);
  const hasNextPage = start + first < list.length;
  const endCursor = page.length > 0 ? encodeCursor(`issue:${page[page.length - 1]?.number ?? 0}`) : null;
  return wrap('IssueConnection', {
    nodes: page.map((i) => issueObj(repo, i)),
    pageInfo: pageInfo(hasNextPage, endCursor),
  });
}

function findRepoByGlobalId(store: Store, id: string): { repo: Repo; kind: string; identity: string } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  const { kind, identity } = parsed;
  if (kind === 'Repository') {
    const slash = identity.indexOf('/');
    if (slash < 0) return null;
    const repo = store.getRepo(identity.slice(0, slash), identity.slice(slash + 1));
    return repo === undefined ? null : { repo, kind, identity };
  }
  if (kind === 'Issue' || kind === 'PullRequest') {
    const match = /^([^/]+)\/([^:]+):(\d+)$/.exec(identity);
    if (match === null) return null;
    const repo = store.getRepo(match[1] as string, match[2] as string);
    return repo === undefined ? null : { repo, kind, identity };
  }
  return null;
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPOSITORY_FIELDS = [
  'id',
  'databaseId',
  'name',
  'nameWithOwner',
  'owner',
  'defaultBranchRef',
  'viewerPermission',
  'hasIssuesEnabled',
  'issue',
  'issues',
  'pullRequests',
  'pullRequest',
];
const SEARCH_TYPE_VALUES = ['CODE', 'COMMIT', 'DISCUSSION', 'ISSUE', 'MILESTONE', 'PULL_REQUEST', 'REPOSITORY', 'USER'];

type Resolver = (parent: AnyObj, field: FieldSel, exec: ExecCtx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_parent, _field, exec) => wrap('User', { login: exec.store.viewerLogin ?? '' }),
    repository: (_parent, field, exec) => {
      const owner = arg<string>(field, 'owner', exec) ?? '';
      const name = arg<string>(field, 'name', exec) ?? '';
      const repo = exec.store.getRepo(owner, name);
      if (repo === undefined) return null;
      return repoObj(repo);
    },
    node: (_parent, field, exec) => {
      const id = arg<string>(field, 'id', exec) ?? '';
      const found = findRepoByGlobalId(exec.store, id);
      if (found === null) return null;
      if (found.kind === 'Repository') return repoObj(found.repo);
      if (found.kind === 'Issue') {
        const number = Number.parseInt(found.identity.split(':')[1] as string, 10);
        const issue = found.repo.issues.find((i) => i.number === number);
        return issue === undefined ? null : issueObj(found.repo, issue);
      }
      if (found.kind === 'PullRequest') {
        const number = Number.parseInt(found.identity.split(':')[1] as string, 10);
        const pull = found.repo.pulls.find((p) => p.number === number);
        return pull === undefined ? null : pullObj(found.repo, pull, exec.store);
      }
      return null;
    },
    __type: (_parent, field, exec) => {
      const name = arg<string>(field, 'name', exec) ?? '';
      let fields: string[] | null = null;
      let enumValues: string[] | null = null;
      if (name === 'Issue') fields = ISSUE_FIELDS;
      else if (name === 'PullRequest') fields = PULL_REQUEST_FIELDS;
      else if (name === 'Repository') fields = REPOSITORY_FIELDS;
      else if (name === 'SearchType') enumValues = SEARCH_TYPE_VALUES;
      else return null;
      return wrap('__Type', {
        name,
        fields: fields === null ? null : fields.map((f) => wrap('__Field', { name: f })),
        enumValues: enumValues === null ? null : enumValues.map((v) => wrap('__EnumValue', { name: v })),
      });
    },
  },
  Mutation: {
    createIssue: (_parent, field, exec) => {
      const input = arg<Record<string, unknown>>(field, 'input', exec) ?? {};
      const repoId = asString(input.repositoryId) ?? '';
      const found = findRepoByGlobalId(exec.store, repoId);
      if (found === null || found.kind !== 'Repository') return { issue: null };
      const repo = found.repo;
      repo.issueSeq += 1;
      const issue: Issue = {
        number: repo.issueSeq,
        restId: exec.store.nextIssueRestId,
        title: asString(input.title) ?? '',
        body: asString(input.body) ?? '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        seq: exec.store.nextSeq(),
      };
      exec.store.nextIssueRestId += 1;
      repo.issues.push(issue);
      return wrap('CreateIssuePayload', { issue: issueObj(repo, issue) });
    },
    closeIssue: (_parent, field, exec) => {
      const input = arg<Record<string, unknown>>(field, 'input', exec) ?? {};
      const issueId = asString(input.issueId) ?? '';
      const found = findRepoByGlobalId(exec.store, issueId);
      if (found === null || found.kind !== 'Issue') return { issue: null };
      const number = Number.parseInt(found.identity.split(':')[1] as string, 10);
      const issue = found.repo.issues.find((i) => i.number === number);
      if (issue === undefined) return { issue: null };
      issue.state = 'closed';
      issue.updatedAt = FIXED_NOW;
      return wrap('CloseIssuePayload', { issue: issueObj(found.repo, issue) });
    },
    createPullRequest: (_parent, field, exec) => {
      const input = arg<Record<string, unknown>>(field, 'input', exec) ?? {};
      const repoId = asString(input.repositoryId) ?? '';
      const found = findRepoByGlobalId(exec.store, repoId);
      if (found === null || found.kind !== 'Repository') return { pullRequest: null };
      const repo = found.repo;
      const headRef = asString(input.headRefName) ?? '';
      const baseRef = asString(input.baseRefName) ?? repo.defaultBranch;
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) return { pullRequest: null };
      repo.prSeq += 1;
      const pull: Pull = {
        number: repo.prSeq,
        restId: exec.store.nextPullRestId,
        title: asString(input.title) ?? '',
        body: asString(input.body) ?? '',
        state: 'open',
        headRef,
        baseRef,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        seq: exec.store.nextSeq(),
      };
      exec.store.nextPullRestId += 1;
      repo.pulls.push(pull);
      return wrap('CreatePullRequestPayload', { pullRequest: pullObj(repo, pull, exec.store) });
    },
    mergePullRequest: (_parent, field, exec) => {
      const input = arg<Record<string, unknown>>(field, 'input', exec) ?? {};
      const prId = asString(input.pullRequestId) ?? '';
      const found = findRepoByGlobalId(exec.store, prId);
      if (found === null || found.kind !== 'PullRequest') return { pullRequest: null };
      const number = Number.parseInt(found.identity.split(':')[1] as string, 10);
      const repo = found.repo;
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined || pull.merged) return { pullRequest: null };
      if (exec.store.mergeConflict(repo, pull).conflict) return { pullRequest: null };
      const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
      const mergeSha = exec.store.makeCommit(repo, headTree, [pull.baseSha], pull.title);
      exec.store.setRef(repo, `refs/heads/${pull.baseRef}`, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = FIXED_NOW;
      pull.mergeCommitSha = mergeSha;
      pull.updatedAt = FIXED_NOW;
      return wrap('MergePullRequestPayload', { pullRequest: pullObj(repo, pull, exec.store) });
    },
    addComment: (_parent, field, exec) => {
      const input = arg<Record<string, unknown>>(field, 'input', exec) ?? {};
      const subjectId = asString(input.subjectId) ?? '';
      const body = asString(input.body) ?? '';
      const found = findRepoByGlobalId(exec.store, subjectId);
      if (found === null) return { commentEdge: null };
      let commentId = 0;
      if (found.kind === 'Issue') {
        const number = Number.parseInt(found.identity.split(':')[1] as string, 10);
        const issue = found.repo.issues.find((i) => i.number === number);
        if (issue === undefined) return { commentEdge: null };
        found.repo.commentSeq += 1;
        commentId = found.repo.commentSeq;
        issue.comments.push({ id: commentId, body, createdAt: FIXED_NOW });
        const node = wrap('IssueComment', {
          id: commentGlobalId(found.repo.owner, found.repo.name, number, commentId),
          body,
        });
        return wrap('AddCommentPayload', { commentEdge: wrap('IssueCommentEdge', { node }) });
      }
      return { commentEdge: null };
    },
  },
  User: {
    login: (parent) => parent.login,
  },
  Repository: {
    id: (parent) => parent.id,
    databaseId: (parent) => parent.databaseId,
    name: (parent) => parent.name,
    nameWithOwner: (parent) => parent.nameWithOwner,
    owner: (parent) => wrap('User', { login: parent.ownerLogin }),
    defaultBranchRef: (parent) => parent.defaultBranchRef,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, field, exec) => {
      const repo = parent.repo as Repo;
      const number = arg<number>(field, 'number', exec);
      const issue = repo.issues.find((i) => i.number === number);
      return issue === undefined ? null : issueObj(repo, issue);
    },
    issues: (parent, field, exec) => issuesConnection(parent.repo as Repo, field, exec),
    pullRequest: (parent, field, exec) => {
      const repo = parent.repo as Repo;
      const number = arg<number>(field, 'number', exec);
      const pull = repo.pulls.find((p) => p.number === number);
      return pull === undefined ? null : pullObj(repo, pull, exec.store);
    },
    pullRequests: (parent, field, exec) => {
      const repo = parent.repo as Repo;
      const first = arg<number>(field, 'first', exec) ?? 10;
      const after = decodeCursor(arg<string>(field, 'after', exec));
      let list = [...repo.pulls].sort((a, b) => a.number - b.number);
      let start = 0;
      if (after !== null) {
        const afterNumber = Number.parseInt(after.replace('pull:', ''), 10);
        if (Number.isFinite(afterNumber)) {
          const index = list.findIndex((p) => p.number === afterNumber);
          if (index >= 0) start = index + 1;
        }
      }
      const page = list.slice(start, start + first);
      const hasNextPage = start + first < list.length;
      const endCursor = page.length > 0 ? encodeCursor(`pull:${page[page.length - 1]?.number ?? 0}`) : null;
      return wrap('PullRequestConnection', {
        nodes: page.map((p) => pullObj(repo, p, exec.store)),
        pageInfo: pageInfo(hasNextPage, endCursor),
      });
    },
  },
  Ref: {
    name: (parent) => parent.name,
  },
  Issue: {
    id: (parent) => parent.id,
    number: (parent) => parent.number,
    title: (parent) => parent.title,
    state: (parent) => parent.state,
    body: (parent) => parent.body,
  },
  PullRequest: {
    id: (parent) => parent.id,
    number: (parent) => parent.number,
    headRefName: (parent) => parent.headRefName,
    baseRefName: (parent) => parent.baseRefName,
    mergeable: (parent) => parent.mergeable,
    state: (parent) => parent.state,
    merged: (parent) => parent.merged,
    files: (parent, field, exec) => {
      const { pull, repo } = parent as unknown as { pull: Pull; repo: Repo };
      const first = arg<number>(field, 'first', exec) ?? 10;
      const store = exec.store;
      const base = store.mergeBase(repo, pull.headSha, pull.baseSha);
      const baseTree = base === null ? null : parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
      const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
      const diffs = store.diffTrees(repo, baseTree, headTree);
      const page = diffs.slice(0, first);
      return wrap('PullRequestFileConnection', {
        nodes: page.map((d) => wrap('PullRequestFile', { path: d.path })),
        pageInfo: pageInfo(diffs.length > first, null),
      });
    },
  },
  IssueConnection: {
    nodes: (parent) => parent.nodes,
    pageInfo: (parent) => parent.pageInfo,
  },
  PullRequestConnection: {
    nodes: (parent) => parent.nodes,
    pageInfo: (parent) => parent.pageInfo,
  },
  PullRequestFileConnection: {
    nodes: (parent) => parent.nodes,
    pageInfo: (parent) => parent.pageInfo,
  },
  PullRequestFile: {
    path: (parent) => parent.path,
  },
  IssueComment: {
    id: (parent) => parent.id,
    body: (parent) => parent.body,
  },
  IssueCommentEdge: {
    node: (parent) => parent.node,
  },
  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage,
    endCursor: (parent) => parent.endCursor,
  },
  __Type: {
    name: (parent) => parent.name,
    fields: (parent) => parent.fields,
    enumValues: (parent) => parent.enumValues,
  },
  __Field: {
    name: (parent) => parent.name,
  },
  __EnumValue: {
    name: (parent) => parent.name,
  },
  CreateIssuePayload: {
    issue: (parent) => parent.issue,
  },
  CloseIssuePayload: {
    issue: (parent) => parent.issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest,
  },
  AddCommentPayload: {
    commentEdge: (parent) => parent.commentEdge,
  },
};

function repoObj(repo: Repo): AnyObj {
  const branchTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return wrap('Repository', {
    repo,
    id: repoGlobalId(repo.owner, repo.name),
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    ownerLogin: repo.owner,
    defaultBranchRef: branchTip === undefined ? null : wrap('Ref', { name: repo.defaultBranch }),
  });
}

function completeValue(value: unknown, field: FieldSel, exec: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, exec));
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    const obj = value as AnyObj;
    if (field.selections.length === 0) return obj;
    return executeSelections(obj, obj.__typename, field.selections, exec);
  }
  return value;
}

function executeSelections(parent: AnyObj, typename: string, selections: Selection[], exec: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.type === typename) {
        Object.assign(out, executeSelections(parent, typename, sel.selections, exec));
      }
      continue;
    }
    const resolver = RESOLVERS[typename]?.[sel.name];
    if (resolver === undefined) {
      exec.errors.push({ message: `Cannot query field "${sel.name}" on type "${typename}".` });
      out[sel.alias ?? sel.name] = null;
      continue;
    }
    const value = resolver(parent, sel, exec);
    out[sel.alias ?? sel.name] = completeValue(value, sel, exec);
  }
  return out;
}

function executeDocument(query: string, variables: Record<string, unknown>, store: Store): Record<string, unknown> {
  const exec: ExecCtx = { store, variables, errors: [] };
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL syntax error' }] };
  }
  const operation = operations[0];
  if (operation === undefined) return { errors: [{ message: 'empty GraphQL document' }] };
  const rootType = operation.opType === 'mutation' ? 'Mutation' : 'Query';
  const root = wrap(rootType, {});
  const data = executeSelections(root, rootType, operation.selections, exec);
  const result: Record<string, unknown> = { data };
  if (exec.errors.length > 0) result.errors = exec.errors;
  return result;
}

export function handleGraphQL(ctx: Ctx): boolean {
  if (ctx.segments.join('/') !== 'api/graphql') return false;
  if ((ctx.req.method ?? 'POST') !== 'POST') {
    sendMessage(ctx, 404, 'Not Found');
    return true;
  }
  if (ctx.jsonError) {
    sendMessage(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  const body = ctx.json;
  const requests: Array<{ query?: unknown; variables?: unknown }> = Array.isArray(body) ? body : [body];
  const results = requests.map((req) => {
    if (!isRecord(req) || typeof req.query !== 'string') {
      return { errors: [{ message: 'GraphQL query must be a string' }] };
    }
    const variables = isRecord(req.variables) ? (req.variables as Record<string, unknown>) : {};
    return executeDocument(req.query, variables, ctx.store);
  });
  sendJson(ctx, 200, Array.isArray(body) ? results : results[0]);
  return true;
}
