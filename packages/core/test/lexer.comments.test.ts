import { expect, test } from "bun:test";

import { Lexer } from "../lexer/Lexer";
import { Diagnostics } from "../diagnostics/Diagnostics";

/** Lex `src`, returning the [type, value] pairs plus the run's diagnostics. */
function lex(src: string) {
    const diagnostics = new Diagnostics();
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

    // No trailing whitespace to close the last token.
    expect(lex("1..5").tokens).toEqual([
        ["Number", "1"],
        [".", "."],
        [".", "."],
        ["Number", "5"],
    ]);
    expect(lex("repeat").tokens).toEqual([["repeat", "repeat"]]);
});

test("strings", () => {
    expect(lex('"a b"').tokens).toEqual([["String", "a b"]]);
    expect(lex("'  padded  '").tokens).toEqual([["String", "  padded  "]]);

    // Escapes: the closing quote must still close the string afterwards.
    expect(lex('"a\\"b\\\\c\\nd\\qe"').tokens).toEqual([["String", 'a"b\\c\nd' + "qe"]]);

    // Backticks keep backslashes for the parser; quoted strings are cooked.
    expect(lex('`\\d+` "\\d"').tokens).toEqual([
        ["String", "\\d+"],
        ["String", "d"],
    ]);
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
