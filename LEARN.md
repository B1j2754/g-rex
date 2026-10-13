# Learning g-rex

A tutorial, in the order the pieces make sense. Every example here is compiled by
the test suite, so what you read is what the compiler produces.

If you want the terse version, the README has a summary and
`testing/kitchen-sink.grex` exercises every construct in one file.

---

## 1. Why

A regex is write-once. This:

```
^(\d{4})-(\d{2})-(\d{2})$
```

is fine until you need to add an optional time, and then you are counting
brackets. g-rex is the same regex with the parts named and the punctuation
spelled out:

```grex
pattern IsoDate {
  start
  capture year  { repeat 4 { digit } }
  "-"
  capture month { repeat 2 { digit } }
  "-"
  capture day   { repeat 2 { digit } }
  end
}
```

```console
$ grex compile date.grex
IsoDate  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/
```

It compiles to a plain regex. There is no runtime, nothing to install in your
app, and nothing clever happening at match time — you get a string you can hand
to any engine.

## 2. Your first file

Save this as `hello.grex`:

```grex
pattern Greeting {
  "hello"
  space
  capture name { repeat 1.. { letter } }
}

test Greeting {
  match  `hello world` { name: `world` }
  reject `goodbye world`
}
```

Three commands you will use constantly:

```console
$ grex compile hello.grex      # what it becomes
Greeting  /hello\s(?<name>[A-Za-z]+)/

$ grex test hello.grex          # does it do what you said
pass  Greeting match "hello world"
pass  Greeting reject "goodbye world"

2 passed, 0 failed, 0 not runnable

$ grex check hello.grex         # anything wrong with it
No problems found.
```

Note what the compiler did with `"hello"`: nothing, because it needed nothing.
Write `"a.b"` and you get `a\.b` — literal text is always escaped for you, so you
never again wonder whether a dot needs a backslash.

## 3. The five brackets

This is the whole syntax, really. Each bracket means exactly one thing:

| | means | example | compiles to |
|---|---|---|---|
| `"..."` | literal **text**, auto-escaped | `"a.b"` | `a\.b` |
| `'...'` | exactly one **character** | `'x'` | `x` |
| `[...]` | a **set** — matches one of them | `['a'..'f']` | `[a-f]` |
| `{...}` | a **sequence** — these in order | `{ "a" "b" }` | `ab` |
| `(...)` | **precedence** only, emits nothing | `{ ("a") "b" }` | `ab` |

And a fifth kind of quote, `` `...` ``, is **raw**: it goes into the output
untouched. It is the escape hatch for when you want to write regex directly.

```
`\d`    -->  \d          (raw: passed through)
"\d"    -->  d           (text: a backslash-d in a string is just d)
```

Two rules follow from this, and they are the reason the language reads cleanly:

**Every operator takes a `{ }` block.** So its argument always has a visible end,
and you never have to work out how far an operator reaches.

**The only bare name after a keyword is a name, never an expression.** In
`capture year { ... }`, `year` is the group's name. In `ref year`, it is which
group. Nothing else can appear in those slots, so nothing is ambiguous.

## 4. Characters and sets

A set is one character out of several. Commas separate members, and a member can
be a character, a range, a string (meaning each of its characters), or a name:

```grex
let vowel   = ["aeiou"]
let hexit   = [digit, 'a'..'f', 'A'..'F']
let pathish = [word, '-', '.']

pattern Demo { vowel hexit pathish }
```

| | compiles to |
|---|---|
| `["aeiou"]` | `[aeiou]` |
| `[digit, 'a'..'f', 'A'..'F']` | `[0-9A-Fa-f]` |
| `[word, '-', '.']` | `[\-.0-9A-Z_a-z]` |
| `['a','b','c']` | `[a-c]` |

That last one is worth noticing: members are merged and sorted, so three separate
characters come out as one range. You write what you mean and the compiler finds
the short spelling.

### The built-in sets

These are **bindings, not keywords** — you can shadow any of them with your own
`let`, which occasionally you want to.

| name | compiles to |
|---|---|
| `digit` | `\d` |
| `letter` | `[A-Za-z]` |
| `word` | `\w` |
| `space` | `\s` |
| `any` | `.` |

### Negation

`not` takes a set or a character and gives you everything else:

| | compiles to |
|---|---|
| `not digit` | `\D` |
| `not space` | `\S` |
| `not ['a'..'z']` | `[^a-z]` |
| `not [' ', '"']` | `[^ "]` |

### Set algebra

Three operators, for when "the letters except the vowels" is what you actually
mean:

| | |
|---|---|
| `+` | union |
| `-` | difference |
| `&` | intersection |

