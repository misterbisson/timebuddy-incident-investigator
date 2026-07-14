import { describe, expect, it } from 'vitest';
import {
  buildShowFieldKeysQuery,
  buildShowMeasurementsQuery,
  buildShowTagKeysQuery,
  escapeInfluxIdentifier,
  escapeInfluxRegexLiteral,
  parseNameListFrames,
} from '../src/tools/discoverInfluxdbSchema.js';
import type { DsQueryResponse } from '../src/grafana/types.js';

describe('escapeInfluxRegexLiteral', () => {
  it('escapes regex metacharacters so the term matches only as a literal substring', () => {
    expect(escapeInfluxRegexLiteral('cpu.load')).toBe('cpu\\.load');
    expect(escapeInfluxRegexLiteral('a+b*c')).toBe('a\\+b\\*c');
  });

  it('escapes the `/` delimiter itself, so a searchTerm cannot break out of the regex literal', () => {
    expect(escapeInfluxRegexLiteral('foo/(?i)bar')).toBe('foo\\/\\(\\?i\\)bar');
  });
});

describe('escapeInfluxIdentifier', () => {
  it('escapes embedded double quotes and backslashes', () => {
    expect(escapeInfluxIdentifier('weird"measurement')).toBe('weird\\"measurement');
    expect(escapeInfluxIdentifier('back\\slash')).toBe('back\\\\slash');
  });
});

describe('buildShowMeasurementsQuery', () => {
  it('wraps an escaped, case-insensitive regex literal', () => {
    expect(buildShowMeasurementsQuery('ceph_health')).toBe('SHOW MEASUREMENTS WITH MEASUREMENT =~ /(?i)ceph_health/');
  });

  it('neutralizes an attempt to inject a semicolon-separated statement via searchTerm', () => {
    const malicious = 'x/ ; DROP SERIES FROM "y"; SHOW MEASUREMENTS WITH MEASUREMENT =~ /z';
    const query = buildShowMeasurementsQuery(malicious);
    // The whole malicious string lands inside a single escaped regex literal — no unescaped `/` to close it early.
    expect(query).toBe(
      'SHOW MEASUREMENTS WITH MEASUREMENT =~ /(?i)x\\/ ; DROP SERIES FROM "y"; SHOW MEASUREMENTS WITH MEASUREMENT =~ \\/z/',
    );
  });
});

describe('buildShowFieldKeysQuery / buildShowTagKeysQuery', () => {
  it('quotes the measurement as an InfluxQL identifier', () => {
    expect(buildShowFieldKeysQuery('solidfire_cluster_active_faults')).toBe('SHOW FIELD KEYS FROM "solidfire_cluster_active_faults"');
    expect(buildShowTagKeysQuery('solidfire_cluster_active_faults')).toBe('SHOW TAG KEYS FROM "solidfire_cluster_active_faults"');
  });
});

function tableResponse(refId: string, fields: Array<{ name: string; type: string }>, values: unknown[][]): DsQueryResponse {
  return { results: { [refId]: { frames: [{ schema: { refId, fields }, data: { values } }] } } };
}

describe('parseNameListFrames', () => {
  it('collects string values from non-time fields, deduped and sorted', () => {
    const response = tableResponse(
      'A',
      [{ name: 'name', type: 'string' }],
      [['zebra_metric', 'alpha_metric', 'zebra_metric']],
    );
    expect(parseNameListFrames(response)).toEqual({ names: ['alpha_metric', 'zebra_metric'], errors: {} });
  });

  it('ignores time-typed fields and non-string values', () => {
    const response = tableResponse(
      'A',
      [
        { name: 'time', type: 'time' },
        { name: 'fieldKey', type: 'string' },
        { name: 'fieldType', type: 'string' },
      ],
      [
        [1_700_000_000_000],
        ['value'],
        ['float'],
      ],
    );
    expect(parseNameListFrames(response)).toEqual({ names: ['float', 'value'], errors: {} });
  });

  it('surfaces a per-refId error instead of throwing', () => {
    const response: DsQueryResponse = { results: { A: { error: 'measurement not found' } } };
    expect(parseNameListFrames(response)).toEqual({ names: [], errors: { A: 'measurement not found' } });
  });

  it('returns an empty name list when there are no frames', () => {
    const response: DsQueryResponse = { results: { A: { frames: [] } } };
    expect(parseNameListFrames(response)).toEqual({ names: [], errors: {} });
  });
});
