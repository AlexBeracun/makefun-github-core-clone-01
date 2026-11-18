// mcp.ts — the Model Context Protocol surface at /mcp (JSON-RPC 2.0, plain JSON
// answers; SSE is not required). Six tools, acting on the same store as REST
// and GraphQL. No Authorization header is a 401; a non-JSON body is HTTP 400
// with JSON-RPC -32700. Unknown tools and missing arguments are JSON-RPC
// errors, never HTTP 500s.

import {
  VIEWER,
  commitOnBranch,
  globalId,
  store,
  trialNowIso,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { computeMergeable, ensureLabels, repoJson, squashMergeTree } from './rest.ts';
import type { Ctx } from './rest.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'string', description: 'Comma-separated label names to apply.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(data: unknown, isError = false): Record<string, unknown> {
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
  if (isError) result.isError = true;
  return result;
}

function findTool(name: string): ToolDef | undefined {
  const lower = name.toLowerCase();
  return TOOLS.find((t) => t.name === lower || t.name.endsWith(lower) || lower.endsWith(t.name));
}

function missingArg(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') return required;
  }
  return null;
}

function repoFor(args: Record<string, unknown>): Repo | null {
  const owner = args.owner;
  const repoName = args.repo;
  if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, repoName) ?? null;
}

function callTool(name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  const tool = findTool(name);
  if (!tool) return { error: { code: -32601, message: `Method not found: ${name}` } };
  const missing = missingArg(tool, args);
  if (missing) return { error: { code: -32602, message: `Missing required argument: ${missing}` } };

  switch (tool.name) {
    case 'create_repo': {
      const repoName = args.name as string;
      if (store.getRepo(VIEWER.login, repoName)) {
        return { result: toolResult({ error: 'Repository already exists' }, true) };
      }
      const repo = store.createRepo(
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      ensureLabels(repo);
      return { result: toolResult(repoJson(repo)) };
    }
    case 'get_repo': {
      const repo = repoFor(args);
      if (!repo) return { result: toolResult({ error: 'Repository not found' }, true) };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = repoFor(args);
      if (!repo) return { result: toolResult({ error: 'Repository not found' }, true) };
      const labelNames: string[] =
        typeof args.labels === 'string'
          ? args.labels.split(',').map((s) => s.trim()).filter((s) => s !== '')
          : [];
      for (const labelName of labelNames) {
        if (!repo.labels.has(labelName)) {
          return { result: toolResult({ error: `Label does not exist: ${labelName}` }, true) };
        }
      }
      const now = trialNowIso();
      const issue: Issue = {
        dbId: repo.nextIssueDbId++,
        number: repo.nextIssueNumber++,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: labelNames,
        createdSeq: store.seq(),
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.set(issue.number, issue);
      return {
        result: toolResult({
          id: issue.dbId,
          node_id: globalId('issue', `${repo.owner}/${repo.name}#${issue.number}`),
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels,
          created_at: issue.createdAt,
        }),
      };
    }
    case 'list_issues': {
      const repo = repoFor(args);
      if (!repo) return { result: toolResult({ error: 'Repository not found' }, true) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      return {
        result: toolResult({
          issues: issues.map((i) => ({
            id: i.dbId,
            node_id: globalId('issue', `${repo.owner}/${repo.name}#${i.number}`),
            number: i.number,
            title: i.title,
            body: i.body,
            state: i.state,
            labels: i.labels,
            created_at: i.createdAt,
            updated_at: i.updatedAt,
          })),
        }),
      };
    }
    case 'create_pull_request': {
      const repo = repoFor(args);
      if (!repo) return { result: toolResult({ error: 'Repository not found' }, true) };
      const head = args.head as string;
      const base = args.base as string;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        return { result: toolResult({ error: 'head or base branch does not exist' }, true) };
      }
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          return { result: toolResult({ error: 'A pull request already exists for this head branch' }, true) };
        }
      }
      const now = trialNowIso();
      const pull: Pull = {
        dbId: repo.nextPullDbId++,
        number: repo.nextPullNumber++,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
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
      return {
        result: toolResult({
          id: pull.dbId,
          node_id: globalId('pr', `${repo.owner}/${repo.name}#${pull.number}`),
          number: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          head: { ref: pull.headRef, sha: pull.headSha },
          base: { ref: pull.baseRef, sha: pull.baseSha },
        }),
      };
    }
    case 'merge_pull_request': {
      const repo = repoFor(args);
      if (!repo) return { result: toolResult({ error: 'Repository not found' }, true) };
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pull = repo.pulls.get(pullNumber);
      if (!pull) return { result: toolResult({ error: 'Pull request not found' }, true) };
      if (pull.state !== 'open') return { result: toolResult({ error: 'Pull request is not open' }, true) };
      if (!computeMergeable(repo, pull)) {
        return { result: toolResult({ error: 'Merge conflict' }, true) };
      }
      const tree = squashMergeTree(repo, pull);
      if (tree === null) return { result: toolResult({ error: 'Merge conflict' }, true) };
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      if (!baseTip) return { result: toolResult({ error: 'Base branch not found' }, true) };
      const commitOid = commitOnBranch(repo, pull.baseRef, tree, pull.title, baseTip);
      const now = trialNowIso();
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = now;
      pull.mergeCommitSha = commitOid;
      pull.updatedAt = now;
      return {
        result: toolResult({
          merged: true,
          sha: commitOid,
          message: pull.title,
          number: pull.number,
          state: pull.state,
        }),
      };
    }
    default:
      return { error: { code: -32601, message: `Method not found: ${name}` } };
  }
}

export function handleMcp(ctx: Ctx): boolean {
  if (!ctx.url.pathname.startsWith('/mcp')) return false;

  if (ctx.method === 'DELETE') {
    ctx.respond(200, {});
    return true;
  }
  if (ctx.method !== 'POST') {
    ctx.respond(405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed' } });
    return true;
  }

  // Auth: no Authorization header at all is a 401.
  const authHeader = ctx.headers.get('authorization');
  if (!authHeader) {
    ctx.respond(401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } });
    return true;
  }
  if (ctx.token && authHeader !== `Bearer ${ctx.token}`) {
    ctx.respond(401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } });
    return true;
  }

  // Non-JSON body is a JSON-RPC parse error.
  let request: Record<string, unknown>;
  try {
    if (ctx.body === null || ctx.body === undefined || typeof ctx.body !== 'object') throw new Error('not json');
    request = ctx.body as Record<string, unknown>;
  } catch {
    ctx.respond(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }

  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) are answered with 202 and no body.
  if (id === null || id === undefined) {
    if (method.startsWith('notifications/')) {
      ctx.respond(202, null);
      return true;
    }
  }

  const reply = (payload: Record<string, unknown>): void => {
    ctx.respond(200, payload);
  };

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    reply({
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      },
    });
    return true;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0];
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
    reply({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
    return true;
  }

  if (method === 'ping') {
    reply({ jsonrpc: '2.0', id, result: {} });
    return true;
  }

  if (method === 'tools/list') {
    // The same array, byte-for-byte, on every call.
    reply({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return true;
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(name, args);
    if (outcome.error) {
      reply({ jsonrpc: '2.0', id, error: outcome.error });
    } else {
      reply({ jsonrpc: '2.0', id, result: outcome.result });
    }
    return true;
  }

  reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  return true;
}
