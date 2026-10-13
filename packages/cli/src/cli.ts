#!/usr/bin/env bun
/**
 * @fileoverview The `grex` command line.
 *
 * Arguments are parsed with `node:util`'s `parseArgs` rather than a library: the
 * whole project has no runtime dependencies and seven subcommands do not justify
 * starting now.
 */

import { parseArgs } from "node:util";
import { basename } from "node:path";

import {
    Diagnostics,
    FLAVORS,
    checkSource,
    compile,
    compileToIR,
    emitTypeScript,
    parse,
    runTests,
    tokenize,
    type Diagnostic,
    type FlavorName,
} from "@g-rex/core";

const USAGE = `grex — compile g-rex sources to regular expressions

usage: grex <command> <file> [options]

commands:
  compile <file>   Compile every pattern and print it
  test <file>      Run the file's \`test\` blocks
  check <file>     Report problems without producing output
  ir <file>        Print the lowered intermediate representation as JSON
  ast <file>       Print the parse tree as JSON
  tokens <file>    Print the token stream as JSON
  help             Show this message

options:
  --flavor <name>  Override the file's \`@flavor\`: pcre, js or re2
  --json           Machine-readable output (compile)
  --emit ts        Write a TypeScript module instead of plain text (compile)
  -o, --out <file> Write to a file instead of stdout
exit codes:
  0  clean
  1  diagnostics were reported, or a test failed
  2  bad usage, or the file could not be read`;

const COMMANDS = new Set(["compile", "test", "check", "ir", "ast", "tokens", "help"]);

function fail(message: string): never {
    console.error(`grex: ${message}`);
    process.exit(2);
}

const { values, positionals } = (() => {
    try {
        return parseArgs({
            args: process.argv.slice(2),
            allowPositionals: true,
            options: {
                flavor: { type: "string" },
                json: { type: "boolean", default: false },
                emit: { type: "string" },
                out: { type: "string", short: "o" },
                help: { type: "boolean", short: "h", default: false },
            },
        });
    } catch (err) {
        return fail((err as Error).message);
    }
})();

const [command, file] = positionals;

if (values.help || command === "help" || command === undefined) {
    console.log(USAGE);
    process.exit(command === undefined && !values.help ? 2 : 0);
}

if (!COMMANDS.has(command)) fail(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
if (!file) fail(`${command} needs a file\n\n${USAGE}`);
if (values.emit !== undefined && values.emit !== "ts") fail(`--emit takes "ts", got ${JSON.stringify(values.emit)}`);

const flavor = values.flavor as FlavorName | undefined;
if (flavor !== undefined && !(flavor in FLAVORS))
    fail(`unknown flavor ${JSON.stringify(flavor)}, expected ${Object.keys(FLAVORS).join(", ")}`);

const source = await Bun.file(file)
    .text()
    .catch(() => fail(`cannot read ${file}`));

/** Re-renders diagnostics with their source line, the way the compiler would. */
function report(diagnostics: readonly Diagnostic[]): boolean {
    if (diagnostics.length === 0) return false;

    const rendered = new Diagnostics(source);
    for (const diagnostic of diagnostics) rendered.report(diagnostic);
    console.error(rendered.format());

    return rendered.hasErrors;
}

async function write(text: string) {
    if (values.out) {
        await Bun.write(values.out, text);
        console.log(`Wrote ${values.out}`);
    } else {
        console.log(text);
    }
}

/** `log.grex` and `log.grex.txt` both suggest `log.ts`. */
function defaultOutName(): string {
    return `${basename(file!).replace(/\.grex(\.txt)?$/, "")}.ts`;
}

switch (command) {
    case "check": {
        const diagnostics = checkSource(source, { flavor });
        if (report(diagnostics)) process.exit(1);
        if (diagnostics.length === 0) console.log("No problems found.");
        break;
    }

    case "compile": {
        const { diagnostics, patterns } = compile(source, { flavor });
        const hadErrors = report(diagnostics);
        if (!patterns) process.exit(hadErrors ? 1 : 2);

        if (values.emit === "ts") {
            if (!values.out) console.error(`grex: writing to stdout; use -o ${defaultOutName()} to save it`);
            await write(emitTypeScript(patterns));
        } else if (values.json) {
            await write(JSON.stringify({ file, flavor: flavor ?? null, patterns }, null, 2));
        } else {
            const width = Math.max(0, ...patterns.map((p) => p.name.length));
            await write(patterns.map((p) => `${p.name.padEnd(width)}  /${p.source}/${p.flags}`).join("\n"));
        }
        break;
    }

    case "test": {
        const { diagnostics, results } = runTests(source, { flavor });
        const hadErrors = report(diagnostics);

        for (const result of results) {
            const label = result.status === "pass" ? "pass" : result.status === "fail" ? "FAIL" : "SKIP";
            console.log(`${label}  ${result.pattern} ${result.mode} ${JSON.stringify(result.subject)}`);
            if (result.detail) console.log(`      ${result.detail}`);
        }

        // One note covers the whole run, so say it once rather than per case.
        const note = results.find((r) => r.note)?.note;
        if (note) console.log(`\nnote: ${note}`);

        const failed = results.filter((r) => r.status === "fail").length;
        const skipped = results.filter((r) => r.status === "unrunnable").length;
        const passed = results.length - failed - skipped;
        console.log(`\n${passed} passed, ${failed} failed, ${skipped} not runnable`);

        process.exit(hadErrors || failed > 0 || skipped > 0 ? 1 : 0);
    }

    case "ir": {
        const { diagnostics, ir } = compileToIR(source);
        const hadErrors = report(diagnostics);
        if (!ir) process.exit(hadErrors ? 1 : 2);
        await write(JSON.stringify(ir, null, 2));
        break;
    }

    case "ast": {
        const { diagnostics, ast } = parse(source);
        const hadErrors = report(diagnostics);
        if (!ast) process.exit(hadErrors ? 1 : 2);
        await write(JSON.stringify(ast, null, 2));
        break;
    }

    case "tokens": {
        const { diagnostics, tokens } = tokenize(source);
        const hadErrors = report(diagnostics);
        await write(JSON.stringify(tokens, null, 2));
        if (hadErrors) process.exit(1);
        break;
    }
}
