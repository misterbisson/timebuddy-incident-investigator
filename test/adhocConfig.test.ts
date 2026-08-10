import { describe, expect, it } from 'vitest';
import { parseAdhocQueryFlags } from '../src/config.js';

describe('parseAdhocQueryFlags', () => {
  it('finds nothing in a normal argv', () => {
    expect(parseAdhocQueryFlags(['electron', '.', '--mcp-server'])).toEqual({ policies: [], problems: [] });
  });

  it('parses one host and datasource type', () => {
    const { policies, problems } = parseAdhocQueryFlags(['--allow-adhoc-queries=metrics.staging.example.com:influxdb']);
    expect(problems).toEqual([]);
    expect(policies).toEqual([{ host: 'metrics.staging.example.com', datasourceTypes: ['influxdb'] }]);
  });

  it('lowercases both host and types so a checked-in file is not case-sensitive', () => {
    const { policies } = parseAdhocQueryFlags(['--allow-adhoc-queries=Metrics.Staging.Example.COM:InfluxDB']);
    expect(policies).toEqual([{ host: 'metrics.staging.example.com', datasourceTypes: ['influxdb'] }]);
  });

  it('accepts several comma-separated types', () => {
    const { policies } = parseAdhocQueryFlags(['--allow-adhoc-queries=host.example.com:influxdb,prometheus']);
    expect(policies[0]!.datasourceTypes).toEqual(['influxdb', 'prometheus']);
  });

  it('is repeatable, one flag per authorized endpoint', () => {
    const { policies } = parseAdhocQueryFlags([
      '--allow-adhoc-queries=a.example.com:influxdb',
      '--mcp-server',
      '--allow-adhoc-queries=b.example.com:prometheus',
    ]);
    expect(policies).toEqual([
      { host: 'a.example.com', datasourceTypes: ['influxdb'] },
      { host: 'b.example.com', datasourceTypes: ['prometheus'] },
    ]);
  });

  it('keeps a port on the host, splitting on the last colon', () => {
    const { policies } = parseAdhocQueryFlags(['--allow-adhoc-queries=localhost:3000:influxdb']);
    expect(policies).toEqual([{ host: 'localhost:3000', datasourceTypes: ['influxdb'] }]);
  });

  describe('refuses to grant more than was spelled out', () => {
    it('rejects a bare flag with no value rather than enabling everything', () => {
      const { policies, problems } = parseAdhocQueryFlags(['--allow-adhoc-queries']);
      expect(policies).toEqual([]);
      expect(problems[0]).toContain('requires a value');
    });

    it('rejects a host with no datasource type', () => {
      const { policies, problems } = parseAdhocQueryFlags(['--allow-adhoc-queries=host.example.com']);
      expect(policies).toEqual([]);
      expect(problems[0]).toContain('malformed');
    });

    it('rejects a trailing colon with no type', () => {
      const { policies } = parseAdhocQueryFlags(['--allow-adhoc-queries=host.example.com:']);
      expect(policies).toEqual([]);
    });

    it('rejects a leading colon with no host', () => {
      const { policies } = parseAdhocQueryFlags(['--allow-adhoc-queries=:influxdb']);
      expect(policies).toEqual([]);
    });

    it('reports a malformed flag but still honors a valid one alongside it', () => {
      // A typo shouldn't be fatal (it would take every other tool down with it),
      // but it also shouldn't be silent.
      const { policies, problems } = parseAdhocQueryFlags([
        '--allow-adhoc-queries=typo-no-type',
        '--allow-adhoc-queries=good.example.com:influxdb',
      ]);
      expect(policies).toEqual([{ host: 'good.example.com', datasourceTypes: ['influxdb'] }]);
      expect(problems).toHaveLength(1);
    });
  });
});
