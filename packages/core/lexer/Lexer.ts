import { Keywords, Symbols, type KwardTokType, type SymbolTokType, type Tok, type TokType } from "./Token";
import { Diagnostics } from "../diagnostics/Diagnostics";

enum State {
    Start,
    Number,
    Identifier,
    String,

    SingleComment,
    MultiComment,
    DocComment,
}

const StringQuotes = { Double: '"', Single: "'", Raw: "`" } as const;
type StringType = typeof StringQuotes[keyof typeof StringQuotes];
const Quotes = new Set<string>(Object.values(StringQuotes));

const StringEscapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0" };

/** Which token type each quote style produces. */
const QuoteToken = { '"': "String", "'": "Char", "`": "Raw" } as const satisfies Record<StringType, TokType>;

/** Token types whose value is user text, so `emit` must not trim it. */
const Verbatim = new Set<TokType>(["String", "Char", "Raw"]);

export class Lexer {
    // Position tracking
    private src: string = "";
    private position = 0;
    private line = 1;
    private lineStart = 0;
    private col = 1;
    private colStart = 1;

    // FSM-related
    private state: State = State.Start; // FSM State
    private buffer = "";
    private quoteType: StringType | null = null;
    private isEscaped = false;
    private isRaw = false;

    // Final
    private tokens: Tok[] = [];

    constructor(private readonly diagnostics: Diagnostics = new Diagnostics()) {}

    tokenize(src: string): Tok[] {
        this.src = src;
        this.position = 0; // Char # of src
        this.line = this.col = 1;
        this.lineStart = this.colStart = 1;

        this.state = State.Start;
        this.buffer = "";
        this.quoteType = null;
        this.isEscaped = false;
        this.isRaw = false;
        this.tokens = [];

        while (this.position < this.src.length) {
            const char = this.peek();
            if (char === null) break;

            const posBefore = this.position;
            const stateBefore: State = this.state;

            this.processChar(char);

            if (this.position === posBefore && this.state === stateBefore) {
                throw new Error(
                    `Internal lexer error: no forward progress in state ${State[this.state]} `
                    + `on ${JSON.stringify(char)} at line ${this.line}, column ${this.col}`
                );
            }
        }

        this.finish();
        return this.tokens;
    }

    private finish() {
        switch (this.state) {
            case State.Number:
                this.emit("Number");
                break;
            case State.Identifier:
                this.emitWord();
                break;
            case State.SingleComment:
                this.emit("CommentSingle");
                break;
            case State.String:
                this.error(`Unterminated string (expected closing ${this.quoteType})`);
                break;
            case State.MultiComment:
                this.error("Unterminated block comment (expected `*/`)");
                break;
            case State.DocComment:
                this.error("Unterminated doc comment (expected `*/`)");
                break;
        }
    }

    // --- Helpers ---

    private peek(distance: number = 0): string | null {
        let pos = this.position;
        for (let i = 0; i < distance; i++) {
            const skipped = this.src.codePointAt(pos);
            if (skipped === undefined) return null;
            pos += String.fromCodePoint(skipped).length;
        }

        const code = this.src.codePointAt(pos);
        return code === undefined ? null : String.fromCodePoint(code);
    }

    private advance(amount: number = 1): string | null {
        let char = this.peek();
        for (let i = 0; i < amount; i++) {
            char = this.peek();
            if (char !== null) {
                this.position += char.length; // 2 for astral characters
                if (char === '\n') {
                    this.line++;
                    this.col = 1;
                } else {
                    this.col++;
                }
            }
        }
        return char;
    }

    private emit(type: TokType) {
        if (!Verbatim.has(type)) this.buffer = this.buffer.trim();

        this.tokens.push({
            info: { type, value: this.buffer },
            start: { line: this.lineStart, column: this.colStart },
            end: { line: this.line, column: this.col },
        });

        this.buffer = "";
        this.state = State.Start;
    }

    // A word is a keyword if it is spelled like one, an identifier otherwise.
    private emitWord() {
        this.emit(Keywords.has(this.buffer) ? (this.buffer as KwardTokType) : "Identifier");
    }

    private error(message: string) {
        this.diagnostics.report({
            stage: "lexer",
            message,
            start: { line: this.lineStart, column: this.colStart },
            end: { line: this.line, column: this.col },
        });

        this.buffer = message;
        this.emit("ErrorTok");
    }

