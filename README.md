# g-rex

A transpiled, human-readable scripting language for constructing complex regex
patterns cleanly.

```grex
@flavor js
@flags unicode

let alnum = ['a'..'z', 'A'..'Z', digit, '-']

/** A version number: no leading zeros. Order matters — "0" must come first. */
let numeric = either {
  "0"
  | { ['1'..'9'] repeat { digit } }
}

pattern SemVer {
  start
  capture major { numeric } "."
  capture minor { numeric } "."
  capture patch { numeric }
  optional { "+" capture build { repeat 1.. { alnum } } }
  end
}

test SemVer {
  match  `1.0.0` { major: `1` }
  reject `01.0.0`
}
```

```console
$ grex compile semver.grex
SemVer  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:\+(?<build>[\-0-9A-Za-z]+))?$/u

$ grex test semver.grex
pass  SemVer match "1.0.0"
pass  SemVer reject "01.0.0"

2 passed, 0 failed, 0 not runnable
```

## The language

Five bracket types, one meaning each:

| | |
|---|---|
| `"text"` | literal text, auto-escaped, with JS escape sequences |
| `'c'`    | one character — the only thing a range endpoint may be |
| `[ ]`    | a **set** of characters, matching one of them |
| `{ }`    | a **sequence**, matching these in order |
| `( )`    | precedence only, emits nothing |

Every operator takes a `{ }` block, so its argument always has a visible end.
The only bare identifier after a keyword is a *name*, never an expression:
`capture year { }`, `ref year`.

- **Declarations** — `let name = expr`, `def name(params) = expr`,
  `pattern Name { }`, `test Name { }`. A `let` and a `def` are compile-time
  macros, always inlined; a cycle between them is a hard error.
- **Set algebra** — `+` union, `-` difference, `&` intersection, over sets and
  single characters. `['a'..'f', digit]` is a union too. `unicode.Greek` is a
  Unicode property.
- **Operators** — `capture`, `either`, `optional`, `repeat`, `ahead`,
  `notAhead`, `behind`, `notBehind`, `not`, `ref`, and the scoped flags
  `ignoreCase`, `byLine`, `dotAll`.
- **Repetition** — `repeat { }` is zero or more, `repeat n { }` exactly n,
  `repeat n.. { }` n or more, `repeat n..m { }` between n and m, each optionally
  `greedy` (the default), `lazy` or `atomic`.
- **The prelude** — `digit letter word space any start end textStart textEnd
  wordBoundary notWordBoundary linebreak unicode`. These are bindings, not
  keywords, so any of them may be shadowed.
- **Directives** — `@flavor pcre|js|re2` and `@flags unicode ignoreCase byLine
  dotAll`.

Flavors differ in what they can express, and the compiler says so rather than
emitting something that does not work. `textStart` needs `\A`, which JS has no
spelling for; RE2 has no backreferences or lookaround; only JS has class set
operations. Pass `--flavor` to check a file against a target other than its own.

`testing/kitchen-sink.grex` exercises every construct and
`testing/EXPECTED.md` records what each one compiles to.

## CLI

```
grex compile <file> [--flavor pcre|js|re2] [--json] [--emit ts] [-o <out>]
grex test    <file>     Run the file's `test` blocks
grex check   <file>     Report problems without producing output
grex ir      <file>     The lowered intermediate representation, as JSON
grex ast     <file>     The parse tree, as JSON
grex tokens  <file>     The token stream, as JSON
```

Exit codes: `0` clean, `1` diagnostics were reported or a test failed, `2` bad
usage or an unreadable file.

`--emit ts` writes a TypeScript module of compiled patterns, with a
named-group type per pattern:

```ts
export interface SemVerGroups {
    readonly major?: string;
    ...
}
export const SemVer = /^(?<major>0|[1-9]\d*)\./u;
```

`grex test` runs patterns through the JS engine, whatever the file's `@flavor`
says, because that is the only engine available. A pattern using something JS
cannot express is reported as not runnable rather than failed; one needing only
atomic grouping relaxed runs with a note saying so.

## Library

```ts
import { checkSource, compile, compileToIR, runTests, emitTypeScript } from "@g-rex/core";

const { diagnostics, patterns } = compile(source, { flavor: "js" });
```

Nothing throws for bad input. Every entry point returns
`{ diagnostics, product? }`, with the product absent when anything errored.

## Layout

```
packages/core     the compiler: lexer → parser → ir → emit
packages/cli      the `grex` command
packages/vscode   syntax highlighting and live diagnostics
testing           the sample corpus, and EXPECTED.md
```

```console
bun install
bun test        # unit tests plus the corpus
bun run typecheck
bun run build   # dist/grex binary, and the extension bundle
```

Regenerate the golden file with
`GREX_UPDATE_EXPECTED=1 bun test corpus` and read the diff: it is a record of
what the compiler does, so a change there is the point.