```grex
@flags unicode

let vowel     = ["aeiou"]
let alpha     = ['a'..'z', 'A'..'Z']
let consonant = alpha - vowel
let greek     = letter & unicode.Greek

pattern Demo { consonant greek }
```

`consonant` compiles to `[A-Zb-df-hj-np-tv-z]`. The compiler did the arithmetic;
you did not have to.

`unicode.Greek` is a Unicode property, and `unicode` is the namespace they all
live in — `unicode.L`, `unicode.Han`, `unicode.Emoji`.

> **Operands must be sets or single characters.** `word + "ab"` is an error,
> because `"ab"` is text, not a set. The compiler tells you to write
> `word + ["ab"]`.

## 5. Sequences and alternatives

Putting things next to each other means "then". That is a sequence:

```grex
pattern Demo { "a" "b" digit }
```

compiles to `ab\d`.

For "or", use `either`. Each expression inside is one branch, and a `|` between
them is optional punctuation — use it or don't:

```grex
pattern Demo {
  either { "cat" "dog" }
}
```

```grex
pattern Demo {
  either {
    "cat"
    | "dog"
  }
}
```

Both compile to `cat|dog`.

### Branch order matters

Branches are tried left to right and the first one that matches wins. This is the
single most common source of regex bugs, and writing branches on their own lines
makes it visible. Here is 0–255, where getting the order wrong gives you a
pattern that matches `2` of `255` and stops:

```grex
let octet = either {
  { "25" ['0'..'5'] }
  { "2" ['0'..'4'] digit }
  { "1" repeat 2 { digit } }
  { ['1'..'9'] digit }
  digit
}

pattern Demo { octet }
```

Note the `{ }` around each branch. Without them, `"25" ['0'..'5']` would be *two*
branches rather than one two-part sequence. Braces are how you group.

> One exception: an algebra operator binds *inside* a branch, so
> `either { letter - vowel }` is one branch, not two.

## 6. Repetition

`repeat` takes an optional count, an optional mode, then a block:

| | compiles to | |
|---|---|---|
| `repeat { digit }` | `\d*` | zero or more |
| `repeat 1.. { digit }` | `\d+` | one or more |
| `repeat 3 { digit }` | `\d{3}` | exactly three |
| `repeat 2..4 { digit }` | `\d{2,4}` | two to four |
| `repeat ..4 { digit }` | `\d{0,4}` | up to four |
| `optional { digit }` | `\d?` | zero or one |

The modes go after the count:

| | compiles to | |
|---|---|---|
| `repeat lazy { any }` | `.*?` | match as little as possible |
| `repeat 1.. lazy { digit }` | `\d+?` | |
| `repeat 1.. atomic { digit }` | `(?>\d+)` | match, then refuse to backtrack |
| `repeat 1.. greedy { digit }` | `\d+` | the default, so this adds nothing |

Grouping is handled for you. `repeat 1.. { "ab" }` compiles to `(?:ab)+`, not the
`ab+` you would get from naive text substitution.

## 7. Captures and backreferences

`capture name { }` pulls out a piece of the match:

```grex
pattern Demo {
  capture year { repeat 4 { digit } }
}
```

gives `(?<year>\d{4})`. Leave the name off for a group you only need positionally
— `capture { digit }` is `(\d)`.

`ref` matches *the same text* a capture matched. This is how you write "closing on
the same quote it opened", which plain alternation cannot express:

```grex
/** A single- or double-quoted string, closing on the quote it opened with. */
pattern QuotedString {
  capture quote { ["\"'"] }
  capture body  { repeat lazy { any } }
  ref quote
}

test QuotedString {
  match  `"hello"` { quote: `"`, body: `hello` }
  match  `'hi'`    { quote: `'`, body: `hi` }
  reject `"mismatched'`
}
```

`ref 1` works too, for an unnamed group.

## 8. Lookaround

Four operators for "is this next to something", without consuming it:

| | compiles to | |
|---|---|---|
| `ahead { digit }` | `(?=\d)` | a digit follows |
| `notAhead { digit }` | `(?!\d)` | a digit does not follow |
| `behind { "$" }` | `(?<=\$)` | a `$` precedes |
| `notBehind { `\\` }` | `(?<!\\)` | not preceded by a backslash |

A common use is "a number, but not one with a leading zero":

```grex
pattern Status {
  notAhead { "0" }
  repeat 3 { digit }
}
```

## 9. Anchors

| | compiles to | |
|---|---|---|
| `start` | `^` | start of line |
| `end` | `$` | end of line |
| `textStart` | `\A` | start of the whole subject |
| `textEnd` | `\z` | end of the whole subject |
| `wordBoundary` | `\b` | |
| `notWordBoundary` | `\B` | |
| `linebreak` | `\R` | any line ending |

## 10. Scoped flags

Three flags you can turn on for part of a pattern instead of all of it:

| | compiles to |
|---|---|
| `ignoreCase { "get" }` | `(?i:get)` |
| `byLine { start "#" }` | `(?m:^#)` |
| `dotAll { any }` | `(?s:.)` |

Because they are scoped, `ignoreCase { "get" } "X"` is case-insensitive for `get`
and case-sensitive for `X`. That is much harder to get right by hand.

## 11. Naming things: `let`

A `let` names an expression. It is a **compile-time macro**: the body is pasted in
at each use, so there is no cost and no indirection in the output.

```grex
let hexit = [digit, 'a'..'f', 'A'..'F']

pattern HexColour {
  start
  "#"
  either {
    repeat 6 { hexit }
    repeat 3 { hexit }
  }
  end
}

test HexColour {
  match  `#aabbcc`
  match  `#abc`
  reject `#ggg`
}
```

Because it is inlined, a `let` used four times appears four times in the output.
That is the point — you are naming a piece of a pattern, not calling a function.

A cycle (`let a = b`, `let b = a`) cannot be inlined, so it is a hard error even
if nothing uses it.

## 12. Parameters: `def`

A `def` is a `let` that takes arguments. Value arguments go in parentheses:

```grex
/** Exactly n decimal digits. */
def digits(n) = repeat n { digit }

