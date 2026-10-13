import { expect, test } from "bun:test";

import { Lexer } from "../lexer/Lexer";
import { Parser } from "../parser/Parser";
import { Diagnostics } from "../diagnostics/Diagnostics";
import type { Expr, LetDecl, PatternDecl, Program, TestDecl } from "../parser/AST";

function parse(src: string) {
    const diagnostics = new Diagnostics(src);
    const ast = new Parser(diagnostics).parse(new Lexer(diagnostics).tokenize(src));
    return { ast, diagnostics };
}

/** Parses `src`, failing loudly on any diagnostic. */
function clean(src: string): Program {
    const { ast, diagnostics } = parse(src);
    if (diagnostics.hasErrors) throw new Error(`unexpected diagnostics:\n${diagnostics.format()}`);
    return ast;
}

/** The body of `let x = <src>`, so a bare expression can be asserted on. */
function expr(src: string): Expr {
    const decl = clean(`let x = ${src}`).declarations[0] as LetDecl;
    return decl.body;
}

/** Drops spans, which would drown out the structure being asserted. */
function shape(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(shape);
    if (node && typeof node === "object")
        return Object.fromEntries(
            Object.entries(node)
                .filter(([key]) => key !== "span")
                .map(([key, value]) => [key, shape(value)]),
        );
    return node;
}

test("directives and declaration kinds", () => {
    const ast = clean(`
        @flavor pcre
        @flags unicode
        let a = "x"
        def f(n) = repeat n { digit }
        pattern P { a }
        test P { reject \`q\` }
    `);

    expect(shape(ast.directives)).toEqual([
        { kind: "Directive", name: { kind: "Identifier", text: "flavor" }, args: [{ kind: "Identifier", text: "pcre" }] },
        { kind: "Directive", name: { kind: "Identifier", text: "flags" }, args: [{ kind: "Identifier", text: "unicode" }] },
    ]);
    expect(ast.declarations.map((d) => d.kind)).toEqual([
        "LetDecl",
        "DefDecl",
        "PatternDecl",
        "TestDecl",
    ]);
});

test("a doc comment attaches to the declaration below it", () => {
    const ast = clean(`
        /** the vowels */
        let vowel = ["aeiou"]
        let other = digit
    `);
    const [vowel, other] = ast.declarations as LetDecl[];

    expect(vowel!.docs?.text).toBe("the vowels");
    expect(other!.docs).toBeNull();
});

test("the three quote styles are three different nodes", () => {
    expect(shape(expr('"text"'))).toEqual({ kind: "StringLit", value: "text" });
    expect(shape(expr("'c'"))).toEqual({ kind: "CharLit", value: "c" });
    expect(shape(expr("`\\d`"))).toEqual({ kind: "RawLit", value: "\\d" });
});

test("a `' '` literal holding more than one character is an error", () => {
    expect(parse("let x = 'ab'").diagnostics.hasErrors).toBe(true);
    // An astral character is still one character.
    expect(parse("let x = '\u{1F600}'").diagnostics.hasErrors).toBe(false);
});

test("sets: strings, ranges, names and member paths", () => {
    expect(shape(expr("[digit, 'a'..'f', \"xy\", unicode.Greek]"))).toEqual({
        kind: "SetLit",
        members: [
            { kind: "NameRef", name: { kind: "Identifier", text: "digit" }, path: [], args: null, block: null },
            {
                kind: "Range",
                from: { kind: "CharLit", value: "a" },
                to: { kind: "CharLit", value: "f" },
            },
            { kind: "StringLit", value: "xy" },
            {
                kind: "NameRef",
                name: { kind: "Identifier", text: "unicode" },
                path: [{ kind: "Identifier", text: "Greek" }],
                args: null,
                block: null,
            },
        ],
    });
});

test("set algebra is left-associative at equal precedence", () => {
    const node = expr("letter - vowel & greek");

    // ((letter - vowel) & greek)
    expect(shape(node)).toMatchObject({
        kind: "Algebra",
        op: "&",
        left: { kind: "Algebra", op: "-" },
        right: { kind: "NameRef", name: { text: "greek" } },
    });
});

test("every repeat spelling, including a parameter as the bound", () => {
    const of = (src: string) => {
        const node = expr(src) as Extract<Expr, { kind: "Repeat" }>;
        return { min: shape(node.min), max: shape(node.max), mode: node.mode };
    };
    const num = (value: number) => ({ kind: "NumberLit", value });

    expect(of("repeat { digit }")).toEqual({ min: null, max: null, mode: "greedy" });
    expect(of("repeat 3 { digit }")).toEqual({ min: num(3), max: num(3), mode: "greedy" });
    expect(of("repeat 1.. { digit }")).toEqual({ min: num(1), max: null, mode: "greedy" });
    expect(of("repeat 2..5 { digit }")).toEqual({ min: num(2), max: num(5), mode: "greedy" });
    expect(of("repeat ..5 { digit }")).toEqual({ min: null, max: num(5), mode: "greedy" });
    expect(of("repeat lazy { digit }")).toEqual({ min: null, max: null, mode: "lazy" });
    expect(of("repeat 1.. atomic { digit }")).toEqual({ min: num(1), max: null, mode: "atomic" });

    // A bare name in the count slot is a name, never a call, so the `{` that
    // follows opens the repeat body rather than becoming a block argument.
    expect(of("repeat n { digit }")).toEqual({
        min: { kind: "NameRef", name: { kind: "Identifier", text: "n" }, path: [], args: null, block: null },
        max: { kind: "NameRef", name: { kind: "Identifier", text: "n" }, path: [], args: null, block: null },
        mode: "greedy",
    });
});

