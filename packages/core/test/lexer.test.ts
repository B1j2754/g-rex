import { expect, test } from "bun:test";

import { Lexer } from "../lexer/Lexer";
import { Diagnostics } from "../diagnostics/Diagnostics";

/** Lex `src`, returning the [type, value] pairs plus the run's diagnostics. */
function lex(src: string) {
    const diagnostics = new Diagnostics(src);
    const tokens = new Lexer(diagnostics)
        .tokenize(src)
        .map((t) => [t.info.type, t.info.value]);

    return { tokens, diagnostics };
}

test("comments", () => {
    expect(lex("// line").tokens).toEqual([["CommentSingle", "line"]]);
    expect(lex("// line\n// two").tokens).toEqual([
        ["CommentSingle", "line"],
        ["CommentSingle", "two"],
    ]);

    expect(lex("/* block */").tokens).toEqual([["CommentMulti", "block"]]);
    expect(lex("/* two\nlines */").tokens).toEqual([["CommentMulti", "two\nlines"]]);
    expect(lex("/**/").tokens).toEqual([["CommentMulti", ""]]);

    expect(lex("/** doc */").tokens).toEqual([["CommentDoc", "doc"]]);
});

test("comment positions", () => {
    const [tok] = new Lexer().tokenize("\n  /* x */");

    expect(tok?.start).toEqual({ line: 2, column: 3 });
    expect(tok?.end).toEqual({ line: 2, column: 10 }); // Exclusive, past the `*/`
});

test("words, numbers and symbols", () => {
    expect(lex("pattern Foo = { 12 }").tokens).toEqual([
        ["pattern", "pattern"],
        ["Identifier", "Foo"],
        ["=", "="],
        ["{", "{"],
        ["Number", "12"],
        ["}", "}"],
    ]);

    // Keyword-ish spellings stay identifiers; `_` and digits are word chars.
    expect(lex("lets my_2nd").tokens).toEqual([
        ["Identifier", "lets"],
        ["Identifier", "my_2nd"],
    ]);

    // No trailing whitespace to close the last token. `..` is one token, so a
    // range never collides with the member access in `unicode.Greek`.
    expect(lex("1..5").tokens).toEqual([
        ["Number", "1"],
        ["..", ".."],
        ["Number", "5"],
    ]);
    expect(lex("unicode.Greek").tokens).toEqual([
        ["Identifier", "unicode"],
        [".", "."],
        ["Identifier", "Greek"],
    ]);
    expect(lex("repeat").tokens).toEqual([["repeat", "repeat"]]);
});

test("strings", () => {
    // One token type per quote style: literal text, one character, raw regex.
    expect(lex('"a b"').tokens).toEqual([["String", "a b"]]);
    expect(lex("'  padded  '").tokens).toEqual([["Char", "  padded  "]]);
    expect(lex("`raw`").tokens).toEqual([["Raw", "raw"]]);

    // Escapes: the closing quote must still close the string afterwards.
    expect(lex('"a\\"b\\\\c\\nd\\qe"').tokens).toEqual([["String", 'a"b\\c\nd' + "qe"]]);

    // Backticks keep backslashes for the emitter; quoted strings are cooked.
    expect(lex('`\\d+` "\\d"').tokens).toEqual([
        ["Raw", "\\d+"],
        ["String", "d"],
    ]);
});

test("codepoint escapes", () => {
    expect(lex('"\\u0041"').tokens).toEqual([["String", "A"]]);
    expect(lex('"\\x41"').tokens).toEqual([["String", "A"]]);
    expect(lex('"\\u{1F600}"').tokens).toEqual([["String", "\u{1F600}"]]);

    // A raw string is not cooked, so the escape text survives verbatim.
    expect(lex("`\\u0041`").tokens).toEqual([["Raw", "\\u0041"]]);

    expect(lex('"\\u{12"').diagnostics.hasErrors).toBe(true);
    expect(lex('"\\uZZZZ"').diagnostics.hasErrors).toBe(true);
});

test("errors are reported and recovered from", () => {
    const unterminated = lex("/* forever");
    expect(unterminated.tokens[0]?.[0]).toBe("ErrorTok");
    expect(unterminated.diagnostics.all).toHaveLength(1);
    expect(unterminated.diagnostics.all[0]?.stage).toBe("lexer");

    expect(lex('"open').tokens[0]?.[0]).toBe("ErrorTok");
    expect(lex("/ oops").tokens[0]?.[0]).toBe("ErrorTok");

    // Lexing continues past a bad character instead of throwing.
    const recovered = lex("# // after");
    expect(recovered.tokens.map((t) => t[0])).toEqual(["ErrorTok", "CommentSingle"]);
    expect(recovered.diagnostics.hasErrors).toBe(true);
});

test("diagnostics render the offending line with carets", () => {
    const src = "let x = #\n";
    const diagnostics = new Diagnostics(src);
    new Lexer(diagnostics).tokenize(src);

    expect(diagnostics.format()).toContain("let x = #");
    expect(diagnostics.format()).toContain("^");
});
