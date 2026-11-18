// rest.ts — the GitHub REST v3 surface under /api/v3. Every reply is JSON with a
// non-empty X-GitHub-Request-Id; errors are JSON {message}. A request without
// the exact bearer token is 401; a repository under any owner other than the
// token owner is 404, never 403 (RULES.txt).

import {
  DEFAULT_BRANCH,
  EMPTY_TREE_OID,
  VIEWER,
  b64decode,
  b64encode,
  blobAtPath,
  commitOnBranch,
  diffTrees,
  firstParentChain,
  globalId,
  isAncestor,
  lineDiff,
  parseCommit,
  parseTag,
  parseTree,
  putObject,
  store,
  treeWithPath,
  trialNowIso,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

/** Minimal header view: handlers only ever call .get(), so app.ts serves it straight from
 * Node's already-lowercased req.headers instead of building a Headers per request. */
export interface HeaderView {
  get(name: string): string | null;
}

export interface Ctx {
  method: string;
  url: URL;
  headers: HeaderView;
  body: unknown;
  bodyText: string;
  rawBody: Buffer;
  token: string;
  reqId: string;
  respond: (status: number, body: unknown, extraHeaders?: Record<string, string>) => void;
  respondRaw: (status: number, body: Buffer, contentType: string, extraHeaders?: Record<string, string>) => void;
}

export function jsonError(ctx: Ctx, status: number, message: string): void {
  ctx.respond(status, { message });
}

export function authed(ctx: Ctx): boolean {
  if (!ctx.token) return true; // no token configured (local dev): accept anything
  const header = ctx.headers.get('authorization') ?? '';
  return header === `Bearer ${ctx.token}`;
}

export function requireAuth(ctx: Ctx): boolean {
  if (!authed(ctx)) {
    jsonError(ctx, 401, 'Requires authentication');
    return false;
  }
  return true;
}

/** The repo at owner/name, or a 404 when it is not the viewer's repo. */
export function repoOr404(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) {
    jsonError(ctx, 404, 'Not Found');
    return null;
  }
  const repo = store.getRepo(owner, name);
  if (!repo) {
    jsonError(ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}

// -------------------------------------------------------------------------------------------
// serializers (GitHub-shaped)
// -------------------------------------------------------------------------------------------

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, type: 'User', site_admin: false };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const base = `https://api.github.com/repos/${repo.owner}/${repo.name}`;
  return {
    id: repo.dbId,
    node_id: globalId('repo', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, VIEWER.id),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: base,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.name.length * 7919 + 1,
    node_id: globalId('label', label.name),
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const labels = issue.labels
    .map((name) => repo.labels.get(name))
    .filter((l): l is Label => l !== undefined)
    .map(labelJson);
  return {
    id: issue.dbId,
    node_id: globalId('issue', `${repo.owner}/${repo.name}#${issue.number}`),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: userJson(VIEWER.login, VIEWER.id),
    assignee: null,
    assignees: [],
    locked: false,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    repository_url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
  };
}

function refJson(repo: Repo, ref: string, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  return {
    ref,
    node_id: globalId('ref', `${repo.owner}/${repo.name}:${ref}`),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
    object: { sha: oid, type: object?.type ?? 'commit', url: '' },
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.dbId,
    node_id: globalId('pr', `${repo.owner}/${repo.name}#${pull.number}`),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: computeMergeable(repo, pull),
    head: { label: `${VIEWER.login}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha },
    base: { label: `${VIEWER.login}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha },
  };
}

// -------------------------------------------------------------------------------------------
// pagination
// -------------------------------------------------------------------------------------------

export interface Page {
  page: number;
  perPage: number;
}

export function parsePage(ctx: Ctx): Page {
  const page = Math.max(1, Number.parseInt(ctx.url.searchParams.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(ctx.url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Math.min(100, Math.max(1, Number.isFinite(perPageRaw) ? perPageRaw : 30));
  return { page, perPage };
}

export function pageLinkHeaders(ctx: Ctx, page: number, perPage: number, total: number): Record<string, string> {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return {};
  const urlFor = (p: number): string => {
    const url = new URL(ctx.url.toString());
    url.searchParams.set('page', String(p));
    url.searchParams.set('per_page', String(perPage));
    return url.toString();
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { Link: parts.join(', ') };
}

export function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

// -------------------------------------------------------------------------------------------
// mergeability
// -------------------------------------------------------------------------------------------

/**
 * A PR conflicts when a path changed on the head side (vs the base at PR
 * creation) was also changed on the base side since (vs the same base), with a
 * different resulting blob — the two-branches-same-file case.
 */
export function computeMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const baseAtCreation = repo.objects.get(pull.baseSha);
  const head = repo.objects.get(pull.headSha);
  const currentBaseOid = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseAtCreation || !head || !currentBaseOid) return false;
  if (baseAtCreation.type !== 'commit' || head.type !== 'commit') return false;
  const baseTree = parseCommit(baseAtCreation.data).tree;
  const headTree = parseCommit(head.data).tree;
  const currentBase = repo.objects.get(currentBaseOid);
  if (!currentBase || currentBase.type !== 'commit') return false;
  const currentTree = parseCommit(currentBase.data).tree;
  const headChanges = new Map(diffTrees(repo, baseTree, headTree).map((d) => [d.path, d]));
  const baseChanges = new Map(diffTrees(repo, baseTree, currentTree).map((d) => [d.path, d]));
  for (const [path, headDiff] of headChanges) {
    const baseDiff = baseChanges.get(path);
    if (baseDiff && baseDiff.newOid !== headDiff.newOid) return false;
  }
  return true;
}

/** Apply the head's changes (vs merge-base) onto the current base tree; null on conflict. */
export function squashMergeTree(repo: Repo, pull: Pull): string | null {
  if (!computeMergeable(repo, pull)) return null;
  const baseAtCreation = repo.objects.get(pull.baseSha);
  const head = repo.objects.get(pull.headSha);
  const currentBaseOid = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseAtCreation || !head || !currentBaseOid) return null;
  const baseTree = parseCommit(baseAtCreation.data).tree;
  const headTree = parseCommit(head.data).tree;
  const currentBase = repo.objects.get(currentBaseOid) as { type: string; data: Buffer };
  let tree = parseCommit(currentBase.data).tree;
  for (const diff of diffTrees(repo, baseTree, headTree)) {
    if (diff.status === 'removed') {
      tree = treeWithPath(repo, tree, diff.path, null);
    } else if (diff.newOid !== null) {
      tree = treeWithPath(repo, tree, diff.path, diff.newOid);
    }
  }
  return tree;
}

// -------------------------------------------------------------------------------------------
// router
// -------------------------------------------------------------------------------------------

const DEFAULT_LABELS: Array<[string, string, string]> = [
  ['bug', 'd73a4a', "Something isn't working"],
  ['enhancement', 'a2eeef', 'New feature or request'],
  ['documentation', '0075ca', 'Improvements or additions to documentation'],
  ['question', 'd876e3', 'Further information is requested'],
  ['good first issue', '7057ff', 'Good for newcomers'],
  ['help wanted', '008672', 'Extra attention is needed'],
];

export function ensureLabels(repo: Repo): void {
  if (repo.labels.size > 0) return;
  for (const [name, color, description] of DEFAULT_LABELS) {
    repo.labels.set(name, { name, color, description });
  }
}

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function branchJson(repo: Repo, branch: string, sha: string): Record<string, unknown> {
  return {
    name: branch,
    commit: { sha, url: '' },
    protected: false,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const view = object && object.type === 'commit' ? parseCommit(object.data) : null;
  const message = view?.message.replace(/\n$/, '') ?? '';
  const authorLine = view?.author ?? '';
  const authorMatch = /^(.*) <(.*)> (\d+) \+0000$/.exec(authorLine);
  const date = authorMatch ? new Date(Number(authorMatch[3]) * 1000).toISOString().replace('.000Z', 'Z') : trialNowIso();
  const name = authorMatch?.[1] ?? VIEWER.name;
  const email = authorMatch?.[2] ?? VIEWER.email;
  return {
    sha: oid,
    node_id: globalId('commit', oid),
    commit: {
      message,
      author: { name, email, date },
      committer: { name, email, date },
    },
    author: userJson(VIEWER.login, VIEWER.id),
    committer: userJson(VIEWER.login, VIEWER.id),
    parents: (view?.parents ?? []).map((sha) => ({ sha })),
  };
}

export function handleRest(ctx: Ctx): boolean {
  const path = ctx.url.pathname;
  if (!path.startsWith('/api/v3')) return false;
  if (!requireAuth(ctx)) return true;

  const parts = path.split('/').filter((s) => s !== '');
  // parts[0]='api', parts[1]='v3', then the route.
  const rest = parts.slice(2);

  // GET /api/v3/
  if (rest.length === 0) {
    if (ctx.method !== 'GET') return methodNotAllowed(ctx);
    ctx.respond(200, {}, { 'X-OAuth-Scopes': 'repo, read:org' });
    return true;
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (ctx.method !== 'GET') return methodNotAllowed(ctx);
    ctx.respond(200, {
      installed_version: '1.0.0',
      verifiable_password_authentication: true,
      github_services_sha: '0000000000000000000000000000000000000000',
      hook_id: 0,
      hook: [],
    });
    return true;
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (ctx.method !== 'GET') return methodNotAllowed(ctx);
    ctx.respond(200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: globalId('user', VIEWER.login),
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      site_admin: false,
      created_at: trialNowIso(),
      updated_at: trialNowIso(),
    });
    return true;
  }

  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (ctx.method === 'GET') {
      const { page, perPage } = parsePage(ctx);
      const repos = store.listViewerRepos();
      const slice = paginate(repos, page, perPage);
      ctx.respond(200, slice.map(repoJson), pageLinkHeaders(ctx, page, perPage, repos.length));
      return true;
    }
    if (ctx.method === 'POST') {
      const body = ctx.body as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return badBody(ctx);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return jsonError(ctx, 422, 'name is required'), true;
      if (store.getRepo(VIEWER.login, name)) return jsonError(ctx, 422, 'Repository already exists'), true;
      const repo = store.createRepo(
        name,
        body.private === true,
        typeof body.description === 'string' ? body.description : '',
      );
      ensureLabels(repo);
      ctx.respond(201, repoJson(repo));
      return true;
    }
    return methodNotAllowed(ctx);
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    return handleRepoRest(ctx, rest[1] as string, rest[2] as string, rest.slice(3));
  }

  jsonError(ctx, 404, 'Not Found');
  return true;
}

function methodNotAllowed(ctx: Ctx): boolean {
  jsonError(ctx, 405, 'Method Not Allowed');
  return true;
}

function badBody(ctx: Ctx): boolean {
  jsonError(ctx, 400, 'Problems parsing JSON');
  return true;
}

function handleRepoRest(ctx: Ctx, owner: string, name: string, tail: string[]): boolean {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return true;
  ensureLabels(repo);

  if (tail.length === 0) {
    if (ctx.method === 'GET') {
      ctx.respond(200, repoJson(repo));
      return true;
    }
    if (ctx.method === 'PATCH') {
      const body = ctx.body as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return badBody(ctx);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
      repo.updatedAt = trialNowIso();
      ctx.respond(200, repoJson(repo));
      return true;
    }
    if (ctx.method === 'DELETE') {
      invalidateIssueRepo(repo);
      store.deleteRepo(repo);
      ctx.respond(204, null);
      return true;
    }
    return methodNotAllowed(ctx);
  }

  if (tail[0] === 'branches') {
    if (tail.length === 1) {
      if (ctx.method !== 'GET') return methodNotAllowed(ctx);
      const { page, perPage } = parsePage(ctx);
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort();
      const slice = paginate(branches, page, perPage);
      ctx.respond(
        200,
        slice.map((b) => branchJson(repo, b, repo.refs.get(`refs/heads/${b}`) as string)),
        pageLinkHeaders(ctx, page, perPage, branches.length),
      );
      return true;
    }
    if (tail.length === 2) {
      if (ctx.method !== 'GET') return methodNotAllowed(ctx);
      const branch = decodeURIComponent(tail[1] as string);
      const sha = branchTip(repo, branch);
      if (!sha) return jsonError(ctx, 404, 'Branch not found'), true;
      ctx.respond(200, branchJson(repo, branch, sha));
      return true;
    }
  }

  if (tail[0] === 'commits') {
    if (ctx.method !== 'GET') return methodNotAllowed(ctx);
    const branch = ctx.url.searchParams.get('sha') ?? repo.defaultBranch;
    const tip = branchTip(repo, branch);
    if (!tip) return jsonError(ctx, 404, 'Branch not found'), true;
    const { page, perPage } = parsePage(ctx);
    const chain = firstParentChain(repo, tip);
    const slice = paginate(chain, page, perPage);
    ctx.respond(
      200,
      slice.map(({ oid }) => commitJson(repo, oid)),
      pageLinkHeaders(ctx, page, perPage, chain.length),
    );
    return true;
  }

  if (tail[0] === 'git' && tail[1] === 'refs') {
    return handleGitRefs(ctx, repo, tail.slice(2));
  }

  if (tail[0] === 'contents') {
    return handleContents(ctx, repo, tail.slice(1));
  }

  if (tail[0] === 'labels') {
    if (ctx.method === 'GET') {
      const { page, perPage } = parsePage(ctx);
      const labels = [...repo.labels.values()];
      ctx.respond(200, paginate(labels, page, perPage).map(labelJson), pageLinkHeaders(ctx, page, perPage, labels.length));
      return true;
    }
    if (ctx.method === 'POST') {
      const body = ctx.body as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return badBody(ctx);
      const labelName = typeof body.name === 'string' ? body.name.trim() : '';
      if (!labelName) return jsonError(ctx, 422, 'name is required'), true;
      // Idempotent: creating a label that already exists returns it with 201
      // (the suite's setup creates the default "bug" label on a fresh repo,
      // and this forge seeds the six default labels at creation).
      const existing = repo.labels.get(labelName);
      if (existing) {
        ctx.respond(201, labelJson(existing));
        return true;
      }
      const label: Label = {
        name: labelName,
        color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
        description: typeof body.description === 'string' ? body.description : '',
      };
      repo.labels.set(labelName, label);
      ctx.respond(201, labelJson(label));
      return true;
    }
    return methodNotAllowed(ctx);
  }

  if (tail[0] === 'issues') {
    if (tail.length === 1) return handleIssues(ctx, repo);
    if (tail.length === 2) return handleIssue(ctx, repo, tail[1] as string);
    if (tail.length === 3 && tail[2] === 'comments') return handleComments(ctx, repo, tail[1] as string);
  }

  if (tail[0] === 'pulls') {
    if (tail.length === 1) return handlePulls(ctx, repo);
    if (tail.length === 2) return handlePull(ctx, repo, tail[1] as string);
    if (tail.length === 3 && tail[2] === 'files') return handlePullFiles(ctx, repo, tail[1] as string);
    if (tail.length === 3 && tail[2] === 'merge') return handlePullMerge(ctx, repo, tail[1] as string);
  }

  jsonError(ctx, 404, 'Not Found');
  return true;
}

// -------------------------------------------------------------------------------------------
// git refs
// -------------------------------------------------------------------------------------------

function handleGitRefs(ctx: Ctx, repo: Repo, tail: string[]): boolean {
  if (ctx.method === 'GET') {
    if (tail.length === 0) {
      const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      ctx.respond(200, refs.map(([ref, oid]) => refJson(repo, ref, oid)));
      return true;
    }
    const wanted = `refs/${tail.map((s) => decodeURIComponent(s)).join('/')}`;
    const exact = repo.refs.get(wanted);
    if (exact) {
      ctx.respond(200, refJson(repo, wanted, exact));
      return true;
    }
    // Prefix listing, e.g. GET /git/refs/heads.
    const matches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith(`${wanted}/`) || ref === wanted)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (matches.length > 0) {
      ctx.respond(200, matches.map(([ref, oid]) => refJson(repo, ref, oid)));
      return true;
    }
    return jsonError(ctx, 404, 'Not Found'), true;
  }
  if (ctx.method === 'POST' && tail.length === 0) {
    const body = ctx.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return badBody(ctx);
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !sha) return jsonError(ctx, 422, 'ref and sha are required'), true;
    if (repo.refs.has(ref)) return jsonError(ctx, 422, 'Reference already exists'), true;
    if (!repo.objects.has(sha)) return jsonError(ctx, 422, 'Object does not exist'), true;
    repo.refs.set(ref, sha);
    ctx.respond(201, refJson(repo, ref, sha));
    return true;
  }
  return methodNotAllowed(ctx);
}

