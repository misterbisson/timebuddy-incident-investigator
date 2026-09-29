/**
 * The labels Loki's parameterless `| json` stage would add to one log line,
 * for HistoricalLokiAdapter (see lokiEventLabels in lokiAdapter.ts for why the
 * adapter needs them at all).
 *
 * This is a port rather than a `JSON.parse` call, because `JSON.parse` differs
 * from Loki in ways that change what a join matches:
 *
 * - **A number's source text.** Loki returns a number token's bytes as-is.
 *   `String(JSON.parse(...))` rounds to a double, so `12345678901234567891`
 *   and `12345678901234567890` became the same join value.
 * - **A truncated line's leading fields.** Loki walks the object with
 *   jsonparser's `ObjectEach`, so every field before the point a clipped line
 *   breaks is already extracted when the error arrives. `JSON.parse` is
 *   all-or-nothing.
 * - **Raw control characters.** jsonparser keeps a raw tab or newline inside a
 *   string; `JSON.parse` rejects the whole line.
 * - **Keys spelled like Object.prototype members**, which a plain object
 *   mishandles (`__proto__` sets the prototype).
 *
 * Ported from Loki v3.7.8's `JSONParser` (pkg/logql/log/parser.go,
 * `sanitizeLabelKey`/`appendSanitized` in util.go) and the jsonparser fork it
 * pins (github.com/grafana/jsonparser at 023329977675: `ObjectEach`,
 * `getType`, `Unescape`):
 *
 * - **Walk.** Whitespace is space, tab, CR and LF only. A trailing comma
 *   before `}` is accepted. A nested object's end is found first (by bracket
 *   counting that skips strings), its fields are read inside that span only,
 *   and the outer walk resumes after it. An unterminated one therefore
 *   contributes nothing. Arrays and nulls are skipped. A number is any token
 *   starting `-` or a digit, up to the next delimiter, kept as written.
 *   `true`/`false` are kept. Any other literal, `undefined` included, is an
 *   error.
 * - **Strings.** Only `\"` `\\` `\/` `\b` `\f` `\n` `\r` `\t` and `\uXXXX`
 *   decode. A surrogate needs a second `\u` escape after it. Any other escape
 *   makes a value `""`, and a key a parse error. U+FFFD in a value becomes a
 *   space.
 * - **Names.** A top-level key is trimmed of whitespace (Go's
 *   `unicode.IsSpace` set, not `String#trim`'s), gets a `_` prefix for a
 *   leading digit, and has every code point outside `[a-zA-Z0-9_]` replaced
 *   with `_`. A nested name joins its path's segments with `_`. Segments that
 *   trim to nothing are skipped, and the digit prefix applies only to the
 *   first segment written. A name that is already a stream label gets
 *   `_extracted` (on a nested name, appended to the raw last key before
 *   sanitizing). When two fields land on the same name, **the first one
 *   wins**, as Loki's `Extracted` check does.
 * - **Errors.** A line that isn't one JSON object, or breaks partway, gets
 *   `__error__` set to `JSONParserErr`, with whatever came before the break
 *   still extracted.
 *
 * Where this deliberately differs:
 *
 * - A nested path whose every segment is blank (`{" ":{" ":"x"}}`) names no
 *   label here. Loki emits a label named `""`, which no selector or `on()`
 *   clause can name, so it can never take part in a join. (A blank top-level
 *   key is skipped by Loki too.)
 * - Nesting deeper than MAX_DEPTH is a parse error at that point. Loki keeps
 *   going. Its walk re-scans every nested object to find its end before
 *   reading it, which is quadratic in depth, and a recursive port overflows
 *   the stack somewhere past a few thousand levels.
 * - `__error_details__`, whose message text is specific to jsonparser, isn't
 *   set.
 */

const ERROR_LABEL = '__error__';
const JSON_PARSER_ERR = 'JSONParserErr';
const DUPLICATE_SUFFIX = '_extracted';

/** Nesting depth past which a line is treated as unparseable — see the module header. */
export const MAX_DEPTH = 100;

class ScanError extends Error {}

/** jsonparser's whitespace, for the walk itself (nextToken). */
const isJsonSpace = (ch: string | undefined) => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';

/** The characters that end an unquoted token (jsonparser's tokenEnd). */
const isTokenEnd = (ch: string) => isJsonSpace(ch) || ch === ',' || ch === '}' || ch === ']';

