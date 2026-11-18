// git.ts — the git smart-HTTP wire: pkt-line framing, packfile read/write (plain
// objects, no deltas — the suite's client resolves deltas when a server sends
// them, and accepts a pack with none), and the fetch computation (wants, haves,
// shallow boundaries, deepen) both protocol versions speak.
//
// Pack reading uses node:zlib only. inflateSync ignores trailing bytes, so the
// consumed length of one object's zlib stream is found by inflating a bounded
// slice once and scanning forward for its Adler-32 trailer (binary search is
// the fallback when that fails) — exact, and ~9x faster than binary search
// for the packs this forge sees.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  collectReachable,
  collectTreeClosure,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type Repo,
} from './store.ts';

export const PKT_LINE_MAX = 65520;

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines. Throws on a malformed header. */
export function decodePktLines(buf: Buffer): PktPacket[] {
  const out: PktPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (head === '0002') {
      out.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > buf.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    }
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

/** Split a request body into pkt-line packets plus the raw tail after the first flush. */
export function splitPktBody(buf: Buffer): { packets: PktPacket[]; tail: Buffer } {
  let offset = 0;
  const packets: PktPacket[] = [];
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush' });
      return { packets, tail: buf.subarray(offset + 4) };
    }
    if (head === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, tail: Buffer.alloc(0) };
}

// -------------------------------------------------------------------------------------------
// packfile write (plain objects, version 2)
// -------------------------------------------------------------------------------------------

const PACK_TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeId = PACK_TYPE_IDS[type];
  const out: number[] = [];
  let first = (typeId << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  out.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>>= 7;
    if (size > 0) byte |= 0x80;
    out.push(byte);
  }
  return Buffer.from(out);
}

