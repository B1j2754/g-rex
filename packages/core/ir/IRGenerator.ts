/**
 * @fileoverview Lowers the AST to IR: resolves names, expands `def` calls,
 * evaluates set algebra and numbers the capture groups.
 *
 * `def` is a macro with no call frame, so a parameter binds to the argument's
 * AST node together with the scope it was written in, and the body is lowered
 * afresh at every use site. A `let` is lowered afresh too, which is what makes
 * `octet` appear four times in kitchen-sink's `ip` with correct group numbers
 * instead of one shared subtree.
 */

import { Diagnostics } from "../diagnostics/Diagnostics";
import type {
    Bound,
    Decl,
    DefDecl,
    Directive,
    Expr,
    LetDecl,
    NameRef,
    PatternDecl,
    Program,
    Sequence,
    SetMember,
    Span,
    TestDecl,
} from "../parser/AST";
import {
    type CharSet,
    EMPTY,
    fromChars,
    prop,
    singleton,
    simplify,
} from "./CharSet";
import type {
    FlavorName,
    IRNode,
    IRPattern,
    IRProgram,
    IRTest,
    IRTestCase,
    ProgramFlags,
    ScopedFlag,
} from "./IRNode";
import { type PreludeBinding, prelude } from "./Prelude";
import { findCycles } from "./DeclGraph";

const FLAVORS = new Set<string>(["pcre", "js", "re2"]);
const FLAG_NAMES = ["unicode", "ignoreCase", "byLine", "dotAll"] as const;
type FlagName = (typeof FLAG_NAMES)[number];

const SCOPED_FLAGS = { ignoreCase: "i", byLine: "m", dotAll: "s" } as const;

type Binding =
    | { kind: "prelude"; value: PreludeBinding }
    | { kind: "let"; decl: LetDecl }
    | { kind: "def"; decl: DefDecl }
    /** A `def` parameter: the argument node, plus the scope it was written in. */
    | { kind: "arg"; node: Expr; scope: Scope };

class Scope {
    private readonly names = new Map<string, Binding>();

    constructor(readonly parent: Scope | null = null) {}

    declare(name: string, binding: Binding) {
        this.names.set(name, binding);
    }

    lookup(name: string): Binding | null {
        return this.names.get(name) ?? this.parent?.lookup(name) ?? null;
    }
}

/**
 * A backstop against runaway expansion. Cycles are caught statically, so hitting
 * this means something nests far deeper than anyone writes by hand.
 */
const MAX_EXPANSION_DEPTH = 256;

export class IRGenerator {
    private file = new Scope();
    /** Macros in a reference cycle, which must not be expanded at all. */
    private cyclic = new Set<string>();
    private depth = 0;

    // Per-pattern capture state, reset by `lowerPattern`.
    private captures: (string | null)[] = [];
    private byName = new Map<string, number>();

    constructor(private readonly diagnostics: Diagnostics = new Diagnostics()) {}

    public generate(ast: Program): IRProgram {
        const { flavor, flags } = this.readDirectives(ast.directives);

        this.file = new Scope();
        for (const [name, value] of prelude(flags.unicode))
            this.file.declare(name, { kind: "prelude", value });

        const patterns: IRPattern[] = [];
        const tests: TestDecl[] = [];

        // Declare everything first, so order of declaration does not matter.
        for (const decl of ast.declarations) this.declare(decl);

        // Before any expansion: a cycle must be reported even if nothing uses it,
        // and reported once rather than at every site that reaches it.
        const cycles = findCycles(ast.declarations);
        for (const cycle of cycles)
            this.error(
                `\`${cycle.names[0]}\` is defined in terms of itself` +
                    ` (${[...cycle.names, cycle.names[0]].join(" -> ")}); a cycle cannot be inlined`,
                cycle.at.span,
            );
        this.cyclic = new Set(cycles.flatMap((cycle) => cycle.names));

        for (const decl of ast.declarations) {
            if (decl.kind === "PatternDecl") patterns.push(this.lowerPattern(decl));
            else if (decl.kind === "TestDecl") tests.push(decl);
        }

        return {
            flavor,
            flags,
            patterns,
            tests: this.lowerTests(tests, patterns),
        };
    }

