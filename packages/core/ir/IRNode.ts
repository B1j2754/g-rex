/**
 * @fileoverview Lowered form of a g-rex pattern: a regex-shaped tree.
 *
 * Every name is resolved, every `def` is expanded, every set-algebra operation
 * that could be computed has been, and every capture has its group number. What
 * is left is flavor-independent, so `emit/` only has to spell it and say what the
 * target cannot do. Nodes keep their source span for exactly that reason: a
 * construct rejected by a flavor must still point at the line that wrote it.
 */

// `RepeatMode` is the same set of modes the source wrote, so it is the AST's.
import type { RepeatMode, Span } from "../parser/AST";
import type { CharSet } from "./CharSet";

export type AnchorKind =
    | "lineStart"
    | "lineEnd"
    | "textStart"
    | "textEnd"
    | "wordBoundary"
    | "notWordBoundary"
    | "linebreak";

export type ScopedFlag = "i" | "m" | "s";

interface Located {
    readonly span: Span;
}

/** Literal text; metacharacters are escaped by the emitter, not here. */
export interface IRLit extends Located {
    readonly kind: "lit";
    readonly text: string;
}

/** Verbatim regex from a `` ` ` `` literal, passed through untouched. */
export interface IRRaw extends Located {
    readonly kind: "raw";
    readonly text: string;
}

export interface IRClass extends Located {
    readonly kind: "class";
    readonly set: CharSet;
}

export interface IRAny extends Located {
    readonly kind: "any";
}

export interface IRAnchor extends Located {
    readonly kind: "anchor";
    readonly at: AnchorKind;
}

export interface IRSeq extends Located {
    readonly kind: "seq";
    readonly items: readonly IRNode[];
}

export interface IRAlt extends Located {
    readonly kind: "alt";
    readonly branches: readonly IRNode[];
}

export interface IRGroup extends Located {
    readonly kind: "group";
    readonly name: string | null;
    /** 1-based, in source order, as the regex engine will number it. */
    readonly index: number;
    readonly body: IRNode;
}

export interface IRRepeat extends Located {
    readonly kind: "repeat";
    readonly min: number;
    /** Null is unbounded. */
    readonly max: number | null;
    readonly mode: RepeatMode;
    readonly body: IRNode;
}

export interface IRLook extends Located {
    readonly kind: "look";
    readonly dir: "ahead" | "behind";
    readonly negated: boolean;
    readonly body: IRNode;
}

export interface IRFlags extends Located {
    readonly kind: "flags";
    readonly on: readonly ScopedFlag[];
    readonly body: IRNode;
}

export interface IRBackref extends Located {
    readonly kind: "backref";
    readonly name: string | null;
    readonly index: number;
}

export type IRNode =
    | IRLit
    | IRRaw
    | IRClass
    | IRAny
    | IRAnchor
    | IRSeq
    | IRAlt
    | IRGroup
    | IRRepeat
    | IRLook
    | IRFlags
    | IRBackref;

export type FlavorName = "pcre" | "js" | "re2";

/** The `@flags` of a file. Each is a whole-pattern flag, not a scoped one. */
export interface ProgramFlags {
    readonly unicode: boolean;
    readonly ignoreCase: boolean;
    readonly byLine: boolean;
    readonly dotAll: boolean;
}

export interface IRPattern {
    readonly name: string;
    readonly docs: string | null;
    readonly body: IRNode;
    /** Group name by 1-based index, with null for an anonymous group. */
    readonly captures: readonly (string | null)[];
    readonly span: Span;
}

export interface IRTestCase {
    readonly mode: "match" | "reject";
    readonly subject: string;
    readonly captures: readonly { readonly name: string; readonly text: string }[];
    readonly span: Span;
}

export interface IRTest {
    /** The pattern under test; guaranteed to name one of `IRProgram.patterns`. */
    readonly pattern: string;
    readonly cases: readonly IRTestCase[];
    readonly span: Span;
}

export interface IRProgram {
    readonly flavor: FlavorName;
    readonly flags: ProgramFlags;
    readonly patterns: readonly IRPattern[];
    readonly tests: readonly IRTest[];
}
