import { describe, expect, it } from 'vitest';
import { classifyInfluxQL, scanInfluxQL } from '../src/query/adhocGuard.js';

/** The statement the tool would actually execute, or undefined if refused. */
function executed(sql: string): string | undefined {
  const verdict = classifyInfluxQL(sql);
  return verdict.allowed ? verdict.statement : undefined;
}

/**
 * The refusal table is the point of this file. classifyInfluxQL is an accident
 * guard rather than an adversary fence (see its module comment), but the whole
 * value of an allowlisted statement head is that it holds against the shapes
 * below without anyone having to enumerate destructive verbs — so each of these
 * asserts the *reason* too, not just that something was refused, to catch a
 * refusal that happens to be right for the wrong rule.
 */
describe('classifyInfluxQL', () => {
  it('allows a plain SELECT', () => {
    const verdict = classifyInfluxQL('SELECT mean("value") FROM "cpu" WHERE $timeFilter GROUP BY time(1m)');
    expect(verdict.allowed).toBe(true);
  });

  it('allows SHOW statements', () => {
    expect(classifyInfluxQL('SHOW MEASUREMENTS').allowed).toBe(true);
    expect(classifyInfluxQL('SHOW TAG KEYS FROM "cpu"').allowed).toBe(true);
  });

  it('is case- and whitespace-insensitive about the statement head', () => {
    expect(classifyInfluxQL('  \n\tselect 1 FROM "m"').allowed).toBe(true);
    expect(classifyInfluxQL('SeLeCt 1 FROM "m"').allowed).toBe(true);
  });

  describe.each([
    ['DROP MEASUREMENT "cpu"', 'DROP'],
    ['DELETE FROM "cpu"', 'DELETE'],
    ['DROP DATABASE "telegraf"', 'DROP'],
    ['DROP RETENTION POLICY "a" ON "b"', 'DROP'],
    ['ALTER RETENTION POLICY "a" ON "b" DURATION 1h', 'ALTER'],
    ['CREATE DATABASE "x"', 'CREATE'],
    ['GRANT ALL ON "x" TO "y"', 'GRANT'],
    ['REVOKE ALL ON "x" FROM "y"', 'REVOKE'],
    ['KILL QUERY 42', 'KILL'],
  ])('refuses %s by statement head', (sql, head) => {
    it('names the head in the reason', () => {
      const verdict = classifyInfluxQL(sql);
      expect(verdict.allowed).toBe(false);
      if (verdict.allowed) return;
      expect(verdict.reason).toContain(head);
      expect(verdict.reason).toContain('Only SELECT and SHOW');
    });
  });

  it('refuses SELECT ... INTO, which writes despite beginning with SELECT', () => {
    const verdict = classifyInfluxQL('SELECT * INTO "copy" FROM "cpu"');
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.reason).toContain('INTO');
  });

  it('refuses INTO with no surrounding whitespace', () => {
    // An explicit "space or paren" separator class would miss this, because the
    // preceding character is `*`.
    expect(classifyInfluxQL('SELECT *INTO "copy" FROM "cpu"').allowed).toBe(false);
  });

  it('allows identifiers that merely contain the letters "into"', () => {
    expect(classifyInfluxQL('SELECT mean("into_bytes") FROM "net"').allowed).toBe(true);
    expect(classifyInfluxQL('SELECT * FROM "point_into"').allowed).toBe(true);
  });

  describe('statement smuggling', () => {
    it('refuses a second statement after a semicolon', () => {
      const verdict = classifyInfluxQL('SELECT 1 FROM "m"; DROP MEASUREMENT "cpu"');
      expect(verdict.allowed).toBe(false);
      if (verdict.allowed) return;
      expect(verdict.reason).toContain('2 statements');
    });

    it('refuses a statement hidden behind a line comment', () => {
      expect(classifyInfluxQL('SELECT 1 FROM "m" -- harmless\n; DROP MEASUREMENT "cpu"').allowed).toBe(false);
    });

    it('refuses a statement hidden behind a block comment', () => {
      expect(classifyInfluxQL('SELECT 1 FROM "m" /* nothing to see */ ; DELETE FROM "cpu"').allowed).toBe(false);
    });

    it('does not glue tokens together when a comment sits between them', () => {
      // Comments collapse to a space, matching InfluxDB's own lexer. Deleting
      // them instead would turn this into "SELECT1" and refuse a valid read.
      expect(classifyInfluxQL('SELECT/**/1 FROM "m"').allowed).toBe(true);
    });

    it('treats IN/**/TO as two tokens, exactly as InfluxDB does', () => {
      // Not an INTO smuggle: the database also lexes this as IN followed by TO,
      // so it is a syntax error there rather than a write we let through.
      expect(classifyInfluxQL('SELECT * IN/**/TO "copy" FROM "cpu"').allowed).toBe(true);
    });

    it('refuses a DROP hidden behind a literal that opens a block comment', () => {
      // Pre-#207-review this was allowed and executed as a truncated
      // `... WHERE t = '` — fail-safe (the datasource rejects it) but the
      // statement was silently rewritten. Now the `'/*'` literal is preserved,
      // the `;` is seen as a real separator, and this refuses as 2 statements.
      const verdict = classifyInfluxQL(`SELECT * FROM "m" WHERE t = '/*'; DROP MEASUREMENT "cpu" /*'*/`);
      expect(verdict.allowed).toBe(false);
      if (verdict.allowed) return;
      expect(verdict.reason).toContain('2 statements');
    });

    it('refuses a query that is only a comment', () => {
      const verdict = classifyInfluxQL('-- SELECT 1');
      expect(verdict.allowed).toBe(false);
      if (verdict.allowed) return;
      expect(verdict.reason).toContain('empty');
    });
  });

  describe('comment markers inside literals are data, not comments', () => {
    // This whole block is the gap that let the truncation bug ship: every
    // smuggling test above put its marker OUTSIDE a literal. The invariant that
    // matters is not just "allowed" — it's that what executes is what was
    // written, since the tool runs verdict.statement rather than the raw input.
    it('preserves a literal containing a double dash', () => {
      expect(executed(`SELECT * FROM "m" WHERE "note" = 'a--b'`)).toContain(`'a--b'`);
    });

    it('preserves a URL with a double dash mid-path, and everything after it', () => {
      const sql = `SELECT * FROM "m" WHERE "url" = 'http://x/a--b' AND "host" = 'web1'`;
      expect(executed(sql)).toBe(sql);
    });

    it('preserves a literal containing block-comment delimiters', () => {
      expect(executed(`SELECT * FROM "m" WHERE "note" = 'a/*b*/c'`)).toContain(`'a/*b*/c'`);
    });

    it('preserves a comment marker inside a quoted identifier', () => {
      expect(executed('SELECT * FROM "we--ird"')).toContain('"we--ird"');
    });

    it('still strips a real comment outside a literal', () => {
      expect(executed(`SELECT * FROM "m" -- trailing note`)?.trim()).toBe('SELECT * FROM "m"');
    });

    it('does not treat a literal "into" as SELECT ... INTO', () => {
      // Keyword checks run against a view with literal contents blanked, so this
      // false positive (documented as accepted before the review) is now gone.
      expect(classifyInfluxQL(`SELECT * FROM "m" WHERE "action" = 'into'`).allowed).toBe(true);
    });

    it('does not treat a quoted identifier containing a verb as that statement', () => {
      expect(classifyInfluxQL('SELECT * FROM "drop table"').allowed).toBe(true);
    });
  });

  describe('unterminated input is refused, never rewritten', () => {
    it.each([
      [`SELECT * FROM "m" WHERE t = 'oops`, 'string literal'],
      ['SELECT * FROM "oops', 'quoted identifier'],
      ['SELECT * FROM "m" WHERE "p" =~ /oops', 'regular expression'],
      ['SELECT * FROM "m" /* oops', 'block comment'],
    ])('refuses %s', (sql, kind) => {
      const verdict = classifyInfluxQL(sql);
      expect(verdict.allowed).toBe(false);
      if (verdict.allowed) return;
      expect(verdict.reason).toContain(kind);
    });
  });

  describe('regex literals', () => {
    it('allows a semicolon inside an =~ regex without calling it a second statement', () => {
      // Previously refused as "2 statements", a reason that invites a blind retry
      // on a query that only ever had one.
      expect(classifyInfluxQL('SELECT * FROM "m" WHERE "path" =~ /a;b/').allowed).toBe(true);
    });

    it('allows !~ as well as =~', () => {
      expect(classifyInfluxQL('SELECT * FROM "m" WHERE "path" !~ /a;b/').allowed).toBe(true);
    });

    it('does not mistake division for a regex literal', () => {
      // A naive "any slash starts a regex" would swallow the rest of the query
      // and hide a trailing statement.
      expect(executed('SELECT "value" / 2 FROM "m"')).toBe('SELECT "value" / 2 FROM "m"');
      expect(classifyInfluxQL('SELECT "value" / 2 FROM "m"; DROP MEASUREMENT "cpu"').allowed).toBe(false);
    });

    it('still refuses a real second statement after a regex literal', () => {
      expect(classifyInfluxQL('SELECT * FROM "m" WHERE "p" =~ /a/; DROP MEASUREMENT "cpu"').allowed).toBe(false);
    });
  });

  describe('semicolons inside literals are data, not separators', () => {
    it('allows a single-quoted literal containing a semicolon', () => {
      expect(classifyInfluxQL(`SELECT * FROM "m" WHERE "tag" = 'a;b'`).allowed).toBe(true);
    });

    it('allows a double-quoted identifier containing a semicolon', () => {
      expect(classifyInfluxQL('SELECT * FROM "we;ird"').allowed).toBe(true);
    });

    it('still refuses a real second statement that follows a literal with a semicolon in it', () => {
      expect(classifyInfluxQL(`SELECT * FROM "m" WHERE t = 'a;b'; DROP MEASUREMENT "cpu"`).allowed).toBe(false);
    });
  });

  describe.each([
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    ['-- nothing', 'comment only'],
    ['(SELECT 1)', 'does not start with a keyword'],
    ['42', 'starts with a number'],
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'unsupported leading keyword'],
  ])('refuses %s', (sql) => {
    it('refuses rather than guessing', () => {
      expect(classifyInfluxQL(sql).allowed).toBe(false);
    });
  });
});

