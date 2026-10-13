import { expect, test } from "bun:test";

import { Lexer } from "../lexer/Lexer";
import { Parser } from "../parser/Parser";
import { IRGenerator } from "../ir/IRGenerator";
import { Diagnostics } from "../diagnostics/Diagnostics";
import { simplify, type CharSet } from "../ir/CharSet";
import type { IRNode, IRProgram } from "../ir/IRNode";

function lower(src: string) {
    const diagnostics = new Diagnostics(src);
    const ir = new IRGenerator(diagnostics).generate(
        new Parser(diagnostics).parse(new Lexer(diagnostics).tokenize(src)),
    );
    return { ir, diagnostics };
}

/** Lowers `src`, failing loudly on any diagnostic. */
function clean(src: string): IRProgram {
    const { ir, diagnostics } = lower(src);
    if (diagnostics.hasErrors) throw new Error(`unexpected diagnostics:\n${diagnostics.format()}`);
    return ir;
}

/** The lowered body of the one pattern in `src`. */
function body(src: string): IRNode {
    return clean(src).patterns[0]!.body;
}

/** The first error message, so a test can assert on what was said. */
function errorOf(src: string): string {
    const { diagnostics } = lower(src);
    const first = diagnostics.all.find((d) => d.severity === "error");
    if (!first) throw new Error("expected an error, got none");
    return first.message;
}

/** Every code-point range of a set, for comparing set algebra by value. */
function rangesOf(set: CharSet): unknown {
    const flat = simplify(set);
    return flat.kind === "ranges" ? flat.ranges.map(([lo, hi]) => [lo, hi]) : flat;
}

const chars = (text: string) => [...text].map((c) => [c.codePointAt(0), c.codePointAt(0)]);

test("directives set the flavor and the flags", () => {
    const ir = clean("@flavor js\n@flags unicode dotAll\npattern P { digit }");

    expect(ir.flavor).toBe("js");
    expect(ir.flags).toEqual({ unicode: true, ignoreCase: false, byLine: false, dotAll: true });
});

test("the flavor defaults to pcre and bad directives are reported", () => {
    expect(clean("pattern P { digit }").flavor).toBe("pcre");
    expect(errorOf("@flavor perl\npattern P { digit }")).toContain("Unknown flavor");
    expect(errorOf("@flags shiny\npattern P { digit }")).toContain("Unknown flag");
    expect(errorOf("@wat x\npattern P { digit }")).toContain("Unknown directive");
});

test("set literals merge into one set, whatever order they are written in", () => {
    const node = body("let hexit = [digit, 'a'..'f', 'A'..'F']\npattern P { hexit }");

    expect(node.kind).toBe("class");
    expect(rangesOf((node as Extract<IRNode, { kind: "class" }>).set)).toEqual([
        [0x30, 0x39],
        [0x41, 0x46],
        [0x61, 0x66],
    ]);
});

test("a string inside a set means its characters", () => {
    const node = body('let vowel = ["aeiou"]\npattern P { vowel }') as Extract<IRNode, { kind: "class" }>;
    expect(rangesOf(node.set)).toEqual(chars("aeiou"));
});

test("difference and intersection of plain ranges are computed exactly", () => {
    const difference = body(
        "let vowel = [\"aeiou\"]\nlet consonant = [ 'a'..'z' ] - vowel\npattern P { consonant }",
    ) as Extract<IRNode, { kind: "class" }>;

    // a-z minus the five vowels leaves six runs.
    expect(rangesOf(difference.set)).toEqual([
        [0x62, 0x64], // b-d
        [0x66, 0x68], // f-h
        [0x6a, 0x6e], // j-n
        [0x70, 0x74], // p-t
        [0x76, 0x7a], // v-z
    ]);

    const intersection = body(
        "let both = [ 'a'..'m' ] & [ 'h'..'z' ]\npattern P { both }",
    ) as Extract<IRNode, { kind: "class" }>;
    expect(rangesOf(intersection.set)).toEqual([[0x68, 0x6d]]);
});

