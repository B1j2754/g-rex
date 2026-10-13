/** 
 * @fileoverview Token definitions for g-rex lexer
 */

// --- Token Types ---
export const KwardTokType = {
    // Declarations
    Pattern: "pattern", // Define new pattern
    Let: "let", // Define reusable sub pattern
    Def: "def", // Define function sub pattern

    // Test
    Test: "test", // Define test
    Match: "match",
    Reject: "reject",

    // Grouping
    Capture: "capture", // Capture group into identifier name
    Either: "either", // Match either of the inputs, checking l->r

    // Quantifiers
    Optional: "optional", // Optionall match the input
    Repeat: "repeat", // Repeatedly match input

    // Repeat-modes
    Greedy: "greedy", // Match as much of the pattern as possible
    Lazy: "lazy", // Match as little of the pattern as possible
    Atomic: "atomic", // Match and prevent backtracking

    // Lookaround
    Ahead: "ahead", // Match where a certain pattern is ahead
    NotAhead: "notAhead", // Match where a certain pattern is NOT ahead
    Behind: "behind", // Match where a certain pattern is behind
    NotBehind: "notBehind", // Match where a certain pattern is NOT behind

    // Operators
    Not: "not",
    Ref: "ref",

    // Flags
    IgnoreCase: "ignoreCase",
    ByLine: "byLine",
    DotAll: "dotAll",
} as const;

export const SymbolTokType = {
    // Grouping symbols
    BracketOpen: "[", BracketClose: "]", // Character-set constructor
    BraceOpen: "{", BraceClose: "}", // Sequence
    ParenOpen: "(", ParenClose: ")", // Precedence grouping, param list, call args

    // Operators
    Dot: ".", // Member access: `unicode.Greek`
    DotDot: "..", // Range: `'a'..'f'`, `2..5`
    Plus: "+", // Set union
    Minus: "-", // Set differences
    Ampersand: "&", // Set intersections
    Pipe: "|", // Branch seperator inside `either`
    Equals: "=", // Binds a `let` or `def` body
    Colon: ":",
    Comma: ",", // Separates set members and capture assertions
    AtSymbol: "@", // Directive prefix

    // Misc
    Backslash: "\\", // Escape char
} as const;

export const MiscTokType = {
    // Comments
    CommentSingle: "CommentSingle",
    CommentMulti: "CommentMulti",
    CommentDoc: "CommentDoc",

    // Literals. The three quote styles mean three different things, so they
    // stay three token types: "text" is literal text, 'c' is one character
    // (the only thing a range endpoint may be), `raw` is verbatim regex.
    String: "String",
    Char: "Char",
    Raw: "Raw",
    Number: "Number",
    Identifier: "Identifier",

    // Error
    ErrorTok: "ErrorTok",
} as const;

export type KwardTokType = typeof KwardTokType[keyof typeof KwardTokType];
export type MiscTokType = typeof MiscTokType[keyof typeof MiscTokType];
export type SymbolTokType = typeof SymbolTokType[keyof typeof SymbolTokType];

export type TokType = SymbolTokType | KwardTokType | MiscTokType;

export const Keywords = new Set<string>(Object.values(KwardTokType));
export const Symbols = new Set<string>(Object.values(SymbolTokType));

// --- Token Structure ---
export interface TokInfo {
    type: TokType;
    value: string;
}

export interface TokPos {
    line: number;
    column: number;
}

export interface Tok {
    info: TokInfo;
    start: TokPos;
    end: TokPos;
}
