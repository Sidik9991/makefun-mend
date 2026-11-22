// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits),
// finds the lines each edit names at the first of three matching tiers, and writes every change
// or none, printing what it changed or why it failed. SPEC.md is the whole contract.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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

/* ------------------------------------------------------------------ */
/* Files as lines (SPEC.md section 3)                                  */
/* ------------------------------------------------------------------ */

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/* ------------------------------------------------------------------ */
/* Matching lines at three tiers (SPEC.md section 5)                   */
/* ------------------------------------------------------------------ */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** 0-based positions where O occurs in `lines` at `tier`, starting at `from`. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = Math.max(0, from); i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!lineEq(O[k]!, lines[i + k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) with an occurrence at or after `from`. */
function findTier(
  O: string[],
  lines: string[],
  from: number,
  strict: boolean,
  eofOnly: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let occ = occurrences(O, lines, t, from);
    if (eofOnly) occ = occ.filter((p) => p + O.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * One replacement block: O is the old lines, N the new lines. A context entry of N carries the
 * index of its line in O, so it is written as the file's own matched line, never the patch's.
 */
interface NEntry {
  text: string;
  ctx: number; // >= 0: context line, index into O; -1: a new line from the patch
}

function buildON(
  ops: { kind: string; text: string }[],
): { O: string[]; N: NEntry[] } {
  const O: string[] = [];
  const N: NEntry[] = [];
  for (const op of ops) {
    if (op.kind === 'ctx') {
      const i = O.length;
      O.push(op.text);
      N.push({ text: op.text, ctx: i });
    } else if (op.kind === 'old') {
      O.push(op.text);
    } else if (op.kind === 'new') {
      N.push({ text: op.text, ctx: -1 });
    }
  }
  return { O, N };
}

/** The lines N writes over the matched lines at `pos`, re-indented at tier 2 (section 5). */
function renderN(N: NEntry[], fileLines: string[], pos: number, O: string[], tier: number): string[] {
  if (tier !== 2) return N.map((e) => (e.ctx >= 0 ? fileLines[pos + e.ctx]! : e.text));
  const F = leadingWs(fileLines[pos] ?? '');
  const P = leadingWs(O[0] ?? '');
  return N.map((e) => {
    if (e.ctx >= 0) return fileLines[pos + e.ctx]!;
    const t = e.text;
    if (t === '' || /^[ \t]*$/.test(t)) return t;
    return t.startsWith(P) ? F + t.slice(P.length) : t;
  });
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC.md section 4)                                */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9) — as the starter had them            */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface HunkOp {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

interface Hunk {
  a: number;
  ops: HunkOp[];
  /** a `\` line follows the hunk's last context or `+` line */
  backslash: boolean;
}

function parseHunkHeader(line: string, idx: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
  return Number(m[1]);
}

/** Collect a hunk's body lines starting at `i`; returns the index of the first line not in it. */
function collectHunkBody(lines: string[], i: number, hunk: Hunk): number {
  const body: string[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      i++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  hunk.ops = body.map((l): HunkOp => {
    if (l === '') return { kind: 'ctx', text: '' };
    if (l[0] === ' ') return { kind: 'ctx', text: l.slice(1) };
    if (l[0] === '-') return { kind: 'old', text: l.slice(1) };
    if (l[0] === '+') return { kind: 'new', text: l.slice(1) };
    return { kind: 'bs', text: l.slice(1) };
  });
  let last = -1;
  for (let k = 0; k < hunk.ops.length; k++) {
    if (hunk.ops[k]!.kind === 'ctx' || hunk.ops[k]!.kind === 'new') last = k;
  }
  hunk.backslash = last >= 0 && hunk.ops[last + 1]?.kind === 'bs';
  return i;
}

/** The path after `--- ` / `+++ `: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

interface Section {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function newSection(diffOld: string | null, diffNew: string | null): Section {
  return {
    oldPath: null,
    newPath: null,
    hasPair: false,
    renameFrom: null,
    renameTo: null,
    diffOld,
    diffNew,
    isCreate: false,
    isDelete: false,
    hunks: [],
  };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const pushCur = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      pushCur();
      cur = newSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = newSection(null, null);
        cur.oldPath = stripAB(headerPath(line));
        cur.newPath = stripAB(headerPath(lines[i + 1]!));
        cur.hasPair = true;
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (cur.hunks.length === 0) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.oldPath = stripAB(headerPath(line));
          cur.newPath = stripAB(headerPath(lines[i + 1]!));
          cur.hasPair = true;
          i += 2;
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        continue;
      }
      if (line.startsWith('+++ ')) {
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const hunk: Hunk = { a: parseHunkHeader(line, i), ops: [], backslash: false };
        cur.hunks.push(hunk);
        i++;
        i = collectHunkBody(lines, i, hunk);
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const hunk: Hunk = { a: parseHunkHeader(line, i), ops: [], backslash: false };
      cur.hunks.push(hunk);
      i++;
      i = collectHunkBody(lines, i, hunk);
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      pushCur();
      cur = newSection(null, null);
      cur.oldPath = stripAB(headerPath(line));
      cur.newPath = stripAB(headerPath(lines[i + 1]!));
      cur.hasPair = true;
      i += 2;
      continue;
    }
    i++;
  }
  pushCur();
  return sections;
}

/**
 * Apply one hunk to a file's lines. Returns the new lines, whether the result ends with a line
 * break, and the change in line count (for the next hunk's drift d).
 */
function applyUnifiedHunk(
  state: FileLines,
  hunk: Hunk,
  d: number,
  strict: boolean,
  path: string,
): { lines: string[]; final: boolean; dDelta: number } {
  const { O, N } = buildON(hunk.ops);
  const lines = state.lines;
  if (O.length === 0) {
    const at = Math.max(0, Math.min(hunk.a + d, lines.length));
    const rep = N.map((e) => e.text);
    const out = [...lines.slice(0, at), ...rep, ...lines.slice(at)];
    return { lines: out, final: at === lines.length ? !hunk.backslash : state.final, dDelta: N.length };
  }
  const found = findTier(O, lines, 0, strict, false);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.occ[0]!;
  for (const p of found.occ) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const rep = renderN(N, lines, best, O, found.tier);
  const out = [...lines.slice(0, best), ...rep, ...lines.slice(best + O.length)];
  const runsToEnd = best + O.length === lines.length;
  return { lines: out, final: runsToEnd ? !hunk.backslash : state.final, dDelta: N.length - O.length };
}

function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec): Edit => {
    let oldP: string | null;
    let newP: string | null;
    if (sec.hasPair) {
      oldP = sec.oldPath === '/dev/null' ? null : sec.oldPath;
      newP = sec.newPath === '/dev/null' ? null : sec.newPath;
    } else if (sec.renameFrom !== null || sec.renameTo !== null) {
      oldP = sec.renameFrom;
      newP = sec.renameTo;
    } else {
      oldP = sec.diffOld;
      newP = sec.diffNew;
    }
    return (tree) => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      const isCreate = oldP === null || sec.isCreate;
      const isDelete = newP === null || sec.isDelete;
      if (isCreate) {
        const p = newP!;
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const created: string[] = [];
        let finalBreak = true;
        for (const h of sec.hunks) {
          for (const op of h.ops) if (op.kind === 'new') created.push(op.text);
        }
        for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const h = sec.hunks[hi]!;
          let done = false;
          for (let k = h.ops.length - 1; k >= 0; k--) {
            if (h.ops[k]!.kind === 'new') {
              finalBreak = !(h.ops[k + 1]?.kind === 'bs');
              done = true;
              break;
            }
          }
          if (done) break;
        }
        tree.now.set(p, created.length === 0 ? '' : created.join('\n') + (finalBreak ? '\n' : ''));
        return;
      }
      if (isDelete) {
        const p = oldP!;
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (oldP !== newP) {
        const cur = tree.get(oldP!);
        if (cur === null) throw new Fail('missing', oldP!);
        if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
        let state = splitFile(cur);
        let d = 0;
        for (const h of sec.hunks) {
          const r = applyUnifiedHunk(state, h, d, strict, oldP!);
          state = { lines: r.lines, br: state.br, final: r.final };
          d += r.dDelta;
        }
        tree.now.set(oldP!, null);
        tree.now.set(newP!, joinFile(state));
        moves.push([oldP!, newP!]);
        return;
      }
      const cur = tree.get(oldP!);
      if (cur === null) throw new Fail('missing', oldP!);
      let state = splitFile(cur);
      let d = 0;
      for (const h of sec.hunks) {
        const r = applyUnifiedHunk(state, h, d, strict, oldP!);
        state = { lines: r.lines, br: state.br, final: r.final };
        d += r.dDelta;
      }
      tree.now.set(oldP!, joinFile(state));
    };
  });
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevReplace = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const file = splitFile(cur);
      const found = findTier(oldLines, file.lines, 0, strict, false);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      let repLines: string[];
      if (found.tier === 2) {
        const F = leadingWs(file.lines[pos] ?? '');
        const P = leadingWs(oldLines[0] ?? '');
        repLines = newLines.map((t) => {
          if (t === '' || /^[ \t]*$/.test(t)) return t;
          return t.startsWith(P) ? F + t.slice(P.length) : t;
        });
      } else {
        repLines = [...newLines];
      }
      const out = [...file.lines.slice(0, pos), ...repLines, ...file.lines.slice(pos + oldLines.length)];
      tree.now.set(p, joinFile({ lines: out, br: file.br, final: file.final }));
    });
    prevPath = p;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  ops: HunkOp[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: V4AChunk[];
}

