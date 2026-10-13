/**
 * @fileoverview Cycle detection over the `let`/`def` reference graph.
 *
 * `let` and `def` are macros: a use site is replaced by the body, so a cycle
 * cannot be inlined at all and the language calls it a hard error. This runs over
 * the declarations rather than over the expansion, which matters twice over: a
 * cycle is reported once even when it is reached from four places, and an
 * unused cycle is still reported, because the rule is about the declarations.
 *
 * Expansion depth cannot stand in for this. `f(f(x))` re-enters `f` legitimately,
 * so a name seen twice during expansion is not evidence of a cycle.
 */

import type { Decl, DefDecl, Identifier, LetDecl } from "../parser/AST";

type Macro = LetDecl | DefDecl;

/** One edge: the name referred to, and where it was written. */
interface Edge {
    readonly to: string;
    readonly at: Identifier;
}

/**
 * Finds every cycle among the `let` and `def` declarations.
 * @returns one entry per cycle, naming the members and the reference that closes it.
 */
export function findCycles(declarations: readonly Decl[]): { names: string[]; at: Identifier }[] {
    const macros = new Map<string, Macro>();
    for (const decl of declarations)
        if (decl.kind === "LetDecl" || decl.kind === "DefDecl") macros.set(decl.name.text, decl);

    const edges = new Map<string, Edge[]>();
    for (const [name, decl] of macros) {
        // A parameter shadows the macro it is named after, so it is not an edge.
        const shadowed = decl.kind === "DefDecl" ? new Set(decl.params.map((p) => p.name.text)) : new Set<string>();
        edges.set(
            name,
            references(decl.body, shadowed)
                .filter((ref) => macros.has(ref.text))
                .map((ref) => ({ to: ref.text, at: ref })),
        );
    }

    const cycles: { names: string[]; at: Identifier }[] = [];
    const state = new Map<string, "visiting" | "done">();
    const stack: string[] = [];
    const reported = new Set<string>();

    const visit = (name: string) => {
        state.set(name, "visiting");
        stack.push(name);

        for (const edge of edges.get(name) ?? []) {
            if (state.get(edge.to) === "done") continue;

            if (state.get(edge.to) === "visiting") {
                const members = stack.slice(stack.indexOf(edge.to));
                // One cycle, however many of its members we enter it from.
                const key = [...members].sort().join(",");
                if (!reported.has(key)) {
                    reported.add(key);
                    cycles.push({ names: members, at: edge.at });
                }
                continue;
            }

            visit(edge.to);
        }

        stack.pop();
        state.set(name, "done");
    };

    for (const name of macros.keys()) if (!state.has(name)) visit(name);

    return cycles;
}

/**
 * Every name used in expression position under `node`, skipping the `.member`
 * part of a path and anything in `shadowed`.
 *
 * The walk is shape-agnostic on purpose: it has to keep working as expression
 * nodes are added, and a missed edge here is a hang rather than a diagnostic.
 */
function references(node: unknown, shadowed: ReadonlySet<string>): Identifier[] {
    const out: Identifier[] = [];

    const walk = (value: unknown) => {
        if (Array.isArray(value)) {
            for (const item of value) walk(item);
            return;
        }
        if (!value || typeof value !== "object") return;

        const record = value as Record<string, unknown>;

        if (record.kind === "NameRef") {
            const name = record.name as Identifier;
            if (!shadowed.has(name.text)) out.push(name);
            // `path` is Unicode property names, and `name` is already taken.
            walk(record.args);
            walk(record.block);
            return;
        }

        for (const key of Object.keys(record)) {
            if (key === "span") continue;
            walk(record[key]);
        }
    };

    walk(node);
    return out;
}
