/**
 * @fileoverview Error collection for a single g-rex compilation run.
 *
 * Every stage is handed the same instance and pushes into it rather than returning
 * errors, so one run surfaces lexer, parser, lowering and emit problems together
 * instead of hiding everything behind the first failure.
 */

import { type TokPos } from "../lexer/Token";
import { pc } from "../utils/colors";

export type Stage = "lexer" | "parser" | "ir" | "emit" | "test";
export type Severity = "error" | "warning";

export interface Diagnostic {
    stage: Stage;
    /** "warning" is reported but never blocks a build; only "error" does. */
    severity: Severity;
    message: string;
    start: TokPos;
    /** Exclusive, matching `Tok.end`. */
    end: TokPos;
}

/** A stage-internal invariant violation: a compiler bug, not a problem with the source. */
export class GrexError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GrexError";
    }
}

export class Diagnostics {
    private readonly items: Diagnostic[] = [];
    private readonly lines: string[];

    /** `source` is only used to render the offending line in `format()`. */
    constructor(source: string = "") {
        this.lines = source.split("\n");
    }

    report(diagnostic: Omit<Diagnostic, "severity"> & { severity?: Severity }) {
        this.items.push({ severity: "error", ...diagnostic });
    }

    get all(): readonly Diagnostic[] {
        return this.items;
    }

    get hasErrors(): boolean {
        return this.items.some((d) => d.severity === "error");
    }

    /**
     * Reads in source order, which is not report order: a `let` is lowered where
     * it is used, so its diagnostics arrive after those of the line using it.
     */
    format(): string {
        return [...this.items]
            .sort((a, b) => a.start.line - b.start.line || a.start.column - b.start.column)
            .map((d) => this.formatOne(d))
            .join("\n");
    }

    private formatOne(d: Diagnostic): string {
        const warn = d.severity === "warning";
        const tint = warn ? pc.yellow : pc.red;
        const header =
            `${tint(pc.bold(`${d.stage} ${warn ? "warning" : "error"}:`))} ${d.message}\n` +
            `  at ${pc.cyan(`line ${d.start.line}, column ${d.start.column}`)}\n`;

        const line = this.lines[d.start.line - 1];
        if (line === undefined) return header; // no source text, or a span past its end

        const gutterWidth = String(this.lines.length).length;
        const pad = " ".repeat(gutterWidth);
        const bar = pc.gray("|");

        // Carets clamped to the visible line; a multi-line span underlines to end of line.
        const available = Math.max(1, line.length - (d.start.column - 1));
        const wanted = d.end.line === d.start.line ? d.end.column - d.start.column : available;
        const carets = Math.min(Math.max(1, wanted), available);

        return (
            header +
            `  ${pad} ${bar}\n` +
            `  ${pc.gray(String(d.start.line).padStart(gutterWidth))} ${bar} ${pc.white(line)}\n` +
            `  ${pad} ${bar} ${" ".repeat(d.start.column - 1)}${tint("^".repeat(carets))}\n`
        );
    }
}
