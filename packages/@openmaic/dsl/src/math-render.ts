/**
 * Hardened render options for KaTeX (and Temml, which shares KaTeX's macro
 * engine and option names).
 *
 * Both engines let a formula define its own macros (`\def`, `\newcommand`,
 * `\let`, ...). Combined with nesting, a short formula can then expand into an
 * output many orders of magnitude larger than itself, and the `maxExpand`
 * budget alone does not keep that cheap. Formulas in this product come from
 * imported documents, model output, and user edits, so every render goes
 * through {@link safeKatexOptions}:
 *
 * - every macro-defining command is replaced by an inert macro that consumes
 *   the definition without registering anything. A formula that then uses the
 *   undefined name fails like any other unknown command (rendered as an error
 *   span or thrown, depending on the caller's `throwOnError`);
 * - `trust` is forced to `false`;
 * - `maxExpand` is pinned explicitly. With definitions disabled, expansion is
 *   linear in the input length, so this is a backstop rather than the guard.
 *   It must stay high enough for long formulas that lean on built-in macros
 *   (`\neq`, `\iff`, `\dots`, `\,`, ... each cost several expansions).
 *
 * Caller-supplied macros are trusted code: a function macro receives the
 * engine's macro context and could define macros through it. Never build
 * `macros` from content (a document, a model response, user input).
 *
 * The engines write `\gdef`-style results into the `macros` object they are
 * given, so a fresh object is built on every call and never shared.
 *
 * This module is dependency-free on purpose: it lives in the DSL package
 * because that is the one package every renderer, importer, editor, and the
 * app already depend on, and it only produces a plain options object.
 */

/** A macro value accepted by KaTeX and Temml: replacement text or a function. */
export type MathMacroExpansion = string | ((context: object) => string);

/** The `macros` option shape produced by {@link safeKatexOptions}. */
export type MathMacros = Record<string, MathMacroExpansion>;

/** The options {@link safeKatexOptions} always sets, overriding the caller. */
export interface MathRenderHardening {
  trust: false;
  maxExpand: number;
  macros: MathMacros;
}

/**
 * Expansion budget per render. KaTeX's and Temml's own default, pinned so a
 * library upgrade cannot change it silently.
 */
export const SAFE_MATH_MAX_EXPAND = 1000;

/** The commands that let a formula define or alias a macro. */
export const MATH_MACRO_DEFINITION_COMMANDS = [
  '\\def',
  '\\gdef',
  '\\edef',
  '\\xdef',
  '\\global',
  '\\long',
  '\\let',
  '\\futurelet',
  '\\newcommand',
  '\\renewcommand',
  '\\providecommand',
] as const;

/** The subset of the engines' macro context the inert macros rely on. */
interface MacroToken {
  text: string;
}
interface MacroContext {
  future(): MacroToken;
  popToken(): MacroToken;
  consumeSpaces(): void;
  consumeArg(): { tokens: MacroToken[] };
}

const END = 'EOF';

function atEnd(context: MacroContext): boolean {
  return context.future().text === END;
}

/** `\def<cs><parameter text>{<body>}`: drop the name, parameters, and body. */
function swallowDef(raw: object): string {
  const context = raw as MacroContext;
  if (!atEnd(context)) context.popToken();
  while (!atEnd(context) && context.future().text !== '{') context.popToken();
  if (!atEnd(context)) context.consumeArg();
  return '';
}

/** Drop one `[...]` group from the input; braces inside it are balanced. */
function skipBracketGroup(context: MacroContext): void {
  context.popToken(); // `[`
  let depth = 0;
  while (!atEnd(context)) {
    const text = context.future().text;
    if (text === ']' && depth === 0) {
      context.popToken();
      return;
    }
    if (text === '{') depth += 1;
    if (text === '}') depth = Math.max(0, depth - 1);
    context.popToken();
  }
}

/**
 * `\newcommand*{<cs>}[<n>][<default>]{<body>}`: drop all of it.
 *
 * Optional groups are recognized only from an unconsumed `[` token, so a body
 * written as `{[}` stays a body. Exactly one replacement body is consumed.
 */
function swallowNewcommand(raw: object): string {
  const context = raw as MacroContext;
  context.consumeSpaces();
  if (context.future().text === '*') context.popToken();
  context.consumeArg(); // the command name, braced or not
  for (let groups = 0; groups < 2; groups += 1) {
    context.consumeSpaces();
    if (context.future().text !== '[') break;
    skipBracketGroup(context);
  }
  context.consumeArg(); // the replacement body
  return '';
}

/** `\let<cs>=<token>`: drop the name, the optional `=`, and the target. */
function swallowLet(raw: object): string {
  const context = raw as MacroContext;
  if (atEnd(context)) return '';
  context.popToken();
  context.consumeSpaces();
  if (context.future().text === '=') {
    context.popToken();
    if (context.future().text === ' ') context.popToken();
  }
  if (!atEnd(context)) context.popToken();
  return '';
}

/** `\futurelet<cs><a><b>`: drop the name; `<a><b>` render as usual. */
function swallowFuturelet(raw: object): string {
  const context = raw as MacroContext;
  if (!atEnd(context)) context.popToken();
  return '';
}

const INERT_DEFINITIONS: Readonly<
  Record<(typeof MATH_MACRO_DEFINITION_COMMANDS)[number], MathMacroExpansion>
> = {
  '\\def': swallowDef,
  '\\gdef': swallowDef,
  '\\edef': swallowDef,
  '\\xdef': swallowDef,
  // Prefixes: dropping them leaves the following definition to be swallowed.
  '\\global': '',
  '\\long': '',
  '\\let': swallowLet,
  '\\futurelet': swallowFuturelet,
  '\\newcommand': swallowNewcommand,
  '\\renewcommand': swallowNewcommand,
  '\\providecommand': swallowNewcommand,
};

/**
 * Merge hardened settings into a caller's KaTeX/Temml options.
 *
 * Every other option (`displayMode`, `output`, `throwOnError`, `strict`, ...)
 * is kept. Caller-supplied `macros` are kept too, but cannot override the
 * inert definitions, and are copied into a fresh object so the caller's own
 * object is never written to. A caller may lower `maxExpand`, not raise it.
 * Caller macros are trusted code (see the module note): never pass macros
 * derived from content.
 */
export function safeKatexOptions<const T extends object = Record<never, never>>(
  options?: T,
): Omit<T, keyof MathRenderHardening> & MathRenderHardening {
  const input = (options ?? {}) as T & {
    macros?: MathMacros;
    maxExpand?: number;
  };
  const requested = input.maxExpand;
  return {
    ...input,
    trust: false,
    maxExpand:
      typeof requested === 'number' && requested >= 0
        ? Math.min(requested, SAFE_MATH_MAX_EXPAND)
        : SAFE_MATH_MAX_EXPAND,
    macros: { ...input.macros, ...INERT_DEFINITIONS },
  };
}
