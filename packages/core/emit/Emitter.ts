/**
 * @fileoverview Spells the IR as a regex for one flavor, and reports what the
 * flavor cannot express.
 *
 * Grouping is driven by precedence, not by what the source wrote: `( )` left no
 * trace in the IR, so a node is wrapped in `(?:...)` exactly when its own
 * precedence is looser than the position it lands in. That is what keeps
 * `either { "a" "b" }` inside a sequence from leaking its alternation.
 */

import { Diagnostics, GrexError } from "../diagnostics/Diagnostics";
import type { Span } from "../parser/AST";
import {
    type CharSet,
    type Ranges,
    MAX_CODEPOINT,
    complementRanges,
    rangesEqual,
    size,
    simplify,
    unionLeaves,
} from "../ir/CharSet";
import type { IRNode, IRPattern, ProgramFlags } from "../ir/IRNode";
import { DIGIT, SPACE, WORD_ASCII } from "../ir/Prelude";
import { type Flavor, propertyName } from "./Flavors";

/** How loosely a piece of regex binds, deciding when it needs `(?:...)`. */
enum Prec {
    /** Contains a top-level `|`. */
    Alt,
    /** A concatenation of two or more atoms. */
    Seq,
    /** One indivisible unit, safe to quantify. */
    Atom,
}

interface Piece {
    readonly text: string;
    readonly prec: Prec;
}

const atom = (text: string): Piece => ({ text, prec: Prec.Atom });

/** Shorthands a class can collapse to, longest-standing first. */
const SHORTHANDS: readonly { readonly ranges: Ranges; readonly short: string; readonly negated: string }[] = [
    { ranges: (DIGIT as { ranges: Ranges }).ranges, short: "\\d", negated: "\\D" },
    { ranges: (WORD_ASCII as { ranges: Ranges }).ranges, short: "\\w", negated: "\\W" },
    { ranges: (SPACE as { ranges: Ranges }).ranges, short: "\\s", negated: "\\S" },
];

/** `\R` has no short spelling elsewhere, so this is what stands in for it. */
const LINEBREAK_FALLBACK = "(?:\\r\\n|[\\n\\v\\f\\r\\u0085\\u2028\\u2029])";

const CONTROL_ESCAPES: Record<number, string> = {
    0x00: "\\0",
    0x09: "\\t",
    0x0a: "\\n",
    0x0b: "\\v",
    0x0c: "\\f",
    0x0d: "\\r",
};

/** Escaped outside a character class. `/` is included so a `/.../` literal is safe. */
const META = new Set([..."\\^$.|?*+()[]{}/"]);
/** Escaped inside a character class. */
const CLASS_META = new Set([..."\\]^-["]);

export interface Emitted {
    readonly source: string;
    readonly flags: string;
}

export interface EmitOptions {
    /**
     * Downgrade "this flavor has no atomic groups" from an error to a warning and
     * emit the plain greedy quantifier instead.
     *
     * Atomic grouping changes backtracking, so this is a real approximation, not
     * a no-op. It exists so `grex test` can run a pcre pattern through the JS
     * engine: the alternative is refusing to test the pattern at all, which is
     * less useful than testing a version that differs only in backtracking.
     */
    readonly relaxAtomic?: boolean;
}

export class Emitter {
    /** Set while emitting, because they decide which Unicode flag the result needs. */
    private usedProps = false;
    private usedClassSetOps = false;

    constructor(
        private readonly flavor: Flavor,
        private readonly flags: ProgramFlags,
        private readonly diagnostics: Diagnostics = new Diagnostics(),
        private readonly options: EmitOptions = {},
    ) {}

    public emit(pattern: IRPattern): Emitted {
        this.usedProps = false;
        this.usedClassSetOps = false;

        const source = this.node(pattern.body).text;
        return { source, flags: this.flagString() };
    }

    /**
     * Whole-pattern flags. A Unicode flag is added when a property forced it,
     * because without one the pattern would simply not compile.
     */
    private flagString(): string {
        const letters: string[] = [];
        if (this.flags.ignoreCase) letters.push("i");
        if (this.flags.byLine) letters.push("m");
        if (this.flags.dotAll) letters.push("s");

        if (this.usedClassSetOps) letters.push("v");
        else if (this.flags.unicode || (this.usedProps && this.flavor.propsNeedUnicodeFlag)) letters.push("u");

        return letters.join("");
    }

