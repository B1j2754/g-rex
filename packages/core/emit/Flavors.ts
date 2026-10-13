/**
 * @fileoverview What each target regex flavor can and cannot do.
 *
 * This table is the whole point of `@flavor`: the IR is flavor-independent, so
 * every "your target cannot express this" diagnostic comes from reading a field
 * here rather than from special cases scattered through the emitter.
 *
 * The `js` row was measured against the engine, not assumed: scoped inline flags
 * (`(?i:...)`) and lookbehind are supported, `\A`/`\z`/`\R`, atomic groups and
 * possessive quantifiers are not, and a Unicode script needs the `Script=`
 * prefix that PCRE and RE2 leave optional.
 */

import type { FlavorName } from "../ir/IRNode";

export interface Flavor {
    readonly name: FlavorName;
    /** `(?>...)` atomic groups. */
    readonly atomic: boolean;
    /** `(?=...)` and `(?!...)`. */
    readonly lookahead: boolean;
    /** `(?<=...)` and `(?<!...)`. */
    readonly lookbehind: boolean;
    /** `\1` and `\k<name>`. */
    readonly backref: boolean;
    /** `\A` and `\z`. */
    readonly textAnchors: boolean;
    /** `(?i:...)` and friends, as opposed to whole-pattern flags only. */
    readonly inlineFlags: boolean;
    /** `\p{...}`. */
    readonly unicodeProps: boolean;
    /** `[a&&b]` / `[a--b]` set operations inside a class. */
    readonly classSetOps: boolean;
    /** `\R`. */
    readonly linebreakEscape: boolean;
    /** A script needs spelling `Script=Greek`, not `Greek`. */
    readonly qualifyScripts: boolean;
    /** Emitting `\p{...}` obliges the pattern to carry a Unicode flag. */
    readonly propsNeedUnicodeFlag: boolean;
}

export const FLAVORS: Record<FlavorName, Flavor> = {
    pcre: {
        name: "pcre",
        atomic: true,
        lookahead: true,
        lookbehind: true,
        backref: true,
        textAnchors: true,
        inlineFlags: true,
        unicodeProps: true,
        classSetOps: false,
        linebreakEscape: true,
        qualifyScripts: false,
        propsNeedUnicodeFlag: false,
    },
    js: {
        name: "js",
        atomic: false,
        lookahead: true,
        lookbehind: true,
        backref: true,
        textAnchors: false,
        inlineFlags: true,
        unicodeProps: true,
        classSetOps: true,
        linebreakEscape: false,
        qualifyScripts: true,
        propsNeedUnicodeFlag: true,
    },
    re2: {
        name: "re2",
        atomic: false,
        lookahead: false,
        lookbehind: false,
        backref: false,
        textAnchors: true,
        inlineFlags: true,
        unicodeProps: true,
        classSetOps: false,
        linebreakEscape: false,
        qualifyScripts: false,
        propsNeedUnicodeFlag: false,
    },
};

/**
 * Unicode property names a flavor takes bare. Anything else is treated as a
 * script, so `unicode.Greek` can be written the short way everywhere and still
 * come out as `\p{Script=Greek}` where that is required.
 */
const GENERAL_CATEGORIES = new Set([
    "C", "Cc", "Cf", "Cn", "Co", "Cs",
    "L", "LC", "Ll", "Lm", "Lo", "Lt", "Lu",
    "M", "Mc", "Me", "Mn",
    "N", "Nd", "Nl", "No",
    "P", "Pc", "Pd", "Pe", "Pf", "Pi", "Po", "Ps",
    "S", "Sc", "Sk", "Sm", "So",
    "Z", "Zl", "Zp", "Zs",
    "Other", "Control", "Format", "Unassigned", "Private_Use", "Surrogate",
    "Letter", "Cased_Letter", "Lowercase_Letter", "Modifier_Letter",
    "Other_Letter", "Titlecase_Letter", "Uppercase_Letter",
    "Mark", "Spacing_Mark", "Enclosing_Mark", "Nonspacing_Mark",
    "Number", "Decimal_Number", "Letter_Number", "Other_Number",
    "Punctuation", "Connector_Punctuation", "Dash_Punctuation",
    "Close_Punctuation", "Final_Punctuation", "Initial_Punctuation",
    "Other_Punctuation", "Open_Punctuation",
    "Symbol", "Currency_Symbol", "Modifier_Symbol", "Math_Symbol", "Other_Symbol",
    "Separator", "Line_Separator", "Paragraph_Separator", "Space_Separator",
]);

const BINARY_PROPERTIES = new Set([
    "ASCII", "ASCII_Hex_Digit", "Alphabetic", "Any", "Assigned",
    "Bidi_Control", "Bidi_Mirrored", "Case_Ignorable", "Cased",
    "Changes_When_Casefolded", "Changes_When_Casemapped",
    "Changes_When_Lowercased", "Changes_When_NFKC_Casefolded",
    "Changes_When_Titlecased", "Changes_When_Uppercased", "Dash",
    "Default_Ignorable_Code_Point", "Deprecated", "Diacritic", "Emoji",
    "Emoji_Component", "Emoji_Modifier", "Emoji_Modifier_Base",
    "Emoji_Presentation", "Extended_Pictographic", "Extender",
    "Grapheme_Base", "Grapheme_Extend", "Hex_Digit",
    "IDS_Binary_Operator", "IDS_Trinary_Operator", "ID_Continue", "ID_Start",
    "Ideographic", "Join_Control", "Logical_Order_Exception", "Lowercase",
    "Math", "Noncharacter_Code_Point", "Pattern_Syntax", "Pattern_White_Space",
    "Quotation_Mark", "Radical", "Regional_Indicator", "Sentence_Terminal",
    "Soft_Dotted", "Terminal_Punctuation", "Unified_Ideograph", "Uppercase",
    "Variation_Selector", "White_Space", "XID_Continue", "XID_Start",
]);

/** How to spell `unicode.<name>` for this flavor. */
export function propertyName(name: string, flavor: Flavor): string {
    if (!flavor.qualifyScripts) return name;
    // Already qualified, a category, or a binary property: leave it alone.
    if (name.includes("=") || GENERAL_CATEGORIES.has(name) || BINARY_PROPERTIES.has(name)) return name;
    return `Script=${name}`;
}
