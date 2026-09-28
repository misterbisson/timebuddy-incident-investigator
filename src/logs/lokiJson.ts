/**
 * The labels Loki's parameterless `| json` stage would add to one log line,
 * for HistoricalLokiAdapter (see lokiEventLabels in lokiAdapter.ts for why the
 * adapter needs them at all).
 *
 * This is a scanner rather than `JSON.parse` because `JSON.parse` loses three
 * things Loki keeps, and each one changes what a join matches:
 *
 * - **A number's source text.** Loki's `readValue` returns a number token's
 *   bytes as-is. `String(JSON.parse(...))` rounds to a double, so
 *   `12345678901234567891` and `12345678901234567890` became the same join
 *   value, and `1.0` became `"1"`.
 * - **A truncated line's leading fields.** Loki walks the object with
 *   jsonparser's `ObjectEach`, so every field before the point a clipped line
 *   breaks is already extracted when the error arrives. `JSON.parse` is
 *   all-or-nothing.
 * - **Keys spelled like Object.prototype members.** Built on a plain object, a
 *   `__proto__` field set the prototype instead of a label, and a
 *   `constructor` field looked like a stream-label collision.
 *
 * Mirrored from Loki's `JSONParser` (pkg/logql/log/parser.go) and
 * `sanitizeLabelKey`/`appendSanitized` (util.go):
 *
 * - Nested keys join with `_`. A key is trimmed of whitespace, and every code
 *   point outside `[a-zA-Z0-9_]` becomes `_`. Only the first segment of a
 *   name gets a `_` prefix for a leading digit, and a segment that trims to
 *   nothing adds no prefix of its own.
 * - Strings, numbers, and booleans are extracted. Nulls and arrays are
 *   skipped. U+FFFD in a string becomes a space, and a string whose escapes
 *   don't decode becomes `""`.
 * - A name that is already a stream label gets `_extracted` appended.
 * - A line that isn't one JSON object, or breaks partway, gets `__error__` set
 *   to `JSONParserErr`, with whatever came before the break still extracted.
 *   A nested object's end is found before any of its fields are read, as
 *   jsonparser does, so an unterminated nested object contributes nothing.
 *
 * One deliberate difference: a name that sanitizes to the empty string is
 * dropped. Loki sets it, but no selector or `on()` clause can name it, so it
 * can never take part in a join.
 *
 * Also not mirrored: jsonparser's `__error_details__` message text, which is
 * specific to its implementation.
 */

const ERROR_LABEL = '__error__';
const JSON_PARSER_ERR = 'JSONParserErr';
const DUPLICATE_SUFFIX = '_extracted';

class ScanError extends Error {}

/** One name segment, sanitized the way Loki's appendSanitized does. `first` is whether nothing precedes it in the name. */
function sanitizeSegment(key: string, first: boolean): string {
  const trimmed = key.trim();
  if (trimmed === '') return '';
  let out = first && trimmed[0]! >= '0' && trimmed[0]! <= '9' ? '_' : '';
  for (const ch of trimmed) out += /^[a-zA-Z0-9_]$/.test(ch) ? ch : '_';
  return out;
}

/** The characters that end an unquoted token, per jsonparser's tokenEnd. */
const TOKEN_END = new Set([' ', '\n', '\r', '\t', ',', '}', ']']);

class Scanner {
  private pos = 0;

  constructor(
    private readonly text: string,
    private readonly onField: (name: string, value: string) => void,
  ) {}

  /** Walks the top-level object. Throws ScanError where Loki's ObjectEach would fail. */
  run(): void {
    this.skipWs();
    this.parseObject('');
  }

  private skipWs(): void {
    while (this.pos < this.text.length && ' \n\r\t'.includes(this.text[this.pos]!)) this.pos++;
  }

  private expect(ch: string): void {
    if (this.text[this.pos] !== ch) throw new ScanError(`expected "${ch}" at ${this.pos}`);
    this.pos++;
  }

  /** Index just past the closing quote of the string starting at `start`, or -1 if it never closes. */
  private stringEnd(start: number): number {
    for (let i = start + 1; i < this.text.length; i++) {
      const ch = this.text[i];
      if (ch === '\\') i++;
      else if (ch === '"') return i + 1;
    }
    return -1;
  }