    // --- Nodes ---

    private node(node: IRNode): Piece {
        switch (node.kind) {
            case "lit":
                return this.literal(node.text);

            // Raw regex is the user's own escape hatch, so it is passed through
            // and only measured for precedence.
            case "raw":
                return { text: node.text, prec: rawPrec(node.text) };

            case "class":
                return this.charClass(simplify(node.set), node.span);

            case "any":
                return atom(".");

            case "anchor":
                return this.anchor(node);

            case "seq": {
                if (node.items.length === 0) return atom("(?:)");
                if (node.items.length === 1) return this.node(node.items[0]!);
                // Only an alternation leaks across a concatenation boundary.
                const text = node.items.map((item) => this.atLeast(item, Prec.Seq)).join("");
                return { text, prec: Prec.Seq };
            }

            case "alt":
                return {
                    text: node.branches.map((branch) => this.node(branch).text).join("|"),
                    prec: Prec.Alt,
                };

            case "group": {
                const inner = this.node(node.body).text;
                return atom(node.name === null ? `(${inner})` : `(?<${node.name}>${inner})`);
            }

            case "repeat":
                return this.repeat(node);

            case "look":
                return this.look(node);

            case "flags":
                return this.scopedFlags(node);

            case "backref":
                return this.backref(node);
        }
    }

    /** Emits `node`, wrapping it in `(?:...)` if it binds more loosely than `need`. */
    private atLeast(node: IRNode, need: Prec): string {
        const piece = this.node(node);
        return piece.prec >= need ? piece.text : `(?:${piece.text})`;
    }

    private literal(text: string): Piece {
        const chars = [...text];
        const escaped = chars.map((c) => escapeChar(c.codePointAt(0)!)).join("");
        // One character is quantifiable as it stands; several are a concatenation.
        return chars.length === 1 ? atom(escaped) : { text: escaped, prec: chars.length === 0 ? Prec.Atom : Prec.Seq };
    }

    private anchor(node: Extract<IRNode, { kind: "anchor" }>): Piece {
        switch (node.at) {
            case "lineStart":
                return atom("^");
            case "lineEnd":
                return atom("$");
            case "wordBoundary":
                return atom("\\b");
            case "notWordBoundary":
                return atom("\\B");

            case "textStart":
            case "textEnd":
                if (!this.flavor.textAnchors) {
                    this.unsupported(
                        `\`${node.at === "textStart" ? "textStart" : "textEnd"}\` needs \\${node.at === "textStart" ? "A" : "z"}`,
                        node.span,
                    );
                    // `^`/`$` is the closest thing, and keeps the rest readable.
                    return atom(node.at === "textStart" ? "^" : "$");
                }
                return atom(node.at === "textStart" ? "\\A" : "\\z");

            case "linebreak":
                return this.flavor.linebreakEscape ? atom("\\R") : atom(LINEBREAK_FALLBACK);
        }
    }

    private repeat(node: Extract<IRNode, { kind: "repeat" }>): Piece {
        const quantifier = quantifierFor(node.min, node.max);
        const body = this.atLeast(node.body, Prec.Atom);

        if (quantifier === "") return atom(body); // `repeat 1 { x }` is just x

        if (node.mode === "atomic") {
            if (!this.flavor.atomic) {
                this.unsupported("atomic repetition has no equivalent", node.span, this.options.relaxAtomic);
                return atom(`${body}${quantifier}`);
            }
            // The portable PCRE spelling: a greedy quantifier sealed in an atomic group.
            return atom(`(?>${body}${quantifier})`);
        }

        return atom(`${body}${quantifier}${node.mode === "lazy" ? "?" : ""}`);
    }

    private look(node: Extract<IRNode, { kind: "look" }>): Piece {
        const supported = node.dir === "ahead" ? this.flavor.lookahead : this.flavor.lookbehind;
        const body = this.node(node.body).text;

        if (!supported) {
            this.unsupported(
                `${node.negated ? "negative " : ""}look${node.dir} is not available`,
                node.span,
            );
            return atom("(?:)");
        }

        const open = node.dir === "ahead" ? (node.negated ? "(?!" : "(?=") : node.negated ? "(?<!" : "(?<=";
        return atom(`${open}${body})`);
    }