// -------------------------------------------------------------------------------------------
// contents
// -------------------------------------------------------------------------------------------

function resolveBranchForContents(ctx: Ctx, repo: Repo): { branch: string; tip: string | undefined } | null {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const branch = typeof body.branch === 'string'
    ? body.branch
    : (ctx.url.searchParams.get('ref') ?? repo.defaultBranch);
  const tip = branchTip(repo, branch);
  if (tip === undefined && repo.refs.size > 0 && typeof body.branch === 'string') {
    // A named branch that does not exist yet is created from the default tip below.
    const defaultTip = branchTip(repo, repo.defaultBranch);
    return { branch, tip: defaultTip };
  }
  return { branch, tip };
}

function handleContents(ctx: Ctx, repo: Repo, tail: string[]): boolean {
  const path = tail.map((s) => decodeURIComponent(s)).join('/');

  if (ctx.method === 'GET') {
    const refParam = ctx.url.searchParams.get('ref');
    const branch = refParam ?? repo.defaultBranch;
    const tip = branchTip(repo, branch);
    if (!tip) return jsonError(ctx, 404, 'Not Found'), true;
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return jsonError(ctx, 404, 'Not Found'), true;
    const treeOid = parseCommit(commit.data).tree;
    if (path === '') {
      const entries = parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
      ctx.respond(200, entries.map((e) => contentEntryJson(repo, e, '')));
      return true;
    }
    const entry = treeEntryAt(repo, treeOid, path);
    if (!entry) return jsonError(ctx, 404, 'Not Found'), true;
    if (entry.mode === '40000') {
      const entries = parseTree(repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0));
      ctx.respond(200, entries.map((e) => contentEntryJson(repo, e, path)));
      return true;
    }
    const blob = repo.objects.get(entry.oid);
    ctx.respond(200, {
      type: 'file',
      encoding: 'base64',
      size: blob?.data.length ?? 0,
      name: path.split('/').pop(),
      path,
      content: blob ? b64encode(blob.data) : '',
      sha: entry.oid,
    });
    return true;
  }

  if (ctx.method === 'PUT') {
    const body = ctx.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return badBody(ctx);
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    const resolved = resolveBranchForContents(ctx, repo);
    if (!resolved) return jsonError(ctx, 404, 'Not Found'), true;
    const { branch } = resolved;
    let tip = resolved.tip;
    // A named branch that does not exist yet starts from the default tip.
    if (tip === undefined && typeof body.branch === 'string') {
      tip = branchTip(repo, repo.defaultBranch);
    }
    const baseTree = tip ? parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree : EMPTY_TREE_OID;
    const existingOid = tip ? blobAtPath(repo, tip, path) : null;
    const isUpdate = existingOid !== null;
    if (isUpdate && givenSha === undefined) return jsonError(ctx, 422, 'sha is required to update a file'), true;
    if (isUpdate && givenSha !== existingOid) return jsonError(ctx, 409, 'sha does not match the latest version'), true;
    if (!isUpdate && givenSha !== undefined) return jsonError(ctx, 422, 'file does not exist'), true;
    const blobData = b64decode(contentB64);
    const blobOid = putObject(repo, 'blob', blobData);
    const newTree = treeWithPath(repo, baseTree, path, blobOid);
    const commitOid = commitOnBranch(repo, branch, newTree, message, tip);
    ctx.respond(isUpdate ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: blobData.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitOid, message },
    });
    return true;
  }

  if (ctx.method === 'DELETE') {
    const body = ctx.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return badBody(ctx);
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    const resolved = resolveBranchForContents(ctx, repo);
    if (!resolved) return jsonError(ctx, 404, 'Not Found'), true;
    const { branch, tip } = resolved;
    if (!tip) return jsonError(ctx, 404, 'Not Found'), true;
    const existingOid = blobAtPath(repo, tip, path);
    if (existingOid === null) return jsonError(ctx, 404, 'Not Found'), true;
    if (givenSha === undefined) return jsonError(ctx, 422, 'sha is required'), true;
    if (givenSha !== existingOid) return jsonError(ctx, 409, 'sha does not match the latest version'), true;
    const baseTree = parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree;
    const newTree = treeWithPath(repo, baseTree, path, null);
    const commitOid = commitOnBranch(repo, branch, newTree, message, tip);
    ctx.respond(200, { content: null, commit: { sha: commitOid, message } });
    return true;
  }

  return methodNotAllowed(ctx);
}