/** Go's unicode.IsSpace, which strings.TrimSpace uses to trim a key. */
function isGoSpace(cp: number): boolean {
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x20 ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

function goTrimSpace(s: string): string {
  const cps = [...s];
  let start = 0;
  let end = cps.length;
  while (start < end && isGoSpace(cps[start]!.codePointAt(0)!)) start++;
  while (end > start && isGoSpace(cps[end - 1]!.codePointAt(0)!)) end--;
  return cps.slice(start, end).join('');
}

/** Loki's appendSanitized: trims `key`, then appends it to `to` with invalid characters as `_`. */
function appendSanitized(to: string, key: string): string {
  const trimmed = goTrimSpace(key);
  if (trimmed === '') return to;
  let out = to === '' && trimmed[0]! >= '0' && trimmed[0]! <= '9' ? '_' : '';
  for (const ch of trimmed) out += /^[a-zA-Z0-9_]$/.test(ch) ? ch : '_';
  return to + out;
}

/** Loki's buildSanitizedPrefixFromBuffer: a nested path's name, blank segments skipped. */
function sanitizedPath(path: readonly string[]): string {
  let out = '';
  path.forEach((part, i) => {
    if (goTrimSpace(part) === '') return;
    if (i > 0 && out !== '') out += '_';
    out = appendSanitized(out, part);
  });
  return out;
}

/**
 * jsonparser's Unescape: undefined for an escape it doesn't accept. Raw
 * control characters pass through untouched.
 */
function unescape(raw: string): string | undefined {
  if (!raw.includes('\\')) return raw;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const e = raw[i + 1];
    const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    if (e !== undefined && Object.hasOwn(simple, e)) {
      out += simple[e];
      i += 1;
      continue;
    }
    if (e !== 'u') return undefined;
    const r = hex4(raw, i + 2);
    if (r === undefined) return undefined;
    if (r < 0xd800 || r > 0xdfff) {
      out += String.fromCodePoint(r);
      i += 5;
      continue;
    }
    // A surrogate (high or low) needs a second \u escape, at or above 0xDC00.
    if (raw[i + 6] !== '\\' || raw[i + 7] !== 'u') return undefined;
    const r2 = hex4(raw, i + 8);
    if (r2 === undefined || r2 < 0xdc00) return undefined;
    const combined = 0x10000 + ((r - 0xd800) << 10) + (r2 - 0xdc00);
    // utf8.EncodeRune writes U+FFFD for anything that isn't a valid code point.
    out += combined > 0x10ffff || (combined >= 0xd800 && combined <= 0xdfff) ? '�' : String.fromCodePoint(combined);
    i += 11;
  }
  return out;
}

function hex4(s: string, at: number): number | undefined {
  const digits = s.slice(at, at + 4);
  return /^[0-9a-fA-F]{4}$/.test(digits) ? parseInt(digits, 16) : undefined;
}

type Emit = (path: readonly string[], key: string, value: string) => void;

/** A port of jsonparser's ObjectEach, over text[start, end), with Loki's JSONParser callback. */
class Walker {
  constructor(
    private readonly text: string,
    private readonly emit: Emit,
  ) {}

  /** First non-whitespace index in [from, end), or -1. */
  private nextToken(from: number, end: number): number {
    for (let i = from; i < end; i++) if (!isJsonSpace(this.text[i])) return i;
    return -1;
  }

  /** Index just past the quote closing a string whose body starts at `from`, or -1. */
  private stringEnd(from: number, end: number): number {
    for (let i = from; i < end; i++) {
      const ch = this.text[i];
      if (ch === '\\') i++;
      else if (ch === '"') return i + 1;
    }
    return -1;
  }

  /** Index just past the bracket closing the block opening at `from`, or -1 (jsonparser's blockEnd). */
  private blockEnd(from: number, end: number, open: string, close: string): number {
    let level = 0;
    for (let i = from; i < end; i++) {
      const ch = this.text[i];
      if (ch === '"') {
        const se = this.stringEnd(i + 1, end);
        if (se === -1) return -1;
        i = se - 1;
      } else if (ch === open) {
        level++;
      } else if (ch === close && --level === 0) {
        return i + 1;
      }
    }
    return -1;
  }