    private scopedFlags(node: Extract<IRNode, { kind: "flags" }>): Piece {
        const body = this.node(node.body).text;
        if (!this.flavor.inlineFlags) {
            this.unsupported(`scoped flags \`(?${node.on.join("")}:...)\` are not available`, node.span);
            return atom(`(?:${body})`);
        }
        return atom(`(?${node.on.join("")}:${body})`);
    }

    private backref(node: Extract<IRNode, { kind: "backref" }>): Piece {
        if (!this.flavor.backref) {
            this.unsupported("backreferences are not available", node.span);
            return atom("(?:)");
        }
        return atom(node.name === null ? `\\${node.index}` : `\\k<${node.name}>`);
    }

    // --- Character classes ---

    private charClass(set: CharSet, span: Span): Piece {
        // Anything expressible as one bracket takes that form, after the
        // shorthand and single-character shortcuts.
        const contents = this.bracketContents(set, span);
        if (contents !== null) return this.bracket(set, contents);

        if (set.kind === "op") {
            const left = this.bracketContents(set.left, span);
            const right = this.bracketContents(set.right, span);

            if (this.flavor.classSetOps && left !== null && right !== null) {
                this.usedClassSetOps = true;
                const op = set.op === "inter" ? "&&" : "--";
                return atom(`[${left}${op}${nestOperand(set.right, right)}]`);
            }

            // Without class set operations, a guard does the same job: match the
            // left set only where the right one does (or does not) also match.
            if (this.flavor.lookahead) {
                const guard = set.op === "inter" ? "(?=" : "(?!";
                const test = this.classAsAtom(set.right, span);
                return { text: `${guard}${test})${this.classAsAtom(set.left, span)}`, prec: Prec.Seq };
            }

            this.unsupported(
                `set ${set.op === "inter" ? "intersection" : "difference"} against a Unicode property needs either class set operations or lookahead`,
                span,
            );
            return atom("(?:)");
        }

        // Only an unfoldable operation reaches here, and `simplify` leaves just
        // two of those; a third would be a bug in this stage, not bad input.
        if (set.kind !== "not")
            throw new GrexError(`charClass reached an unexpected ${set.kind} set`);

        // A negation left standing is one whose operand could not be folded.
        if (this.flavor.lookahead)
            return { text: `(?!${this.classAsAtom(set.of, span)})[\\s\\S]`, prec: Prec.Seq };

        this.unsupported("negating this set needs lookahead", span);
        return atom("(?:)");
    }

    private classAsAtom(set: CharSet, span: Span): string {
        const piece = this.charClass(set, span);
        return piece.prec >= Prec.Atom ? piece.text : `(?:${piece.text})`;
    }

    /** Wraps class contents, taking the shortest correct spelling. */
    private bracket(set: CharSet, contents: string): Piece {
        if (set.kind === "ranges") {
            const { ranges } = set;

            if (ranges.length === 0) {
                // `[]` is not a regex; this never matches, which is what was asked for.
                return atom("[^\\s\\S]");
            }
            if (ranges.length === 1 && ranges[0]![0] === 0 && ranges[0]![1] === MAX_CODEPOINT) {
                return atom("[\\s\\S]");
            }

            for (const { ranges: known, short, negated } of SHORTHANDS) {
                if (rangesEqual(ranges, known)) return atom(short);
                if (rangesEqual(ranges, complementRanges(known))) return atom(negated);
            }

            // A one-character set is just that character.
            if (ranges.length === 1 && ranges[0]![0] === ranges[0]![1]) return atom(escapeChar(ranges[0]![0]));

            // `not [' ', '"']` folds to every code point except two, so spell the
            // two: `[^ "]`, not a complement that reaches U+10FFFF.
            const complement = complementRanges(ranges);
            if (size(complement) < size(ranges))
                return atom(`[^${complement.map(rangeText).join("")}]`);
        }

        // A lone property needs no brackets either.
        if (set.kind === "prop") return atom(contents);

        return atom(`[${contents}]`);
    }

