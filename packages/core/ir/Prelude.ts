/**
 * @fileoverview The prelude: the built-in names, which are bindings rather than
 * keywords and so may be shadowed by any `let` or `def` parameter.
 *
 * `letter` and `word` depend on `@flags unicode`, because ASCII definitions make
 * `letter & unicode.Greek` the empty set — which is not what anyone writing that
 * line meant.
 */

import type { AnchorKind } from "./IRNode";
import { type CharSet, type Range, prop, ranges } from "./CharSet";

export type PreludeBinding =
    | { readonly kind: "class"; readonly set: CharSet }
    | { readonly kind: "any" }
    | { readonly kind: "anchor"; readonly at: AnchorKind }
    /** `unicode`, whose members are Unicode properties: `unicode.Greek`. */
    | { readonly kind: "namespace" };

const r = (...pairs: Range[]): CharSet => ranges(pairs);
const cp = (ch: string): number => ch.codePointAt(0)!;

/** `[0-9]`, which the emitter prints as `\d`. */
export const DIGIT: CharSet = r([cp("0"), cp("9")]);

/** `[A-Za-z0-9_]`, which the emitter prints as `\w`. */
export const WORD_ASCII: CharSet = r(
    [cp("0"), cp("9")],
    [cp("A"), cp("Z")],
    [cp("_"), cp("_")],
    [cp("a"), cp("z")],
);

/** Exactly what `\s` means in JS and PCRE, so the emitter can print it back. */
export const SPACE: CharSet = r(
    [0x09, 0x0d],
    [0x20, 0x20],
    [0xa0, 0xa0],
    [0x1680, 0x1680],
    [0x2000, 0x200a],
    [0x2028, 0x2029],
    [0x202f, 0x202f],
    [0x205f, 0x205f],
    [0x3000, 0x3000],
    [0xfeff, 0xfeff],
);

const LETTER_ASCII: CharSet = r([cp("A"), cp("Z")], [cp("a"), cp("z")]);

/**
 * The prelude bindings for a file. `unicode` widens `letter` to `\p{L}`; `word`
 * stays ASCII because that is what `\w` means in every target flavor, unicode
 * flag or not.
 */
export function prelude(unicode: boolean): Map<string, PreludeBinding> {
    const cls = (set: CharSet): PreludeBinding => ({ kind: "class", set });
    const anchor = (at: AnchorKind): PreludeBinding => ({ kind: "anchor", at });

    return new Map<string, PreludeBinding>([
        ["digit", cls(DIGIT)],
        ["letter", cls(unicode ? prop("L") : LETTER_ASCII)],
        ["word", cls(WORD_ASCII)],
        ["space", cls(SPACE)],

        ["any", { kind: "any" }],

        ["start", anchor("lineStart")],
        ["end", anchor("lineEnd")],
        ["textStart", anchor("textStart")],
        ["textEnd", anchor("textEnd")],
        ["wordBoundary", anchor("wordBoundary")],
        ["notWordBoundary", anchor("notWordBoundary")],
        ["linebreak", anchor("linebreak")],

        ["unicode", { kind: "namespace" }],
    ]);
}