export function writePack(objects: Iterable<GitObject & { oid: string }>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  // The trailer is the raw SHA-1 of the preceding pack bytes (not a git object hash).
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// -------------------------------------------------------------------------------------------
// packfile read
// -------------------------------------------------------------------------------------------

export interface PackEntry {
  oid: string;
  type: GitObjectType;
  data: Buffer;
}

/** Adler-32 (deferred-mod, NMAX=5552 blocks) — the zlib trailer checksum. */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  let i = 0;
  const len = data.length;
  while (i < len) {
    const end = Math.min(i + 5552, len);
    for (; i < end; i += 1) {
      a += data[i] as number;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Inflate one zlib stream starting at `offset`; returns the data and bytes consumed. */
function inflateAt(buf: Buffer, offset: number, size: number): { data: Buffer; consumed: number } {
  // Fast path: the compressed form is at most the raw size plus stored-block
  // overhead (5 bytes per 64 KiB) and zlib framing, so inflate that bounded
  // slice once, then locate the stream end by scanning forward for the 4-byte
  // big-endian Adler-32 trailer. The scan is forward and every candidate is
  // verified by an exact-length inflate: inflateSync ignores trailing bytes,
  // so a candidate past the true end would also "succeed" — only the first
  // position whose exact inflate reproduces the data is the true end.
  // (The old binary search did ~10 throwing inflates per object, ~9x slower.)
  const bound = size + 5 * Math.ceil(size / 65535) + 32;
  const end = Math.min(buf.length, offset + bound);
  try {
    const data = inflateSync(buf.subarray(offset, end));
    if (data.length === size) {
      const want = adler32(data);
      for (let k = offset + 2; k + 4 <= end; k += 1) {
        if (buf.readUInt32BE(k) === want) {
          try {
            const check = inflateSync(buf.subarray(offset, k + 4));
            if (check.length === size && check.equals(data)) {
              return { data, consumed: k + 4 - offset };
            }
          } catch {
            // Not the boundary (truncated stream) — keep scanning.
          }
        }
      }
    }
  } catch {
    // Bounded inflate failed (bound too small or corrupt) — fall through.
  }
  // Fallback: binary-search the smallest prefix that inflates.
  let lo = 1;
  let hi = buf.length - offset;
  let data: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      data = inflateSync(buf.subarray(offset, offset + mid));
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (data === null) throw new Error(`cannot inflate object at pack offset ${offset}`);
  return { data, consumed: lo };
}

function readPackVarint(buf: Buffer, offset: number): { size: number; type: number; next: number } {
  const first = buf[offset] as number;
  const type = (first >> 4) & 0x7;
  let size = first & 0x0f;
  let shift = 4;
  let at = offset + 1;
  // NOTE: no `as` cast inside a mask expression — `(x as number & 0x7f)` parses
  // `number & 0x7f` as an intersection type and the mask silently disappears.
  while (((buf[at - 1] as number) & 0x80) !== 0) {
    const byte = buf[at] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    at += 1;
  }
  return { size, type, next: at };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at++] as number;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (at < delta.length) {
    const op = delta[at++] as number;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) offset |= (delta[at++] as number) << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) size |= (delta[at++] as number) << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      out.push(delta.subarray(at, at + op));
      at += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Read a packfile (v2/v3, plain and delta objects), verifying its trailer checksum. */
export function readPack(pack: Buffer): PackEntry[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const expectedTrailer = pack.subarray(pack.length - 20).toString('hex');
  const actualTrailer = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (expectedTrailer !== actualTrailer) throw new Error('pack trailer checksum mismatch');
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const { size, type, next } = readPackVarint(pack, offset);
    offset = next;
    if (type === 6 || type === 7) {
      // OFS_DELTA (6) or REF_DELTA (7).
      let base: GitObject;
      if (type === 6) {
        let byte = pack[offset++] as number;
        let baseOffset = byte & 0x7f;
        while (byte & 0x80) {
          byte = pack[offset++] as number;
          baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
        }
        const baseEntry = byOffset.get(entryOffset - baseOffset);
        if (!baseEntry) throw new Error('ofs-delta base not found');
        base = baseEntry;
      } else {
        const baseOid = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
        const baseEntry = entries.find((e) => e.oid === baseOid);
        if (!baseEntry) throw new Error('ref-delta base not found');
        base = baseEntry;
      }
      const { data: delta, consumed } = inflateAt(pack, offset, size);
      offset += consumed;
      const data = applyDelta(base.data, delta);
      if (data.length !== size) throw new Error('delta object size mismatch');
      const oid = hashObject(base.type, data);
      const entry: PackEntry = { oid, type: base.type, data };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    } else {
      const objectType = PACK_TYPES[type];
      if (!objectType) throw new Error(`unknown pack object type ${type}`);
      const { data, consumed } = inflateAt(pack, offset, size);
      offset += consumed;
      if (data.length !== size) throw new Error('pack object size mismatch');
      const oid = hashObject(objectType, data);
      const entry: PackEntry = { oid, type: objectType, data };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    }
  }
  return entries;
}

// -------------------------------------------------------------------------------------------
// fetch computation
// -------------------------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

export interface FetchPlan {
  /** Objects to send, in deterministic (oid-sorted) order. */
  objects: Array<GitObject & { oid: string }>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Which objects a fetch sends.
 *
 * Included commits: from the wants, following parents — all of them, or only
 * those fewer than `depth` generations away when a depth is given. A have's
 * closure is excluded, except that the walk stops at the client's shallow
 * boundaries: the client holds a boundary commit, its tree and blobs, but not
 * its parents. Shallow lines name included commits whose parents are not
 * included (only when a depth is in play); unshallow lines name the client's
 * old boundaries that are now fully included.
 */
export function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const shallowSet = new Set(request.shallow);
  const depth = request.depth;

  // Included commits, with their distance from the nearest want.
  const included = new Map<string, number>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const want of request.wants) {
    const peeled = peelCommit(repo, want);
    if (peeled) queue.push({ oid: peeled, dist: 0 });
  }
  while (queue.length) {
    const { oid, dist } = queue.shift() as { oid: string; dist: number };
    if (included.has(oid)) continue;
    if (depth !== null && dist >= depth) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    included.set(oid, dist);
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: dist + 1 });
  }

  // The have closure: everything the client already holds.
  const haveObjects = new Set<string>();
  const visitHave = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (!object) return;
    if (object.type === 'commit') {
      if (shallowSet.has(oid)) {
        // A shallow boundary's own objects are held — the boundary commit and
        // its own tree — but its ancestors (and their trees) are not.
        haveObjects.add(oid);
        for (const key of collectTreeClosure(repo, parseCommit(object.data).tree).keys()) {
          haveObjects.add(key);
        }
        return;
      }
      for (const key of collectReachable(repo, [oid]).keys()) haveObjects.add(key);
    } else if (object.type === 'tag') {
      haveObjects.add(oid);
      visitHave(parseTag(object.data).object);
    } else {
      haveObjects.add(oid);
    }
  };
  for (const have of request.haves) visitHave(have);

  // Objects to send: the included commits themselves plus the tree closure of
  // each included commit (trees and blobs only — never a parent commit the
  // depth limit excluded), plus any tag object a want named. Minus what the
  // client already holds.
  const send = new Map<string, GitObject>();
  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (object && object.type === 'tag') {
      send.set(want, object);
      const target = parseTag(object.data).object;
      const peeled = peelCommit(repo, target);
      if (peeled && included.has(peeled)) {
        // The peeled commit is included below; nothing extra to add here.
      }
    }
  }
  for (const oid of included.keys()) {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    send.set(oid, object);
    // Tree closure only: the commit's own tree, subtrees and blobs — never a parent commit.
    for (const [key, entry] of collectTreeClosure(repo, parseCommit(object.data).tree)) {
      send.set(key, entry);
    }
  }
  for (const held of haveObjects) send.delete(held);

  const objects = [...send.entries()]
    .map(([oid, entry]) => ({ oid, ...entry }))
    .sort((a, b) => (a.oid < b.oid ? -1 : 1));

  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of included.keys()) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.some((p) => !included.has(p))) shallow.push(oid);
    }
    shallow.sort();
    for (const boundary of request.shallow) {
      if (!included.has(boundary)) continue;
      if (!shallow.includes(boundary)) unshallow.push(boundary);
    }
    unshallow.sort();
  }
  return { objects, shallow, unshallow };
}