pattern Time {
  capture hour   { digits(2) }
  ":"
  capture minute { digits(2) }
}
```

A **block argument trails** the call instead, which is what makes wrappers read
well:

```grex
/** Wraps a block argument in double quotes. */
def quoted(inner) = { "\"" inner "\"" }

pattern Demo {
  quoted { "GET" space "/" }
}
```

That compiles to `"GET\s\/"`. The block `{ "GET" space "/" }` became `inner`.

Arguments are substituted, not evaluated — a `def` has no call frame. So a
parameter can be a number used as a count (`digits(2)`), a set, or a whole block,
and it just works:

```grex
def digits(n) = repeat n { digit }
def dotted(part) = { part repeat { "." part } }

pattern Version {
  start
  capture v { dotted(digits(1)) }
  end
}
```

## 13. Tests

A `test` block is how a `.grex` file proves it does what you meant. Subjects are
raw strings in backticks:

```grex
pattern Word {
  capture first { letter }
  capture rest  { repeat { letter } }
}

test Word {
  match  `hello` { first: `h`, rest: `ello` }
  match  `a`     { first: `a` }
  reject `123`
}
```

- `match` asserts the pattern matches, and that each listed capture bound to
  exactly that text. List only the captures you care about.
- `reject` asserts it does not match, and takes no capture list.

```console
$ grex test word.grex
pass  Word match "hello"
pass  Word match "a"
pass  Word reject "123"

3 passed, 0 failed, 0 not runnable
```

Tests run the pattern through the JavaScript engine, whatever flavor the file
declares, because that is the engine available. A pattern using something JS
cannot express is reported "not runnable" rather than quietly passing.

## 14. Flavors

Regex dialects genuinely differ, and the differences are not cosmetic. `@flavor`
says which one you are targeting, and the compiler refuses to emit something that
will not work there:

```grex
@flavor js

pattern Demo { start repeat 1.. { digit } end }
```

| | `pcre` | `js` | `re2` |
|---|---|---|---|
| `textStart` | `\A` | **rejected** | `\A` |
| `behind { digit }` | `(?<=\d)` | `(?<=\d)` | **rejected** |
| `repeat 1.. atomic { digit }` | `(?>\d+)` | **rejected** | **rejected** |
| `ref q` | `\k<q>` | `\k<q>` | **rejected** |
| `linebreak` | `\R` | `(?:\r\n\|[\n\v\f\r…])` | `(?:\r\n\|[\n\v\f\r…])` |

The default is `pcre`. When a construct will not work, you get the line that
wrote it:

```console
$ grex compile kitchen-sink.grex --flavor js
emit error: The js flavor cannot express this: `textStart` needs \A
  at line 127, column 3
      |
  127 |   textStart
      |   ^^^^^^^^^
```

`--flavor` on the command line overrides the file, which is how you check whether
a pattern is portable before you rely on it.

### `@flags`

Whole-pattern flags, as opposed to the scoped ones in §10:

| `@flags` | flags emitted |
|---|---|
| *(none)* | *(none)* |
| `@flags unicode` | `u` |
| `@flags ignoreCase byLine dotAll` | `ims` |

`unicode` is the one you most often want: it enables `\p{...}` properties and
makes `letter` mean `\p{L}` rather than ASCII `[A-Za-z]`. Without it,
`letter & unicode.Greek` is the empty set, which is not what anyone writing that
line meant.

## 15. Comments

```grex
// a line comment

