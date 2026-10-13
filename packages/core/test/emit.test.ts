import { expect, test } from "bun:test";

import { compile, type CompiledPattern, type FlavorName } from "../index";

const FLAVOR_NAMES: FlavorName[] = ["pcre", "js", "re2"];

function compileOne(src: string, flavor: FlavorName = "pcre") {
    const { diagnostics, patterns } = compile(src, { flavor });
    return { diagnostics, pattern: patterns?.[0] as CompiledPattern | undefined };
}

/** The emitted regex for `pattern P { <body> }`, failing loudly on a diagnostic. */
function re(body: string, flavor: FlavorName = "pcre", preamble = ""): string {
    const { diagnostics, pattern } = compileOne(`${preamble}\npattern P { ${body} }`, flavor);
    if (!pattern) throw new Error(`did not compile:\n${diagnostics.map((d) => d.message).join("\n")}`);
    return pattern.source;
}

function flagsOf(body: string, flavor: FlavorName = "pcre", preamble = ""): string {
    const { pattern } = compileOne(`${preamble}\npattern P { ${body} }`, flavor);
    return pattern!.flags;
}

/** The flavors that reject `body`, in a stable order. */
function rejectedBy(body: string, preamble = ""): FlavorName[] {
    return FLAVOR_NAMES.filter(
        (flavor) =>
            compile(`${preamble}\npattern P { ${body} }`, { flavor }).diagnostics.some(
                (d) => d.severity === "error",
            ),
    );
}

test("literal text is escaped, including the `/` a regex literal would end on", () => {
    expect(re('"a.b*c"')).toBe("a\\.b\\*c");
    expect(re('"HTTP/1.1"')).toBe("HTTP\\/1\\.1");
    expect(re('"(a|b)[c]{d}"')).toBe("\\(a\\|b\\)\\[c\\]\\{d\\}");
    expect(re('"\\n\\t"')).toBe("\\n\\t");
});

test("raw literals pass through untouched", () => {
    expect(re("`\\\\`")).toBe("\\\\");
    expect(re("`[0-9a-f]`")).toBe("[0-9a-f]");
});

test("a raw literal holding an alternation is grouped where it matters", () => {
    // Left bare it would swallow the rest of the sequence.
    expect(re('{ `a|b` "c" }')).toBe("(?:a|b)c");
    // One atom needs no wrapper.
    expect(re('{ `\\d` "c" }')).toBe("\\dc");
});

test("the prelude sets print as their shorthands", () => {
    expect(re("digit")).toBe("\\d");
    expect(re("word")).toBe("\\w");
    expect(re("space")).toBe("\\s");
    expect(re("any")).toBe(".");

    expect(re("not digit")).toBe("\\D");
    expect(re("not word")).toBe("\\W");
    expect(re("not space")).toBe("\\S");
});

test("anchors", () => {
    expect(re("start")).toBe("^");
    expect(re("end")).toBe("$");
    expect(re("textStart")).toBe("\\A");
    expect(re("textEnd")).toBe("\\z");
    expect(re("wordBoundary")).toBe("\\b");
    expect(re("notWordBoundary")).toBe("\\B");

    // `\R` has no equivalent outside pcre, so an explicit alternation stands in.
    expect(re("linebreak")).toBe("\\R");
    expect(re("linebreak", "js")).toContain("\\r\\n|");
});

test("character classes take the shortest correct spelling", () => {
    expect(re("['a']")).toBe("a"); // one character needs no brackets
    expect(re("['a','b']")).toBe("[ab]"); // two adjacent are shorter written out
    expect(re("['a'..'f']")).toBe("[a-f]");
    expect(re('["aeiou"]')).toBe("[aeiou]");
    expect(re("[digit, 'a'..'f', 'A'..'F']")).toBe("[0-9A-Fa-f]");

    // Inside a class, only `] \\ ^ -` need escaping.
    expect(re("['-', '.', ']']")).toBe("[\\-.\\]]");
});

test("a set that excludes a few characters emits as a negated class", () => {
    // Not the complement spelled out, which would run to U+10FFFF.
    expect(re("not [' ', '\"']")).toBe('[^ "]');
    expect(re("not ['a'..'z']")).toBe("[^a-z]");
});

test("quantifiers collapse to their shorthands", () => {
    expect(re("repeat { digit }")).toBe("\\d*");
    expect(re("repeat 1.. { digit }")).toBe("\\d+");
    expect(re("optional { digit }")).toBe("\\d?");
    expect(re("repeat 3 { digit }")).toBe("\\d{3}");
    expect(re("repeat 2.. { digit }")).toBe("\\d{2,}");
    expect(re("repeat 2..5 { digit }")).toBe("\\d{2,5}");
    // Exactly one of something is just that something.
    expect(re("repeat 1 { digit }")).toBe("\\d");

    expect(re("repeat lazy { digit }")).toBe("\\d*?");
    expect(re("repeat 1.. lazy { digit }")).toBe("\\d+?");
    expect(re("repeat 1.. atomic { digit }")).toBe("(?>\\d+)");
    // `greedy` is the default, so it adds nothing.
    expect(re("repeat 1.. greedy { digit }")).toBe("\\d+");
});