/** A want oid peeled to its commit (tags peel to their target). */
function peelCommit(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object) return null;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') return peelCommit(repo, parseTag(object.data).object);
  return null;
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

export interface AdvertisedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** The repo's refs as an advertisement list: HEAD first, then sorted refs, peeled tags after. */
export function advertisedRefs(repo: Repo): AdvertisedRef[] {
  const out: AdvertisedRef[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid) {
    out.push({ oid: headOid, name: 'HEAD', symrefTarget: headTarget });
  } else {
    out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: headTarget, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const object = repo.objects.get(oid);
    const entry: AdvertisedRef = { oid, name };
    if (object && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject && targetObject.type === 'commit') entry.peeled = target;
    }
    out.push(entry);
  }
  return out;
}

/** v0 ref lines (with the capability NUL on the first line, or the capabilities^{} line when empty). */
export function v0AdvertisementLines(repo: Repo, capabilities: string): Buffer[] {
  const refs = advertisedRefs(repo);
  const real = refs.filter((r) => r.name !== 'HEAD' || !r.unborn);
  const lines: Buffer[] = [];
  const caps = capabilities ? `\0${capabilities}` : '';
  if (real.length === 0 && !repo.refs.get(`refs/heads/${repo.defaultBranch}`)) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}${caps}\n`));
    return lines;
  }
  let first = true;
  for (const ref of refs) {
    if (ref.unborn) continue;
    lines.push(pktLine(`${ref.oid} ${ref.name}${first ? caps : ''}\n`));
    first = false;
    if (ref.peeled) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
  }
  return lines;
}

export const UPLOAD_V2_CAPS: Array<[string, string | null]> = [
  ['ls-refs', 'unborn'],
  ['fetch', 'shallow wait-for-done filter'],
  ['object-format', 'sha1'],
  ['agent', 'forge/1.0'],
];

export function v2Advertisement(): Buffer[] {
  const lines: Buffer[] = [pktLine('version 2\n')];
  for (const [key, value] of UPLOAD_V2_CAPS) {
    lines.push(pktLine(value === null ? `${key}\n` : `${key}=${value}\n`));
  }
  return lines;
}