    /**
     * The inside of a single `[...]`, or null when the set needs more than one
     * bracket — which is only ever an unfolded `&`, `-` or negation.
     */
    private bracketContents(set: CharSet, span: Span): string | null {
        const leaves = unionLeaves(set);
        if (leaves === null) return null;

        let out = "";
        for (const leaf of leaves) {
            if (leaf.kind === "prop") {
                if (!this.flavor.unicodeProps) {
                    this.unsupported(`Unicode properties such as \`unicode.${leaf.name}\` are not available`, span);
                    continue;
                }
                this.usedProps = true;
                out += `\\${leaf.negated ? "P" : "p"}{${propertyName(leaf.name, this.flavor)}}`;
            } else {
                out += leaf.ranges.map(rangeText).join("");
            }
        }
        return out;
    }

    // --- Errors ---

    /** `asWarning` is for an approximation the caller asked for and accepts. */
    private unsupported(what: string, span: Span, asWarning: boolean = false) {
        this.diagnostics.report({
            stage: "emit",
            severity: asWarning ? "warning" : "error",
            message: asWarning
                ? `Approximated for the ${this.flavor.name} flavor: ${what}`
                : `The ${this.flavor.name} flavor cannot express this: ${what}`,
            start: span.start,
            end: span.end,
        });
    }
}

// --- Spelling helpers ---

function rangeText([lo, hi]: readonly [number, number]): string {
    if (lo === hi) return escapeClassChar(lo);
    // A two-wide range is shorter written out than as a range.
    if (hi === lo + 1) return escapeClassChar(lo) + escapeClassChar(hi);
    return `${escapeClassChar(lo)}-${escapeClassChar(hi)}`;
}

/**
 * The right-hand operand of a class set operation. A bare property stands alone;
 * a list of ranges has to be bracketed to be one operand.
 */
function nestOperand(set: CharSet, contents: string): string {
    return set.kind === "prop" ? contents : `[${contents}]`;
}

function escapeChar(code: number): string {
    const control = CONTROL_ESCAPES[code];
    if (control) return control;

    const char = String.fromCodePoint(code);
    if (META.has(char)) return `\\${char}`;
    if (code < 0x20 || code === 0x7f) return `\\x${code.toString(16).padStart(2, "0")}`;
    return char;
}

function escapeClassChar(code: number): string {
    const control = CONTROL_ESCAPES[code];
    if (control) return control;

    const char = String.fromCodePoint(code);
    if (CLASS_META.has(char)) return `\\${char}`;
    if (code < 0x20 || code === 0x7f) return `\\x${code.toString(16).padStart(2, "0")}`;
    return char;
}

function quantifierFor(min: number, max: number | null): string {
    if (max === null) {
        if (min === 0) return "*";
        if (min === 1) return "+";
        return `{${min},}`;
    }
    if (min === 0 && max === 1) return "?";
    if (min === max) return min === 1 ? "" : `{${min}}`;
    return `{${min},${max}}`;
}

/**
 * How loosely a raw literal binds. Only a top-level `|` can surprise the
 * surrounding pattern, so that is what is looked for; a single atom is
 * recognised so the common `` `\\` `` stays unwrapped.
 */
function rawPrec(text: string): Prec {
    let depth = 0;
    let inClass = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        if (char === "\\") {
            i++;
            continue;
        }
        if (inClass) {
            if (char === "]") inClass = false;
            continue;
        }
        if (char === "[") inClass = true;
        else if (char === "(") depth++;
        else if (char === ")") depth--;
        else if (char === "|" && depth === 0) return Prec.Alt;
    }

    return isSingleAtom(text) ? Prec.Atom : Prec.Seq;
}

function isSingleAtom(text: string): boolean {
    if ([...text].length === 1) return true;
    // An escape, a property, or a bracket/group spanning the whole string.
    return (
        /^\\[^\s]$/u.test(text) ||
        /^\\[pP]\{[^{}]*\}$/u.test(text) ||
        /^\[[^\]\\]*\]$/u.test(text) ||
        /^\((?:[^()\\]|\\.)*\)$/u.test(text)
    );
}
