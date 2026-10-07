// Assembles the whole-repository graph from cached per-file analyses.
// Parsing is per file and incremental; assembly (import resolution, module
// grouping, layout) is a cheap linear pass over cached results.

import path from 'node:path';

const RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_TO_TS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
export const EXTERNAL_MODULE_ID = 'mod:~external';

export function moduleIdForPath(relPath) {
  return `mod:${path.posix.dirname(relPath)}`;
}

export function packageName(spec) {
  if (spec.startsWith('node:')) return spec.split('/')[0];
  const parts = spec.split('/');
  return spec.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** Resolve an import specifier against the set of known root-relative files. */
export function resolveSpecifier(fromPath, spec, fileSet) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return { external: packageName(spec) };
  if (spec.startsWith('/')) return { unresolved: true, reason: 'absolute import paths are outside the watched root' };
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), spec));
  if (base === '..' || base.startsWith('../')) return { unresolved: true, reason: 'import escapes the watched root' };
  const candidates = [base];
  const ext = path.posix.extname(base);
  if (JS_TO_TS[ext]) for (const t of JS_TO_TS[ext]) candidates.push(base.slice(0, -ext.length) + t);
  for (const e of RESOLVE_EXTS) candidates.push(base + e);
  for (const e of RESOLVE_EXTS) candidates.push(`${base}/index${e}`);
  for (const c of candidates) if (fileSet.has(c)) return { path: c };
  return { unresolved: true, reason: `cannot resolve '${spec}'` };
}

/**
 * @param {Map<string, {uid:string, hash:string, size:number, analysis:object}>} files keyed by path
 * @param {import('./layout.js').LayoutManager} layout
 */
export function assembleGraph(files, layout) {
  const fileSet = new Set(files.keys());
  const pathToFileId = new Map();
  for (const [p, rec] of files) pathToFileId.set(p, `file:${rec.uid}`);

  const modules = new Map();
  const fileNodes = [];
  const symbolNodes = [];
  const symbolsByFile = new Map();
  const externals = new Map();
  const edges = new Map();
  const diagnostics = [];

  const sortedPaths = [...files.keys()].sort();
  for (const p of sortedPaths) {
    const rec = files.get(p);
    const a = rec.analysis;
    const fileId = `file:${rec.uid}`;
    const modId = moduleIdForPath(p);
    const dir = path.posix.dirname(p);
    if (!modules.has(modId)) {
      modules.set(modId, { id: modId, kind: 'module', name: dir === '.' ? '(root)' : dir, path: dir, fileCount: 0, symbolCount: 0, diagnosticCount: 0 });
    }
    const mod = modules.get(modId);
    mod.fileCount++;
    mod.symbolCount += a.symbols.length;

    const fileDiags = a.diagnostics.map((d) => ({ ...d, path: p, fileId }));
    const syms = a.symbols.map((s) => ({ ...s, path: p }));
    symbolNodes.push(...syms);
    symbolsByFile.set(fileId, syms);

    for (const imp of a.imports) {
      const r = resolveSpecifier(p, imp.specifier, fileSet);
      let target;
      if (r.external) {
        target = `ext:${r.external}`;
        if (!externals.has(target)) {
          externals.set(target, { id: target, kind: 'external', name: r.external, path: r.external, parent: EXTERNAL_MODULE_ID, importerCount: 0 });
        }
      } else if (r.path) {
        target = pathToFileId.get(r.path);
      } else {
        fileDiags.push({
          source: 'resolve', severity: 'warning', code: 'UNRESOLVED_IMPORT',
          message: `Unresolved import: ${r.reason}`, line: imp.line, column: 1, path: p, fileId,
        });
        continue;
      }
      if (target === fileId) continue;
      const edgeId = `imp:${fileId}->${target}`;
      let e = edges.get(edgeId);
      if (!e) {
        e = { id: edgeId, kind: 'imports', source: fileId, target, specifiers: [], importKinds: [], typeOnly: true };
        edges.set(edgeId, e);
        if (externals.has(target)) externals.get(target).importerCount++;
      }
      if (!e.specifiers.includes(imp.specifier)) e.specifiers.push(imp.specifier);
      if (!e.importKinds.includes(imp.kind)) e.importKinds.push(imp.kind);
      e.typeOnly = e.typeOnly && Boolean(imp.typeOnly);
    }

    mod.diagnosticCount += fileDiags.length;
    diagnostics.push(...fileDiags);
    fileNodes.push({
      id: fileId, kind: 'file', name: path.posix.basename(p), path: p, parent: modId,
      uid: rec.uid, contentHash: rec.hash, size: rec.size, lines: a.lines, language: a.language,
      symbolCount: a.symbols.length, importCount: a.imports.length,
      diagnosticCount: fileDiags.length,
      errorCount: fileDiags.filter((d) => d.severity === 'error').length,
    });
  }

  if (externals.size) {
    modules.set(EXTERNAL_MODULE_ID, {
      id: EXTERNAL_MODULE_ID, kind: 'module', name: 'external packages', path: '~external', external: true,
      fileCount: externals.size, symbolCount: 0, diagnosticCount: 0,
    });
  }
  const externalNodes = [...externals.values()].sort((a, b) => a.id.localeCompare(b.id));
  const moduleNodes = [...modules.values()].sort((a, b) => a.id.localeCompare(b.id));

  const boxes = layout.apply(moduleNodes, [...fileNodes, ...externalNodes], symbolsByFile);
  const place = (n) => Object.assign(n, boxes.get(n.id));
  const nodes = [...moduleNodes, ...fileNodes, ...externalNodes, ...symbolNodes].map(place);
  nodes.sort((a, b) => a.id.localeCompare(b.id));

  return {
    nodes,
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics,
  };
}