    // --- Directives ---

    private readDirectives(directives: readonly Directive[]) {
        let flavor: FlavorName = "pcre";
        const flags: Record<FlagName, boolean> = {
            unicode: false,
            ignoreCase: false,
            byLine: false,
            dotAll: false,
        };

        for (const directive of directives) {
            switch (directive.name.text) {
                case "flavor": {
                    const [arg, ...rest] = directive.args;
                    if (!arg) {
                        this.error("`@flavor` needs a flavor name", directive.span);
                    } else if (!FLAVORS.has(arg.text)) {
                        this.error(
                            `Unknown flavor ${JSON.stringify(arg.text)}, expected pcre, js or re2`,
                            arg.span,
                        );
                    } else {
                        flavor = arg.text as FlavorName;
                    }
                    for (const extra of rest) this.error("`@flavor` takes one flavor", extra.span);
                    break;
                }

                case "flags":
                    if (directive.args.length === 0) this.error("`@flags` needs at least one flag", directive.span);
                    for (const arg of directive.args) {
                        if ((FLAG_NAMES as readonly string[]).includes(arg.text)) flags[arg.text as FlagName] = true;
                        else
                            this.error(
                                `Unknown flag ${JSON.stringify(arg.text)}, expected ${FLAG_NAMES.join(", ")}`,
                                arg.span,
                            );
                    }
                    break;

                default:
                    this.error(
                        `Unknown directive \`@${directive.name.text}\`, expected \`@flavor\` or \`@flags\``,
                        directive.span,
                    );
            }
        }

        return { flavor, flags: flags as ProgramFlags };
    }

    // --- Declarations ---

    private declare(decl: Decl) {
        switch (decl.kind) {
            case "LetDecl":
                this.file.declare(decl.name.text, { kind: "let", decl });
                break;
            case "DefDecl":
                this.file.declare(decl.name.text, { kind: "def", decl });
                break;
        }
    }

    private lowerPattern(decl: PatternDecl): IRPattern {
        this.captures = [];
        this.byName = new Map();

        const body = this.lowerSequence(decl.body, this.file);

        return {
            name: decl.name.text,
            docs: decl.docs?.text ?? null,
            body,
            captures: this.captures,
            span: decl.span,
        };
    }

    /** Keeps only tests naming a pattern that exists; the rest are reported. */
    private lowerTests(decls: readonly TestDecl[], patterns: readonly IRPattern[]): IRTest[] {
        const known = new Set(patterns.map((p) => p.name));
        const out: IRTest[] = [];

        for (const decl of decls) {
            if (!known.has(decl.name.text)) {
                this.error(`No pattern named ${JSON.stringify(decl.name.text)} to test`, decl.name.span);
                continue;
            }

            const pattern = patterns.find((p) => p.name === decl.name.text)!;
            const cases: IRTestCase[] = [];

            for (const testCase of decl.cases) {
                for (const assertion of testCase.captures)
                    if (!pattern.captures.includes(assertion.name.text))
                        this.error(
                            `Pattern ${JSON.stringify(pattern.name)} has no capture named ${JSON.stringify(assertion.name.text)}`,
                            assertion.name.span,
                        );

                cases.push({
                    mode: testCase.mode,
                    subject: testCase.subject.value,
                    captures: testCase.captures.map((a) => ({ name: a.name.text, text: a.text.value })),
                    span: testCase.span,
                });
            }

            out.push({ pattern: decl.name.text, cases, span: decl.span });
        }

        return out;
    }

    // --- Expressions ---

    private lowerSequence(node: Sequence, scope: Scope): IRNode {
        const items = node.items.map((item) => this.lower(item, scope)).filter((n): n is IRNode => n !== null);

        // A one-item sequence is that item; keeping the wrapper only adds noise.
        if (items.length === 1) return items[0]!;
        return { kind: "seq", span: node.span, items };
    }

