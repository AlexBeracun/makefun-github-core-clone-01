// git-http.ts — git smart HTTP at /{owner}/{repo}.git: info/refs advertisement
// (v0 and v2), upload-pack (v0 and v2 fetch, ls-refs) and receive-pack.
// A missing repository is a 404 on every verb; a malformed POST body is a
// 400 and the server stays up.

import {
  VIEWER,
  ZERO_OID,
  isAncestor,
  parseCommit,
  store,
  type Repo,
} from './store.ts';
import {
  UPLOAD_V2_CAPS,
  advertisedRefs,
  decodePktLines,
  planFetch,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  v0AdvertisementLines,
  v2Advertisement,
  writePack,
  type FetchRequest,
} from './git.ts';
import { jsonError, repoOr404, requireAuth, type Ctx } from './rest.ts';

const UPLOAD_V0_CAPS = 'side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=forge/1.0 object-format=sha1';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

function wantsForClone(repo: Repo): string[] {
  const tips: string[] = [];
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) tips.push(oid);
  }
  return tips;
}

/** Split a sideband pack into band-1 pkt-lines (each <= 65520 bytes on the wire). */
function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const maxChunk = 65515;
  for (let offset = 0; offset < pack.length; offset += maxChunk) {
    const piece = pack.subarray(offset, Math.min(pack.length, offset + maxChunk));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  if (pack.length === 0) {
    // A zero-object pack is still a pack; writePack never returns empty, but be safe.
    chunks.push(pktLine(Buffer.from([1])));
  }
  return chunks;
}

/** Parse a receive-pack request body into commands + pack bytes. Throws on malformed input. */
function parseReceiveBody(body: Buffer): { commands: Array<{ oldOid: string; newOid: string; ref: string }>; pack: Buffer } {
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let offset = 0;
  let packStart = -1;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packStart = offset + 4;
      break;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > body.length) {
      throw new Error('malformed pkt-line in receive-pack request');
    }
    const payload = body.subarray(offset + 4, offset + len).toString('utf8');
    const nul = payload.indexOf('\0');
    const line = (nul >= 0 ? payload.slice(0, nul) : payload).trim();
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match) {
      commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    }
    offset += len;
  }
  if (packStart < 0) throw new Error('receive-pack request has no flush');
  return { commands, pack: body.subarray(packStart) };
}

function reportText(lines: string[]): Buffer {
  const data = Buffer.concat(lines.map((line) => pktLine(`${line}\n`)));
  return pktLine(Buffer.concat([Buffer.from([1]), data]));
}

export function handleGitHttp(ctx: Ctx): boolean {
  const path = ctx.url.pathname;
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (!match) return false;
  const owner = decodeURIComponent(match[1] as string);
  const repoName = decodeURIComponent(match[2] as string);
  const rest = match[3] as string;
  if (!requireAuth(ctx)) return true;
  const repo = repoOr404(ctx, owner, repoName);
  if (!repo) return true;

  if (ctx.method === 'GET' && rest === 'info/refs') {
    return handleInfoRefs(ctx, repo);
  }
  if (ctx.method === 'POST' && rest === 'git-upload-pack') {
    return handleUploadPack(ctx, repo);
  }
  if (ctx.method === 'POST' && rest === 'git-receive-pack') {
    return handleReceivePack(ctx, repo);
  }
  jsonError(ctx, 404, 'Not Found');
  return true;
}

function handleInfoRefs(ctx: Ctx, repo: Repo): boolean {
  const service = ctx.url.searchParams.get('service');
  const wantsV2 = (ctx.headers.get('git-protocol') ?? '').includes('version=2');
  if (service === 'git-upload-pack') {
    ctx.respondRaw(
      200,
      Buffer.concat([
        pktLine('# service=git-upload-pack\n'),
        pktFlush(),
        ...(wantsV2 ? v2Advertisement() : v0AdvertisementLines(repo, UPLOAD_V0_CAPS)),
        pktFlush(),
      ]),
      'application/x-git-upload-pack-advertisement',
    );
    return true;
  }
  if (service === 'git-receive-pack') {
    // Receive-pack has no v2; always advertise v0.
    ctx.respondRaw(
      200,
      Buffer.concat([
        pktLine('# service=git-receive-pack\n'),
        pktFlush(),
        ...v0AdvertisementLines(repo, RECEIVE_V0_CAPS),
        pktFlush(),
      ]),
      'application/x-git-receive-pack-advertisement',
    );
    return true;
  }
  ctx.respondRaw(400, Buffer.from('service parameter required', 'utf8'), 'text/plain');
  return true;
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

function parseUploadRequest(body: Buffer): { version: 0 | 2; command?: string; request: FetchRequest } {
  const packets = decodePktLines(body);
  const first = packets.find((p) => p.kind === 'data');
  const firstText = first && first.kind === 'data' ? first.payload.toString('utf8').trim() : '';
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };

  if (firstText.startsWith('command=')) {
    const command = firstText.slice('command='.length).trim();
    let afterDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (packet.kind !== 'data' || !afterDelim) continue;
      const line = packet.payload.toString('utf8').trim();
      if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n)) request.depth = n;
      }
    }
    return { version: 2, command, request };
  }

  // v0: wants (+ shallow/deepen) until flush, then haves + done.
  let phase = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      phase = 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    if (phase === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
    }
    line = line.trim();
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) request.depth = n;
    }
  }
  return { version: 0, request };
}

