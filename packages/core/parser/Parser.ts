/**
 * @fileoverview Recursive-descent parser for g-rex.
 *
 * Every operator takes a `{ }` block, so no construct needs lookahead past its
 * keyword, and the only bare identifier after a keyword is a name. Errors are
 * reported into `Diagnostics` and recovered from: the top-level loop guarantees
 * forward progress, so a broken file still yields a tree for later stages.
 */

import { Diagnostics } from "../diagnostics/Diagnostics";
import { Keywords, type Tok, type TokPos, type TokType } from "../lexer/Token";
import type {
    Algebra,
    Bound,
    CaptureAssert,
    CharLit,
    Decl,
    Directive,
    DocComment,
    Either,
    Expr,
    Identifier,
    NameRef,
    NumberLit,
    Param,
    Program,
    RawLit,
    RepeatMode,
    Sequence,
    SetMember,
    Span,
    TestCase,
} from "./AST";

const ALGEBRA_OPS = new Set<TokType>(["+", "-", "&"]);
const REPEAT_MODES = new Set<TokType>(["greedy", "lazy", "atomic"]);
const LOOKAROUND = {
    ahead: { dir: "ahead", negated: false },
    notAhead: { dir: "ahead", negated: true },
    behind: { dir: "behind", negated: false },
    notBehind: { dir: "behind", negated: true },
} as const;

/** Where a declaration can start, used to resynchronise after a syntax error. */
const DECL_STARTS = new Set<TokType>(["let", "def", "pattern", "test", "@"]);

const ORIGIN: TokPos = { line: 1, column: 1 };

export class Parser {
    private tokens: Tok[] = [];
    private pos = 0;
    /** Doc comment attached to the token at each index, by index into `tokens`. */
    private docs = new Map<number, DocComment>();

    constructor(private readonly diagnostics: Diagnostics = new Diagnostics()) {}

    public parse(src: Tok[]): Program {
        this.prepare(src);

        const directives: Directive[] = [];
        const declarations: Decl[] = [];

        while (!this.isAtEnd()) {
            const before = this.pos;

            if (this.at("@")) {
                const directive = this.parseDirective();
                if (directive) directives.push(directive);
            } else {
                const decl = this.parseDecl();
                if (decl) declarations.push(decl);
            }

            // Nothing consumed means parseDecl bailed without reporting progress;
            // skip a token so the loop cannot spin.
            if (this.pos === before) this.advance();
        }

        return {
            kind: "Program",
            span: this.wholeSpan(),
            directives,
            declarations,
        };
    }

    // --- Token stream ---

    /**
     * Drops comments and already-reported error tokens, and records which doc
     * comment precedes each surviving token so declarations can claim it.
     */
    private prepare(src: Tok[]) {
        this.tokens = [];
        this.pos = 0;
        this.docs = new Map();

        let pending: Tok | null = null;
        for (const tok of src) {
            switch (tok.info.type) {
                case "CommentDoc":
                    pending = tok;
                    continue;
                case "CommentSingle":
                case "CommentMulti":
                    continue;
                // The lexer already reported these; carrying them forward would
                // only produce a second, less useful error at the same place.
                case "ErrorTok":
                    continue;
            }

            if (pending) {
                this.docs.set(this.tokens.length, {
                    kind: "DocComment",
                    span: { start: pending.start, end: pending.end },
                    text: pending.info.value,
                });
                pending = null;
            }
            this.tokens.push(tok);
        }
    }

    private peek(lookAhead: number = 0): Tok | null {
        return this.tokens[this.pos + lookAhead] ?? null;
    }

    private isAtEnd(): boolean {
        return this.pos >= this.tokens.length;
    }

    private at(...types: TokType[]): boolean {
        const tok = this.peek();
        return tok !== null && types.includes(tok.info.type);
    }

    private advance(): Tok | null {
        return this.tokens[this.pos++] ?? null;
    }

    /** Consumes the current token if it has `type`, else reports and returns null. */
    private expect(type: TokType, what: string): Tok | null {
        if (this.at(type)) return this.advance();
        this.error(`Expected ${what}, found ${this.describe()}`);
        return null;
    }

    private takeDocs(): DocComment | null {
        return this.docs.get(this.pos) ?? null;
    }