test("an operation against a Unicode property survives for the emitter to lower", () => {
    // `letter` is \p{L} under @flags unicode, so this cannot be folded to ranges.
    const node = body(
        "@flags unicode\nlet greek = letter & unicode.Greek\npattern P { greek }",
    ) as Extract<IRNode, { kind: "class" }>;

    expect(node.set).toEqual({
        kind: "op",
        op: "inter",
        left: { kind: "prop", name: "L", negated: false },
        right: { kind: "prop", name: "Greek", negated: false },
    });
});

test("`letter` is ASCII without @flags unicode and \\p{L} with it", () => {
    const ascii = body("pattern P { letter }") as Extract<IRNode, { kind: "class" }>;
    expect(rangesOf(ascii.set)).toEqual([
        [0x41, 0x5a],
        [0x61, 0x7a],
    ]);

    const unicode = body("@flags unicode\npattern P { letter }") as Extract<IRNode, { kind: "class" }>;
    expect(unicode.set).toEqual({ kind: "prop", name: "L", negated: false });
});

test("set algebra rejects operands that are not sets", () => {
    expect(errorOf('pattern P { word + "ab" }')).toContain('write ["ab"]');
    expect(errorOf("pattern P { word + start }")).toContain("not a set of characters");
});

test("a prelude name may be shadowed by a let", () => {
    const node = body("let digit = ['x']\npattern P { digit }") as Extract<IRNode, { kind: "class" }>;
    expect(rangesOf(node.set)).toEqual(chars("x"));
});

test("a def is expanded at each use site, with its value arguments substituted", () => {
    const node = body("def digits(n) = repeat n { digit }\npattern P { digits(2) digits(4) }");

    expect(node).toMatchObject({
        kind: "seq",
        items: [
            { kind: "repeat", min: 2, max: 2 },
            { kind: "repeat", min: 4, max: 4 },
        ],
    });
});

test("a def's trailing block fills its remaining parameter", () => {
    const node = body('def quoted(inner) = { "\'" inner "\'" }\npattern P { quoted { digit } }');

    expect(node).toMatchObject({
        kind: "seq",
        items: [{ kind: "lit", text: "'" }, { kind: "class" }, { kind: "lit", text: "'" }],
    });
});

test("a let is inlined freshly at every use, so repeated captures each get a number", () => {
    // This is kitchen-sink's `ip`: one octet, then three more inside a repeat.
    const ir = clean(`
        let octet = either { { "25" ['0'..'5'] } digit }
        pattern P { capture a { octet } capture b { octet } }
    `);

    expect(ir.patterns[0]!.captures).toEqual(["a", "b"]);
    // Both captures hold a full copy of the alternation, not a shared reference.
    const [first, second] = (ir.patterns[0]!.body as Extract<IRNode, { kind: "seq" }>).items;
    expect(first).toMatchObject({ kind: "group", index: 1, body: { kind: "alt" } });
    expect(second).toMatchObject({ kind: "group", index: 2, body: { kind: "alt" } });
});

test("wrong argument counts are reported", () => {
    expect(errorOf("def f(a, b) = { a b }\npattern P { f(digit) }")).toContain("takes 2 arguments, got 1");
    expect(errorOf("def f(a) = { a }\npattern P { f(digit, letter) }")).toContain("takes 1 argument, got 2");
    expect(errorOf("let x = digit\npattern P { x(1) }")).toContain("is a `let` and takes no arguments");
});

test("a cycle in the let/def graph is a hard error", () => {
    expect(errorOf("let a = b\nlet b = a\npattern P { a }")).toContain("defined in terms of itself");
    expect(errorOf("def f(x) = { f(x) }\npattern P { f(digit) }")).toContain("defined in terms of itself");
    expect(errorOf("let a = a\npattern P { a }")).toContain("defined in terms of itself");

    // The rule is about the declarations, so an unused cycle still breaks the file.
    expect(errorOf("let a = b\nlet b = a\npattern P { digit }")).toContain("defined in terms of itself");

    // One cycle, one diagnostic, however many sites reach it.
    const { diagnostics } = lower("let a = b\nlet b = a\npattern P { a a a }");
    expect(diagnostics.all.filter((d) => d.message.includes("in terms of itself"))).toHaveLength(1);
});

