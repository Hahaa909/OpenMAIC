import { createMathPlugin, type MathPlugin, type MathPluginOptions } from '@streamdown/math';
import { safeKatexOptions } from '@openmaic/dsl';

/**
 * Streamdown's math plugin with the hardened KaTeX options merged in.
 *
 * `@streamdown/math` only forwards `errorColor` to `rehype-katex`, so its
 * plugin would render with KaTeX's defaults (formula-defined macros enabled).
 * This keeps its remark side and its `rehype-katex` instance, and replaces the
 * rehype options with `safeKatexOptions(...)` of what it configured.
 *
 * `rehype-katex` spreads these options into every render, so the `macros`
 * object is shared by the formulas of one plugin instance. That is safe only
 * because every definition command is inert: no formula can write to it.
 */
export function createSafeMathPlugin(options?: MathPluginOptions): MathPlugin {
  const base = createMathPlugin(options);
  const rehype = base.rehypePlugin;
  if (
    !Array.isArray(rehype) ||
    typeof rehype[0] !== 'function' ||
    typeof rehype[1] !== 'object' ||
    rehype[1] === null
  ) {
    // Fail loudly if an upgrade changes the plugin's shape, rather than
    // silently rendering with KaTeX's defaults.
    throw new Error('@streamdown/math: unexpected rehypePlugin shape');
  }
  const [rehypeKatex, katexOptions] = rehype;
  return { ...base, rehypePlugin: [rehypeKatex, safeKatexOptions(katexOptions as object)] };
}