    /** Skips tokens until the next declaration keyword, so one bad line costs one error. */
    private synchronize() {
        while (!this.isAtEnd() && !DECL_STARTS.has(this.peek()!.info.type)) this.advance();
    }

    // --- Spans and errors ---

    private spanOf(tok: Tok): Span {
        return { start: tok.start, end: tok.end };
    }

    private spanFrom(start: Span, end: Span | null): Span {
        return { start: start.start, end: (end ?? start).end };
    }

    private wholeSpan(): Span {
        const last = this.tokens[this.tokens.length - 1];
        const first = this.tokens[0];
        return {
            start: first?.start ?? ORIGIN,
            end: last?.end ?? ORIGIN,
        };
    }

    /** A human description of the current token, for "found ..." messages. */
    private describe(): string {
        const tok = this.peek();
        if (!tok) return "end of file";
        const { type, value } = tok.info;
        switch (type) {
            case "Identifier":
            case "Number":
                return `${JSON.stringify(value)}`;
            case "String":
            case "Char":
            case "Raw":
                return `a ${type === "String" ? "text" : type === "Char" ? "character" : "raw"} literal`;
            default:
                return `\`${type}\``;
        }
    }

    private error(message: string, span?: Span) {
        const tok = this.peek();
        const where = span ?? (tok ? this.spanOf(tok) : this.wholeSpan());
        this.diagnostics.report({ stage: "parser", message, start: where.start, end: where.end });
    }

    // --- Declarations ---

    private parseDirective(): Directive | null {
        const at = this.advance()!; // `@`
        const name = this.parseWord("a directive name");
        if (!name) return null;

        const args: Identifier[] = [];
        for (let arg = this.tryWord(); arg !== null; arg = this.tryWord()) args.push(arg);

        return {
            kind: "Directive",
            span: this.spanFrom(this.spanOf(at), args[args.length - 1]?.span ?? name.span),
            name,
            args,
        };
    }

    private parseDecl(): Decl | null {
        switch (this.peek()?.info.type) {
            case "let":
                return this.parseLet();
            case "def":
                return this.parseDef();
            case "pattern":
                return this.parsePattern();
            case "test":
                return this.parseTest();
            default:
                this.error(`Expected a declaration, found ${this.describe()}`);
                this.advance();
                this.synchronize();
                return null;
        }
    }

    private parseLet() {
        const docs = this.takeDocs();
        const kw = this.advance()!;
        const name = this.parseIdentifier("a name after `let`");
        if (!name || !this.expect("=", "`=` after the name")) return this.bail();

        const body = this.parseExpr();
        if (!body) return this.bail();

        return { kind: "LetDecl" as const, span: this.spanFrom(this.spanOf(kw), body.span), docs, name, body };
    }

    private parseDef() {
        const docs = this.takeDocs();
        const kw = this.advance()!;
        const name = this.parseIdentifier("a name after `def`");
        if (!name || !this.expect("(", "`(` after the name")) return this.bail();

        const params: Param[] = [];
        while (!this.at(")") && !this.isAtEnd()) {
            const param = this.parseIdentifier("a parameter name");
            if (!param) break;
            params.push({ kind: "Param", span: param.span, name: param });
            if (!this.at(",")) break;
            this.advance();
        }
        if (!this.expect(")", "`)` after the parameters")) return this.bail();
        if (!this.expect("=", "`=` after the parameter list")) return this.bail();

        const body = this.parseExpr();
        if (!body) return this.bail();

        return { kind: "DefDecl" as const, span: this.spanFrom(this.spanOf(kw), body.span), docs, name, params, body };
    }

    private parsePattern() {
        const docs = this.takeDocs();
        const kw = this.advance()!;
        const name = this.parseIdentifier("a name after `pattern`");
        if (!name) return this.bail();

        const body = this.parseBlock();
        if (!body) return this.bail();

        return { kind: "PatternDecl" as const, span: this.spanFrom(this.spanOf(kw), body.span), docs, name, body };
    }

    private parseTest() {
        const docs = this.takeDocs();
        const kw = this.advance()!;
        const name = this.parseIdentifier("the name of the pattern under test");
        if (!name || !this.expect("{", "`{` after the pattern name")) return this.bail();

        const cases: TestCase[] = [];
        while (!this.at("}") && !this.isAtEnd()) {
            const before = this.pos;
            const testCase = this.parseTestCase();
            if (testCase) cases.push(testCase);
            if (this.pos === before) break;
        }
        const close = this.expect("}", "`}` to close the test block");

        return {
            kind: "TestDecl" as const,
            span: this.spanFrom(this.spanOf(kw), close ? this.spanOf(close) : null),
            docs,
            name,
            cases,
        };
    }

