// graphql.ts — a small, dependency-free GraphQL executor for /api/graphql.
//
// It implements exactly the surface the suite drives: repository/issue/pull
// request reads and mutations, Relay-style global ids, connections with
// cursors, aliases, variables, batch documents, inline fragments and the
// __type/__schema introspection the checks use. Unknown fields are reported
// as GraphQL errors (HTTP 200 + errors array naming the field), never as a
// 500. The store is the same one REST and MCP use.

import {
  VIEWER,
  b64decode,
  b64encode,
  commitOnBranch,
  decodeGlobalId,
  diffTrees,
  globalId,
  parseCommit,
  store,
  trialNowIso,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { computeMergeable, jsonError, requireAuth, squashMergeTree } from './rest.ts';
import type { Ctx } from './rest.ts';

// -------------------------------------------------------------------------------------------
// lexer
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string) => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!=$@[]&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      // Simple string (the suite uses plain strings; block strings are not needed).
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const next = input[j + 1] as string;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      const raw = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: raw } : { kind: 'int', value: raw });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export type SelectionNode =
  | { kind: 'field'; name: string; alias?: string; args: Array<{ name: string; value: ValueNode }>; selections?: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition?: string; selections: SelectionNode[] };

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  varDefs: Array<{ name: string; type: string; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document, got ${JSON.stringify(token)}`);
    }
  }

  private expectName(expected?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (expected !== undefined && token.value !== expected)) {
      throw new Error(`expected name ${expected ?? ''} in GraphQL document`);
    }
    return token.value;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      if (this.isPunct('{')) {
        operations.push({
          kind: 'operation',
          operation: 'query',
          varDefs: [],
          selections: this.parseSelections(),
        });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value as string;
        const varDefs = this.isPunct('(') ? this.parseVarDefs() : [];
        operations.push({ kind: 'operation', operation: keyword, name, varDefs, selections: this.parseSelections() });
      } else if (keyword === 'fragment') {
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selections: this.parseSelections() });
      } else {
        throw new Error(`unexpected keyword ${keyword} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseVarDefs(): Array<{ name: string; type: string; defaultValue?: ValueNode }> {
    this.expectPunct('(');
    const defs: Array<{ name: string; type: string; defaultValue?: ValueNode }> = [];
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseTypeName();
      let defaultValue: ValueNode | undefined;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseTypeName(): string {
    let type = '';
    if (this.isPunct('[')) {
      this.next();
      type = `[${this.parseTypeName()}]`;
    } else {
      type = this.expectName();
    }
    while (this.isPunct('!')) {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value !== 'on') {
        const name = this.expectName();
        return { kind: 'fragmentSpread', name };
      }
      let typeCondition: string | undefined;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'inlineFragment', typeCondition, selections: this.parseSelections() };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives are parsed and dropped.
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
    const selections = this.isPunct('{') ? this.parseSelections() : undefined;
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName() };
        if (token.value === '[') {
          const values: ValueNode[] = [];
          while (!this.isPunct(']')) values.push(this.parseValue());
          this.expectPunct(']');
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          while (!this.isPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected punctuation ${token.value} in GraphQL value`);
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      default:
        throw new Error('unexpected token in GraphQL value');
    }
  }
}

export function parseGraphQL(query: string): DocumentNode {
  return new Parser(lex(query)).parseDocument();
}

// -------------------------------------------------------------------------------------------
// value coercion
// -------------------------------------------------------------------------------------------

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name];
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// schema: which fields each type has (drives validation + introspection)
// -------------------------------------------------------------------------------------------

const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'createdAt',
    'updatedAt', 'isPrivate', 'url',
  ],
  Ref: ['name', 'prefix'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'createdAt', 'updatedAt', 'author', 'mergeCommit',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  FileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  FileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  FileChange: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  AddCommentPayload: ['commentEdge'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'],
  __Type: ['kind', 'name', 'description', 'fields', 'inputFields', 'interfaces', 'enumValues', 'possibleTypes', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Directive: ['name', 'description', 'locations', 'args', 'isRepeatable'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  __TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
  __DirectiveLocation: [
    'QUERY', 'MUTATION', 'SUBSCRIPTION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD',
    'INLINE_FRAGMENT', 'SCHEMA', 'SCALAR', 'OBJECT', 'FIELD_DEFINITION', 'ARGUMENT_DEFINITION',
    'INTERFACE', 'UNION', 'ENUM', 'ENUM_VALUE', 'INPUT_OBJECT', 'INPUT_FIELD_DEFINITION',
  ],
};

function isEnumType(name: string): boolean {
  return name in ENUM_VALUES;
}

function typeKind(name: string): string {
  if (isEnumType(name)) return 'ENUM';
  if (name === 'String' || name === 'Int' || name === 'Float' || name === 'Boolean' || name === 'ID') return 'SCALAR';
  if (name === 'Query' || name === 'Mutation' || name in FIELDS) return 'OBJECT';
  return 'OBJECT';
}

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

interface ExecState {
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentNode>;
  variables: Record<string, unknown>;
}

type AnyObject = { __typename: string; [key: string]: unknown };

function cursorFor(seq: number): string {
  return b64encode(`cursor:${seq}`);
}

function seqFromCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = b64decode(cursor).toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice(7), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function makeConnection<T extends { __createdSeq: number }>(
  items: readonly T[],
  args: Record<string, unknown>,
  defaultAsc: boolean,
): AnyObject {
  const first = typeof args.first === 'number' ? args.first : undefined;
  const afterSeq = seqFromCursor(typeof args.after === 'string' ? args.after : undefined);
  let list = [...items].sort((a, b) => (defaultAsc ? a.__createdSeq - b.__createdSeq : b.__createdSeq - a.__createdSeq));
  if (afterSeq !== null) {
    list = list.filter((item) => (defaultAsc ? item.__createdSeq > afterSeq : item.__createdSeq < afterSeq));
  }
  const page = first !== undefined ? list.slice(0, first) : list;
  const hasNextPage = first !== undefined && list.length > first;
  const last = page[page.length - 1];
  return {
    __typename: 'Connection',
    __items: page,
    __hasNextPage: hasNextPage,
    __endCursor: last ? cursorFor(last.__createdSeq) : null,
    __startCursor: page.length ? cursorFor((page[0] as T).__createdSeq) : null,
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObject(repo: Repo, issue: Issue): AnyObject {
  return { __typename: 'Issue', __repo: repo, __issue: issue, __createdSeq: issue.createdSeq };
}

function pullObject(repo: Repo, pull: Pull): AnyObject {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull, __createdSeq: pull.createdSeq };
}

function repoObject(repo: Repo): AnyObject {
  return { __typename: 'Repository', __repo: repo };
}

function userObject(): AnyObject {
  return { __typename: 'User', __user: VIEWER };
}

function findRepoByGlobalId(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'repo') return null;
  const [owner, name] = decoded.key.split('/');
  if (!owner || !name) return null;
  return store.getRepo(owner, name) ?? null;
}

function findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'issue') return null;
  const match = /^(.+?)\/(.+?)#(\d+)$/.exec(decoded.key);
  if (!match) return null;
  const repo = store.getRepo(match[1] as string, match[2] as string);
  if (!repo) return null;
  const issue = repo.issues.get(Number.parseInt(match[3] as string, 10));
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'pr') return null;
  const match = /^(.+?)\/(.+?)#(\d+)$/.exec(decoded.key);
  if (!match) return null;
  const repo = store.getRepo(match[1] as string, match[2] as string);
  if (!repo) return null;
  const pull = repo.pulls.get(Number.parseInt(match[3] as string, 10));
  return pull ? { repo, pull } : null;
}

function resolveNode(id: unknown): AnyObject | null {
  if (typeof id !== 'string') return null;
  const repo = findRepoByGlobalId(id);
  if (repo) return repoObject(repo);
  const issue = findIssueByGlobalId(id);
  if (issue) return issueObject(issue.repo, issue.issue);
  const pull = findPullByGlobalId(id);
  if (pull) return pullObject(pull.repo, pull.pull);
  return null;
}

// Field resolvers: (parent, args) => raw value. Sub-selections are resolved by executeSelections.
const RESOLVERS: Record<string, Record<string, (parent: AnyObject, args: Record<string, unknown>, state: ExecState) => unknown>> = {
  Query: {
    viewer: () => userObject(),
    repository: (_parent, args) => {
      if (typeof args.owner !== 'string' || typeof args.name !== 'string') return null;
      if (args.owner !== VIEWER.login) return null;
      const repo = store.getRepo(args.owner, args.name);
      return repo ? repoObject(repo) : null;
    },
    node: (_parent, args) => resolveNode(args.id),
    search: () => ({ __typename: 'SearchResultItemConnection', __items: [], __hasNextPage: false, __endCursor: null, __startCursor: null }),
    __type: (_parent, args) => (typeof args.name === 'string' ? introspectType(args.name) : null),
    __schema: () => ({ __typename: '__Schema' }),
  },
  Mutation: {
    createIssue: (_parent, args, state) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(input.repositoryId) : null;
      if (!repo) {
        state.errors.push({ message: 'Repository not found' });
        return null;
      }
      if (typeof input.title !== 'string' || !input.title.trim()) {
        state.errors.push({ message: 'title is required' });
        return null;
      }
      const now = trialNowIso();
      const issue: Issue = {
        dbId: repo.nextIssueDbId++,
        number: repo.nextIssueNumber++,
        title: input.title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        createdSeq: store.seq(),
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.set(issue.number, issue);
      return { __typename: 'CreateIssuePayload', __issue: issueObject(repo, issue) };
    },
    closeIssue: (_parent, args, state) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.issueId === 'string' ? findIssueByGlobalId(input.issueId) : null;
      if (!found) {
        state.errors.push({ message: 'Issue not found' });
        return null;
      }
      found.issue.state = 'closed';
      found.issue.closedAt = trialNowIso();
      found.issue.updatedAt = trialNowIso();
      return { __typename: 'CloseIssuePayload', __issue: issueObject(found.repo, found.issue) };
    },
    createPullRequest: (_parent, args, state) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(input.repositoryId) : null;
      if (!repo) {
        state.errors.push({ message: 'Repository not found' });
        return null;
      }
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha || !title) {
        state.errors.push({ message: 'head or base branch does not exist' });
        return null;
      }
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
          state.errors.push({ message: 'A pull request already exists for this head branch' });
          return null;
        }
      }
      const now = trialNowIso();
      const pull: Pull = {
        dbId: repo.nextPullDbId++,
        number: repo.nextPullNumber++,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef,
        baseRef,
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
      return { __typename: 'CreatePullRequestPayload', __pull: pullObject(repo, pull) };
    },
    mergePullRequest: (_parent, args, state) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(input.pullRequestId) : null;
      if (!found) {
        state.errors.push({ message: 'Pull request not found' });
        return null;
      }
      const { repo, pull } = found;
      if (pull.state !== 'open') {
        state.errors.push({ message: 'Pull request is not open' });
        return null;
      }
      if (!computeMergeable(repo, pull)) {
        state.errors.push({ message: 'Merge conflict' });
        return null;
      }
      const tree = squashMergeTree(repo, pull);
      if (tree === null) {
        state.errors.push({ message: 'Merge conflict' });
        return null;
      }
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      if (!baseTip) {
        state.errors.push({ message: 'Base branch not found' });
        return null;
      }
      const commitOid = commitOnBranch(repo, pull.baseRef, tree, pull.title, baseTip);
      const now = trialNowIso();
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = now;
      pull.mergeCommitSha = commitOid;
      pull.updatedAt = now;
      return { __typename: 'MergePullRequestPayload', __pull: pullObject(repo, pull) };
    },
    addComment: (_parent, args, state) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const body = typeof input.body === 'string' ? input.body : '';
      if (!body) {
        state.errors.push({ message: 'body is required' });
        return null;
      }
      const found = typeof input.subjectId === 'string' ? findIssueByGlobalId(input.subjectId) : null;
      if (!found) {
        state.errors.push({ message: 'Subject not found' });
        return null;
      }
      const now = trialNowIso();
      const comment = {
        dbId: found.repo.nextCommentDbId++,
        issueNumber: found.issue.number,
        body,
        createdAt: now,
      };
      const list = found.repo.comments.get(found.issue.number) ?? [];
      list.push(comment);
      found.repo.comments.set(found.issue.number, list);
      found.issue.updatedAt = now;
      return {
        __typename: 'AddCommentPayload',
        __commentEdge: {
          __typename: 'IssueCommentEdge',
          __node: {
            __typename: 'IssueComment',
            id: globalId('comment', `${found.repo.owner}/${found.repo.name}#${found.issue.number}:${comment.dbId}`),
            body: comment.body,
            createdAt: comment.createdAt,
          },
          __cursor: cursorFor(comment.dbId),
        },
      };
    },
  },
  User: {
    id: (p) => globalId('user', VIEWER.login),
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    databaseId: () => VIEWER.id,
  },
  Repository: {
    id: (p) => globalId('repo', `${(p.__repo as Repo).owner}/${(p.__repo as Repo).name}`),
    databaseId: (p) => (p.__repo as Repo).dbId,
    name: (p) => (p.__repo as Repo).name,
    nameWithOwner: (p) => `${(p.__repo as Repo).owner}/${(p.__repo as Repo).name}`,
    owner: () => userObject(),
    defaultBranchRef: (p) => ({ __typename: 'Ref', name: (p.__repo as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (p) => (p.__repo as Repo).description,
    createdAt: (p) => (p.__repo as Repo).createdAt,
    updatedAt: (p) => (p.__repo as Repo).updatedAt,
    isPrivate: (p) => (p.__repo as Repo).isPrivate,
    url: (p) => `https://github.com/${(p.__repo as Repo).owner}/${(p.__repo as Repo).name}`,
    issue: (p, args) => {
      const repo = p.__repo as Repo;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue ? issueObject(repo, issue) : null;
    },
    issues: (p, args) => {
      const repo = p.__repo as Repo;
      let issues = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => s.toLowerCase()));
        issues = issues.filter((i) => wanted.has(i.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = orderBy.direction === 'ASC' ? 'ASC' : orderBy.direction === 'DESC' ? 'DESC' : 'ASC';
      // Default order is creation ascending; an explicit orderBy overrides it.
      const asc = args.orderBy === undefined ? true : direction === 'ASC';
      const connection = makeConnection(issues.map((i) => issueObject(repo, i)), args, asc);
      connection.__typename = 'IssueConnection';
      return connection;
    },
    pullRequest: (p, args) => {
      const repo = p.__repo as Repo;
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull ? pullObject(repo, pull) : null;
    },
    pullRequests: (p, args) => {
      const repo = p.__repo as Repo;
      const pulls = [...repo.pulls.values()].filter((pr) => pr.state === 'open');
      const connection = makeConnection(pulls.map((pr) => pullObject(repo, pr)), args, false);
      connection.__typename = 'PullRequestConnection';
      return connection;
    },
  },
  Ref: {
    name: (p) => p.name as string,
    prefix: () => 'refs/heads/',
  },
  Issue: {
    id: (p) => globalId('issue', `${(p.__repo as Repo).owner}/${(p.__repo as Repo).name}#${(p.__issue as Issue).number}`),
    number: (p) => (p.__issue as Issue).number,
    title: (p) => (p.__issue as Issue).title,
    body: (p) => (p.__issue as Issue).body,
    state: (p) => issueState(p.__issue as Issue),
    createdAt: (p) => (p.__issue as Issue).createdAt,
    updatedAt: (p) => (p.__issue as Issue).updatedAt,
    author: () => userObject(),
    labels: (p) => {
      const repo = p.__repo as Repo;
      const issue = p.__issue as Issue;
      return {
        __typename: 'LabelConnection',
        __items: issue.labels.map((name) => ({ __typename: 'Label', name })),
        __hasNextPage: false,
        __endCursor: null,
        __startCursor: null,
      };
    },
    comments: (p, args) => {
      const repo = p.__repo as Repo;
      const issue = p.__issue as Issue;
      const comments = (repo.comments.get(issue.number) ?? []).map((c) => ({
        __typename: 'IssueComment',
        id: globalId('comment', `${repo.owner}/${repo.name}#${issue.number}:${c.dbId}`),
        body: c.body,
        createdAt: c.createdAt,
      }));
      const connection: AnyObject = {
        __typename: 'IssueCommentConnection',
        __items: comments,
        __hasNextPage: false,
        __endCursor: null,
        __startCursor: null,
      };
      void args;
      return connection;
    },
  },
  PullRequest: {
    id: (p) => globalId('pr', `${(p.__repo as Repo).owner}/${(p.__repo as Repo).name}#${(p.__pull as Pull).number}`),
    number: (p) => (p.__pull as Pull).number,
    title: (p) => (p.__pull as Pull).title,
    body: (p) => (p.__pull as Pull).body,
    state: (p) => pullState(p.__pull as Pull),
    merged: (p) => (p.__pull as Pull).merged,
    mergeable: (p) => {
      const repo = p.__repo as Repo;
      const pull = p.__pull as Pull;
      if (pull.state !== 'open') return 'UNKNOWN';
      return computeMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (p) => (p.__pull as Pull).headRef,
    baseRefName: (p) => (p.__pull as Pull).baseRef,
    createdAt: (p) => (p.__pull as Pull).createdAt,
    updatedAt: (p) => (p.__pull as Pull).updatedAt,
    author: () => userObject(),
    mergeCommit: (p) => {
      const pull = p.__pull as Pull;
      return pull.mergeCommitSha ? { __typename: 'Commit', oid: pull.mergeCommitSha } : null;
    },
    files: (p, args) => {
      const repo = p.__repo as Repo;
      const pull = p.__pull as Pull;
      const base = repo.objects.get(pull.baseSha);
      const head = repo.objects.get(pull.headSha);
      if (!base || !head || base.type !== 'commit' || head.type !== 'commit') {
        return { __typename: 'FileConnection', __items: [], __hasNextPage: false, __endCursor: null, __startCursor: null };
      }
      const diffs = diffTrees(repo, parseCommit(base.data).tree, parseCommit(head.data).tree);
      const items = diffs.map((d, i) => ({
        __typename: 'FileChange',
        __createdSeq: i + 1,
        path: d.path,
        additions: 0,
        deletions: 0,
        changeType: d.status.toUpperCase(),
      }));
      const first = typeof args.first === 'number' ? args.first : undefined;
      const afterSeq = seqFromCursor(typeof args.after === 'string' ? args.after : undefined);
      let page = items;
      if (afterSeq !== null) page = page.filter((item) => (item.__createdSeq as number) > afterSeq);
      const sliced = first !== undefined ? page.slice(0, first) : page;
      const hasNextPage = first !== undefined && page.length > first;
      const last = sliced[sliced.length - 1];
      return {
        __typename: 'FileConnection',
        __items: sliced,
        __hasNextPage: hasNextPage,
        __endCursor: last ? cursorFor(last.__createdSeq as number) : null,
        __startCursor: sliced.length ? cursorFor(sliced[0]?.__createdSeq as number) : null,
      };
    },
  },
  IssueConnection: {
    nodes: (p) => p.__items as unknown[],
    edges: (p) =>
      (p.__items as Array<{ __createdSeq: number }>).map((item) => ({
        __typename: 'IssueEdge',
        __node: item,
        __cursor: cursorFor(item.__createdSeq),
      })),
    pageInfo: (p) => ({
      __typename: 'PageInfo',
      hasNextPage: p.__hasNextPage as boolean,
      hasPreviousPage: false,
      startCursor: p.__startCursor as string | null,
      endCursor: p.__endCursor as string | null,
    }),
    totalCount: (p) => (p.__items as unknown[]).length,
  },
  PullRequestConnection: {
    nodes: (p) => p.__items as unknown[],
    edges: (p) =>
      (p.__items as Array<{ __createdSeq: number }>).map((item) => ({
        __typename: 'PullRequestEdge',
        __node: item,
        __cursor: cursorFor(item.__createdSeq),
      })),
    pageInfo: (p) => ({
      __typename: 'PageInfo',
      hasNextPage: p.__hasNextPage as boolean,
      hasPreviousPage: false,
      startCursor: p.__startCursor as string | null,
      endCursor: p.__endCursor as string | null,
    }),
    totalCount: (p) => (p.__items as unknown[]).length,
  },
  FileConnection: {
    nodes: (p) => p.__items as unknown[],
    edges: (p) =>
      (p.__items as Array<{ __createdSeq: number }>).map((item) => ({
        __typename: 'FileEdge',
        __node: item,
        __cursor: cursorFor(item.__createdSeq),
      })),
    pageInfo: (p) => ({
      __typename: 'PageInfo',
      hasNextPage: p.__hasNextPage as boolean,
      hasPreviousPage: false,
      startCursor: p.__startCursor as string | null,
      endCursor: p.__endCursor as string | null,
    }),
    totalCount: (p) => (p.__items as unknown[]).length,
  },
  IssueEdge: {
    node: (p) => p.__node as unknown,
    cursor: (p) => p.__cursor as string,
  },
  PullRequestEdge: {
    node: (p) => p.__node as unknown,
    cursor: (p) => p.__cursor as string,
  },
  FileEdge: {
    node: (p) => p.__node as unknown,
    cursor: (p) => p.__cursor as string,
  },
  PageInfo: {
    hasNextPage: (p) => p.hasNextPage as boolean,
    hasPreviousPage: (p) => p.hasPreviousPage as boolean,
    startCursor: (p) => p.startCursor as string | null,
    endCursor: (p) => p.endCursor as string | null,
  },
  FileChange: {
    path: (p) => p.path as string,
    additions: (p) => p.additions as number,
    deletions: (p) => p.deletions as number,
    changeType: (p) => p.changeType as string,
  },
  IssueComment: {
    id: (p) => p.id as string,
    body: (p) => p.body as string,
    createdAt: (p) => p.createdAt as string,
    author: () => userObject(),
  },
  IssueCommentEdge: {
    node: (p) => p.__node as unknown,
    cursor: (p) => p.__cursor as string,
  },
  CreateIssuePayload: { issue: (p) => p.__issue as unknown },
  CloseIssuePayload: { issue: (p) => p.__issue as unknown },
  CreatePullRequestPayload: { pullRequest: (p) => p.__pull as unknown },
  MergePullRequestPayload: { pullRequest: (p) => p.__pull as unknown },
  AddCommentPayload: { commentEdge: (p) => p.__commentEdge as unknown },
  Label: { name: (p) => p.name as string },
  LabelConnection: {
    nodes: (p) => p.__items as unknown[],
    edges: (p) => (p.__items as unknown[]).map((item) => ({ __typename: 'LabelEdge', __node: item, __cursor: '' })),
    pageInfo: () => ({ __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
    totalCount: (p) => (p.__items as unknown[]).length,
  },
  LabelEdge: { node: (p) => p.__node as unknown, cursor: () => '' },
  Commit: { oid: (p) => p.oid as string },
  __Schema: {
    queryType: () => ({ __typename: '__Type', __typeName: 'Query' }),
    mutationType: () => ({ __typename: '__Type', __typeName: 'Mutation' }),
    subscriptionType: () => null,
    types: () =>
      Object.keys(FIELDS).map((name) => ({ __typename: '__Type', __typeName: name })),
    directives: () => [],
  },
  __Type: {
    kind: (p) => typeKind(p.__typeName as string),
    name: (p) => p.__typeName as string,
    description: () => null,
    fields: (p, args) => {
      const includeDeprecated = args.includeDeprecated === true;
      void includeDeprecated;
      const names = FIELDS[p.__typeName as string] ?? [];
      return names
        .filter((n) => !n.startsWith('__'))
        .map((n) => ({ __typename: '__Field', __fieldName: n, __typeName: p.__typeName as string }));
    },
    inputFields: () => [],
    interfaces: () => [],
    enumValues: (p, args) => {
      const includeDeprecated = args.includeDeprecated === true;
      void includeDeprecated;
      return (ENUM_VALUES[p.__typeName as string] ?? []).map((n) => ({
        __typename: '__EnumValue',
        __enumName: n,
      }));
    },
    possibleTypes: () => [],
    ofType: () => null,
    specifiedByURL: () => null,
  },
  __Field: {
    name: (p) => p.__fieldName as string,
    description: () => null,
    args: () => [],
    type: (p) => ({ __typename: '__Type', __typeName: 'String' }),
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __InputValue: {
    name: (p) => p.__inputName as string,
    description: () => null,
    type: () => ({ __typename: '__Type', __typeName: 'String' }),
    defaultValue: () => null,
  },
  __EnumValue: {
    name: (p) => p.__enumName as string,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Directive: {
    name: (p) => p.__directiveName as string,
    description: () => null,
    locations: () => [],
    args: () => [],
    isRepeatable: () => false,
  },
};

function introspectType(name: string): AnyObject | null {
  if (!(name in FIELDS) && !isEnumType(name) && !['String', 'Int', 'Float', 'Boolean', 'ID'].includes(name)) {
    return null;
  }
  return { __typename: '__Type', __typeName: name };
}

function executeSelections(
  parent: AnyObject,
  selections: SelectionNode[],
  state: ExecState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = parent.__typename;
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = state.fragments.get(selection.name);
      if (!fragment) {
        state.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition && fragment.typeCondition !== typeName && fragment.typeCondition !== 'Node') {
        continue;
      }
      Object.assign(out, executeSelections(parent, fragment.selections, state));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition && selection.typeCondition !== typeName && selection.typeCondition !== 'Node') {
        continue;
      }
      Object.assign(out, executeSelections(parent, selection.selections, state));
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const known = (FIELDS[typeName] ?? []).includes(field.name) || field.name === '__typename';
    if (!known) {
      state.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[field.name];
    if (!resolver) {
      out[responseKey] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = valueOf(arg.value, state.variables);
    let value: unknown;
    try {
      value = resolver(parent, args, state);
    } catch (err) {
      state.errors.push({ message: err instanceof Error ? err.message : 'Internal error' });
      out[responseKey] = null;
      continue;
    }
    if (field.selections && value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        out[responseKey] = value.map((item) =>
          typeof item === 'object' && item !== null && '__typename' in item
            ? executeSelections(item as AnyObject, field.selections as SelectionNode[], state)
            : item,
        );
      } else if (typeof value === 'object' && '__typename' in (value as AnyObject)) {
        out[responseKey] = executeSelections(value as AnyObject, field.selections as SelectionNode[], state);
      } else {
        out[responseKey] = value;
      }
    } else {
      out[responseKey] = value ?? null;
    }
  }
  return out;
}

function executeOperation(
  operation: OperationNode,
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const state: ExecState = { errors: [], fragments, variables };
  // Apply variable defaults.
  for (const def of operation.varDefs) {
    if (!(def.name in variables) && def.defaultValue !== undefined) {
      variables[def.name] = valueOf(def.defaultValue, variables);
    }
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyObject = { __typename: rootType };
  const data = executeSelections(root, operation.selections, state);
  const result: { data: Record<string, unknown>; errors?: Array<{ message: string }> } = { data };
  if (state.errors.length > 0) result.errors = state.errors;
  return result;
}

export function handleGraphQL(ctx: Ctx): boolean {
  if (!ctx.url.pathname.startsWith('/api/graphql')) return false;
  if (!requireAuth(ctx)) return true;
  if (ctx.method !== 'POST') {
    jsonError(ctx, 405, 'Method Not Allowed');
    return true;
  }
  const body = ctx.body;
  const docs: Array<Record<string, unknown>> = (Array.isArray(body) ? body : [body]).map(
    (d) => (d !== null && typeof d === 'object' ? (d as Record<string, unknown>) : {}),
  );
  const results = docs.map((doc) => {
    const query = typeof doc.query === 'string' ? doc.query : '';
    const variables = (doc.variables ?? {}) as Record<string, unknown>;
    if (!query) return { data: null, errors: [{ message: 'query is required' }] };
    try {
      const parsed = parseGraphQL(query);
      const operationName = typeof doc.operationName === 'string' ? doc.operationName : undefined;
      const operation =
        parsed.operations.find((op) => op.name === operationName) ?? parsed.operations[0];
      if (!operation) return { data: null, errors: [{ message: 'No operation found' }] };
      if (operation.operation === 'subscription') {
        return { data: null, errors: [{ message: 'Subscriptions are not supported' }] };
      }
      return executeOperation(operation, { ...variables }, parsed.fragments);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
    }
  });
  ctx.respond(200, Array.isArray(body) ? results : results[0]);
  return true;
}
