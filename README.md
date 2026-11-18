# forge — a GitHub-compatible git forge

A single-process, standard-library-only Node 22 implementation of a
GitHub-compatible git forge, built for the make.fun `github-core-clone-01`
bounty. One process serves four surfaces on the same in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git` — `info/refs`, `git-upload-pack`
  (protocol v0 and v2, `ls-refs`, `fetch` with shallow/deepen, sideband
  packfiles) and `git-receive-pack` (fast-forward enforcement, per-ref
  report). Packs carry plain objects only, no deltas.
- **REST v3** under `/api/v3` — repositories, branches, commits, refs,
  contents (create/update/delete with sha checks), labels, issues,
  comments and pull requests with squash merge and conflict detection.
- **GraphQL** at `/api/graphql` — repository/issue/pull-request queries and
  mutations, Relay global ids, connections with cursors, aliases,
  variables, batch documents and `__type`/`__schema` introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 with `server/discover`, `initialize`,
  `tools/list` and six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`).

## Run

```sh
node --experimental-strip-types main.ts
```

With `MAKEFUN_ENV_URL` set (a trial), the process binds an ephemeral port,
registers it with the env and exits when the env reports done. Without it,
it serves standalone on `$PORT` (default 18080). API calls carry
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Layout

- `main.ts` — entry lifecycle (trial register/done, standalone fallback)
- `app.ts` — HTTP server and dispatch
- `store.ts` — in-memory store, git object helpers, tree/commit builders
- `git.ts` — pkt-line codec, packfile read/write, fetch planning, advertisements
- `git-http.ts` — smart-HTTP handlers
- `rest.ts` — REST v3 handlers
- `graphql.ts` — GraphQL parser and executor
- `mcp.ts` — MCP JSON-RPC handlers and tools

No dependencies, no network calls, no disk state: everything lives in
memory for the life of the process.