    private parseTestCase(): TestCase | null {
        if (!this.at("match", "reject")) {
            this.error(`Expected \`match\` or \`reject\`, found ${this.describe()}`);
            this.advance();
            return null;
        }

        const kw = this.advance()!;
        const mode = kw.info.type as "match" | "reject";
        const subject = this.parseRaw("a subject in backticks");
        if (!subject) return null;

        const captures: CaptureAssert[] = [];
        let end: Span = subject.span;

        // `reject` takes no assertions, so a `{` after one is a mistake worth naming.
        if (this.at("{")) {
            if (mode === "reject") {
                this.error("`reject` asserts no match, so it takes no capture assertions");
            }
            this.advance();
            while (!this.at("}") && !this.isAtEnd()) {
                const name = this.parseIdentifier("a capture name");
                if (!name || !this.expect(":", "`:` after the capture name")) break;
                const text = this.parseRaw("the expected text in backticks");
                if (!text) break;
                captures.push({
                    kind: "CaptureAssert",
                    span: this.spanFrom(name.span, text.span),
                    name,
                    text,
                });
                if (!this.at(",")) break;
                this.advance();
            }
            const close = this.expect("}", "`}` to close the capture assertions");
            if (close) end = this.spanOf(close);
        }

        return {
            kind: "TestCase",
            span: this.spanFrom(this.spanOf(kw), end),
            mode,
            subject,
            captures: mode === "reject" ? [] : captures,
        };
    }

    /** Reports nothing further and resynchronises; the caller already reported. */
    private bail(): null {
        this.synchronize();
        return null;
    }

    // --- Expressions ---

    /** A primary, then any set-algebra operators, which are left-associative. */
    private parseExpr(): Expr | null {
        let left = this.parsePrimary();
        if (!left) return null;

        while (this.at(...ALGEBRA_OPS)) {
            const op = this.advance()!.info.type as Algebra["op"];
            const right = this.parsePrimary();
            if (!right) return left;
            left = { kind: "Algebra", span: this.spanFrom(left.span, right.span), op, left, right };
        }

        return left;
    }

    private parsePrimary(): Expr | null {
        const tok = this.peek();
        if (!tok) {
            this.error("Unexpected end of file, expected an expression");
            return null;
        }

        switch (tok.info.type) {
            case "{":
                return this.parseBlock();
            case "[":
                return this.parseSet();
            case "(": {
                this.advance();
                const body = this.parseExpr();
                const close = this.expect(")", "`)` to close the group");
                if (!body) return null;
                return {
                    kind: "Group",
                    span: this.spanFrom(this.spanOf(tok), close ? this.spanOf(close) : body.span),
                    body,
                };
            }
            case "String":
                this.advance();
                return { kind: "StringLit", span: this.spanOf(tok), value: tok.info.value };
            case "Char":
                this.advance();
                return this.charFrom(tok);
            case "Raw":
                this.advance();
                return { kind: "RawLit", span: this.spanOf(tok), value: tok.info.value };
            case "Number":
                this.advance();
                return this.numberFrom(tok);

            case "capture": {
                this.advance();
                const name = this.at("Identifier") ? this.parseIdentifier("a capture name") : null;
                const body = this.parseBlock();
                if (!body) return null;
                return { kind: "Capture", span: this.spanFrom(this.spanOf(tok), body.span), name, body };
            }
            case "either":
                return this.parseEither();
            case "optional": {
                this.advance();
                const body = this.parseBlock();
                if (!body) return null;
                return { kind: "Optional", span: this.spanFrom(this.spanOf(tok), body.span), body };
            }
            case "repeat":
                return this.parseRepeat();

            case "ahead":
            case "notAhead":
            case "behind":
            case "notBehind": {
                const { dir, negated } = LOOKAROUND[tok.info.type];
                this.advance();
                const body = this.parseBlock();
                if (!body) return null;
                return { kind: "Lookaround", span: this.spanFrom(this.spanOf(tok), body.span), dir, negated, body };
            }

            case "ignoreCase":
            case "byLine":
            case "dotAll": {
                const flag = tok.info.type;
                this.advance();
                const body = this.parseBlock();
                if (!body) return null;
                return { kind: "FlagScope", span: this.spanFrom(this.spanOf(tok), body.span), flag, body };
            }

            case "not": {
                this.advance();
                const body = this.parsePrimary();
                if (!body) return null;
                return { kind: "Not", span: this.spanFrom(this.spanOf(tok), body.span), body };
            }

            case "ref": {
                this.advance();
                if (this.at("Number")) {
                    const num = this.numberFrom(this.advance()!);
                    return { kind: "Backref", span: this.spanFrom(this.spanOf(tok), num.span), target: num };
                }
                const name = this.parseIdentifier("a capture name or number after `ref`");
                if (!name) return null;
                return { kind: "Backref", span: this.spanFrom(this.spanOf(tok), name.span), target: name };
            }

            case "Identifier":
                return this.parseNameRef();

            default:
                this.error(`Expected an expression, found ${this.describe()}`);
                return null;
        }
    }

