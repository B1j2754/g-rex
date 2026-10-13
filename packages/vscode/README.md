# g-rex for VS Code

Syntax highlighting and live compiler diagnostics for
[g-rex](https://github.com/B1j2754/g-rex), a readable language that transpiles to
regular expressions.

## Features

**Syntax highlighting** for `.grex` files, and for `.grex.txt` — the alias that
lets a source file render as plain text in editors and viewers that do not know
`.grex` yet.

Each of the five bracket types is coloured for what it means: `"text"` as a
string, `'c'` as a single character, `` `raw` `` as raw regex, and the prelude
names (`digit`, `letter`, `start`, `unicode.Greek` …) as built-in constants
rather than as variables, since they are bindings you may shadow.

**Live diagnostics** as you type, from the compiler itself — the same check
`grex check` runs, which means the Problems panel reports more than syntax:

- unknown names, duplicate capture names, and unresolvable `ref`s
- reference cycles between `let` and `def` declarations
- set algebra on something that is not a set (`word + "ab"`)
- wrong argument counts on a `def`
- **anything the file's `@flavor` cannot express** — `textStart` under `js`,
  backreferences or lookaround under `re2`, atomic groups outside `pcre`

That last one is the point of the language having flavors at all, and it is
reported against the line that wrote the construct.

## Example

```grex
@flavor pcre
@flags unicode

let hexit = [digit, 'a'..'f', 'A'..'F']

/** A single- or double-quoted string, closing on the same quote it opened. */
pattern QuotedString {
  capture quote { ["\"'"] }
  capture body  { repeat lazy { any } }
  ref quote
}
```

## Requirements

None. The compiler is bundled into the extension, so nothing has to be installed
and no language server runs.

## Settings

None yet. Files are re-checked 250 ms after you stop typing, and on open and
save.

## Licence

Apache-2.0.
