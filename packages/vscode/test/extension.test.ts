/**
 * @fileoverview Drives the extension against a stand-in `vscode` module.
 *
 * The range mapping is the part worth guarding: compiler positions are 1-based
 * with an exclusive end, VS Code's are 0-based, and an off-by-one there puts the
 * squiggle under the wrong text with nothing to notice it.
 */

import { beforeAll, expect, mock, test } from "bun:test";

interface StubRange {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

interface StubDiagnostic {
    range: StubRange;
    message: string;
    severity: string;
    source?: string;
}

interface Collection {
    entries: Map<string, StubDiagnostic[]>;
    set(uri: unknown, diagnostics: StubDiagnostic[]): void;
    delete(uri: unknown): void;
    dispose(): void;
}

const handlers: Record<string, (arg: never) => void> = {};
const collections: Collection[] = [];

const register = (name: string) => (fn: (arg: never) => void) => {
    handlers[name] = fn;
    return { dispose() {} };
};

mock.module("vscode", () => ({
    Diagnostic: class {
        constructor(
            public range: StubRange,
            public message: string,
            public severity: string,
        ) {}
    },
    Range: class {
        start: { line: number; character: number };
        end: { line: number; character: number };
        constructor(startLine: number, startColumn: number, endLine: number, endColumn: number) {
            this.start = { line: startLine, character: startColumn };
            this.end = { line: endLine, character: endColumn };
        }
    },
    DiagnosticSeverity: { Error: "error", Warning: "warning" },
    languages: {
        createDiagnosticCollection(): Collection {
            const entries = new Map<string, StubDiagnostic[]>();
            const collection: Collection = {
                entries,
                set: (uri, diagnostics) => entries.set(String(uri), diagnostics),
                delete: (uri) => entries.delete(String(uri)),
                dispose: () => {},
            };
            collections.push(collection);
            return collection;
        },
    },
    workspace: {
        textDocuments: [],
        onDidOpenTextDocument: register("open"),
        onDidSaveTextDocument: register("save"),
        onDidChangeTextDocument: register("change"),
        onDidCloseTextDocument: register("close"),
    },
}));

const URI = "file:///x.grex";
const document = (text: string, languageId = "grex") => ({
    languageId,
    uri: URI,
    getText: () => text,
});

let collection: Collection;
const subscriptions: { dispose(): void }[] = [];

beforeAll(async () => {
    const extension = await import("../src/extension");
    extension.activate({ subscriptions } as never);
    collection = collections[0]!;
});

/** Opens a document holding `text` and returns what landed in the collection. */
function diagnosticsFor(text: string): StubDiagnostic[] {
    handlers.open!(document(text) as never);
    return collection.entries.get(URI) ?? [];
}

test("activation registers its disposables", () => {
    // The collection itself, four document events, and the timer cleanup.
    expect(subscriptions.length).toBe(6);
    expect(collections).toHaveLength(1);
});

test("a clean file produces no diagnostics", () => {
    expect(diagnosticsFor("pattern P { digit }")).toEqual([]);
});

test("a flavor problem lands on the line that wrote it, 0-based", () => {
    const [diagnostic, ...rest] = diagnosticsFor("@flavor js\npattern P {\n  textStart\n}");

    expect(rest).toEqual([]);
    // `textStart` is at line 3, column 3 one-based, so line 2, character 2 here.
    expect(diagnostic!.range.start).toEqual({ line: 2, character: 2 });
    expect(diagnostic!.range.end).toEqual({ line: 2, character: 11 });
    expect(diagnostic!.severity).toBe("error");
    expect(diagnostic!.source).toBe("grex (emit)");
    expect(diagnostic!.message).toContain("js flavor cannot express");
});

test("the whole pipeline reports, not just syntax", () => {
    expect(diagnosticsFor("pattern P { nope }")[0]!.source).toBe("grex (ir)");
    expect(diagnosticsFor("let = =")[0]!.source).toBe("grex (parser)");
    expect(diagnosticsFor('pattern P { "a }')[0]!.source).toBe("grex (lexer)");
});

test("a range is never zero-width, or it would render as nothing", () => {
    for (const source of ["pattern P { nope }", "let = =", "@flavor js\npattern P { textStart }"])
        for (const diagnostic of diagnosticsFor(source)) {
            const { start, end } = diagnostic.range;
            expect(end.line > start.line || end.character > start.character).toBe(true);
        }
});

test("other languages are left alone", () => {
    collection.entries.clear();
    handlers.open!(document("nonsense {", "plaintext") as never);
    expect(collection.entries.size).toBe(0);
});

test("closing a document clears its diagnostics", () => {
    diagnosticsFor("pattern P { nope }");
    expect(collection.entries.has(URI)).toBe(true);

    handlers.close!(document("pattern P { nope }") as never);
    expect(collection.entries.has(URI)).toBe(false);
});

test("a change is debounced rather than checked immediately", async () => {
    collection.entries.clear();
    handlers.change!({ document: document("pattern P { nope }") } as never);

    // Nothing yet: the whole point is not to recompile on every keystroke.
    expect(collection.entries.size).toBe(0);

    await Bun.sleep(400);
    expect(collection.entries.get(URI)).toHaveLength(1);
});
