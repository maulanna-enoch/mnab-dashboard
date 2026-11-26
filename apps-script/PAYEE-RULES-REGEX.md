# Regex for payee rules: a short intro

Most payee rules don't need regex. Use **contains**, **starts with** or **equals** whenever they're enough: they're easier to read and can't break. Use **regex** when you need one of two things:

1. **One rule for several spellings**, e.g. `DANA QR * …` and `DANA QROFF * …`.
2. **Copying part of the bank's text into the new payee**: pick out the merchant name and put it after `DANA - `.

This page covers the subset of regex that does those two jobs. For anything fancier, see [Testing a pattern](#testing-a-pattern).

## How a rule sees the text

Before any rule runs, the bank text is tidied:

- **Upper and lower case don't matter.** `dana`, `DANA` and `Dana` all match each other, so you never need `[Dd]`.
- **Runs of spaces count as one space**, and spaces at the start or end are dropped. `DANA QR  *  Toko` is checked as `DANA QR * Toko`.
- A regex rule matches if the pattern is found **anywhere** in the text, unless you anchor it (see `^` and `$` below).

## The pieces you'll actually use

### Ordinary characters match themselves

Letters, digits and spaces mean exactly what they say: `DANA QR` matches the text `DANA QR`.

### Special characters

These characters have a meaning in regex: `.` `*` `+` `?` `(` `)` `[` `]` `{` `}` `|` `\` `^` `$`

To match one of them literally, put `\` in front. Bank text uses `*` a lot (`DANA QR * Toko`), so you'll write `\*` often.

| You want to match | Write |
|---|---|
| `*` | `\*` |
| `.` (as in `PT. ABC`) | `\.` |
| `(` and `)` | `\(` and `\)` |
| `+` | `\+` |

Type one backslash in the sheet. The `\\` you may see in code is only how code spells a single `\`.

### Wildcards: "something goes here"

| Pattern | Means | Example |
|---|---|---|
| `.` | any one character | `A.C` matches `ABC`, `A-C` |
| `\d` | one digit 0–9 | `\d\d\d\d` matches `2892` |
| `\s` | one space | |
| `[ABC]` | one of A, B or C | `[-/]` matches `-` or `/` |

### Repeats: "how many"

Put these right after the thing they repeat:

| Pattern | Means | Example |
|---|---|---|
| `+` | one or more | `\d+` matches `7`, `2892`, `1234567` |
| `*` | zero or more | `\s*` matches no space or any spaces |
| `?` | zero or one (optional) | `QR(?:OFF)?` matches `QR` and `QROFF` |

`.+` means "one or more of anything", i.e. "the rest of the text". You'll use it constantly.

### Anchors: "at the start" / "at the end"

| Pattern | Means |
|---|---|
| `^` | the text must **start** here |
| `$` | the text must **end** here |

`^DANA` matches `DANA QR * Toko` but not `TOPUP DANA`. Without the `^`, both match. Anchoring is the easiest way to stop a rule from catching more than you meant.

### Either/or

`|` means "or". Group it, so the "or" doesn't swallow the rest of the pattern:

- `^(?:GOPAY|GOJEK)` matches text starting with `GOPAY` or `GOJEK`.
- `^GOPAY|GOJEK` (no group) means "starts with GOPAY, **or** contains GOJEK anywhere". That's usually not what you want.

## Groups and `{1}`, `{2}`

Parentheses do two different jobs:

| Written as | Name | What it does |
|---|---|---|
| `( … )` | **capturing** group | groups, **and** remembers what it matched as `{1}`, `{2}`, … |
| `(?: … )` | **non-capturing** group | only groups, for `?` or `\|`; remembers nothing |

**Numbering:** count the `(` from the left, **skipping** any `(?:`. The first capturing group is `{1}`, the next is `{2}`, and so on up to `{9}`. A group that matched nothing (an optional part that wasn't there) becomes empty text.

```
Pattern   : ^TRANSFER KE (.+?) (\d+)$
Text      : TRANSFER KE BUDI SANTOSO 1234567
              (.+?)  →  {1} = BUDI SANTOSO
              (\d+)  →  {2} = 1234567
Set Payee : {1}          →  BUDI SANTOSO
Set Notes : Rek {2}      →  Rek 1234567
```

Why `(?:OFF)` in the DANA rule and not `(OFF)`? With `(OFF)` the numbering shifts: `{1}` becomes `OFF` (or empty), and the merchant moves to `{2}`. Use `(?: )` for every group you only need for `?` or `|`. Then `{1}` is always the part you actually want.

`{0}` is the whole matched text. The non-regex tokens still work in regex rules: `{payee}`, `{notes}`, `{sof}`, `{amount}`.

## Greedy vs. lazy: `.+` vs `.+?`

`.+` grabs **as much as it can**. `.+?` grabs **as little as it can** while the rest of the pattern still matches. This only matters when something comes after the group:

```
Text: QRIS ABC SHOP - JAKARTA - ID

^QRIS (.+) -      {1} = ABC SHOP - JAKARTA    (greedy: runs to the LAST " - ")
^QRIS (.+?) -     {1} = ABC SHOP              (lazy: stops at the FIRST " - ")
```

Rule of thumb: when the group is the **last** thing in the pattern (`… (.+)$`), use `.+`. When something comes **after** it and that something can appear more than once in the text, use `.+?`.

## Cookbook

Every pattern below was run through the actual rules engine on the text shown.

| Goal | Match Type | Pattern | Set Payee | Text → result |
|---|---|---|---|---|
| DANA, both spellings, keep merchant | regex | `^DANA QR(?:OFF)?\s*\*\s*(.+)$` | `DANA - {1}` | `DANA QROFF * FamilyM` → `DANA - FamilyM` |
| One DANA merchant, any truncation | regex | `^DANA QR(?:OFF)?\s*\*\s*FamilyM` | `DANA - FamilyMart` | `DANA QR * FamilyMart Cipete` → `DANA - FamilyMart` |
| Indomaret with any store code | regex | `^INDOMARET\b` | `Indomaret` | `INDOMARET T123-CIPETE` → `Indomaret` |
| Same merchant, two spellings | regex | `^(?:ALFAMART\|ALFA MART)\b` | `Alfamart` | `ALFA MART CILANDAK` → `Alfamart` |
| Drop a leading company prefix | regex | `^PT\.?\s+(.+?)(?:\s+TBK)?$` | `{1}` | `PT. KOPI KENANGAN TBK` → `KOPI KENANGAN` |
| Transfer: name to payee, account to notes | regex | `^TRANSFER KE (.+?) (\d+)$` | `{1}` (Set Notes: `Rek {2}`) | `TRANSFER KE BUDI SANTOSO 1234567` → `BUDI SANTOSO` |
| Reorder pieces | regex | `^(\w+) TOP ?UP\b` | `Top up {1}` | `GOPAY TOPUP 0812xxxx` → `Top up GOPAY` |
| A plain substring (no regex needed) | contains | `DUITKU` | `School fees` (Transfer: TRUE) | `PT DUITKU SEKOLAH` → `School fees` |

New pieces in the table: `\b` is a "word boundary" (`INDOMARET\b` matches `INDOMARET T123` but not `INDOMARETPOINT`). `\w` is one letter, digit or `_`. `\.?` is an optional dot.

The last column shows the Payee exactly as written. Upper or lower case in the bank text isn't changed: `{1}` copies it as is.

## Common mistakes

- **Forgetting `\` before `*`.** This one fails quietly. In `DANA QR * (.+)` the `*` repeats the space before it ("zero or more spaces"), so the rule still matches, but `{1}` comes out as `* Toko` instead of `Toko`. Write `\*`. A pattern that *starts* with `*` (`*Toko`) is a real error: that rule is skipped and listed in the log and in the Apply dialog, and imports carry on.
- **A catch-all above a specific rule.** The first match wins. Give specific rules a lower Order (40) than the general rule (50).
- **No `^`.** A rule for `DANA` without `^` also catches `TOPUP DANA 0812…`. Anchor it when you mean "starts with".
- **`{1}` in a contains / starts with / equals rule.** Only regex rules have groups. In other rules `{1}` becomes empty.
- **Using `(OFF)?` when you meant `(?:OFF)?`.** It shifts the numbering of every group after it.
- **A typo in a token** (`{payeee}`). It's left in the result as written, so the row will show it.

## Testing a pattern

1. Open [regex101.com](https://regex101.com), choose the **ECMAScript (JavaScript)** flavor and turn on the `i` (case-insensitive) flag. That's exactly how rules run.
2. Paste the pattern at the top and a few real payees from your `transactions` sheet below it, one per line. Turn on the `m` flag too, so `^` and `$` work per line while you test.
3. The right-hand panel shows what each group caught. That's your `{1}`, `{2}`, ….
4. Put the rule in `PayeeRules` and run **Finances > Apply Payee Rules to All Rows…**. It shows every row that would change, and the rule that fired, before anything is written. Answer **No** if it looks wrong.

If a real bank text doesn't match the way you expect, check its `Raw Import` cell. That's the exact text the rule sees, before any earlier rule changed it.