    private lower(node: Expr, scope: Scope): IRNode | null {
        switch (node.kind) {
            case "Sequence":
                return this.lowerSequence(node, scope);

            // Parentheses are precedence only, so they leave nothing behind.
            case "Group":
                return this.lower(node.body, scope);

            case "StringLit":
                return { kind: "lit", span: node.span, text: node.value };

            case "RawLit":
                return { kind: "raw", span: node.span, text: node.value };

            case "CharLit":
                return { kind: "class", span: node.span, set: this.charSetOf(node, scope) ?? EMPTY };

            case "SetLit":
            case "Range":
            case "Algebra":
            case "Not": {
                const set = this.charSetOf(node, scope);
                return set === null ? null : { kind: "class", span: node.span, set: simplify(set) };
            }

            case "NumberLit":
                this.error("A number is only meaningful as a repeat count or a `ref`", node.span);
                return null;

            case "Capture": {
                const name = node.name?.text ?? null;
                if (name !== null && this.byName.has(name)) {
                    this.error(`Duplicate capture name ${JSON.stringify(name)}`, node.name!.span);
                }

                // Reserve this group's number before lowering the body, so nested
                // captures get the numbers the engine will give them.
                this.captures.push(name);
                const index = this.captures.length;
                if (name !== null && !this.byName.has(name)) this.byName.set(name, index);

                return {
                    kind: "group",
                    span: node.span,
                    name,
                    index,
                    body: this.lowerSequence(node.body, scope),
                };
            }

            case "Either": {
                const branches = node.branches
                    .map((branch) => this.lower(branch, scope))
                    .filter((n): n is IRNode => n !== null);
                if (branches.length === 0) return null;
                if (branches.length === 1) return branches[0]!;
                return { kind: "alt", span: node.span, branches };
            }

            case "Optional":
                return {
                    kind: "repeat",
                    span: node.span,
                    min: 0,
                    max: 1,
                    mode: "greedy",
                    body: this.lowerSequence(node.body, scope),
                };

            case "Repeat": {
                // An absent bound is 0 or unbounded; a bound that failed to resolve
                // has already been reported, and must not be read as either.
                const min = node.min === null ? 0 : this.resolveBound(node.min, scope);
                if (min === null) return null;

                let max: number | null = null;
                if (node.max !== null) {
                    max = this.resolveBound(node.max, scope);
                    if (max === null) return null;
                }

                if (max !== null && max < min) {
                    this.error(`Repeat range ${min}..${max} counts backwards`, node.span);
                    return null;
                }

                return {
                    kind: "repeat",
                    span: node.span,
                    min,
                    max,
                    mode: node.mode,
                    body: this.lowerSequence(node.body, scope),
                };
            }

            case "Lookaround":
                return {
                    kind: "look",
                    span: node.span,
                    dir: node.dir,
                    negated: node.negated,
                    body: this.lowerSequence(node.body, scope),
                };

            case "FlagScope":
                return {
                    kind: "flags",
                    span: node.span,
                    on: [SCOPED_FLAGS[node.flag] as ScopedFlag],
                    body: this.lowerSequence(node.body, scope),
                };

            case "Backref":
                return this.lowerBackref(node, scope);

            case "NameRef":
                return this.lowerNameRef(node, scope);
        }
    }

    private lowerBackref(node: Extract<Expr, { kind: "Backref" }>, _scope: Scope): IRNode | null {
        if (node.target.kind === "NumberLit") {
            const index = node.target.value;
            if (index < 1 || index > this.captures.length) {
                this.error(
                    `No group ${index} to reference; this pattern has ${this.captures.length}`,
                    node.target.span,
                );
                return null;
            }
            return { kind: "backref", span: node.span, name: null, index };
        }

        const name = node.target.text;
        const index = this.byName.get(name);
        if (index === undefined) {
            this.error(`No capture named ${JSON.stringify(name)} to reference`, node.target.span);
            return null;
        }
        return { kind: "backref", span: node.span, name, index };
    }

