/**
 * @fileoverview The public surface of the g-rex compiler.
 *
 * Every entry point is a thin wrapper over one private `analyze`, and each
 * returns `{ diagnostics, product? }` with the product simply absent when
 * anything errored. Nothing here throws for bad input; a `GrexError` escaping a
 * stage is a compiler bug and is caught at this one boundary.
 */

import { Diagnostics, GrexError, type Diagnostic } from "./diagnostics/Diagnostics";
import { Lexer } from "./lexer/Lexer";
import { Parser } from "./parser/Parser";
import { IRGenerator } from "./ir/IRGenerator";
import { Emitter } from "./emit/Emitter";
import { FLAVORS } from "./emit/Flavors";
import type { FlavorName, IRPattern, IRProgram } from "./ir/IRNode";
import type { Program, Span } from "./parser/AST";

export { Lexer } from "./lexer/Lexer";
export * from "./lexer/Token";
export { Parser } from "./parser/Parser";
export type * from "./parser/AST";
export { Diagnostics, GrexError, type Diagnostic, type Severity, type Stage } from "./diagnostics/Diagnostics";
export { IRGenerator } from "./ir/IRGenerator";
export type * from "./ir/IRNode";
export { Emitter, type Emitted, type EmitOptions } from "./emit/Emitter";
export { FLAVORS, type Flavor } from "./emit/Flavors";

export interface Options {
    /** Overrides the file's own `@flavor`. */
    readonly flavor?: FlavorName;
}

export interface CompiledPattern {
    readonly name: string;
    readonly docs: string | null;
    /** The regex itself, with no delimiters. */
    readonly source: string;
    /** Flag letters, in a stable order. */
    readonly flags: string;
    /** Group name by 1-based index, with null for an anonymous group. */
    readonly captures: readonly (string | null)[];
}

export interface TestResult {
    readonly pattern: string;
    readonly mode: "match" | "reject";
    readonly subject: string;
    readonly status: "pass" | "fail" | "unrunnable";
    /** Why it failed, or why it could not be run. Null when it passed. */
    readonly detail: string | null;
    /** Set when the pattern had to be approximated to run at all. */
    readonly note: string | null;
    readonly span: Span;
}

/** Lex, parse and lower. The IR is always returned; check `diagnostics` for its worth. */
function analyze(source: string): { diagnostics: Diagnostics; ast: Program; ir: IRProgram } {
    const diagnostics = new Diagnostics(source);

    const tokens = new Lexer(diagnostics).tokenize(source);
    // Each stage recovers rather than bailing, so a broken file reports its
    // syntax and its naming problems in one run instead of one per fix.
    const ast = new Parser(diagnostics).parse(tokens);
    const ir = new IRGenerator(diagnostics).generate(ast);

    return { diagnostics, ast, ir };
}

/** Everything wrong with `source`, including what its target flavor cannot express. */
export function checkSource(source: string, options: Options = {}): readonly Diagnostic[] {
    return compile(source, options).diagnostics;
}

/** The token stream. Lexing recovers, so tokens come back even when it reported. */
export function tokenize(source: string): { diagnostics: readonly Diagnostic[]; tokens: ReturnType<Lexer["tokenize"]> } {
    const diagnostics = new Diagnostics(source);
    return { tokens: new Lexer(diagnostics).tokenize(source), diagnostics: diagnostics.all };
}

/** The AST. `ast` is absent when parsing reported anything. */
export function parse(source: string): { diagnostics: readonly Diagnostic[]; ast?: Program } {
    const diagnostics = new Diagnostics(source);
    const ast = new Parser(diagnostics).parse(new Lexer(diagnostics).tokenize(source));
    return diagnostics.hasErrors ? { diagnostics: diagnostics.all } : { diagnostics: diagnostics.all, ast };
}

/** Lowers to IR. `ir` is absent when anything errored. */
export function compileToIR(source: string): { diagnostics: readonly Diagnostic[]; ir?: IRProgram } {
    return guard(() => {
        const { diagnostics, ir } = analyze(source);
        return diagnostics.hasErrors
            ? { diagnostics: diagnostics.all }
            : { diagnostics: diagnostics.all, ir };
    }, source);
}

/** Compiles every pattern to a regex. `patterns` is absent when anything errored. */
export function compile(
    source: string,
    options: Options = {},
): { diagnostics: readonly Diagnostic[]; patterns?: CompiledPattern[] } {
    return guard(() => {
        const { diagnostics, ir } = analyze(source);
        const flavor = FLAVORS[options.flavor ?? ir.flavor];
        const emitter = new Emitter(flavor, ir.flags, diagnostics);

        // Emit even after earlier errors: a name that failed to resolve should not
        // hide the fact that the target flavor also rejects three other lines.
        const patterns = ir.patterns.map((pattern) => describe(pattern, emitter));

        return diagnostics.hasErrors
            ? { diagnostics: diagnostics.all }
            : { diagnostics: diagnostics.all, patterns };
    }, source);
}

/**
 * Runs the `test` blocks.
 *
 * Patterns are re-emitted for the `js` flavor whatever the file's `@flavor` says,
 * because that is the only engine available here. A pattern JS cannot express is
 * reported `unrunnable` rather than failed, and one that needs only atomic
 * grouping relaxed runs with a note saying so.
 */
