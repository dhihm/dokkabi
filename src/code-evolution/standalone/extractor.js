// Per-file structural extraction using the TypeScript compiler AST.
// Each file is parsed in isolation (ts.createSourceFile), which is what makes
// targeted incremental updates cheap: only changed files are ever re-parsed.

import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { redactSecrets } from './security.js';

const SCRIPT_KINDS = {
  '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
};

export const LANGUAGE = { '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx' };

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function shortHash(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function hasExportModifier(node) {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node) || [];
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function hasModifier(node, kind) {
  if (!ts.canHaveModifiers(node)) return false;
  return (ts.getModifiers(node) || []).some((m) => m.kind === kind);
}

function isFunctionLike(expr) {
  return expr && (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr));
}

function unwrap(expr) {
  while (expr && (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression?.(expr))) {
    expr = expr.expression;
  }
  return expr;
}

function truncate(text, max = 160) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Analyze one source file.
 * @param {string} relPath root-relative posix path
 * @param {string} text file content
 * @param {string} fileUid stable file identity (survives renames)
 */
export function analyzeSource(relPath, text, fileUid) {
  // Redact before AST construction so computed names, import specifiers,
  // diagnostics and every other graph field receive the same protection as
  // persisted source blobs. The engine retains the original hash separately.
  text = redactSecrets(text);
  const ext = path.posix.extname(relPath).toLowerCase();
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[ext] ?? ts.ScriptKind.TS);
  const fileId = `file:${fileUid}`;
  const symbols = [];
  const imports = [];
  const idCounts = new Map();

  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos);

  function addSymbol(kind, role, name, qualifiedName, node, parentId, extra = {}) {
    const base = `sym:${fileUid}#${qualifiedName}`;
    const n = (idCounts.get(base) || 0) + 1;
    idCounts.set(base, n);
    const id = n === 1 ? base : `${base}~${n}`;
    const start = node.getStart(sf);
    const end = node.getEnd();
    const s = lineOf(start);
    const e = lineOf(end);
    symbols.push({
      id, kind, role, name, qualifiedName,
      parent: parentId,
      fileId,
      line: s.line + 1, column: s.character + 1, endLine: e.line + 1,
      bodyHash: shortHash(text.slice(start, end)),
      ...extra,
    });
    return id;
  }

  // Signatures are stored in snapshots, so they never include default-value
  // expressions (which may hold literals such as keys); types are kept, then
  // the result is passed through secret redaction as a second line of defense.
  function paramText(p) {
    const mods = ts.canHaveModifiers(p) ? (ts.getModifiers(p) || []).map((m) => m.getText(sf)).join(' ') : '';
    const rest = p.dotDotDotToken ? '...' : '';
    const opt = p.questionToken ? '?' : '';
    const type = p.type ? `: ${p.type.getText(sf)}` : '';
    const init = p.initializer ? ' = …' : '';
    return `${mods ? `${mods} ` : ''}${rest}${p.name.getText(sf)}${opt}${type}${init}`;
  }

  function signatureOf(fn, name) {
    const params = (fn.parameters || []).map(paramText).join(', ');
    const ret = fn.type ? `: ${fn.type.getText(sf)}` : '';
    const asyncKw = hasModifier(fn, ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
    return truncate(redactSecrets(`${asyncKw}${name}(${params})${ret}`));
  }

  function addFunction(role, name, qualified, node, fnNode, parentId, exported, extra = {}) {
    return addSymbol('function', role, name, qualified, node, parentId, {
      exported,
      async: hasModifier(fnNode, ts.SyntaxKind.AsyncKeyword),
      signature: signatureOf(fnNode, name),
      ...extra,
    });
  }

  function memberName(member) {
    if (!member.name) return 'anonymous';
    if (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)) {
      return member.name.text;
    }
    return member.name.getText(sf);
  }

  function addClass(name, qualified, node, classNode, parentId, exported) {
    const heritage = redactSecrets((classNode.heritageClauses || []).map((h) => h.getText(sf)).join(' '));
    const classId = addSymbol('class', 'class', name, qualified, node, parentId, {
      exported,
      abstract: hasModifier(classNode, ts.SyntaxKind.AbstractKeyword),
      signature: truncate(`class ${name}${heritage ? ` ${heritage}` : ''}`),
      memberCount: classNode.members.length,
    });
    for (const m of classNode.members) {
      const isStatic = hasModifier(m, ts.SyntaxKind.StaticKeyword);
      if (ts.isConstructorDeclaration(m)) {
        addFunction('constructor', 'constructor', `${qualified}.constructor`, m, m, classId, false);
      } else if (ts.isMethodDeclaration(m)) {
        const n = memberName(m);
        addFunction('method', n, `${qualified}.${n}`, m, m, classId, false, { static: isStatic });
      } else if (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
        const n = `${ts.isGetAccessorDeclaration(m) ? 'get' : 'set'} ${memberName(m)}`;
        addFunction('accessor', n, `${qualified}.${n}`, m, m, classId, false);
      } else if (ts.isPropertyDeclaration(m) && isFunctionLike(unwrap(m.initializer))) {
        const n = memberName(m);
        addFunction('method', n, `${qualified}.${n}`, m, unwrap(m.initializer), classId, false);
      }
    }
    return classId;
  }

  function cjsExportName(left) {
    // module.exports = ..., module.exports.x = ..., exports.x = ...
    const t = left.getText(sf);
    if (t === 'module.exports') return 'default';
    const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(t);
    return m ? m[1] : null;
  }

  function collectSymbols(statements, parentId, prefix) {
    for (const st of statements) {
      const exported = hasExportModifier(st);
      if (ts.isFunctionDeclaration(st)) {
        const name = st.name ? st.name.text : 'default';
        addFunction('function', name, prefix + name, st, st, parentId, exported);
      } else if (ts.isClassDeclaration(st)) {
        const name = st.name ? st.name.text : 'default';
        addClass(name, prefix + name, st, st, parentId, exported);
      } else if (ts.isVariableStatement(st)) {
        for (const decl of st.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const init = unwrap(decl.initializer);
          const name = decl.name.text;
          if (isFunctionLike(init)) addFunction('function', name, prefix + name, decl, init, parentId, exported);
          else if (init && ts.isClassExpression(init)) addClass(name, prefix + name, decl, init, parentId, exported);
        }
      } else if (ts.isExportAssignment(st)) {
        const expr = unwrap(st.expression);
        if (isFunctionLike(expr)) addFunction('function', 'default', `${prefix}default`, st, expr, parentId, true);
        else if (expr && ts.isClassExpression(expr)) addClass(expr.name?.text || 'default', `${prefix}default`, st, expr, parentId, true);
      } else if (ts.isModuleDeclaration(st) && st.body && ts.isModuleBlock(st.body) && ts.isIdentifier(st.name)) {
        collectSymbols(st.body.statements, parentId, `${prefix}${st.name.text}.`);
      } else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression)
        && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const name = cjsExportName(st.expression.left);
        const right = unwrap(st.expression.right);
        if (name && isFunctionLike(right)) addFunction('function', name, prefix + name, st, right, parentId, true);
        else if (name && right && ts.isClassExpression(right)) addClass(name, prefix + name, st, right, parentId, true);
      }
    }
  }

  function pushImport(kind, specNode, extra = {}) {
    if (!specNode || !ts.isStringLiteralLike(specNode)) return;
    imports.push({ kind, specifier: specNode.text, line: lineOf(specNode.getStart(sf)).line + 1, ...extra });
  }

  function collectImports(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const names = [];
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) names.push(`* as ${clause.namedBindings.name.text}`);
        else for (const el of clause.namedBindings.elements) names.push(el.name.text);
      }
      pushImport('import', node.moduleSpecifier, { names, typeOnly: Boolean(clause?.isTypeOnly) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      pushImport('re-export', node.moduleSpecifier, { typeOnly: Boolean(node.isTypeOnly) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      pushImport('import-equals', node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) pushImport('dynamic', node.arguments[0]);
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') pushImport('require', node.arguments[0]);
    }
    ts.forEachChild(node, collectImports);
  }

  collectSymbols(sf.statements, fileId, '');
  collectImports(sf);

  const diagnostics = (sf.parseDiagnostics || []).map((d) => {
    const pos = lineOf(d.start ?? 0);
    return {
      source: 'parse',
      severity: d.category === ts.DiagnosticCategory.Warning ? 'warning' : 'error',
      code: `TS${d.code}`,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      line: pos.line + 1,
      column: pos.character + 1,
    };
  });

  return {
    language: LANGUAGE[ext] || 'ts',
    lines: sf.getLineStarts().length,
    symbols,
    imports,
    diagnostics,
  };
}