  objectEach(start: number, end: number, path: readonly string[]): void {
    if (path.length > MAX_DEPTH) throw new ScanError('nested too deeply');
    let pos = this.nextToken(start, end);
    if (pos === -1 || this.text[pos] !== '{') throw new ScanError('not an object');
    pos = this.nextToken(pos + 1, end);
    if (pos === -1) throw new ScanError('unterminated object');
    if (this.text[pos] === '}') return;

    while (pos < end) {
      // Step 1: the key (or the closing brace, which also accepts a trailing comma).
      const ch = this.text[pos];
      if (ch === '}') return;
      if (ch !== '"') throw new ScanError(`expected a key at ${pos}`);
      const keyEnd = this.stringEnd(pos + 1, end);
      if (keyEnd === -1) throw new ScanError('unterminated key');
      const key = unescape(this.text.slice(pos + 1, keyEnd - 1));
      if (key === undefined) throw new ScanError('invalid escape in a key');

      // Step 2: the colon.
      pos = this.nextToken(keyEnd, end);
      if (pos === -1 || this.text[pos] !== ':') throw new ScanError(`expected ":" at ${pos}`);

      // Step 3: the value.
      pos = this.nextToken(pos + 1, end);
      if (pos === -1) throw new ScanError('missing value');
      pos = this.value(pos, end, path, key);

      // Step 4: a comma, or the end of the object.
      pos = this.nextToken(pos, end);
      if (pos === -1) throw new ScanError('unterminated object');
      if (this.text[pos] === '}') return;
      if (this.text[pos] !== ',') throw new ScanError(`expected "," or "}" at ${pos}`);
      pos = this.nextToken(pos + 1, end);
      if (pos === -1) throw new ScanError('unterminated object');
    }
    throw new ScanError('unterminated object');
  }

  /** jsonparser's getType plus Loki's parseObject for the value at `pos`. Returns the index past it. */
  private value(pos: number, end: number, path: readonly string[], key: string): number {
    const ch = this.text[pos]!;
    if (ch === '"') {
      const se = this.stringEnd(pos + 1, end);
      if (se === -1) throw new ScanError('unterminated string');
      // An escape Unescape refuses makes the value "", not an error (readValue).
      const value = unescape(this.text.slice(pos + 1, se - 1)) ?? '';
      this.emit(path, key, value.replace(/�/g, ' '));
      return se;
    }
    if (ch === '{' || ch === '[') {
      const blockEnd = this.blockEnd(pos, end, ch, ch === '{' ? '}' : ']');
      if (blockEnd === -1) throw new ScanError('unterminated block');
      if (ch === '{') this.objectEach(pos, blockEnd, [...path, key]);
      return blockEnd;
    }
    let tokenEnd = pos;
    while (tokenEnd < end && !isTokenEnd(this.text[tokenEnd]!)) tokenEnd++;
    const token = this.text.slice(pos, tokenEnd);
    if (ch === 't' || ch === 'f') {
      if (token !== 'true' && token !== 'false') throw new ScanError(`unknown literal ${token}`);
      this.emit(path, key, token);
    } else if (ch === 'n' || ch === 'u') {
      if (token !== 'null') throw new ScanError(`unknown literal ${token}`);
    } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
      this.emit(path, key, token);
    } else {
      throw new ScanError(`unknown value type at ${pos}`);
    }
    return tokenEnd;
  }
}

/**
 * The labels `| json` would give `line` in a stream labelled `streamLabels`:
 * the stream labels themselves, plus the extracted fields (see this module's
 * header for the rules). A plain object with own properties only, so a
 * `__proto__` or `constructor` field is an ordinary label.
 */
export function lokiJsonLabels(line: string, streamLabels: Record<string, string>): Record<string, string> {
  const isStreamLabel = (name: string) => Object.hasOwn(streamLabels, name);
  const extracted = new Map<string, string>();
  const emit: Emit = (path, key, value) => {
    let name: string;
    if (path.length === 0) {
      name = appendSanitized('', key);
      if (name === '') return;
      if (isStreamLabel(name)) name += DUPLICATE_SUFFIX;
    } else {
      name = sanitizedPath([...path, key]);
      if (isStreamLabel(name)) name = sanitizedPath([...path, key + DUPLICATE_SUFFIX]);
      if (name === '') return; // Loki emits "" here; see the header.
    }
    if (!extracted.has(name)) extracted.set(name, value);
  };

  let failed = false;
  try {
    new Walker(line, emit).objectEach(0, line.length, []);
  } catch (err) {
    if (!(err instanceof ScanError)) throw err;
    failed = true;
  }
  const labels = new Map<string, string>([...Object.entries(streamLabels), ...extracted]);
  if (failed) labels.set(ERROR_LABEL, JSON_PARSER_ERR);
  // Object.fromEntries defines each key as an own property, "__proto__" included.
  return Object.fromEntries(labels);
}