test("a def nested inside itself is not a cycle", () => {
    // `wrap { wrap { ... } }` re-enters `wrap`, but the expansion terminates: the
    // declaration graph has no edge from `wrap` to itself.
    const ir = clean('def wrap(x) = { "<" x ">" }\npattern P { wrap { wrap { digit } } }');

    expect(ir.patterns[0]!.body).toMatchObject({
        kind: "seq",
        items: [
            { kind: "lit", text: "<" },
            { kind: "seq", items: [{ kind: "lit", text: "<" }, { kind: "class" }, { kind: "lit", text: ">" }] },
            { kind: "lit", text: ">" },
        ],
    });
});

test("a def parameter shadows a macro of the same name", () => {
    // `x` here is the parameter, not the `let`, so this is not a cycle either.
    const ir = clean("let x = digit\ndef f(x) = { x }\npattern P { f(letter) }");
    expect(ir.patterns[0]!.body.kind).toBe("class");
});

test("captures are numbered left to right, nested ones included", () => {
    const ir = clean("pattern P { capture a { capture b { digit } } capture { digit } }");
    expect(ir.patterns[0]!.captures).toEqual(["a", "b", null]);
});

test("a duplicate capture name is reported", () => {
    expect(errorOf("pattern P { capture a { digit } capture a { digit } }")).toContain("Duplicate capture name");
});

test("backreferences resolve by name and by number, and are range-checked", () => {
    const node = body("pattern P { capture q { digit } ref q ref 1 }");

    expect(node).toMatchObject({
        kind: "seq",
        items: [{ kind: "group", index: 1 }, { kind: "backref", name: "q", index: 1 }, { kind: "backref", name: null, index: 1 }],
    });

    expect(errorOf("pattern P { capture q { digit } ref 2 }")).toContain("No group 2 to reference");
    expect(errorOf("pattern P { capture q { digit } ref nope }")).toContain("No capture named");
});

test("repeat bounds come from numbers or from a def parameter", () => {
    expect(body("pattern P { repeat { digit } }")).toMatchObject({ min: 0, max: null });
    expect(body("pattern P { repeat 1.. { digit } }")).toMatchObject({ min: 1, max: null });
    expect(body("pattern P { repeat ..5 { digit } }")).toMatchObject({ min: 0, max: 5 });
    expect(body("pattern P { optional { digit } }")).toMatchObject({ min: 0, max: 1 });

    expect(errorOf("pattern P { repeat 5..2 { digit } }")).toContain("counts backwards");
    expect(errorOf("let n = digit\npattern P { repeat n { digit } }")).toContain("must be a number");
});

test("unknown names and misused namespaces are reported", () => {
    expect(errorOf("pattern P { nope }")).toContain("Unknown name");
    expect(errorOf("pattern P { unicode }")).toContain("`unicode` is a namespace");
    expect(errorOf("pattern P { digit.Greek }")).toContain("has no members");
    expect(errorOf("pattern P { 5 }")).toContain("only meaningful as a repeat count");
});

test("a test naming no pattern, or an unknown capture, is reported", () => {
    expect(errorOf("pattern P { digit }\ntest Q { reject `x` }")).toContain("No pattern named");
    expect(errorOf("pattern P { digit }\ntest P { match `1` { nope: `1` } }")).toContain("has no capture named");
});

test("test cases carry over to the IR with their raw subjects intact", () => {
    const ir = clean("pattern P { capture a { digit } }\ntest P { match `1` { a: `1` } \n reject `x` }");

    expect(ir.tests).toHaveLength(1);
    expect(ir.tests[0]!.cases.map((c) => [c.mode, c.subject])).toEqual([
        ["match", "1"],
        ["reject", "x"],
    ]);
    expect(ir.tests[0]!.cases[0]!.captures).toEqual([{ name: "a", text: "1" }]);
});
