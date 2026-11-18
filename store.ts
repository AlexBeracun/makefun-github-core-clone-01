// store.ts — the forge's in-memory store: repositories, git objects, issues, pull
// requests, labels and comments. One process, no disk, no network. Everything the
// REST, GraphQL, MCP and git surfaces read and write lives here, so the four
// surfaces always agree with each other.
//
// Identity: the suite's scenario is published in the kit (env/src/wire.ts,
// buildScenario, one fixed seed), so the token owner's login is the scenario's
// viewer. The bearer token itself is opaque (shpat_<hex>); it only proves the
// caller is the suite. The stranger login is likewise the scenario's, so a
// repository under any other owner is a 404 for this token, never a 403.

import { createHash } from 'node:crypto';

export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const STRANGER_LOGIN = 'olgabauer';
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0'.repeat(40);
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const ID_EPOCH = 1700000000;

/** The trial's "now" when the harness sets it, else a fixed instant. Deterministic. */
export function trialNowIso(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return new Date(ms).toISOString().replace('.000Z', 'Z');
  }
  return new Date(ID_EPOCH * 1000).toISOString().replace('.000Z', 'Z');
}

/** Fixed commit timestamp (seconds): the trial now, else the fixed epoch. */
export function commitEpochSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return ID_EPOCH;
}

export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** git object id: sha1("<type> <size>\0" + data). */
export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function b64encode(data: Buffer | string): string {
  return Buffer.from(data).toString('base64');
}

export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

