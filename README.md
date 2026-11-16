# github-core-clone-01 — a GitHub-compatible git forge

A from-scratch GitHub-compatible forge for [the contest](https://make.fun/bounty/github-core-clone-01):
git smart HTTP, REST v3, GraphQL v4, and an MCP endpoint, all in one Node
process, stdlib only, no dependencies, no network, no model calls.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is nothing
to install: the program imports `node:http`, `node:crypto`, `node:zlib`, and
its own modules only.

## The lifecycle (main.ts)

Untouched from the starter: bind an ephemeral port, POST the port to
`$MAKEFUN_ENV_URL/register`, poll GET `$MAKEFUN_ENV_URL/done` until it says
`{"done": true}`, then exit 0. The server lives in `app.ts`.

## The surface

- `GET /healthz` — `200 {"ok": true}` (the env's boot check, no token).
- `/{owner}/{repo}.git/info/refs`, `git-upload-pack`, `git-receive-pack` —
  git smart HTTP, v0 and v2 advertisements, ls-refs, fetch with depth and
  shallow boundaries, receive-pack with fast-forward checks and
  report-status. Packfiles are read and written by hand (plain objects,
  OFS/REF deltas resolved on read).
- `/api/v3/...` — REST v3: repositories, branches, commits, contents,
  labels, issues, comments, pull requests, squash merges with three-way
  conflict detection, Link pagination. Every reply is JSON and carries a
  non-empty `X-GitHub-Request-Id`; a missing or wrong bearer token is 401.
- `POST /api/graphql` — GraphQL v4 for the documents `gh` and
  `github-mcp-server` send: viewer, repository, issue, pull requests,
  mutations, node lookups, cursor pagination, and `__type` introspection.
- `POST /mcp` — MCP over Streamable HTTP, modern era 2026-07-28
  (`server/discover`, `initialize`, `tools/list`, `tools/call`) with six
  tools that act on the same store as REST.

## State and determinism

Everything is in memory. The shop token does not encode the viewer login,
so the server learns it lazily from the first owner-naming request
(a git push, a REST repo path, a GraphQL `repository(owner:)`, an MCP
tool argument); repositories created before learning are adopted then.
All timestamps are fixed, all ids are counters or content hashes, so a
trial replays byte-identically.

## Layout

- `main.ts` — lifecycle (starter, one comment added).
- `app.ts` — HTTP server, routing, auth, request ids.
- `common.ts` — request context, JSON replies, auth.
- `store.ts` — repositories, issues, pull requests, git graph helpers.
- `gitobj.ts` — pkt-lines, object hashing, tree/commit/tag codecs, packfiles.
- `githttp.ts` — git smart-HTTP handlers.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — GraphQL parser and executor.
- `mcp.ts` — MCP handlers and the six tools.

## License

MIT — see `LICENSE`.