export function runTests(
    source: string,
    options: Options = {},
): { diagnostics: readonly Diagnostic[]; results: TestResult[] } {
    return guard(() => {
        const { diagnostics, ir } = analyze(source);
        // A pattern that does not compile cannot meaningfully be tested.
        if (diagnostics.hasErrors) return { diagnostics: diagnostics.all, results: [] };

        // Report against the file's declared flavor too, so `grex test` on a pcre
        // file still says when that file is not valid pcre.
        const declared = new Emitter(FLAVORS[options.flavor ?? ir.flavor], ir.flags, diagnostics);
        for (const pattern of ir.patterns) declared.emit(pattern);

        const results: TestResult[] = [];
        for (const test of ir.tests) {
            const pattern = ir.patterns.find((p) => p.name === test.pattern)!;
            const { regex, reason, note } = jsRegexFor(pattern, ir, source);

            for (const testCase of test.cases) {
                if (!regex) {
                    results.push({
                        pattern: test.pattern,
                        mode: testCase.mode,
                        subject: testCase.subject,
                        status: "unrunnable",
                        detail: reason,
                        note,
                        span: testCase.span,
                    });
                    continue;
                }

                const detail = checkCase(regex, testCase);
                results.push({
                    pattern: test.pattern,
                    mode: testCase.mode,
                    subject: testCase.subject,
                    status: detail === null ? "pass" : "fail",
                    detail,
                    note,
                    span: testCase.span,
                });
            }
        }

        return { diagnostics: diagnostics.all, results };
    }, source);
}

/**
 * A TypeScript module of the compiled patterns, plus a named-group type per
 * pattern that has named captures. This is the seam the `.grex` import support
 * will reuse.
 */
export function emitTypeScript(patterns: readonly CompiledPattern[]): string {
    const lines = ["// Generated from a .grex source by g-rex. Edit the .grex file instead.", ""];

    for (const pattern of patterns) {
        const names = pattern.captures.filter((name): name is string => name !== null);

        if (names.length > 0) {
            lines.push(`export interface ${pattern.name}Groups {`);
            // A group inside `optional { }` can be absent from a successful match.
            for (const name of names) lines.push(`    readonly ${name}?: string;`);
            lines.push("}", "");
        }

        if (pattern.docs) lines.push(`/** ${pattern.docs.replace(/\s+/g, " ").trim()} */`);
        lines.push(`export const ${pattern.name} = /${pattern.source}/${pattern.flags};`, "");
    }

    return lines.join("\n");
}

// --- Internals ---

function describe(pattern: IRPattern, emitter: Emitter): CompiledPattern {
    const { source, flags } = emitter.emit(pattern);
    return {
        name: pattern.name,
        docs: pattern.docs,
        source,
        flags,
        captures: pattern.captures,
    };
}

/** Compiles one pattern for the JS engine, saying why if it cannot be. */
function jsRegexFor(
    pattern: IRPattern,
    ir: IRProgram,
    source: string,
): { regex: RegExp | null; reason: string | null; note: string | null } {
    // A throwaway reporter: a JS shortcoming here is a property of the test run,
    // not a problem with the file, so it must not reach the caller's diagnostics.
    const probe = new Diagnostics(source);
    const emitted = new Emitter(FLAVORS.js, ir.flags, probe, { relaxAtomic: true }).emit(pattern);

    const errors = probe.all.filter((d) => d.severity === "error");
    const warnings = probe.all.filter((d) => d.severity === "warning");
    const note = warnings.length > 0 ? warnings.map((d) => d.message).join("; ") : null;

    if (errors.length > 0)
        return { regex: null, reason: errors.map((d) => d.message).join("; "), note };

    try {
        return { regex: new RegExp(emitted.source, emitted.flags), reason: null, note };
    } catch (err) {
        return { regex: null, reason: `JS rejected the emitted regex: ${(err as Error).message}`, note };
    }
}

/** Null when the case passed, else what went wrong. */
function checkCase(regex: RegExp, testCase: IRProgram["tests"][number]["cases"][number]): string | null {
    // Patterns carry their own anchors, so the subject is searched, not tested whole.
    const match = new RegExp(regex.source, regex.flags).exec(testCase.subject);

    if (testCase.mode === "reject")
        return match === null ? null : `expected no match, matched ${JSON.stringify(match[0])}`;

    if (match === null) return "expected a match, got none";

    for (const { name, text } of testCase.captures) {
        const actual = match.groups?.[name];
        if (actual !== text)
            return `capture \`${name}\` was ${actual === undefined ? "unset" : JSON.stringify(actual)}, expected ${JSON.stringify(text)}`;
    }

    return null;
}

/**
 * The one place a stage-internal invariant failure is turned into a diagnostic.
 * Anything that is not a `GrexError` is a genuine crash and is left to propagate.
 */
function guard<T extends { diagnostics: readonly Diagnostic[] }>(run: () => T, source: string): T {
    try {
        return run();
    } catch (err) {
        if (!(err instanceof GrexError)) throw err;
        const diagnostics = new Diagnostics(source);
        diagnostics.report({
            stage: "emit",
            message: `Internal compiler error: ${err.message}`,
            start: { line: 1, column: 1 },
            end: { line: 1, column: 1 },
        });
        return { diagnostics: diagnostics.all } as T;
    }
}