    /** Resolves a name, expanding a `let` body or a `def` call in place. */
    private lowerNameRef(node: NameRef, scope: Scope): IRNode | null {
        const binding = scope.lookup(node.name.text);
        if (!binding) {
            this.error(`Unknown name ${JSON.stringify(node.name.text)}`, node.name.span);
            return null;
        }

        if (node.path.length > 0) {
            const set = this.memberSet(node, binding);
            return set === null ? null : { kind: "class", span: node.span, set };
        }

        switch (binding.kind) {
            case "prelude": {
                if (node.args || node.block) {
                    this.error(`\`${node.name.text}\` is not a definition and takes no arguments`, node.span);
                    return null;
                }
                switch (binding.value.kind) {
                    case "class":
                        return { kind: "class", span: node.span, set: binding.value.set };
                    case "any":
                        return { kind: "any", span: node.span };
                    case "anchor":
                        return { kind: "anchor", span: node.span, at: binding.value.at };
                    case "namespace":
                        this.error("`unicode` is a namespace; write `unicode.Greek`", node.span);
                        return null;
                }
            }

            case "arg":
                if (node.args || node.block) {
                    this.error(`\`${node.name.text}\` is a parameter and takes no arguments`, node.span);
                    return null;
                }
                return this.lower(binding.node, binding.scope);

            case "let": {
                if (node.args || node.block) {
                    this.error(`\`${node.name.text}\` is a \`let\` and takes no arguments`, node.span);
                    return null;
                }
                return this.withCycleGuard(node.name.text, node.name.span, () =>
                    this.lower(binding.decl.body, this.file),
                );
            }

            case "def":
                return this.expandDef(node, binding.decl, scope);
        }
    }

    /** `unicode.Greek` is the only member access there is. */
    private memberSet(node: NameRef, binding: Binding): CharSet | null {
        if (binding.kind !== "prelude" || binding.value.kind !== "namespace") {
            this.error(`\`${node.name.text}\` has no members`, node.span);
            return null;
        }
        if (node.path.length !== 1) {
            this.error("A Unicode property is one name, as in `unicode.Greek`", node.span);
            return null;
        }
        if (node.args || node.block) {
            this.error("A Unicode property takes no arguments", node.span);
            return null;
        }
        return prop(node.path[0]!.text);
    }

    /**
     * Expands a `def` at its use site. Value arguments fill the parameters in
     * order; a trailing block fills the first parameter left over.
     * @param caller - Scope the arguments were written in, which is where they
     *   must be lowered: a def has no call frame, so a parameter *is* its argument.
     */
    private expandDef(node: NameRef, decl: DefDecl, caller: Scope): IRNode | null {
        const args: Expr[] = [...(node.args ?? [])];
        if (node.block) args.push(node.block);

        if (args.length !== decl.params.length) {
            const plural = decl.params.length === 1 ? "" : "s";
            this.error(
                `\`${decl.name.text}\` takes ${decl.params.length} argument${plural}, got ${args.length}`,
                node.span,
            );
            return null;
        }

        const inner = new Scope(this.file);
        decl.params.forEach((param, i) => {
            inner.declare(param.name.text, { kind: "arg", node: args[i]!, scope: caller });
        });

        return this.withCycleGuard(decl.name.text, node.name.span, () => this.lower(decl.body, inner));
    }

    /**
     * Expands `name`, refusing to if it is part of a cycle. The cycle itself was
     * already reported by the declaration graph, so this only has to stop.
     */
    private withCycleGuard<T>(name: string, span: Span, lower: () => T | null): T | null {
        if (this.cyclic.has(name)) return null;

        if (this.depth >= MAX_EXPANSION_DEPTH) {
            this.error(`Expanding \`${name}\` nests more than ${MAX_EXPANSION_DEPTH} deep`, span);
            return null;
        }

        this.depth++;
        try {
            return lower();
        } finally {
            this.depth--;
        }
    }

