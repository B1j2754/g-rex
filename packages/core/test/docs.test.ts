/**
 * @fileoverview Compiles every g-rex example in the documentation.
 *
 * A tutorial with examples that do not compile is worse than no tutorial, and
 * prose rots more quietly than code. Every fenced ```grex block in LEARN.md and
 * README.md is compiled here, and any `test` block inside one is run, so an
 * example that stops working fails the suite rather than misleading a reader.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

import { compile, runTests, type Diagnostic } from "../index";

const ROOT = join(import.meta.dir, "..", "..", "..");
const DOCS = ["LEARN.md", "README.md"];

interface Block {
    doc: string;
    line: number;
    source: string;
}

/** Every ```grex fenced block in `text`, with the line it starts on. */
function blocksIn(doc: string, text: string): Block[] {
    const blocks: Block[] = [];
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.trim() !== "```grex") continue;

        const start = i + 1;
        const body: string[] = [];
        for (i = start; i < lines.length && lines[i]!.trim() !== "```"; i++) body.push(lines[i]!);

        blocks.push({ doc, line: start, source: body.join("\n") });
    }

    return blocks;
}

const blocks: Block[] = [];
for (const doc of DOCS) {
    const text = await Bun.file(join(ROOT, doc)).text();
    blocks.push(...blocksIn(doc, text));
}

function errorsOf(diagnostics: readonly Diagnostic[]): string[] {
    return diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => `${d.start.line}:${d.start.column} ${d.message}`);
}

test("the documentation actually contains examples", () => {
    // A regex that stopped matching would otherwise make every test below vacuous.
    expect(blocks.length).toBeGreaterThan(10);
});

for (const block of blocks) {
    const label = `${block.doc}:${block.line}`;

    test(`${label} compiles`, () => {
        const { diagnostics, patterns } = compile(block.source);

        expect(errorsOf(diagnostics)).toEqual([]);
        // Every example declares something; a block that compiles to nothing is
        // either a snippet that drifted or a heading that lost its content.
        expect(patterns!.length).toBeGreaterThan(0);
    });

    // Only the examples that claim to be tested get their claims checked.
    if (!/^\s*test\s/m.test(block.source)) continue;

    test(`${label} passes its own test blocks`, () => {
        const { results } = runTests(block.source);

        expect(results.length).toBeGreaterThan(0);
        expect(
            results
                .filter((r) => r.status !== "pass")
                .map((r) => `${r.pattern} ${r.mode} ${JSON.stringify(r.subject)}: ${r.status} — ${r.detail}`),
        ).toEqual([]);
    });
}
