/**
 * Short formulas that define their own macros so that their expansion grows
 * far beyond the input size while staying inside the default expansion budget.
 * Used to check that every math render path disables user macro definitions.
 */

const LEAF = 'x'.repeat(400);
const times = (name: string, count: number) => `\\${name}`.repeat(count);

export const MACRO_EXPANSION_INPUTS: Readonly<Record<string, string>> = {
  /** Two levels of `\def` with a thirty-way fan-out over a long leaf. */
  nestedDef: `\\def\\ma{${LEAF}}\\def\\mb{${times('ma', 30)}}\\def\\mc{${times('mb', 30)}}\\mc`,
  /** The same shape written with `\newcommand` and `\providecommand`. */
  nestedNewcommand: `\\newcommand{\\ma}{${LEAF}}\\newcommand{\\mb}{${times('ma', 30)}}\\providecommand{\\mc}{${times('mb', 30)}}\\mc`,
  /** Global definitions via `\gdef`, `\global\def`, and `\xdef`. */
  nestedGdef: `\\gdef\\ma{${LEAF}}\\global\\def\\mb{${times('ma', 30)}}\\xdef\\md{y}\\gdef\\mc{${times('mb', 30)}}\\mc`,
  /** `\let` aliasing a defined macro, then fanning out through the alias. */
  letAlias: `\\def\\ma{${LEAF}}\\let\\mb\\ma\\let\\mc=\\mb \\providecommand{\\md}{${times('mc', 30)}}\\def\\me{${times('md', 30)}}\\me`,
  /** A flat repetition of one defined macro. */
  flatDef: `\\def\\ma{${LEAF}}${times('ma', 300)}`,
};
