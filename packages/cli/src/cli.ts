#!/usr/bin/env bun
import { Lexer, Diagnostics } from "@g-rex/core";

const file = process.argv[2];
if (!file) {
    console.error("usage: grex <file.grex>");
    process.exit(2);
}

const diagnostics = new Diagnostics();
const tokens = new Lexer(diagnostics).tokenize(await Bun.file(file).text());

console.log(JSON.stringify({ file, tokens, diagnostics: diagnostics.all }, null, 2));
process.exit(diagnostics.hasErrors ? 1 : 0);