test("a multi-atom quantifier body is grouped, a single atom is not", () => {
    expect(re('repeat 1.. { "ab" }')).toBe("(?:ab)+");
    expect(re('repeat 1.. { "a" }')).toBe("a+");
    expect(re("repeat 1.. { either { digit letter } }")).toBe("(?:\\d|[A-Za-z])+");
});

test("alternation is grouped inside a sequence but not at the top level", () => {
    expect(re('either { "a" "b" }')).toBe("a|b");
    expect(re('{ either { "a" "b" } "c" }')).toBe("(?:a|b)c");
    // `( )` is precedence only, so it leaves nothing of its own behind.
    expect(re('{ ("a") "b" }')).toBe("ab");
});

test("captures, lookaround, scoped flags and backreferences", () => {
    expect(re("capture year { digit }")).toBe("(?<year>\\d)");
    expect(re("capture { digit }")).toBe("(\\d)");

    expect(re("ahead { digit }")).toBe("(?=\\d)");
    expect(re("notAhead { digit }")).toBe("(?!\\d)");
    expect(re("behind { digit }")).toBe("(?<=\\d)");
    expect(re("notBehind { digit }")).toBe("(?<!\\d)");

    expect(re('ignoreCase { "get" }')).toBe("(?i:get)");
    expect(re("byLine { start }")).toBe("(?m:^)");
    expect(re("dotAll { any }")).toBe("(?s:.)");

    expect(re("{ capture q { digit } ref q }")).toBe("(?<q>\\d)\\k<q>");
    expect(re("{ capture { digit } ref 1 }")).toBe("(\\d)\\1");
});

test("an unfoldable set operation becomes a guard, or class set ops under js", () => {
    const preamble = "@flags unicode\nlet greek = letter & unicode.Greek";

    // pcre has no `[a&&b]`, so the intersection is spelled as a lookahead guard.
    expect(re("greek", "pcre", preamble)).toBe("(?=\\p{Greek})\\p{L}");
    // js has class set operations, and needs scripts qualified. A property stands
    // alone as an operand; only a range list has to be bracketed to be one.
    expect(re("greek", "js", preamble)).toBe("[\\p{L}&&\\p{Script=Greek}]");

    const difference = "@flags unicode\nlet consonant = letter - [\"aeiou\"]";
    expect(re("consonant", "pcre", difference)).toBe("(?![aeiou])\\p{L}");
    expect(re("consonant", "js", difference)).toBe("[\\p{L}--[aeiou]]");
});

test("flags come from @flags, plus whatever a Unicode property forces", () => {
    expect(flagsOf("digit")).toBe("");
    expect(flagsOf("digit", "pcre", "@flags unicode")).toBe("u");
    expect(flagsOf("digit", "pcre", "@flags ignoreCase byLine dotAll")).toBe("ims");

    // js needs a Unicode flag to accept \p{...} at all, even without @flags unicode.
    expect(flagsOf("unicode.Greek", "js")).toBe("u");
    expect(flagsOf("unicode.Greek", "pcre")).toBe("");

    // Class set operations need `v` rather than `u`.
    expect(flagsOf("greek", "js", "@flags unicode\nlet greek = letter & unicode.Greek")).toBe("v");
});

test("each flavor rejects exactly what it cannot express", () => {
    expect(rejectedBy("textStart")).toEqual(["js"]);
    expect(rejectedBy("textEnd")).toEqual(["js"]);
    expect(rejectedBy("repeat 1.. atomic { digit }")).toEqual(["js", "re2"]);

    expect(rejectedBy("ahead { digit }")).toEqual(["re2"]);
    expect(rejectedBy("notAhead { digit }")).toEqual(["re2"]);
    expect(rejectedBy("behind { digit }")).toEqual(["re2"]);
    expect(rejectedBy("notBehind { digit }")).toEqual(["re2"]);
    expect(rejectedBy("{ capture q { digit } ref q }")).toEqual(["re2"]);
    expect(rejectedBy("{ capture { digit } ref 1 }")).toEqual(["re2"]);

    // re2 has neither class set operations nor lookahead to guard with.
    expect(rejectedBy("greek", "@flags unicode\nlet greek = letter & unicode.Greek")).toEqual(["re2"]);

    // What every flavor can do.
    expect(rejectedBy("{ start repeat 1.. { digit } ignoreCase { \"x\" } end }")).toEqual([]);
});

test("an unsupported construct still reports a span pointing at the source", () => {
    const { diagnostics } = compile("pattern P {\n  textStart\n}", { flavor: "js" });
    const error = diagnostics.find((d) => d.severity === "error")!;

    expect(error.stage).toBe("emit");
    expect(error.start).toEqual({ line: 2, column: 3 });
    expect(error.message).toContain("js flavor cannot express");
});

test("every emitted pattern is a regex the JS engine accepts", () => {
    const src = `
        @flags unicode
        let hexit = [digit, 'a'..'f', 'A'..'F']
        def digits(n) = repeat n { digit }
        pattern P {
            start
            capture q { ["\\"'"] }
            repeat 1.. lazy { not space }
            optional { "?" capture n { digits(3) } }
            either { hexit | "x" }
            ignoreCase { "get" }
            ref q
            end
        }
    `;
    const { diagnostics, patterns } = compile(src, { flavor: "js" });

    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(() => new RegExp(patterns![0]!.source, patterns![0]!.flags)).not.toThrow();
});
