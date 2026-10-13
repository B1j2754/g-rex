/**
 * @fileoverview The g-rex VS Code extension: live diagnostics from the compiler.
 *
 * There is no language server. `checkSource` is a pure string-to-diagnostics
 * function that runs the whole pipeline, flavor checks included, so the editor
 * reports exactly what `grex check` would.
 */

import * as vscode from "vscode";

import { checkSource, type Diagnostic } from "@g-rex/core";

/** Long enough that typing a word does not recompile seven times. */
const DEBOUNCE_MS = 250;

const SEVERITY: Record<Diagnostic["severity"], vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
};

export function activate(context: vscode.ExtensionContext) {
    const collection = vscode.languages.createDiagnosticCollection("grex");
    const pending = new Map<string, ReturnType<typeof setTimeout>>();

    function check(document: vscode.TextDocument) {
        if (document.languageId !== "grex") return;
        collection.set(document.uri, checkSource(document.getText()).map(toVsCode));
    }

    function schedule(document: vscode.TextDocument) {
        if (document.languageId !== "grex") return;

        const key = document.uri.toString();
        const existing = pending.get(key);
        if (existing) clearTimeout(existing);

        pending.set(
            key,
            setTimeout(() => {
                pending.delete(key);
                check(document);
            }, DEBOUNCE_MS),
        );
    }

    function forget(document: vscode.TextDocument) {
        const key = document.uri.toString();
        const existing = pending.get(key);
        if (existing) clearTimeout(existing);
        pending.delete(key);
        collection.delete(document.uri);
    }

    context.subscriptions.push(
        collection,
        vscode.workspace.onDidOpenTextDocument(check),
        vscode.workspace.onDidSaveTextDocument(check),
        vscode.workspace.onDidChangeTextDocument((event) => schedule(event.document)),
        vscode.workspace.onDidCloseTextDocument(forget),
        { dispose: () => pending.forEach(clearTimeout) },
    );

    // Files already open when the extension activates.
    for (const document of vscode.workspace.textDocuments) check(document);
}

export function deactivate() {
    // Everything is registered in `context.subscriptions`, so VS Code disposes it.
}

/** Compiler positions are 1-based with an exclusive end; VS Code's are 0-based. */
function toVsCode(diagnostic: Diagnostic): vscode.Diagnostic {
    const startLine = Math.max(0, diagnostic.start.line - 1);
    const startColumn = Math.max(0, diagnostic.start.column - 1);
    const endLine = Math.max(startLine, diagnostic.end.line - 1);
    // A zero-width range renders as nothing, so always underline at least one character.
    const endColumn =
        endLine === startLine
            ? Math.max(startColumn + 1, diagnostic.end.column - 1)
            : Math.max(0, diagnostic.end.column - 1);

    const result = new vscode.Diagnostic(
        new vscode.Range(startLine, startColumn, endLine, endColumn),
        diagnostic.message,
        SEVERITY[diagnostic.severity],
    );
    result.source = `grex (${diagnostic.stage})`;

    return result;
}