test("either accepts juxtaposed and pipe-separated branches alike", () => {
    const branchKinds = (src: string) =>
        (expr(src) as Extract<Expr, { kind: "Either" }>).branches.map((b) => b.kind);

    expect(branchKinds('either { "a" "b" digit }')).toEqual(["StringLit", "StringLit", "NameRef"]);
    expect(branchKinds('either { "a" | "b" | digit }')).toEqual(["StringLit", "StringLit", "NameRef"]);

    // Two branches with no separator, as kitchen-sink writes `bytes`.
    expect(branchKinds('either { "-" repeat 1.. atomic { digit } }')).toEqual(["StringLit", "Repeat"]);

    // An algebra operator binds into one branch instead of splitting it.
    expect(branchKinds("either { letter - vowel }")).toEqual(["Algebra"]);
});

test("calls take value arguments in parens and a block argument trailing", () => {
    expect(shape(expr("digits(2)"))).toEqual({
        kind: "NameRef",
        name: { kind: "Identifier", text: "digits" },
        path: [],
        args: [{ kind: "NumberLit", value: 2 }],
        block: null,
    });

    expect(shape(expr('quoted { "x" }'))).toEqual({
        kind: "NameRef",
        name: { kind: "Identifier", text: "quoted" },
        path: [],
        args: null,
        block: { kind: "Sequence", items: [{ kind: "StringLit", value: "x" }] },
    });
});

test("lookaround, flag scopes, not and ref", () => {
    expect(shape(expr("notBehind { `x` }"))).toMatchObject({ kind: "Lookaround", dir: "behind", negated: true });
    expect(shape(expr("ahead { digit }"))).toMatchObject({ kind: "Lookaround", dir: "ahead", negated: false });
    expect(shape(expr("byLine { start }"))).toMatchObject({ kind: "FlagScope", flag: "byLine" });
    expect(shape(expr("not space"))).toMatchObject({ kind: "Not", body: { kind: "NameRef" } });
    expect(shape(expr("not [' ', '\"']"))).toMatchObject({ kind: "Not", body: { kind: "SetLit" } });
    expect(shape(expr("ref quote"))).toEqual({ kind: "Backref", target: { kind: "Identifier", text: "quote" } });
    expect(shape(expr("ref 1"))).toEqual({ kind: "Backref", target: { kind: "NumberLit", value: 1 } });
});

test("captures may be named or anonymous", () => {
    expect(shape(expr("capture year { digit }"))).toMatchObject({
        kind: "Capture",
        name: { kind: "Identifier", text: "year" },
    });
    expect(shape(expr("capture { digit }"))).toMatchObject({ kind: "Capture", name: null });
});

test("test blocks carry subjects and capture assertions", () => {
    const ast = clean("test P {\n  match `ab` { x: `a`, y: `b` }\n  reject `cd`\n}");
    const decl = ast.declarations[0] as TestDecl;

    expect(shape(decl.cases)).toEqual([
        {
            kind: "TestCase",
            mode: "match",
            subject: { kind: "RawLit", value: "ab" },
            captures: [
                { kind: "CaptureAssert", name: { kind: "Identifier", text: "x" }, text: { kind: "RawLit", value: "a" } },
                { kind: "CaptureAssert", name: { kind: "Identifier", text: "y" }, text: { kind: "RawLit", value: "b" } },
            ],
        },
        { kind: "TestCase", mode: "reject", subject: { kind: "RawLit", value: "cd" }, captures: [] },
    ]);
});

test("`reject` with capture assertions is rejected", () => {
    expect(parse("test P { reject `a` { x: `a` } }").diagnostics.hasErrors).toBe(true);
});

test("a pattern body is a sequence of juxtaposed items", () => {
    const decl = clean('pattern P { start "a" digit end }').declarations[0] as PatternDecl;
    expect(decl.body.items.map((i) => i.kind)).toEqual(["NameRef", "StringLit", "NameRef", "NameRef"]);
});

test("parsing recovers instead of hanging, and keeps the good declarations", () => {
    // `let` with no body, then a well-formed declaration after it.
    const { ast, diagnostics } = parse("let = = =\nlet good = digit");

    expect(diagnostics.hasErrors).toBe(true);
    expect(ast.declarations.map((d) => d.name.text)).toEqual(["good"]);
});

test("garbage input is reported, not thrown", () => {
    const { ast, diagnostics } = parse("} ) ] | & ,");

    expect(diagnostics.hasErrors).toBe(true);
    expect(ast.declarations).toEqual([]);
});