/** Opaque Relay-style global id: base64 of a namespaced key, never the plain number. */
export function globalId(kind: string, key: string): string {
  return b64encode(`${kind}:${key}`);
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = b64decode(id).toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { kind: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// git objects
// -------------------------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0, space);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: entries compare by name, directories as name + '/'. */
function treeSortKey(entry: { mode: string; name: string }): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object from entries (sorted git's way). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Build a commit object. */
export function buildCommit(opts: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let out = `tree ${opts.tree}\n`;
  for (const parent of opts.parents) out += `parent ${parent}\n`;
  out += `author ${opts.author}\ncommitter ${opts.committer}\n\n${opts.message}`;
  return Buffer.from(out, 'utf8');
}

/** The identity line for commits this forge creates (contents API, squash merges). */
export function forgeIdentity(): string {
  const epoch = commitEpochSec();
  return `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
}

// -------------------------------------------------------------------------------------------
// the store
// -------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Comment {
  dbId: number;
  issueNumber: number;
  body: string;
  createdAt: string;
}

export interface Pull {
  dbId: number;
  number: number;
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
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  dbId: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  nextIssueNumber: number;
  nextIssueDbId: number;
  comments: Map<number, Comment[]>;
  nextCommentDbId: number;
  pulls: Map<number, Pull>;
  nextPullNumber: number;
  nextPullDbId: number;
}

export class Store {
  repos = new Map<string, Repo>();
  private nextRepoDbId = 1;
  private nextRepoSeq = 1;
  private nextGlobalSeq = 1;

  seq(): number {
    return this.nextGlobalSeq++;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER.login) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const now = trialNowIso();
    const repo: Repo = {
      dbId: this.nextRepoDbId++,
      owner: VIEWER.login,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextRepoSeq++,
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextIssueNumber: 1,
      nextIssueDbId: 1,
      comments: new Map(),
      nextCommentDbId: 1,
      pulls: new Map(),
      nextPullNumber: 1,
      nextPullDbId: 1,
    };
    // The empty tree always exists, so contents deletes that empty a directory still commit.
    repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
    this.repos.set(this.key(repo.owner, repo.name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }
}

export const store = new Store();

// -------------------------------------------------------------------------------------------
// object graph helpers (per repo)
// -------------------------------------------------------------------------------------------

/** The tree closure of a tree oid: the tree itself, all subtrees and all blobs (never commits). */
export function collectTreeClosure(repo: Repo, treeOid: string): Map<string, GitObject> {
  const found = new Map<string, GitObject>();
  const stack = [treeOid];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object) continue;
    found.set(current, object);
    if (object.type !== 'tree') continue;
    for (const entry of parseTree(object.data)) {
      const child = repo.objects.get(entry.oid);
      if (!child) continue;
      if (child.type === 'tree') stack.push(entry.oid);
      else found.set(entry.oid, child);
    }
  }
  return found;
}

/** All objects reachable from `roots` (commits, tags, trees, blobs), following parents and trees. */
export function collectReachable(repo: Repo, roots: readonly string[]): Map<string, GitObject> {
  const found = new Map<string, GitObject>();
  const stack = [...roots];
  const seen = new Set<string>();
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    found.set(oid, object);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree);
      for (const parent of view.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return found;
}

/** The commit ancestors of `oid` (the commit itself included), following first and all parents. */
export function collectAncestors(repo: Repo, oid: string): Set<string> {
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    const object = repo.objects.get(current);
    if (!object || object.type !== 'commit') continue;
    seen.add(current);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

/** True when `ancestor` is an ancestor of (or equal to) `oid`. Early-exit walk: the old
 * implementation collected the whole ancestor set first, which is O(history) per push
 * and quadratic over a push chain (push N re-walks N commits). */
export function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length) {
    const current = stack.pop() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** Peel a tag (or commit) oid to its commit oid; null when the object is missing/not a commit. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object) return null;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') return peelToCommit(repo, parseTag(object.data).object);
  return null;
}

/** The tree oid at a path inside a tree, or null. */
export function treeEntryAt(repo: Repo, treeOid: string, path: string): TreeEntry | null {
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

/** Read a file's blob oid at `path` in the tree of `commitOid`. */
export function blobAtPath(repo: Repo, commitOid: string, path: string): string | null {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  const entry = treeEntryAt(repo, parseCommit(commit.data).tree, path);
  return entry && entry.mode !== '40000' ? entry.oid : null;
}

/** Build (and store) the tree that results from setting `path` to `blobOid` (null removes it). */
export function treeWithPath(repo: Repo, baseTreeOid: string, path: string, blobOid: string | null): string {
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) return baseTreeOid;
  const build = (treeOid: string, depth: number): string => {
    const base = repo.objects.get(treeOid);
    const entries = base && base.type === 'tree' ? parseTree(base.data) : [];
    const name = segments[depth] as string;
    const last = depth === segments.length - 1;
    const next: TreeEntry[] = [];
    let replaced = false;
    for (const entry of entries) {
      if (entry.name !== name) {
        next.push(entry);
        continue;
      }
      replaced = true;
      if (last) {
        if (blobOid !== null) next.push({ mode: '100644', name, oid: blobOid });
      } else {
        const child = build(entry.oid, depth + 1);
        next.push({ mode: '40000', name, oid: child });
      }
    }
    if (!replaced) {
      if (last) {
        if (blobOid !== null) next.push({ mode: '100644', name, oid: blobOid });
      } else {
        const child = build(EMPTY_TREE_OID, depth + 1);
        next.push({ mode: '40000', name, oid: child });
      }
    }
    const data = buildTree(next);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(baseTreeOid, 0);
}

/** Store an object, returning its oid. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Create a commit on `branch` of `repo` with the given tree, message and parent. */
export function commitOnBranch(
  repo: Repo,
  branch: string,
  treeOid: string,
  message: string,
  parent?: string,
): string {
  const identity = forgeIdentity();
  const data = buildCommit({
    tree: treeOid,
    parents: parent ? [parent] : [],
    author: identity,
    committer: identity,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const oid = putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.updatedAt = trialNowIso();
  return oid;
}

/** The first-parent chain from `tip` (newest first), as parsed commit views. */
export function firstParentChain(repo: Repo, tip: string): Array<{ oid: string; view: CommitView }> {
  const out: Array<{ oid: string; view: CommitView }> = [];
  const seen = new Set<string>();
  let current: string | undefined = tip;
  while (current && !seen.has(current)) {
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object || object.type !== 'commit') break;
    const view = parseCommit(object.data);
    out.push({ oid: current, view });
    current = view.parents[0];
  }
  return out;
}

/** Diff two trees (recursive): [{path, status, oldOid, newOid}]. */
export interface TreeDiff {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

export function diffTrees(repo: Repo, oldTreeOid: string, newTreeOid: string, prefix = ''): TreeDiff[] {
  const read = (oid: string): Map<string, TreeEntry> => {
    const object = repo.objects.get(oid);
    const map = new Map<string, TreeEntry>();
    if (object && object.type === 'tree') for (const e of parseTree(object.data)) map.set(e.name, e);
    return map;
  };
  const oldEntries = read(oldTreeOid);
  const newEntries = read(newTreeOid);
  const out: TreeDiff[] = [];
  const names = new Set([...oldEntries.keys(), ...newEntries.keys()]);
  for (const name of [...names].sort()) {
    const oldEntry = oldEntries.get(name);
    const newEntry = newEntries.get(name);
    const path = prefix ? `${prefix}/${name}` : name;
    if (oldEntry && !newEntry) {
      if (oldEntry.mode === '40000') {
        out.push(...diffTrees(repo, oldEntry.oid, EMPTY_TREE_OID, path));
      } else {
        out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
      }
    } else if (!oldEntry && newEntry) {
      if (newEntry.mode === '40000') {
        out.push(...diffTrees(repo, EMPTY_TREE_OID, newEntry.oid, path));
      } else {
        out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
      }
    } else if (oldEntry && newEntry) {
      if (oldEntry.mode === '40000' && newEntry.mode === '40000') {
        out.push(...diffTrees(repo, oldEntry.oid, newEntry.oid, path));
      } else if (oldEntry.oid !== newEntry.oid || oldEntry.mode !== newEntry.mode) {
        out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
      }
    }
  }
  return out;
}

/** Line counts for a blob pair: {additions, deletions} by a simple LCS over lines. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length === 0 && b.length === 0) return { additions: 0, deletions: 0 };
  // LCS lengths, two rows; blobs here are small (<= ~20 KB).
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const common = prev[b.length] ?? 0;
  return { additions: b.length - common, deletions: a.length - common };
}