function parseV4A(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    const bodyStart = i + 1;
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) j++;
    const body = lines.slice(bodyStart, j);
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    const sec: V4ASection = { kind, path, lineNo: startLine, addLines: [], moveTo: null, chunks: [] };
    if (kind === 'add') {
      for (let k = 0; k < body.length; k++) {
        const l = body[k]!;
        if (l.startsWith('+')) sec.addLines.push(l.slice(1));
        else if (l === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      }
    } else if (kind === 'delete') {
      for (let k = 0; k < body.length; k++) {
        throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      }
    } else {
      let k = 0;
      if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
        sec.moveTo = body[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      let cur: V4AChunk | null = null;
      for (; k < body.length; k++) {
        const l = body[k]!;
        const lineNo = bodyStart + k + 1;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, ops: [], eof: false };
          sec.chunks.push(cur);
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
          cur.eof = true;
          cur = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (sec.chunks.length === 0) {
              cur = { anchor: null, ops: [], eof: false };
              sec.chunks.push(cur);
            } else {
              throw new Exit2(`error: parse ${lineNo}`);
            }
          }
          if (l === '') cur.ops.push({ kind: 'ctx', text: '' });
          else if (l[0] === ' ') cur.ops.push({ kind: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') cur.ops.push({ kind: 'old', text: l.slice(1) });
          else cur.ops.push({ kind: 'new', text: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${lineNo}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${startLine}`);
    }
    sections.push(sec);
    i = j;
  }
  return sections;
}

function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const sections = parseV4A(lines);
  return sections.map((sec): Edit => {
    if (sec.kind === 'add') {
      const p = sec.path;
      const text = sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n';
      return (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text);
      };
    }
    if (sec.kind === 'delete') {
      const p = sec.path;
      return (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const p = sec.path;
    const moveTo = sec.moveTo;
    const chunks = sec.chunks;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const file = splitFile(cur);
      let fileLines = file.lines;
      let cursor = 0;
      for (const chunk of chunks) {
        if (chunk.anchor !== null) {
          let foundAt: number | null = null;
          const tiers = strict ? [0] : [0, 1, 2];
          for (const t of tiers) {
            for (let k = cursor; k < fileLines.length; k++) {
              if (lineEq(chunk.anchor, fileLines[k]!, t)) {
                foundAt = k;
                break;
              }
            }
            if (foundAt !== null) break;
          }
          if (foundAt === null) throw new Fail('no-match', p);
          cursor = foundAt + 1;
        }
        const { O, N } = buildON(chunk.ops);
        if (O.length === 0) {
          const at = chunk.eof ? fileLines.length : cursor;
          const rep = N.map((e) => e.text);
          fileLines = [...fileLines.slice(0, at), ...rep, ...fileLines.slice(at)];
          cursor = at + rep.length;
          continue;
        }
        const found = findTier(O, fileLines, cursor, strict, chunk.eof);
        if (found === null) throw new Fail('no-match', p);
        const pos = found.occ[0]!;
        const rep = renderN(N, fileLines, pos, O, found.tier);
        fileLines = [...fileLines.slice(0, pos), ...rep, ...fileLines.slice(pos + O.length)];
        cursor = pos + rep.length;
      }
      const text = joinFile({ lines: fileLines, br: file.br, final: file.final });
      if (moveTo !== null) {
        tree.now.set(p, null);
        tree.now.set(moveTo, text);
        moves.push([p, moveTo]);
      } else {
        tree.now.set(p, text);
      }
    };
  });
}

/* ------------------------------------------------------------------ */
/* Running the CLI (SPEC.md sections 1, 2 and 10)                      */
/* ------------------------------------------------------------------ */

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
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const covered = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of moves) {
    const wasOld = tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowOld = tree.get(oldP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
