import { describe, expect, it } from 'vitest';
import { classifyInfluxQL, splitInfluxStatements, stripInfluxComments } from '../src/query/adhocGuard.js';

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

    it('refuses a query that is only a comment', () => {
      const verdict = classifyInfluxQL('-- SELECT 1');
      expect(verdict.allowed).toBe(false);
      if (verdict.allowed) return;
      expect(verdict.reason).toContain('empty');
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

describe('stripInfluxComments', () => {
  it('replaces comments with a space rather than deleting them', () => {
    expect(stripInfluxComments('a/*x*/b')).toBe('a b');
    expect(stripInfluxComments('a -- x\nb')).toBe('a  \nb');
  });

  it('handles an unterminated block comment without hanging', () => {
    // A `*/`-less block comment simply doesn't match, leaving the text in place
    // — where the statement-head allowlist then judges it.
    expect(stripInfluxComments('SELECT /* oops')).toBe('SELECT /* oops');
  });
});

describe('splitInfluxStatements', () => {
  it('drops empty trailing statements from a trailing semicolon', () => {
    expect(splitInfluxStatements('SELECT 1;')).toEqual(['SELECT 1']);
    expect(splitInfluxStatements('SELECT 1;  ;  ')).toEqual(['SELECT 1']);
  });

  it('treats an escaped quote inside a literal as data', () => {
    expect(splitInfluxStatements(`SELECT 'it\\'s;fine'`)).toEqual([`SELECT 'it\\'s;fine'`]);
  });
});