    /**
     * Reads the digits of a `\xHH`, `\uHHHH` or `\u{H..}` escape, already past the
     * backslash, with `kind` the x or u. A malformed escape is reported and dropped,
     * so lexing still moves forward.
     */
    private readCodepointEscape(kind: "u" | "x") {
        this.advance(); // the u or x

        const braced = kind === "u" && this.peek() === "{";
        if (braced) this.advance();

        const want = braced ? Infinity : kind === "x" ? 2 : 4;
        let digits = "";
        while (digits.length < want && /[0-9a-fA-F]/.test(this.peek() ?? "")) digits += this.advance();

        if (braced) {
            if (this.peek() !== "}") return this.error("Unterminated `\\u{...}` escape (expected `}`)");
            this.advance();
        }

        const code = parseInt(digits, 16);
        if (digits.length === 0 || code > 0x10ffff)
            return this.error(`Invalid \\${kind} escape ${JSON.stringify(digits)}`);

        this.buffer += String.fromCodePoint(code);
    }

    // --- Main Logic ---
    private processChar(char: string) {
        if (this.state === State.Start)
            this.processStartState(char);
        else
            this.processState(char);
    }

    private processStartState(char: string) {
        this.lineStart = this.line;
        this.colStart = this.col;

        if (/\s/.test(char)) {
            this.advance(); // Skip whitespace
        } else if (/[a-zA-Z_]/.test(char)) {
            this.state = State.Identifier;
            this.buffer += this.advance();
        } else if (/[0-9]/.test(char)) {
            this.state = State.Number;
            this.buffer += this.advance();
        } else if (Quotes.has(char)) {
            this.isRaw = char === StringQuotes.Raw;
            this.quoteType = char as StringType;
            this.state = State.String;
            this.advance();
        } else if (char === "/") {
            const next = this.peek(1);

            if (next === "/") {
                this.state = State.SingleComment;
                this.advance(2);
            } else if (next === "*") {
                const isDoc = this.peek(2) === "*" && this.peek(3) !== "/";

                this.state = isDoc ? State.DocComment : State.MultiComment;
                this.advance(isDoc ? 3 : 2);
            } else {
                this.advance();
                this.error("Unexpected `/` (expected `//`, `/*` or `/**`)");
            }
        } else if (char === "." && this.peek(1) === ".") {
            this.buffer = "..";
            this.advance(2);
            this.emit("..");
        } else if (Symbols.has(char)) {
            this.buffer = char;
            this.advance();
            this.emit(char as SymbolTokType);
        } else {
            this.advance();
            this.error(`Unexpected character ${JSON.stringify(char)}`);
        }
    }

    private processState(char: string) {
        switch (this.state) {
            case State.String:
                if (this.isEscaped) {
                    this.isEscaped = false;
                    if (char === "u" || char === "x") this.readCodepointEscape(char);
                    else {
                        this.buffer += StringEscapes[char] ?? char;
                        this.advance();
                    }
                    break;
                }
                if (char === "\\" && !this.isRaw) {
                    this.isEscaped = true;
                    this.advance();
                    break;
                }
                if (char === this.quoteType) {
                    this.emit(QuoteToken[this.quoteType]);
                    this.advance();
                    break;
                }

                this.buffer += char;
                this.advance();
                break;
            case State.Number:
                if (/[0-9]/.test(char)) { // This was a fun line to write lol
                    this.buffer += char;
                    this.advance();
                    break;
                }

                this.emit("Number");
                break;
            case State.Identifier:
                if (/[a-zA-Z0-9_]/.test(char)) {
                    this.buffer += char;
                    this.advance();
                    break;
                }

                this.emitWord();
                break;

            case State.SingleComment:
                if (char === "\n") {
                    this.emit("CommentSingle");
                    break;
                }

                this.buffer += char;
                this.advance();
                break;

            case State.MultiComment:
            case State.DocComment:
                if (char === "*" && this.peek(1) === "/") {
                    const type = this.state === State.DocComment ? "CommentDoc" : "CommentMulti";
                    this.advance(2);
                    this.emit(type);
                    break;
                }

                this.buffer += char;
                this.advance();
                break;
        }
    }
}