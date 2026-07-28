/**
 * @fileoverview Error collection for a single g-rex compilation run.
 */

import { type TokPos } from "../lexer/Token";

export interface Diagnostic {
    stage: string;
    message: string;
    start: TokPos;
    end: TokPos;
}

export class Diagnostics {
    private readonly items: Diagnostic[] = [];

    report(diagnostic: Diagnostic) {
        this.items.push(diagnostic);
    }

    get all(): readonly Diagnostic[] {
        return this.items;
    }

    get hasErrors(): boolean {
        return this.items.length > 0;
    }

    format(): string {
        return this.items
            .map((d) => `${d.stage}: ${d.message} (${d.start.line}:${d.start.column})`)
            .join("\n");
    }
}
