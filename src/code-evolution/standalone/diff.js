// Line diff (Myers O(ND)) with unified hunks, plus structural graph diffs.

const MAX_EDIT_DISTANCE = 4000;

export function splitLines(text) {
  if (text === '' || text == null) return [];
  const lines = String(text).split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  let v = new Map([[1, 0]]);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) return null;
    trace.push(v);
    const next = new Map(v);
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) ? v.get(k + 1) : v.get(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      next.set(k, x);
      if (x >= n && y >= m) {
        trace.push(next);
        return backtrack(trace, a, b);
      }
    }
    v = next;
  }
  return null;
}

function backtrack(trace, a, b) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 2; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) ? k + 1 : k - 1;
    const prevX = v.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ t: ' ', a: x - 1, b: y - 1 }); x--; y--; }
    if (d > 0) {
      if (x === prevX) ops.push({ t: '+', b: y - 1 });
      else ops.push({ t: '-', a: x - 1 });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** Returns line operations: {t:' '|'-'|'+', a?:index, b?:index}. */
export function diffLineOps(aLines, bLines) {
  let start = 0;
  while (start < aLines.length && start < bLines.length && aLines[start] === bLines[start]) start++;
  let endA = aLines.length;
  let endB = bLines.length;
  while (endA > start && endB > start && aLines[endA - 1] === bLines[endB - 1]) { endA--; endB--; }
  const midA = aLines.slice(start, endA);
  const midB = bLines.slice(start, endB);
  let mid = myers(midA, midB);
  if (!mid) mid = [...midA.map((_, i) => ({ t: '-', a: i })), ...midB.map((_, i) => ({ t: '+', b: i }))];
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ t: ' ', a: i, b: i });
  for (const op of mid) ops.push({ t: op.t, a: op.a === undefined ? undefined : op.a + start, b: op.b === undefined ? undefined : op.b + start });
  for (let i = 0; i < aLines.length - endA; i++) ops.push({ t: ' ', a: endA + i, b: endB + i });
  return ops;
}

/**
 * Unified diff hunks. Line numbers are 1-based and offset by `aOffset`/`bOffset`
 * (useful when diffing a symbol's text that starts mid-file).
 */
export function diffText(aText, bText, { context = 3, aOffset = 0, bOffset = 0 } = {}) {
  const a = splitLines(aText);
  const b = splitLines(bText);
  const ops = diffLineOps(a, b);
  const rows = ops.map((op) => ({
    t: op.t,
    a: op.a === undefined ? null : op.a + 1 + aOffset,
    b: op.b === undefined ? null : op.b + 1 + bOffset,
    text: op.t === '+' ? b[op.b] : a[op.a],
  }));
  const added = rows.filter((r) => r.t === '+').length;
  const removed = rows.filter((r) => r.t === '-').length;
  const hunks = [];
  let current = null;
  let lastChange = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].t === ' ') continue;
    const from = Math.max(0, i - context);
    if (current && from <= lastChange + context + 1) {
      for (let j = current.endIndex + 1; j <= i; j++) current.rows.push(rows[j]);
      current.endIndex = i;
    } else {
      if (current) hunks.push(current);
      current = { rows: rows.slice(from, i + 1), endIndex: i };
    }
    lastChange = i;
  }
  if (current) hunks.push(current);
  const finished = hunks.map((h) => {
    const tail = rows.slice(h.endIndex + 1, Math.min(rows.length, h.endIndex + 1 + context));
    const all = [...h.rows, ...tail];
    const first = all[0];
    return {
      aStart: first.a ?? (all.find((r) => r.a !== null)?.a ?? aOffset),
      bStart: first.b ?? (all.find((r) => r.b !== null)?.b ?? bOffset),
      aLines: all.filter((r) => r.t !== '+').length,
      bLines: all.filter((r) => r.t !== '-').length,
      rows: all,
    };
  });
  return { added, removed, hunks: finished, identical: added === 0 && removed === 0 };
}

function nodeFingerprint(n) {
  if (n.kind === 'file') return n.contentHash;
  if (n.kind === 'class' || n.kind === 'function') return `${n.bodyHash}|${n.signature || ''}|${n.exported ? 1 : 0}`;
  return null; // modules/externals: membership changes are reported via files/edges
}

function diagKey(d) {
  return `${d.fileId}|${d.source}|${d.code}|${d.message}`;
}

const ghost = (n) => ({ id: n.id, kind: n.kind, role: n.role, name: n.name, qualifiedName: n.qualifiedName, path: n.path, parent: n.parent, x: n.x, y: n.y, w: n.w, h: n.h, hidden: n.hidden });

/**
 * Structural changes between two graphs. `fileEvents` comes from the engine so
 * renames are reported explicitly instead of as delete+add.
 */
export function structuralChanges(prev, next, fileEvents) {
  const prevNodes = new Map((prev?.nodes || []).map((n) => [n.id, n]));
  const nextNodes = new Map(next.nodes.map((n) => [n.id, n]));
  const added = [];
  const removed = [];
  const modified = [];
  const moved = [];
  for (const [id, n] of nextNodes) {
    const p = prevNodes.get(id);
    if (!p) { added.push(id); continue; }
    if (nodeFingerprint(p) !== nodeFingerprint(n)) modified.push(id);
    if (p.path !== n.path && n.kind !== 'module' && n.kind !== 'external') moved.push({ id, from: p.path, to: n.path });
  }
  for (const [id, p] of prevNodes) if (!nextNodes.has(id)) removed.push(ghost(p));

  const prevEdges = new Set((prev?.edges || []).map((e) => e.id));
  const nextEdges = new Set(next.edges.map((e) => e.id));
  const prevDiag = new Set((prev?.diagnostics || []).map(diagKey));
  const nextDiag = new Set(next.diagnostics.map(diagKey));

  return {
    initial: !prev,
    files: fileEvents,
    nodes: { added, removed, modified, moved },
    edges: {
      added: [...nextEdges].filter((e) => !prevEdges.has(e)),
      removed: [...prevEdges].filter((e) => !nextEdges.has(e)),
    },
    diagnostics: {
      introduced: [...nextDiag].filter((k) => !prevDiag.has(k)).length,
      resolved: [...prevDiag].filter((k) => !nextDiag.has(k)).length,
      total: next.diagnostics.length,
    },
  };
}