describe('scanInfluxQL', () => {
  it('replaces comments with a space rather than deleting them', () => {
    expect(scanInfluxQL('a/*x*/b').statements).toEqual(['a b']);
    // Two spaces: the one already in the source, plus the one the comment
    // collapses to. The newline that ends the comment is kept as-is.
    expect(scanInfluxQL('a -- x\nb').statements).toEqual(['a  \nb']);
  });

  it('drops empty statements from a trailing or doubled semicolon', () => {
    expect(scanInfluxQL('SELECT 1;').statements).toEqual(['SELECT 1']);
    expect(scanInfluxQL('SELECT 1;  ;  ').statements).toEqual(['SELECT 1']);
  });

  it('treats an escaped quote inside a literal as data', () => {
    expect(scanInfluxQL(`SELECT 'it\\'s;fine'`).statements).toEqual([`SELECT 'it\\'s;fine'`]);
  });

  it('reports what it ran out of input inside', () => {
    expect(scanInfluxQL(`SELECT 'x`).unterminated).toBe('string literal');
    expect(scanInfluxQL('SELECT /* x').unterminated).toBe('block comment');
    expect(scanInfluxQL('SELECT 1').unterminated).toBeUndefined();
  });

  it('blanks literal contents in keywordText while keeping the executable text intact', () => {
    // The two views are what let a literal be preserved for execution and
    // simultaneously be invisible to the keyword checks.
    const scan = scanInfluxQL(`SELECT * FROM "m" WHERE t = 'drop into'`);
    expect(scan.statements[0]).toContain(`'drop into'`);
    expect(scan.keywordText[0]).not.toContain('drop');
    expect(scan.keywordText[0]).not.toContain('into');
    // Delimiters survive; the interior blanks to one space per character, so a
    // literal reads as an empty-but-present literal rather than as nothing.
    expect(scan.keywordText[0]).toMatch(/'\s+'/);
  });

  it('keeps delimiters in keywordText so a blanked literal is still visible as one', () => {
    // Not a claim that offsets line up — both views are trimmed independently,
    // so a statement ending in a blanked literal legitimately differs in length.
    // What matters is that a literal reads as an empty literal, not as nothing.
    expect(scanInfluxQL(`SELECT t FROM "m" WHERE t = 'abc' AND u = 1`).keywordText[0]).toMatch(/= '\s{3}' AND/);
  });
});
