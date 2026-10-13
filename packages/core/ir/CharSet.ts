/**
 * @fileoverview Character sets and the set algebra over them.
 *
 * A set is a tree rather than a flat bracket because `&` and `-` against a
 * Unicode property cannot be computed as code-point ranges. Range-only
 * operations are folded exactly by `simplify`; anything involving a property
 * survives into `emit/`, which lowers it the way the target flavor allows.
 */

/** Inclusive code-point range. */
export type Range = readonly [number, number];
export type Ranges = readonly Range[];

export const MAX_CODEPOINT = 0x10ffff;

export type CharSet =
    | { readonly kind: "ranges"; readonly ranges: Ranges }
    | { readonly kind: "prop"; readonly name: string; readonly negated: boolean }
    | { readonly kind: "op"; readonly op: SetOp; readonly left: CharSet; readonly right: CharSet }
    | { readonly kind: "not"; readonly of: CharSet };

export type SetOp = "union" | "diff" | "inter";

/** The two set forms that go straight into a single `[...]`. */
export type LeafSet = Extract<CharSet, { kind: "ranges" | "prop" }>;

// --- Constructors ---

export function ranges(rs: Ranges): CharSet {
    return { kind: "ranges", ranges: normalize(rs) };
}

export function singleton(codepoint: number): CharSet {
    return { kind: "ranges", ranges: [[codepoint, codepoint]] };
}

/** `["aeiou"]` — a string in a set means each of its characters. */
export function fromChars(text: string): CharSet {
    return ranges([...text].map((c) => [c.codePointAt(0)!, c.codePointAt(0)!] as Range));
}

export function prop(name: string): CharSet {
    return { kind: "prop", name, negated: false };
}

export const EMPTY: CharSet = { kind: "ranges", ranges: [] };

// --- Range arithmetic ---

/** Sorts and merges, so two sets are comparable by deep equality. */
export function normalize(rs: Ranges): Ranges {
    const sorted = [...rs].filter(([lo, hi]) => lo <= hi).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const out: Range[] = [];
    for (const [lo, hi] of sorted) {
        const last = out[out.length - 1];
        // Adjacent ranges merge too: [a-b][c-c] with c === b + 1 is one range.
        if (last && lo <= last[1] + 1) out[out.length - 1] = [last[0], Math.max(last[1], hi)];
        else out.push([lo, hi]);
    }
    return out;
}

export function unionRanges(a: Ranges, b: Ranges): Ranges {
    return normalize([...a, ...b]);
}

export function complementRanges(a: Ranges): Ranges {
    const out: Range[] = [];
    let next = 0;
    for (const [lo, hi] of normalize(a)) {
        if (lo > next) out.push([next, lo - 1]);
        next = Math.max(next, hi + 1);
    }
    if (next <= MAX_CODEPOINT) out.push([next, MAX_CODEPOINT]);
    return out;
}

export function interRanges(a: Ranges, b: Ranges): Ranges {
    const left = normalize(a);
    const right = normalize(b);
    const out: Range[] = [];

    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
        const lo = Math.max(left[i]![0], right[j]![0]);
        const hi = Math.min(left[i]![1], right[j]![1]);
        if (lo <= hi) out.push([lo, hi]);
        // Advance whichever range ends first; the other may still overlap the next.
        if (left[i]![1] < right[j]![1]) i++;
        else j++;
    }
    return out;
}

export function diffRanges(a: Ranges, b: Ranges): Ranges {
    return interRanges(a, complementRanges(b));
}

export function size(rs: Ranges): number {
    return rs.reduce((total, [lo, hi]) => total + (hi - lo + 1), 0);
}

export function rangesEqual(a: Ranges, b: Ranges): boolean {
    const x = normalize(a);
    const y = normalize(b);
    return x.length === y.length && x.every((r, i) => r[0] === y[i]![0] && r[1] === y[i]![1]);
}

// --- Simplification ---

export function isRanges(set: CharSet): set is Extract<CharSet, { kind: "ranges" }> {
    return set.kind === "ranges";
}

/**
 * Folds every operation whose operands are pure ranges, leaving only the ones a
 * property makes uncomputable. Always returns a tree with normalized ranges.
 */
export function simplify(set: CharSet): CharSet {
    switch (set.kind) {
        case "ranges":
            return { kind: "ranges", ranges: normalize(set.ranges) };

        case "prop":
            return set;

        case "not": {
            const of = simplify(set.of);
            if (isRanges(of)) return { kind: "ranges", ranges: complementRanges(of.ranges) };
            // A negated property is spellable directly as \P{...}.
            if (of.kind === "prop") return { kind: "prop", name: of.name, negated: !of.negated };
            return { kind: "not", of };
        }

        case "op": {
            const left = simplify(set.left);
            const right = simplify(set.right);

            if (isRanges(left) && isRanges(right)) {
                const folded =
                    set.op === "union"
                        ? unionRanges(left.ranges, right.ranges)
                        : set.op === "diff"
                          ? diffRanges(left.ranges, right.ranges)
                          : interRanges(left.ranges, right.ranges);
                return { kind: "ranges", ranges: folded };
            }

            // A union with nothing in it is the other side, whatever that side is.
            if (set.op === "union" && isRanges(left) && left.ranges.length === 0) return right;
            if (set.op === "union" && isRanges(right) && right.ranges.length === 0) return left;

            return { kind: "op", op: set.op, left, right };
        }
    }
}

/**
 * The leaves of a pure-union tree, or null if any other operation appears.
 * A pure union emits as one bracket however many properties it mixes in.
 */
export function unionLeaves(set: CharSet): LeafSet[] | null {
    if (set.kind === "ranges" || set.kind === "prop") return [set];
    if (set.kind === "op" && set.op === "union") {
        const left = unionLeaves(set.left);
        const right = unionLeaves(set.right);
        return left && right ? [...left, ...right] : null;
    }
    return null;
}