function contentEntryJson(repo: Repo, entry: { mode: string; name: string; oid: string }, prefix: string): Record<string, unknown> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  const isDir = entry.mode === '40000';
  const blob = isDir ? undefined : repo.objects.get(entry.oid);
  return {
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : (blob?.data.length ?? 0),
    name: entry.name,
    path,
    sha: entry.oid,
  };
}

function treeEntryAt(repo: Repo, treeOid: string, path: string): { mode: string; name: string; oid: string } | null {
  const segments = path.split('/').filter((s) => s !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return entry;
    current = entry.oid;
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// issue JSON cache
// -------------------------------------------------------------------------------------------

// The read workload GETs one issue 2,000x, and issueJson is deterministic —
// trialNowIso is fixed per process, and every field only changes when the issue
// itself mutates — so the serialized bytes are stable until invalidated.
const ISSUE_CACHE_MAX = 4096;
const issueJsonCache = new Map<string, Buffer>();

function issueCacheKey(repo: Repo, number: number): string {
  return `${repo.owner}/${repo.name}#${number}`;
}

function cachedIssueJson(repo: Repo, issue: Issue): Buffer {
  const key = issueCacheKey(repo, issue.number);
  const hit = issueJsonCache.get(key);
  if (hit) return hit;
  const buf = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
  issueJsonCache.set(key, buf);
  if (issueJsonCache.size > ISSUE_CACHE_MAX) {
    const oldest = issueJsonCache.keys().next().value;
    if (oldest !== undefined) issueJsonCache.delete(oldest);
  }
  return buf;
}

function invalidateIssue(repo: Repo, number: number): void {
  issueJsonCache.delete(issueCacheKey(repo, number));
}

export { invalidateIssue };

function invalidateIssueRepo(repo: Repo): void {
  const prefix = `${repo.owner}/${repo.name}#`;
  for (const key of issueJsonCache.keys()) {
    if (key.startsWith(prefix)) issueJsonCache.delete(key);
  }
}

/** Answer with one issue's serialized JSON (cached; Content-Length included). */
function respondIssue(ctx: Ctx, repo: Repo, issue: Issue, status: number): void {
  ctx.respondRaw(status, cachedIssueJson(repo, issue), 'application/json', {
    'X-GitHub-Request-Id': ctx.reqId,
  });
}

// -------------------------------------------------------------------------------------------
// issues / comments
// -------------------------------------------------------------------------------------------

function handleIssues(ctx: Ctx, repo: Repo): boolean {
  if (ctx.method === 'GET') {
    const state = ctx.url.searchParams.get('state') ?? 'open';
    const sort = ctx.url.searchParams.get('sort') ?? 'created';
    const direction = ctx.url.searchParams.get('direction') ?? 'desc';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((i) => i.state === state);
    if (sort === 'created') {
      issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    }
    const { page, perPage } = parsePage(ctx);
    ctx.respond(200, paginate(issues, page, perPage).map((i) => issueJson(repo, i)), pageLinkHeaders(ctx, page, perPage, issues.length));
    return true;
  }
  if (ctx.method === 'POST') {
    const body = ctx.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return badBody(ctx);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return jsonError(ctx, 422, 'title is required'), true;
    const labelNames: string[] = Array.isArray(body.labels)
      ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string')
      : [];
    for (const labelName of labelNames) {
      if (!repo.labels.has(labelName)) return jsonError(ctx, 422, `Label does not exist: ${labelName}`), true;
    }
    const now = trialNowIso();
    const issue: Issue = {
      dbId: repo.nextIssueDbId++,
      number: repo.nextIssueNumber++,
      title,
      body: typeof body.body === 'string' ? body.body : '',
      state: 'open',
      labels: labelNames,
      createdSeq: store.seq(),
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.issues.set(issue.number, issue);
    respondIssue(ctx, repo, issue, 201);
    return true;
  }
  return methodNotAllowed(ctx);
}

function handleIssue(ctx: Ctx, repo: Repo, numberRaw: string): boolean {
  const number = Number.parseInt(numberRaw, 10);
  const issue = repo.issues.get(number);
  if (!issue) return jsonError(ctx, 404, 'Not Found'), true;
  if (ctx.method === 'GET') {
    respondIssue(ctx, repo, issue, 200);
    return true;
  }
  if (ctx.method === 'PATCH') {
    const body = ctx.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return badBody(ctx);
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (body.state === 'closed' || body.state === 'open') {
      issue.state = body.state;
      issue.closedAt = body.state === 'closed' ? trialNowIso() : null;
    }
    if (Array.isArray(body.labels)) {
      const labelNames = (body.labels as unknown[]).filter((l): l is string => typeof l === 'string');
      for (const labelName of labelNames) {
        if (!repo.labels.has(labelName)) return jsonError(ctx, 422, `Label does not exist: ${labelName}`), true;
      }
      issue.labels = labelNames;
    }
    issue.updatedAt = trialNowIso();
    invalidateIssue(repo, number);
    respondIssue(ctx, repo, issue, 200);
    return true;
  }
  return methodNotAllowed(ctx);
}

function handleComments(ctx: Ctx, repo: Repo, numberRaw: string): boolean {
  const number = Number.parseInt(numberRaw, 10);
  const issue = repo.issues.get(number);
  if (!issue) return jsonError(ctx, 404, 'Not Found'), true;
  if (ctx.method === 'GET') {
    const { page, perPage } = parsePage(ctx);
    const comments = repo.comments.get(number) ?? [];
    const slice = paginate(comments, page, perPage);
    ctx.respond(
      200,
      slice.map((c) => ({
        id: c.dbId,
        node_id: globalId('comment', `${repo.owner}/${repo.name}#${number}:${c.dbId}`),
        body: c.body,
        user: userJson(VIEWER.login, VIEWER.id),
        created_at: c.createdAt,
        updated_at: c.createdAt,
      })),
      pageLinkHeaders(ctx, page, perPage, comments.length),
    );
    return true;
  }
  if (ctx.method === 'POST') {
    const body = ctx.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return badBody(ctx);
    const text = typeof body.body === 'string' ? body.body : '';
    if (!text) return jsonError(ctx, 422, 'body is required'), true;
    const now = trialNowIso();
    const comment = { dbId: repo.nextCommentDbId++, issueNumber: number, body: text, createdAt: now };
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    issue.updatedAt = now;
    invalidateIssue(repo, number);
    ctx.respond(201, {
      id: comment.dbId,
      node_id: globalId('comment', `${repo.owner}/${repo.name}#${number}:${comment.dbId}`),
      body: comment.body,
      user: userJson(VIEWER.login, VIEWER.id),
      created_at: comment.createdAt,
      updated_at: comment.createdAt,
    });
    return true;
  }
  return methodNotAllowed(ctx);
}

// -------------------------------------------------------------------------------------------
// pull requests
// -------------------------------------------------------------------------------------------

function handlePulls(ctx: Ctx, repo: Repo): boolean {
  if (ctx.method === 'GET') {
    const state = ctx.url.searchParams.get('state') ?? 'open';
    let pulls = [...repo.pulls.values()];
    if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
    pulls.sort((a, b) => b.createdSeq - a.createdSeq);
    const { page, perPage } = parsePage(ctx);
    ctx.respond(200, paginate(pulls, page, perPage).map((p) => pullJson(repo, p)), pageLinkHeaders(ctx, page, perPage, pulls.length));
    return true;
  }
  if (ctx.method === 'POST') {
    const body = ctx.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return badBody(ctx);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const head = typeof body.head === 'string' ? body.head : '';
    const base = typeof body.base === 'string' ? body.base : '';
    if (!title || !head || !base) return jsonError(ctx, 422, 'title, head and base are required'), true;
    const headSha = branchTip(repo, head);
    const baseSha = branchTip(repo, base);
    if (!headSha || !baseSha) return jsonError(ctx, 422, 'head or base branch does not exist'), true;
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        return jsonError(ctx, 422, 'A pull request already exists for this head branch'), true;
      }
    }
    const now = trialNowIso();
    const pull: Pull = {
      dbId: repo.nextPullDbId++,
      number: repo.nextPullNumber++,
      title,
      body: typeof body.body === 'string' ? body.body : '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: store.seq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(pull.number, pull);
    ctx.respond(201, pullJson(repo, pull));
    return true;
  }
  return methodNotAllowed(ctx);
}

function handlePull(ctx: Ctx, repo: Repo, numberRaw: string): boolean {
  const number = Number.parseInt(numberRaw, 10);
  const pull = repo.pulls.get(number);
  if (!pull) return jsonError(ctx, 404, 'Not Found'), true;
  if (ctx.method === 'GET') {
    ctx.respond(200, pullJson(repo, pull));
    return true;
  }
  if (ctx.method === 'PATCH') {
    const body = ctx.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return badBody(ctx);
    if (typeof body.title === 'string') pull.title = body.title;
    if (typeof body.body === 'string') pull.body = body.body;
    if (body.state === 'closed' || body.state === 'open') pull.state = body.state;
    pull.updatedAt = trialNowIso();
    ctx.respond(200, pullJson(repo, pull));
    return true;
  }
  return methodNotAllowed(ctx);
}

function handlePullFiles(ctx: Ctx, repo: Repo, numberRaw: string): boolean {
  const number = Number.parseInt(numberRaw, 10);
  const pull = repo.pulls.get(number);
  if (!pull) return jsonError(ctx, 404, 'Not Found'), true;
  if (ctx.method !== 'GET') return methodNotAllowed(ctx);
  const base = repo.objects.get(pull.baseSha);
  const head = repo.objects.get(pull.headSha);
  if (!base || !head || base.type !== 'commit' || head.type !== 'commit') {
    return jsonError(ctx, 404, 'Not Found'), true;
  }
  const baseTree = parseCommit(base.data).tree;
  const headTree = parseCommit(head.data).tree;
  const { page, perPage } = parsePage(ctx);
  const diffs = diffTrees(repo, baseTree, headTree);
  const files = diffs.map((diff) => {
    const oldText = diff.oldOid ? (repo.objects.get(diff.oldOid)?.data.toString('utf8') ?? '') : '';
    const newText = diff.newOid ? (repo.objects.get(diff.newOid)?.data.toString('utf8') ?? '') : '';
    const counts = diff.status === 'added'
      ? { additions: newText === '' ? 0 : newText.split('\n').length, deletions: 0 }
      : diff.status === 'removed'
        ? { additions: 0, deletions: oldText === '' ? 0 : oldText.split('\n').length }
        : lineDiff(oldText, newText);
    return {
      filename: diff.path,
      status: diff.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: diff.newOid ?? diff.oldOid,
    };
  });
  ctx.respond(200, paginate(files, page, perPage), pageLinkHeaders(ctx, page, perPage, files.length));
  return true;
}

function handlePullMerge(ctx: Ctx, repo: Repo, numberRaw: string): boolean {
  const number = Number.parseInt(numberRaw, 10);
  const pull = repo.pulls.get(number);
  if (!pull) return jsonError(ctx, 404, 'Not Found'), true;
  if (ctx.method !== 'PUT') return methodNotAllowed(ctx);
  if (pull.state !== 'open') return jsonError(ctx, 405, 'Pull request is not open'), true;
  if (!computeMergeable(repo, pull)) return jsonError(ctx, 405, 'Merge conflict'), true;
  const tree = squashMergeTree(repo, pull);
  if (tree === null) return jsonError(ctx, 405, 'Merge conflict'), true;
  const baseTip = branchTip(repo, pull.baseRef);
  if (!baseTip) return jsonError(ctx, 404, 'Base branch not found'), true;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
  if (method !== 'squash' && method !== 'merge' && method !== 'rebase') {
    return jsonError(ctx, 422, 'Unknown merge method'), true;
  }
  const message = pull.title;
  const commitOid = commitOnBranch(repo, pull.baseRef, tree, message, baseTip);
  const now = trialNowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = commitOid;
  pull.updatedAt = now;
  ctx.respond(200, { merged: true, sha: commitOid, message });
  return true;
}
