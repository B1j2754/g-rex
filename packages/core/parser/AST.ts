/**
 * @fileoverview AST node interfaces for the g-rex parser.
 *
 * The tree is source-shaped: it records what was written, not what it means.
 * Names stay unresolved, `def` calls stay uncalled and set algebra stays
 * unevaluated until the lowering pass in `ir/`.
 */

import type { TokPos } from "../lexer/Token";

/** Source range, `end` exclusive, matching `Tok`. */
export interface Span {
    readonly start: TokPos;
    readonly end: TokPos;
}

export interface NodeBase {
    readonly kind: string;
    readonly span: Span;
}

// --- Basic Nodes ---
export interface Identifier extends NodeBase {
    readonly kind: "Identifier";
    readonly text: string;
}

export interface DocComment extends NodeBase {
    readonly kind: "DocComment";
    readonly text: string;
}

// --- Program Nodes ---
export interface Program extends NodeBase {
    readonly kind: "Program";
    readonly directives: readonly Directive[];
    readonly declarations: readonly Decl[];
}

export interface Directive extends NodeBase {
    readonly kind: "Directive";
    readonly name: Identifier;
    readonly args: readonly Identifier[];
}

// --- Declarations ---
export type Decl = LetDecl | DefDecl | PatternDecl | TestDecl;

export interface LetDecl extends NodeBase {
    readonly kind: "LetDecl";
    readonly docs: DocComment | null;
    readonly name: Identifier;
    readonly body: Expr;
}

export interface DefDecl extends NodeBase {
    readonly kind: "DefDecl";
    readonly docs: DocComment | null;
    readonly name: Identifier;
    readonly params: readonly Param[];
    readonly body: Expr;
}

export interface Param extends NodeBase {
    readonly kind: "Param";
    readonly name: Identifier;
}

export interface PatternDecl extends NodeBase {
    readonly kind: "PatternDecl";
    readonly docs: DocComment | null;
    readonly name: Identifier;
    readonly body: Sequence;
}

export interface TestDecl extends NodeBase {
    readonly kind: "TestDecl";
    readonly docs: DocComment | null;
    /** The pattern under test. */
    readonly name: Identifier;
    readonly cases: readonly TestCase[];
}

export interface TestCase extends NodeBase {
    readonly kind: "TestCase";
    readonly mode: "match" | "reject";
    readonly subject: RawLit;
    /** Always empty for `reject`. */
    readonly captures: readonly CaptureAssert[];
}

export interface CaptureAssert extends NodeBase {
    readonly kind: "CaptureAssert";
    readonly name: Identifier;
    readonly text: RawLit;
}

// --- Expressions ---
export type Expr =
    | Sequence
    | Group
    | SetLit
    | Range
    | StringLit
    | CharLit
    | RawLit
    | NumberLit
    | Algebra
    | Capture
    | Either
    | Optional
    | Repeat
    | Lookaround
    | FlagScope
    | Not
    | Backref
    | NameRef;

/** `{ a b c }` — matches its items in order. */
export interface Sequence extends NodeBase {
    readonly kind: "Sequence";
    readonly items: readonly Expr[];
}

/** `( a )` — precedence only, emits nothing of its own. */
export interface Group extends NodeBase {
    readonly kind: "Group";
    readonly body: Expr;
}

/** `[ a, b ]` — a set of characters, matching one of them. Commas are unions. */
export interface SetLit extends NodeBase {
    readonly kind: "SetLit";
    readonly members: readonly SetMember[];
}

export type SetMember = Range | CharLit | StringLit | NameRef;

/** `'a'..'f'` */
export interface Range extends NodeBase {
    readonly kind: "Range";
    readonly from: CharLit;
    readonly to: CharLit;
}

/** `"text"` — literal text, auto-escaped on emit. Escapes are already cooked. */
export interface StringLit extends NodeBase {
    readonly kind: "StringLit";
    readonly value: string;
}

/** `'c'` — one character. The only thing a range endpoint may be. */
export interface CharLit extends NodeBase {
    readonly kind: "CharLit";
    readonly value: string;
}

/** `` `...` `` — verbatim regex, or a raw subject inside a `test`. */
export interface RawLit extends NodeBase {
    readonly kind: "RawLit";
    readonly value: string;
}

export interface NumberLit extends NodeBase {
    readonly kind: "NumberLit";
    readonly value: number;
}

/** Set algebra. Operands must resolve to sets or single characters. */
export interface Algebra extends NodeBase {
    readonly kind: "Algebra";
    readonly op: "+" | "-" | "&";
    readonly left: Expr;
    readonly right: Expr;
}

export interface Capture extends NodeBase {
    readonly kind: "Capture";
    /** Null for `capture { }`, which still takes a group number. */
    readonly name: Identifier | null;
    readonly body: Sequence;
}

/** `either { a b }` — branches tried left to right; `|` between them is optional. */
export interface Either extends NodeBase {
    readonly kind: "Either";
    readonly branches: readonly Expr[];
}

export interface Optional extends NodeBase {
    readonly kind: "Optional";
    readonly body: Sequence;
}

export type RepeatMode = "greedy" | "lazy" | "atomic";

/**
 * `repeat [count] [mode] { }`. Bounds are a bare number or a bare `def`
 * parameter name, never an expression.
 * - `repeat { }`      → min null, max null  (0 or more)
 * - `repeat n { }`    → min n, max n
 * - `repeat n.. { }`  → min n, max null
 * - `repeat n..m { }` → min n, max m
 * - `repeat ..m { }`  → min null, max m
 */
export interface Repeat extends NodeBase {
    readonly kind: "Repeat";
    readonly min: Bound | null;
    readonly max: Bound | null;
    readonly mode: RepeatMode;
    readonly body: Sequence;
}

export type Bound = NumberLit | NameRef;

export interface Lookaround extends NodeBase {
    readonly kind: "Lookaround";
    readonly dir: "ahead" | "behind";
    readonly negated: boolean;
    readonly body: Sequence;
}

/** `ignoreCase { }`, `byLine { }`, `dotAll { }` — a flag scoped to the block. */
export interface FlagScope extends NodeBase {
    readonly kind: "FlagScope";
    readonly flag: "ignoreCase" | "byLine" | "dotAll";
    readonly body: Sequence;
}

/** `not x` — takes a bare operand, which must resolve to a set or a character. */
export interface Not extends NodeBase {
    readonly kind: "Not";
    readonly body: Expr;
}

/** `ref name` or `ref 1`. */
export interface Backref extends NodeBase {
    readonly kind: "Backref";
    readonly target: Identifier | NumberLit;
}

/**
 * A name in expression position: a prelude binding, a `let`, a `def` parameter,
 * or a `def` call. `path` holds the `.member` chain (`unicode.Greek`), `args`
 * the parenthesised value arguments, `block` the trailing block argument.
 */
export interface NameRef extends NodeBase {
    readonly kind: "NameRef";
    readonly name: Identifier;
    readonly path: readonly Identifier[];
    readonly args: readonly Expr[] | null;
    readonly block: Sequence | null;
}
