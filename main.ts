// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. Unified diffs (section 6),
// three-tier matching (section 5), SEARCH/REPLACE blocks (section 7) and V4A patches (section 8) are implemented
// below, with R-lines for moves (section 2). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves in patch order: [old, new] (SPEC.md section 2, R-lines). */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Split a file's text into its lines, its line break and whether it ends with a break (SPEC.md section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

/** Normalize one line at a matching tier (SPEC.md section 5). */
function tierNorm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The first tier at which O occurs in the file's lines, with every occurrence position; null when it occurs at no tier. Occurrences may overlap. */
function findOccurrences(old: string[], file: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = old.map((l) => tierNorm(l, tier));
    const have = file.map((l) => tierNorm(l, tier));
    const positions: number[] = [];
    for (let i = 0; i + old.length <= file.length; i++) {
      let ok = true;
      for (let j = 0; j < old.length; j++) {
        if (have[i + j] !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0];

type BodyEntry = { kind: 'ctx' | 'old' | 'new'; text: string; backslash: boolean };

interface Hunk {
  a: number;
  entries: BodyEntry[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noeol: boolean;
  /** A `\` line follows the hunk's last `+` line (for created files). */
  plusNoeol: boolean;
  hasPlus: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** A path from a `--- ` or `+++ ` line: after the four characters, up to the first tab, surrounding spaces removed; /dev/null means no file; a leading a/ or b/ removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** The two paths of a `diff --git a/<X> b/<Y>` line, or null when the line is not of that form. */
function gitPaths(line: string): [string, string] | null {
  if (!line.startsWith('diff --git a/')) return null;
  const rest = line.slice('diff --git a/'.length);
  const at = rest.indexOf(' b/');
  if (at <= 0) return null;
  const x = rest.slice(0, at);
  const y = rest.slice(at + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Read one hunk body starting at lines[j] (the line after the header). Returns the hunk and the index of the first line after the body. */
function readHunkBody(lines: string[], j: number, a: number): { hunk: Hunk; next: number } {
  const entries: BodyEntry[] = [];
  let k = j;
  while (k < lines.length) {
    const l = lines[k]!;
    // A `--- ` line followed by a `+++ ` line ends the body (a new section starts there); otherwise a `--- ` line is an old line.
    if (l.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      entries.push({ kind: 'ctx', text: '', backslash: false });
      k++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      entries.push({ kind: 'ctx', text: l.slice(1), backslash: false });
      k++;
      continue;
    }
    if (c === '-') {
      entries.push({ kind: 'old', text: l.slice(1), backslash: false });
      k++;
      continue;
    }
    if (c === '+') {
      entries.push({ kind: 'new', text: l.slice(1), backslash: false });
      k++;
      continue;
    }
    if (c === '\\') {
      // A `\` line refers to the body line before it.
      if (entries.length > 0) entries[entries.length - 1]!.backslash = true;
      k++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (entries.length > 0) {
    const last = entries[entries.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') entries.pop();
    else break;
  }
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.kind !== 'old') lastCtxOrPlus = i;
    if (entries[i]!.kind === 'new') lastPlus = i;
  }
  return {
    hunk: {
      a,
      entries,
      noeol: lastCtxOrPlus >= 0 && entries[lastCtxOrPlus]!.backslash,
      plusNoeol: lastPlus >= 0 && entries[lastPlus]!.backslash,
      hasPlus: lastPlus >= 0,
    },
    next: k,
  };
}

/** Build the lines a hunk writes: context lines as the file's own matched lines, other lines re-indented at tier 2 (SPEC.md section 5). */
function buildReplacement(h: Hunk, file: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  let oIdx = 0;
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadingWs(file[at]!);
    const firstOld = h.entries.find((e) => e.kind === 'ctx' || e.kind === 'old');
    p = firstOld === undefined ? '' : leadingWs(firstOld.text);
  }
  for (const e of h.entries) {
    if (e.kind === 'ctx') {
      out.push(file[at + oIdx]!);
      oIdx++;
    } else if (e.kind === 'old') {
      oIdx++;
    } else {
      let t = e.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

/** Apply a section's hunks in order to a file's text (SPEC.md section 6). Throws Fail('no-match', path) when a hunk's old lines are not found. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const split = splitFile(before);
  const lines = split.lines;
  const br = split.br;
  let final = split.final;
  let d = 0;
  for (const h of hunks) {
    const oEntries = h.entries.filter((e) => e.kind === 'ctx' || e.kind === 'old');
    const nCount = h.entries.filter((e) => e.kind === 'ctx' || e.kind === 'new').length;
    const oCount = oEntries.length;
    if (oCount === 0) {
      const add = h.entries.filter((e) => e.kind === 'new').map((e) => e.text);
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > lines.length) at = lines.length;
      if (at === lines.length) final = !h.noeol;
      lines.splice(at, 0, ...add);
    } else {
      const old = oEntries.map((e) => e.text);
      const found = findOccurrences(old, lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.positions) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const replacement = buildReplacement(h, lines, best, found.tier);
      const runsToEnd = best + oCount === lines.length;
      lines.splice(best, oCount, ...replacement);
      if (runsToEnd) final = !h.noeol;
    }
    d += nCount - oCount;
  }
  return joinFile(lines, br, final);
}

/** One unified section as an edit (SPEC.md section 6). */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null || sec.isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const lines: string[] = [];
      for (const h of sec.hunks) for (const e of h.entries) if (e.kind === 'new') lines.push(e.text);
      let noeol = false;
      for (let i = sec.hunks.length - 1; i >= 0; i--) {
        if (sec.hunks[i]!.hasPlus) {
          noeol = sec.hunks[i]!.plusNoeol;
          break;
        }
      }
      tree.now.set(newP, joinFile(lines, '\n', !noeol));
      return;
    }
    if (newP === null || sec.isDelete) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const after = applyHunks(before, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, after);
      tree.moves.push([oldP, newP]);
      return;
    }
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(before, sec.hunks, strict, oldP));
  };
}

/** Read a unified patch (SPEC.md section 6) into one edit per section. Throws Exit2 on a parse error. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface Draft {
    pairOld: string | null | undefined;
    pairNew: string | null | undefined;
    renameOld: string | undefined;
    renameNew: string | undefined;
    gitOld: string | undefined;
    gitNew: string | undefined;
    isCreate: boolean;
    isDelete: boolean;
    hunks: Hunk[];
  }
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l === 'diff --git' || l.startsWith('diff --git ')) {
      const p = gitPaths(l);
      if (p === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { pairOld: undefined, pairNew: undefined, renameOld: undefined, renameNew: undefined, gitOld: p[0], gitNew: p[1], isCreate: false, isDelete: false, hunks: [] };
      drafts.push(cur);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = readHunkBody(lines, i + 1, parseInt(m[1]!, 10));
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && cur.hunks.length === 0 && cur.pairOld === undefined) {
          cur.pairOld = headerPath(l);
          cur.pairNew = headerPath(next);
        } else {
          cur = { pairOld: headerPath(l), pairNew: headerPath(next), renameOld: undefined, renameNew: undefined, gitOld: undefined, gitNew: undefined, isCreate: false, isDelete: false, hunks: [] };
          drafts.push(cur);
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) cur.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.isCreate = true;
      else if (l.startsWith('deleted file mode')) cur.isDelete = true;
      // index, mode, similarity, Index: and any other header line are ignored.
    }
    // Outside bodies, lines that are not part of a section header are ignored (prose, code fences).
    i++;
  }
  return drafts.map((d) => {
    const oldPath = d.pairOld !== undefined ? d.pairOld : d.renameOld !== undefined ? d.renameOld : d.gitOld ?? null;
    const newPath = d.pairNew !== undefined ? d.pairNew : d.renameNew !== undefined ? d.renameNew : d.gitNew ?? null;
    return unifiedEdit({ oldPath, newPath, isCreate: d.isCreate, isDelete: d.isDelete, hunks: d.hunks }, strict);
  });
}

/** Re-indent one N line at tier 2 (SPEC.md section 5): F is the leading spaces and tabs of the file's first matched line, P those of O's first line. */
function reindentLine(t: string, f: string, p: string): string {
  return t !== '' && t.trim() !== '' && t.startsWith(p) ? f + t.slice(p.length) : t;
}

/** One SEARCH/REPLACE block as an edit (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile(newLines, '\n', true));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const split = splitFile(before);
    const found = findOccurrences(oldLines, split.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const at = found.positions[0]!;
    let replacement = newLines;
    if (found.tier === 2) {
      const f = leadingWs(split.lines[at]!);
      const p = leadingWs(oldLines[0]!);
      replacement = newLines.map((t) => reindentLine(t, f, p));
    }
    const out = [...split.lines];
    out.splice(at, oldLines.length, ...replacement);
    tree.now.set(path, joinFile(out, split.br, split.final));
  };
}

/** Read a SEARCH/REPLACE patch (SPEC.md section 7) into one edit per block. Throws Exit2 on a parse error. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j--) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(srEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevReplace = end;
    i = end + 1;
  }
  return edits;
}

/** Build the lines a V4A chunk writes: context lines as the file's own matched lines, other lines re-indented at tier 2 (SPEC.md section 5). */
function buildChunkReplacement(entries: ChunkEntry[], file: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  let oIdx = 0;
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadingWs(file[at]!);
    const firstOld = entries.find((e) => e.kind === 'ctx' || e.kind === 'old');
    p = firstOld === undefined ? '' : leadingWs(firstOld.text);
  }
  for (const e of entries) {
    if (e.kind === 'ctx') {
      out.push(file[at + oIdx]!);
      oIdx++;
    } else if (e.kind === 'old') {
      oIdx++;
    } else {
      out.push(tier === 2 ? reindentLine(e.text, f, p) : e.text);
    }
  }
  return out;
}

type ChunkEntry = { kind: 'ctx' | 'old' | 'new'; text: string };

interface V4aChunk {
  anchor: string | null;
  entries: ChunkEntry[];
  eof: boolean;
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is (SPEC.md section 8, both sides a single line). */
function findAnchor(anchor: string, file: string[], from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = tierNorm(anchor, tier);
    for (let i = from; i < file.length; i++) {
      if (tierNorm(file[i]!, tier) === want) return i;
    }
  }
  return null;
}

/** The first occurrence of O at or after the cursor, at the first tier with one; an end-of-file chunk takes only an occurrence that ends at the file's last line. */
function findChunkOccurrence(old: string[], file: string[], from: number, eof: boolean, strict: boolean): { at: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = old.map((l) => tierNorm(l, tier));
    const have = file.map((l) => tierNorm(l, tier));
    for (let i = from; i + old.length <= file.length; i++) {
      if (eof && i + old.length !== file.length) continue;
      let ok = true;
      for (let j = 0; j < old.length; j++) {
        if (have[i + j] !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return { at: i, tier };
    }
  }
  return null;
}

/** Apply a V4A section's chunks in order to a file's text, with the cursor (SPEC.md section 8). Throws Fail('no-match', path) when an anchor or a chunk's old lines are not found. */
function applyV4aChunks(before: string, chunks: V4aChunk[], strict: boolean, path: string): string {
  const split = splitFile(before);
  const lines = split.lines;
  const br = split.br;
  const final = split.final;
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== null) {
      const anchorAt = findAnchor(chunk.anchor, lines, cursor, strict);
      if (anchorAt === null) throw new Fail('no-match', path);
      cursor = anchorAt + 1;
    }
    const oEntries = chunk.entries.filter((e) => e.kind === 'ctx' || e.kind === 'old');
    const old = oEntries.map((e) => e.text);
    if (old.length === 0) {
      const add = chunk.entries.filter((e) => e.kind === 'new').map((e) => e.text);
      const at = chunk.eof ? lines.length : cursor;
      lines.splice(at, 0, ...add);
      cursor = at + add.length;
      continue;
    }
    const found = findChunkOccurrence(old, lines, cursor, chunk.eof, strict);
    if (found === null) throw new Fail('no-match', path);
    const replacement = buildChunkReplacement(chunk.entries, lines, found.at, found.tier);
    lines.splice(found.at, old.length, ...replacement);
    cursor = found.at + replacement.length;
  }
  return joinFile(lines, br, final);
}

/** A V4A section header line: `*** Add File: `, `*** Delete File: ` or `*** Update File: `, the path the rest of the line with its surrounding spaces removed. */
function v4aHeader(l: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice('*** Add File: '.length).trim() };
  if (l.startsWith('*** Delete File: ')) return { kind: 'delete', path: l.slice('*** Delete File: '.length).trim() };
  if (l.startsWith('*** Update File: ')) return { kind: 'update', path: l.slice('*** Update File: '.length).trim() };
  return null;
}

/** One V4A section as an edit (SPEC.md section 8). `body` is the section's lines with blank lines at its end removed; `headerLine` is the 1-based line of the section header. Throws Exit2 on a parse error. */
function v4aSectionEdit(hdr: { kind: 'add' | 'delete' | 'update'; path: string }, body: string[], headerLine: number, strict: boolean): Edit {
  const path = hdr.path;
  if (hdr.kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < body.length; k++) {
      const l = body[k]!;
      if (l.startsWith('+')) fileLines.push(l.slice(1));
      else if (l === '') fileLines.push('');
      else throw new Exit2(`error: parse ${headerLine + 1 + k}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile(fileLines, '\n', true));
    };
  }
  if (hdr.kind === 'delete') {
    for (let k = 0; k < body.length; k++) {
      if (!blank(body[k]!)) throw new Exit2(`error: parse ${headerLine + 1 + k}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let k = 0;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  const closeChunk = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (; k < body.length; k++) {
    const l = body[k]!;
    const lineNo = headerLine + 1 + k;
    if (l.startsWith('@@')) {
      closeChunk();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, entries: [], eof: false };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      closeChunk();
      continue;
    }
    const c = l[0];
    if (c === ' ' || c === '-' || c === '+' || l === '') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
        cur = { anchor: null, entries: [], eof: false };
      }
      if (c === ' ') cur.entries.push({ kind: 'ctx', text: l.slice(1) });
      else if (c === '-') cur.entries.push({ kind: 'old', text: l.slice(1) });
      else if (c === '+') cur.entries.push({ kind: 'new', text: l.slice(1) });
      else cur.entries.push({ kind: 'ctx', text: '' });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const after = applyV4aChunks(before, chunks, strict, path);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, after);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, after);
    }
  };
}

/** Read a V4A patch (SPEC.md section 8) into one edit per section. Throws Exit2 on a parse error. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const hdr = v4aHeader(l);
    if (hdr === null) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && v4aHeader(lines[j]!) === null) j++;
    const raw = lines.slice(i + 1, j);
    let end = raw.length;
    while (end > 0 && blank(raw[end - 1]!)) end--;
    edits.push(v4aSectionEdit(hdr, raw.slice(0, end), i + 1, strict));
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const consumed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (consumed.has(oldP) || consumed.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.line);
  if (!check) {
    for (const [p, now] of tree.now) {
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
