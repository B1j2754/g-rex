import { type Tok, type TokType } from "./Token";

enum State {
    Start,
    Number,
    Identifier,
    String,

    SingleComment,
    MultiComment,
    DocComment,
}

const StringQuotes = { Double: '"', Single: "'" } as const;
type StringType = typeof StringQuotes[keyof typeof StringQuotes];

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

    // Final
    private tokens: Tok[] = [];

    tokenize(src: string): Tok[] {
        this.src = src;
        this.position = 0; // Char # of src
        this.line = 1;
        this.line = this.col = 1;
        this.lineStart = this.colStart = 0;

        this.state = State.Start;
        this.buffer = "";
        this.quoteType = null;

        while (this.position < this.src.length) {
            const char = this.peek();
            if (char === null) break;

            const posBefore = this.position;
            const stateBefore: State = this.state;

            this.processChar(char);

            if (this.position === posBefore && this.state === stateBefore) {
                throw new Error(
                    `Internal lexer error: no forward progress in state ${State[this.state]} ` +
                    `on ${JSON.stringify(char)} at line ${this.line}, column ${this.col}`
                );
            }
        }

        return this.tokens;
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
        if (type !== "String") this.buffer = this.buffer.trim();

        this.tokens.push({
            info: { type, value: this.buffer },
            start: { line: this.lineStart, column: this.colStart },
            end: { line: this.line, column: this.col },
        });

        this.buffer = "";
        this.state = State.Start;
    }

    // --- Main Logic ---
    private processChar(char: string) {
        if (this.state === State.Start)
            this.processStartState(char);
        else
            this.processState(char);
    }

    private processStartState(char: string) {}

    private processState(char: string) {}
}