function handleUploadPack(ctx: Ctx, repo: Repo): boolean {
  let parsed: { version: 0 | 2; command?: string; request: FetchRequest };
  try {
    parsed = parseUploadRequest(ctx.rawBody);
  } catch {
    ctx.respondRaw(400, Buffer.from('malformed request', 'utf8'), 'text/plain');
    return true;
  }

  if (parsed.version === 2 && parsed.command === 'ls-refs') {
    return handleLsRefs(ctx, repo, parsed.request);
  }
  if (parsed.version === 2 && parsed.command !== 'fetch') {
    ctx.respondRaw(400, Buffer.from('unknown command', 'utf8'), 'text/plain');
    return true;
  }

  const plan = planFetch(repo, parsed.request);
  const pack = writePack(plan.objects);

  if (parsed.version === 2) {
    const hasDone = ctx.rawBody.toString('utf8').includes('done');
    const parts: Buffer[] = [
      pktLine('acknowledgments\n'),
      pktLine(hasDone ? 'ready\n' : 'NAK\n'),
      pktFlush(),
    ];
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktFlush());
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
    parts.push(pktFlush());
    ctx.respondRaw(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return true;
  }

  // v0 fetch response: NAK, shallow/unshallow lines, sideband pack, flush.
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  ctx.respondRaw(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
  return true;
}

function handleLsRefs(ctx: Ctx, repo: Repo, _request: FetchRequest): boolean {
  // Re-parse the raw args: ls-refs options live in the packet list, not in FetchRequest.
  const packets = decodePktLines(ctx.rawBody);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  let prefix: string | undefined;
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const line = packet.payload.toString('utf8').trim();
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefix = line.slice('ref-prefix '.length).trim();
  }

  const refs = advertisedRefs(repo);
  const lines: Buffer[] = [];
  for (const ref of refs) {
    if (ref.name === 'HEAD') {
      if (prefix !== undefined && !'HEAD'.startsWith(prefix)) continue;
      if (ref.unborn) {
        if (!unborn) continue;
        lines.push(pktLine(`unborn HEAD symref-target:${ref.symrefTarget ?? `refs/heads/${repo.defaultBranch}`}\n`));
      } else {
        const sym = symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : '';
        lines.push(pktLine(`${ref.oid} HEAD${sym}\n`));
      }
      continue;
    }
    if (prefix !== undefined && !ref.name.startsWith(prefix)) continue;
    // v2 carries the peeled target as an attribute on the same line (the
    // `^{}` line is the v0 advertisement's form, not v2's).
    const peeled = peel && ref.peeled ? ` peeled:${ref.peeled}` : '';
    lines.push(pktLine(`${ref.oid} ${ref.name}${peeled}\n`));
  }
  lines.push(pktFlush());
  ctx.respondRaw(200, Buffer.concat(lines), 'application/x-git-upload-pack-result');
  return true;
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

function handleReceivePack(ctx: Ctx, repo: Repo): boolean {
  let parsed: { commands: Array<{ oldOid: string; newOid: string; ref: string }>; pack: Buffer };
  try {
    parsed = parseReceiveBody(ctx.rawBody);
  } catch {
    ctx.respondRaw(400, Buffer.from('malformed request', 'utf8'), 'text/plain');
    return true;
  }

  const report: string[] = [];
  let unpackError: string | null = null;
  let entries: Array<{ oid: string; type: string; data: Buffer }> = [];
  if (parsed.pack.length > 0) {
    try {
      entries = readPack(parsed.pack);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (unpackError === null) {
    for (const entry of entries) {
      if (!repo.objects.has(entry.oid)) {
        repo.objects.set(entry.oid, { type: entry.type as 'commit' | 'tree' | 'blob' | 'tag', data: entry.data });
      }
    }
    report.push('unpack ok');
  } else {
    report.push(`unpack ${unpackError}`);
  }

  if (unpackError === null) {
    for (const command of parsed.commands) {
      const current = repo.refs.get(command.ref);
      const isCreate = command.oldOid === ZERO_OID;
      const isDelete = command.newOid === ZERO_OID;
      if (isCreate && current !== undefined) {
        report.push(`ng ${command.ref} reference already exists`);
        continue;
      }
      if (!isCreate && current === undefined) {
        report.push(`ng ${command.ref} reference does not exist`);
        continue;
      }
      if (!isCreate && current !== command.oldOid) {
        report.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      if (!isDelete) {
        const newObject = repo.objects.get(command.newOid);
        if (!newObject) {
          report.push(`ng ${command.ref} object not found`);
          continue;
        }
        if (!isCreate && newObject.type === 'commit') {
          // Fast-forward: the new tip must descend from the old tip.
          if (!isAncestor(repo, command.oldOid, command.newOid)) {
            report.push(`ng ${command.ref} non-fast-forward`);
            continue;
          }
        }
        repo.refs.set(command.ref, command.newOid);
      } else {
        repo.refs.delete(command.ref);
      }
      repo.updatedAt = new Date().toISOString();
      report.push(`ok ${command.ref}`);
    }
  }

  ctx.respondRaw(
    200,
    Buffer.concat([reportText(report), pktFlush()]),
    'application/x-git-receive-pack-result',
  );
  return true;
}

export { wantsForClone };