    /** `{ a b c }` — juxtaposition is concatenation. */
    private parseBlock(): Sequence | null {
        const open = this.expect("{", "`{` to open a block");
        if (!open) return null;

        const items: Expr[] = [];
        while (!this.at("}") && !this.isAtEnd()) {
            const before = this.pos;
            const item = this.parseExpr();
            if (item) items.push(item);
            if (this.pos === before) break; // parseExpr reported and consumed nothing
        }

        const close = this.expect("}", "`}` to close the block");
        return {
            kind: "Sequence",
            span: this.spanFrom(this.spanOf(open), close ? this.spanOf(close) : null),
            items,
        };
    }

    /**
     * `either { a b }`. Each expression is one branch; `|` between branches is
     * optional punctuation, which is why both sample files spell it differently.
     */
    private parseEither(): Either | null {
        const kw = this.advance()!;
        if (!this.expect("{", "`{` after `either`")) return null;

        const branches: Expr[] = [];
        while (!this.at("}") && !this.isAtEnd()) {
            const before = this.pos;
            if (this.at("|")) this.advance();
            const branch = this.parseExpr();
            if (branch) branches.push(branch);
            if (this.pos === before) break;
        }

        const close = this.expect("}", "`}` to close `either`");
        if (branches.length === 0) this.error("`either` needs at least one branch", this.spanOf(kw));

        return {
            kind: "Either",
            span: this.spanFrom(this.spanOf(kw), close ? this.spanOf(close) : null),
            branches,
        };
    }

    private parseRepeat(): Expr | null {
        const kw = this.advance()!;

        let min: Bound | null = null;
        let max: Bound | null = null;

        if (this.at("..")) {
            // `repeat ..m` — no lower bound.
            this.advance();
            max = this.parseBound();
            if (!max) return null;
        } else if (this.at("Number", "Identifier")) {
            min = this.parseBound();
            if (this.at("..")) {
                this.advance();
                // `repeat n..` leaves the upper bound open.
                max = this.at("Number", "Identifier") ? this.parseBound() : null;
            } else {
                max = min; // `repeat n` means exactly n
            }
        }

        const mode: RepeatMode = this.at(...REPEAT_MODES)
            ? (this.advance()!.info.type as RepeatMode)
            : "greedy";

        const body = this.parseBlock();
        if (!body) return null;

        return { kind: "Repeat", span: this.spanFrom(this.spanOf(kw), body.span), min, max, mode, body };
    }

    /**
     * A repeat bound: a bare number, or a bare `def` parameter name. Never a call
     * or a block, so the `{` that follows always opens the repeat body.
     */
    private parseBound(): Bound | null {
        if (this.at("Number")) return this.numberFrom(this.advance()!);

        const name = this.parseIdentifier("a repeat count");
        if (!name) return null;
        return { kind: "NameRef", span: name.span, name, path: [], args: null, block: null };
    }

    private parseSet() {
        const open = this.advance()!; // `[`

        const members: SetMember[] = [];
        while (!this.at("]") && !this.isAtEnd()) {
            const before = this.pos;
            const member = this.parseSetMember();
            if (member) members.push(member);
            if (this.pos === before) break;
            if (!this.at(",")) break;
            this.advance();
        }

        const close = this.expect("]", "`]` to close the set");
        return {
            kind: "SetLit" as const,
            span: this.spanFrom(this.spanOf(open), close ? this.spanOf(close) : null),
            members,
        };
    }