    // --- Character sets ---

    /**
     * Lowers an expression that must denote a set of characters.
     * Returns null after reporting when it denotes something else, which is the
     * `word + "ab"` case the language calls a type error.
     */
    private charSetOf(node: Expr, scope: Scope): CharSet | null {
        switch (node.kind) {
            case "CharLit":
                return singleton(node.value.codePointAt(0) ?? 0);

            case "Range": {
                const from = node.from.value.codePointAt(0) ?? 0;
                const to = node.to.value.codePointAt(0) ?? 0;
                if (to < from) {
                    this.error(
                        `Range ${JSON.stringify(node.from.value)}..${JSON.stringify(node.to.value)} counts backwards`,
                        node.span,
                    );
                    return null;
                }
                return { kind: "ranges", ranges: [[from, to]] };
            }

            case "SetLit": {
                let set: CharSet = EMPTY;
                for (const member of node.members) {
                    const part = this.setMember(member, scope);
                    if (part === null) continue;
                    set = { kind: "op", op: "union", left: set, right: part };
                }
                return simplify(set);
            }

            case "Algebra": {
                const left = this.charSetOf(node.left, scope);
                const right = this.charSetOf(node.right, scope);
                if (left === null || right === null) return null;
                const op = node.op === "+" ? "union" : node.op === "-" ? "diff" : "inter";
                return simplify({ kind: "op", op, left, right });
            }

            case "Not": {
                const of = this.charSetOf(node.body, scope);
                return of === null ? null : simplify({ kind: "not", of });
            }

            case "Group":
                return this.charSetOf(node.body, scope);

            case "NameRef": {
                const lowered = this.lowerNameRef(node, scope);
                if (lowered === null) return null;
                if (lowered.kind !== "class") {
                    this.error(
                        `\`${node.name.text}\` is not a set of characters, so it cannot be used in set algebra`,
                        node.span,
                    );
                    return null;
                }
                return lowered.set;
            }

            // A `" "` is text, not a set. Inside `[ ]` it means its characters,
            // which `setMember` handles; here it is the documented type error.
            case "StringLit":
                this.error(
                    `Set algebra needs sets or single characters; write ["${node.value}"] to mean its characters`,
                    node.span,
                );
                return null;

            default:
                this.error("Set algebra needs sets or single characters", node.span);
                return null;
        }
    }

    private setMember(member: SetMember, scope: Scope): CharSet | null {
        // Only inside `[ ]` does a string mean "each of these characters".
        if (member.kind === "StringLit") return fromChars(member.value);
        return this.charSetOf(member, scope);
    }

    // --- Repeat bounds ---

    /**
     * A repeat bound: a literal number, or a `def` parameter that is one.
     * Returns null after reporting; `undefined` is never returned, so callers can
     * tell "absent" from "broken".
     */
    private resolveBound(bound: Bound, scope: Scope): number | null {
        if (bound.kind === "NumberLit") {
            if (!Number.isInteger(bound.value) || bound.value < 0) {
                this.error("A repeat count must be a non-negative whole number", bound.span);
                return null;
            }
            return bound.value;
        }

        const binding = scope.lookup(bound.name.text);
        if (!binding) {
            this.error(`Unknown name ${JSON.stringify(bound.name.text)}`, bound.name.span);
            return null;
        }
        if (binding.kind !== "arg") {
            this.error(
                `A repeat count must be a number; \`${bound.name.text}\` is a ${binding.kind === "prelude" ? "built-in" : binding.kind}`,
                bound.name.span,
            );
            return null;
        }
        if (binding.node.kind !== "NumberLit" && binding.node.kind !== "NameRef") {
            this.error(`A repeat count must be a number, not ${binding.node.kind}`, bound.name.span);
            return null;
        }
        return this.resolveBound(binding.node as Bound, binding.scope);
    }

    // --- Errors ---

    private error(message: string, span: Span) {
        this.diagnostics.report({ stage: "ir", message, start: span.start, end: span.end });
    }
}
