/**
 * Static guard for math rendering: finds every way a source file can reach a
 * KaTeX/Temml renderer, so each one can be held to `safeKatexOptions`.
 *
 * Shapes recognized: default, aliased-default, named and namespace imports,
 * side-effect imports, `import x = require()`, re-exports, dynamic `import()`
 * and `require()`. Type-only imports and asset subpaths (CSS, fonts,
 * `package.json`) are ignored because they cannot render anything.
 */
import ts from 'typescript';

/** Modules that render math (or wire a renderer into Markdown). */
const MATH_ENGINE_RE =
  /^(?:katex|temml|rehype-katex|rehype-mathjax|remark-math|react-katex|@matejmazur\/react-katex|@streamdown\/math|markdown-it-katex|markdown-it-texmath|mathjax|mathjax-full|better-react-mathjax)(?:\/.*)?$/;
const ASSET_SUBPATH_RE = /\.(?:css|json|woff2?|ttf|otf)$/;
/** Browser-global KaTeX auto-render, injected as script text rather than imported. */
const AUTO_RENDER_TEXT_RE = /renderMathInElement|contrib\/auto-render/;

const RENDER_METHODS = new Set([
  'render',
  'renderToString',
  '__renderToDomTree',
  '__renderToHTMLTree',
]);
const DIRECT_RENDER_ENGINES = new Set(['katex', 'temml']);

export interface EngineImport {
  specifier: string;
  line: number;
  /** How it was imported, for messages. */
  shape: string;
}

function isEngine(specifier: string): boolean {
  return MATH_ENGINE_RE.test(specifier) && !ASSET_SUBPATH_RE.test(specifier);
}

function parse(fileName: string, source: string): ts.SourceFile {
  const kind = /\.tsx$|\.jsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

function stringArgument(call: ts.CallExpression): string | null {
  const [first] = call.arguments;
  return first && ts.isStringLiteralLike(first) ? first.text : null;
}

/** Every runtime import of a math engine in a file. */
export function findEngineImports(fileName: string, source: string): EngineImport[] {
  const file = parse(fileName, source);
  const found: EngineImport[] = [];
  const add = (specifier: string, node: ts.Node, shape: string) => {
    if (isEngine(specifier)) found.push({ specifier, line: lineOf(file, node), shape });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause?.isTypeOnly ||
        (clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) add(node.moduleSpecifier.text, node, clause ? 'import' : 'side-effect import');
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text, node, 'import = require');
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, node, 're-export');
    } else if (ts.isCallExpression(node)) {
      const specifier = stringArgument(node);
      if (specifier !== null) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          add(specifier, node, 'dynamic import');
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          add(specifier, node, 'require');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Whether the file injects KaTeX auto-render as script text. */
export function usesAutoRenderText(source: string): boolean {
  return AUTO_RENDER_TEXT_RE.test(source);
}

function isSafeOptionsCall(node: ts.Expression | undefined): boolean {
  return (
    !!node &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'safeKatexOptions'
  );
}

/**
 * For a file allowed to import KaTeX/Temml directly: every use of the engine
 * must be `engine.<render method>(..., safeKatexOptions(...))`, and the engine
 * may only be bound through a default or namespace import. Returns violations.
 */
export function findUnsafeRenderUses(fileName: string, source: string): string[] {
  const file = parse(fileName, source);
  const violations: string[] = [];
  const bindings = new Set<string>();

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (!isEngine(specifier)) continue;
    const clause = statement.importClause;
    if (!DIRECT_RENDER_ENGINES.has(specifier) || !clause || clause.isTypeOnly) {
      violations.push(
        `${fileName}:${lineOf(file, statement)} imports ${specifier} in an unsupported form`,
      );
      continue;
    }
    if (clause.name) bindings.add(clause.name.text);
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) bindings.add(named.name.text);
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if (element.isTypeOnly) continue;
        violations.push(
          `${fileName}:${lineOf(file, element)} binds ${element.getText(file)} from ${specifier}; use the default import`,
        );
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && bindings.has(node.text) && !isDeclarationName(node)) {
      const access = node.parent;
      const call = access?.parent;
      const ok =
        ts.isPropertyAccessExpression(access) &&
        access.expression === node &&
        RENDER_METHODS.has(access.name.text) &&
        ts.isCallExpression(call) &&
        call.expression === access &&
        isSafeOptionsCall(call.arguments[call.arguments.length - 1]);
      if (!ok) {
        violations.push(
          `${fileName}:${lineOf(file, node)} uses ${node.text} other than as a render call with safeKatexOptions(...)`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) ||
    // `typeof katex` / `katex.KatexOptions` in type positions cannot render.
    ts.isTypeQueryNode(parent) ||
    ts.isQualifiedName(parent)
  );
}