    private parseSetMember(): SetMember | null {
        const tok = this.peek();
        switch (tok?.info.type) {
            case "Char": {
                this.advance();
                const from = this.charFrom(tok);
                if (!this.at("..")) return from;
                this.advance();
                const toTok = this.expect("Char", "a single character to end the range");
                if (!toTok) return from;
                const to = this.charFrom(toTok);
                return { kind: "Range", span: this.spanFrom(from.span, to.span), from, to };
            }
            case "String":
                this.advance();
                return { kind: "StringLit", span: this.spanOf(tok), value: tok.info.value };
            case "Identifier":
                return this.parsePath();
            default:
                this.error(`Expected a set member, found ${this.describe()}`);
                this.advance();
                return null;
        }
    }

    /** `name` or `name.member…`, with no call and no trailing block. */
    private parsePath(): NameRef | null {
        const name = this.parseIdentifier("a name");
        if (!name) return null;

        const path: Identifier[] = [];
        while (this.at(".")) {
            this.advance();
            const member = this.parseIdentifier("a member name after `.`");
            if (!member) break;
            path.push(member);
        }

        return {
            kind: "NameRef",
            span: this.spanFrom(name.span, path[path.length - 1]?.span ?? null),
            name,
            path,
            args: null,
            block: null,
        };
    }

    /** A path, then optional `( args )`, then an optional trailing block argument. */
    private parseNameRef(): NameRef | null {
        const base = this.parsePath();
        if (!base) return null;

        let end: Span = base.span;
        let args: Expr[] | null = null;

        if (this.at("(")) {
            this.advance();
            args = [];
            while (!this.at(")") && !this.isAtEnd()) {
                const before = this.pos;
                const arg = this.parseExpr();
                if (arg) args.push(arg);
                if (this.pos === before) break;
                if (!this.at(",")) break;
                this.advance();
            }
            const close = this.expect(")", "`)` to close the arguments");
            if (close) end = this.spanOf(close);
        }

        const block = this.at("{") ? this.parseBlock() : null;
        if (block) end = block.span;

        return { ...base, span: this.spanFrom(base.span, end), args, block };
    }

    // --- Leaves ---

    /**
     * A bare word in a directive. Keywords are allowed here because a directive
     * argument is never an expression, and three of the `@flags` names
     * (`ignoreCase`, `byLine`, `dotAll`) are spelled like keywords. The
     * declaration keywords are excluded, since those end the directive instead:
     * nothing separates `@flavor pcre` from the `let` on the next line.
     */
    private parseWord(what: string): Identifier | null {
        const word = this.tryWord();
        if (word) return word;
        this.error(`Expected ${what}, found ${this.describe()}`);
        return null;
    }

    private tryWord(): Identifier | null {
        const tok = this.peek();
        if (!tok) return null;
        if (tok.info.type !== "Identifier" && !Keywords.has(tok.info.type)) return null;
        if (DECL_STARTS.has(tok.info.type)) return null;

        this.advance();
        return { kind: "Identifier", span: this.spanOf(tok), text: tok.info.value };
    }

    private parseIdentifier(what: string): Identifier | null {
        const tok = this.expect("Identifier", what);
        if (!tok) return null;
        return { kind: "Identifier", span: this.spanOf(tok), text: tok.info.value };
    }

    private parseRaw(what: string): RawLit | null {
        const tok = this.expect("Raw", what);
        if (!tok) return null;
        return { kind: "RawLit", span: this.spanOf(tok), value: tok.info.value };
    }

    /**
     * A `' '` literal must hold exactly one code point: it is the only thing a
     * range endpoint may be, and `'ab'..'f'` has no meaning.
     */
    private charFrom(tok: Tok): CharLit {
        const value = tok.info.value;
        if ([...value].length !== 1)
            this.error(
                `A \`' '\` literal must be exactly one character, got ${JSON.stringify(value)}`,
                this.spanOf(tok),
            );
        return { kind: "CharLit", span: this.spanOf(tok), value };
    }

    private numberFrom(tok: Tok): NumberLit {
        return { kind: "NumberLit", span: this.spanOf(tok), value: Number(tok.info.value) };
    }
}