  /** Index just past the bracket closing the object or array starting at `start`, or -1 if it never closes. */
  private blockEnd(start: number): number {
    const open = this.text[start]!;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    for (let i = start; i < this.text.length; i++) {
      const ch = this.text[i];
      if (ch === '"') {
        const end = this.stringEnd(i);
        if (end === -1) return -1;
        i = end - 1;
      } else if (ch === open) {
        depth++;
      } else if (ch === close && --depth === 0) {
        return i + 1;
      }
    }
    return -1;
  }

  /** Reads a string token, returning its decoded value, or undefined if its escapes don't decode. */
  private readString(): string | undefined {
    const end = this.stringEnd(this.pos);
    if (end === -1) throw new ScanError(`unterminated string at ${this.pos}`);
    const raw = this.text.slice(this.pos, end);
    this.pos = end;
    try {
      // The token's own text, quotes included, is a JSON string literal
      // exactly when its escapes are valid.
      return JSON.parse(raw) as string;
    } catch {
      return undefined;
    }
  }

  private readToken(): string {
    const start = this.pos;
    while (this.pos < this.text.length && !TOKEN_END.has(this.text[this.pos]!)) this.pos++;
    return this.text.slice(start, this.pos);
  }

  private parseObject(prefix: string): void {
    this.expect('{');
    this.skipWs();
    if (this.text[this.pos] === '}') {
      this.pos++;
      return;
    }
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] !== '"') throw new ScanError(`expected a key at ${this.pos}`);
      const key = this.readString();
      if (key === undefined) throw new ScanError('key with an invalid escape');
      this.skipWs();
      this.expect(':');
      this.skipWs();
      this.parseValue(prefix, key);
      this.skipWs();
      const next = this.text[this.pos];
      this.pos++;
      if (next === '}') return;
      if (next !== ',') throw new ScanError(`expected "," or "}" at ${this.pos - 1}`);
    }
  }

  private parseValue(prefix: string, key: string): void {
    const ch = this.text[this.pos];
    if (ch === '"') {
      const value = this.readString() ?? '';
      this.emit(prefix, key, value.replace(/�/g, ' '));
    } else if (ch === '{') {
      if (this.blockEnd(this.pos) === -1) throw new ScanError(`unterminated object at ${this.pos}`);
      const segment = sanitizeSegment(key, prefix === '');
      this.parseObject(prefix === '' ? segment : `${prefix}_${segment}`);
    } else if (ch === '[') {
      const end = this.blockEnd(this.pos);
      if (end === -1) throw new ScanError(`unterminated array at ${this.pos}`);
      this.pos = end;
    } else if (ch === '-' || (ch !== undefined && ch >= '0' && ch <= '9')) {
      this.emit(prefix, key, this.readToken());
    } else {
      const token = this.readToken();
      if (token === 'true' || token === 'false') this.emit(prefix, key, token);
      else if (token !== 'null') throw new ScanError(`unknown value type at ${this.pos}`);
    }
  }

  private emit(prefix: string, key: string, value: string): void {
    const name = prefix === '' ? sanitizeSegment(key, true) : `${prefix}_${sanitizeSegment(key, false)}`;
    if (name !== '') this.onField(name, value);
  }
}

/**
 * The labels `| json` would give `line` in a stream labelled `streamLabels`:
 * the stream labels themselves, plus the extracted fields (see this module's
 * header for the rules). A plain object with own properties only, so a
 * `__proto__` or `constructor` field is an ordinary label.
 */
export function lokiJsonLabels(line: string, streamLabels: Record<string, string>): Record<string, string> {
  const labels = new Map<string, string>(Object.entries(streamLabels));
  const extracted = new Map<string, string>();
  let failed = false;
  try {
    new Scanner(line, (name, value) => extracted.set(name, value)).run();
  } catch (err) {
    if (!(err instanceof ScanError)) throw err;
    failed = true;
  }
  for (const [name, value] of extracted) {
    labels.set(Object.hasOwn(streamLabels, name) ? `${name}${DUPLICATE_SUFFIX}` : name, value);
  }
  if (failed) labels.set(ERROR_LABEL, JSON_PARSER_ERR);
  // Object.fromEntries defines each key as an own property, "__proto__" included.
  return Object.fromEntries(labels);
}