/* a block comment,
   over several lines */

/** A doc comment. Attaches to the declaration below it, and survives into
    `grex compile --emit ts` as a JSDoc comment. */
pattern Documented { digit }
```

## 16. Using the output

Print it, and paste it wherever you need a regex:

```console
$ grex compile date.grex
IsoDate  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/
```

Or generate a TypeScript module, with a type for the named groups:

```console
$ grex compile date.grex --emit ts -o date.ts
```

```ts
import { IsoDate, type IsoDateGroups } from "./date";

const groups = IsoDate.exec("2026-10-13")?.groups as IsoDateGroups | undefined;
groups?.year; // string | undefined
```

`--json` gives you the same information for tooling.

## 17. Mistakes the compiler will catch

Worth reading once, so the messages are familiar when you see them:

| you wrote | what it says |
|---|---|
| `word + "ab"` | Set algebra needs sets or single characters; write `["ab"]` to mean its characters |
| `'ab'` | A `' '` literal must be exactly one character |
| `nope` | Unknown name `"nope"` |
| `unicode` | `unicode` is a namespace; write `unicode.Greek` |
| `repeat 5..2 { digit }` | Repeat range 5..2 counts backwards |
| two `capture a` | Duplicate capture name `"a"` |
| `ref 2` with one group | No group 2 to reference; this pattern has 1 |
| `let a = b`, `let b = a` | `a` is defined in terms of itself; a cycle cannot be inlined |

Every one of them points at the line and column, with the source underlined.

## 18. A worked example

Putting it together — a combined-log-format line, which is the kind of pattern
that is genuinely unpleasant to write by hand:

```grex
@flavor pcre
@flags unicode

let pathish = [word, '-', '.']

def digits(n) = repeat n { digit }

let octet = either {
  { "25" ['0'..'5'] }
  { "2" ['0'..'4'] digit }
  { "1" repeat 2 { digit } }
  { ['1'..'9'] digit }
  digit
}

pattern LogLine {
  start

  capture ip {
    octet
    repeat 3 { "." octet }
  }

  space "-" space
  capture user { repeat 1.. { pathish } }

  space "["
  capture time {
    digits(2) "/" repeat 3 { letter } "/" digits(4)
    ":" digits(2) ":" digits(2) ":" digits(2)
    space ['+', '-'] digits(4)
  }
  "]"

  space "\""
  capture method {
    ignoreCase { either { "GET" "POST" "PUT" "DELETE" } }
  }
  space
  capture path { "/" repeat lazy { not space } }
  " HTTP/"
  capture version { digit "." digit }
  "\""

  space
  capture status { notAhead { "0" } repeat 3 { digit } }
  space
  capture bytes { either { "-" repeat 1.. { digit } } }

  end
}

test LogLine {
  match `127.0.0.1 - alice [10/Oct/2000:13:55:36 -0700] "GET /pb.gif HTTP/1.0" 200 2326` {
    ip: `127.0.0.1`, user: `alice`, method: `GET`,
    path: `/pb.gif`, status: `200`, bytes: `2326`
  }
  reject `256.0.0.1 - - [10/Oct/2000:13:55:36 -0700] "GET / HTTP/1.0" 200 0`
}
```

Nine named captures, order-sensitive alternation, a macro used four times, and a
scoped case-insensitivity — and it still reads top to bottom.

## Where next

- `testing/kitchen-sink.grex` — every construct in the language, in one file,
  with the flavor-specific lines marked.
- `testing/EXPECTED.md` — what each sample compiles to, generated by the compiler.
- `grex ast file.grex` and `grex ir file.grex` — if you want to see how a file is
  understood before it becomes a regex.

## Cheat sheet

```text
@flavor pcre | js | re2
@flags unicode ignoreCase byLine dotAll

let name = expr                  // compile-time macro
def name(a, b) = expr            // macro with parameters
pattern Name { ... }             // a regex to emit
test Name { match `s` { c: `t` }  reject `s` }

"text"  'c'  `raw`               // text, one character, verbatim regex
[ ... ]                          // set: 'a'..'z', "chars", name, unicode.Prop
{ ... }                          // sequence
( ... )                          // precedence only

+  -  &                          // union, difference, intersection
not x                            // complement

capture name { }   capture { }   // named and positional groups
ref name           ref 1         // backreference
either { a b }     either { a | b }
optional { }
repeat { }  repeat n { }  repeat n.. { }  repeat n..m { }  repeat ..m { }
    ... greedy | lazy | atomic   // mode goes after the count
ahead { }  notAhead { }  behind { }  notBehind { }
ignoreCase { }  byLine { }  dotAll { }

digit letter word space any
start end textStart textEnd wordBoundary notWordBoundary linebreak
unicode.Greek
```
