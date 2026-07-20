import { describe, expect, it } from 'vitest';
import { substituteVariables, substituteTargetFields, resolveDatasourceVariable } from '../src/dashboards/variables.js';
import { DEFAULT_MAX_DATA_POINTS } from '../src/config.js';
import type { TemplateVariable } from '../src/grafana/types.js';

const window = { fromMs: 1_700_000_000_000, toMs: 1_700_003_600_000 };
const dayWindow = { fromMs: 0, toMs: 86_400_000 };

describe('substituteVariables', () => {
  it('substitutes a single-value variable raw', () => {
    const variables: TemplateVariable[] = [{ name: 'service', type: 'custom', current: { value: 'checkout' } }];
    expect(substituteVariables('up{service="$service"}', variables, {}, window)).toBe('up{service="checkout"}');
  });

  it('substitutes a multi-value override as a regex alternation by default', () => {
    const variables: TemplateVariable[] = [{ name: 'service', type: 'custom', current: { value: 'checkout' } }];
    const overrides = { service: ['checkout', 'payments'] };
    expect(substituteVariables('up{service=~"$service"}', variables, overrides, window)).toBe(
      'up{service=~"(checkout|payments)"}',
    );
  });

  it('supports ${var:pipe} and ${var:csv} formats', () => {
    const variables: TemplateVariable[] = [{ name: 'host', type: 'custom', current: { value: ['a', 'b'] } }];
    expect(substituteVariables('hosts: ${host:pipe}', variables, {}, window)).toBe('hosts: a|b');
    expect(substituteVariables('hosts: ${host:csv}', variables, {}, window)).toBe('hosts: a,b');
  });

  it('prefers an override over the dashboard current value', () => {
    const variables: TemplateVariable[] = [{ name: 'env', type: 'custom', current: { value: 'staging' } }];
    expect(substituteVariables('$env', variables, { env: ['prod'] }, window)).toBe('prod');
  });

  it('resolves $__all to the variable options when includeAll is set without an explicit allValue', () => {
    const variables: TemplateVariable[] = [
      {
        name: 'region',
        type: 'custom',
        current: { value: '$__all' },
        includeAll: true,
        options: [
          { text: 'All', value: '$__all' },
          { text: 'us-east-1', value: 'us-east-1' },
          { text: 'us-west-2', value: 'us-west-2' },
        ],
      },
    ];
    expect(substituteVariables('region=~"$region"', variables, {}, window)).toBe('region=~"(us-east-1|us-west-2)"');
  });

  it('resolves $__all arriving as a URL override (var-region=$__all), not just a saved current value', () => {
    const variables: TemplateVariable[] = [
      {
        name: 'region',
        type: 'custom',
        current: { value: 'us-east-1' },
        includeAll: true,
        options: [
          { text: 'All', value: '$__all' },
          { text: 'us-east-1', value: 'us-east-1' },
          { text: 'us-west-2', value: 'us-west-2' },
        ],
      },
    ];
    expect(substituteVariables('region=~"$region"', variables, { region: ['$__all'] }, window)).toBe(
      'region=~"(us-east-1|us-west-2)"',
    );
  });

  it('resolves an unresolvable $__all (no allValue, no cached options) to a wildcard rather than an empty match', () => {
    const variables: TemplateVariable[] = [
      { name: 'proxy_host', type: 'query', current: { value: '$__all' }, includeAll: true, options: [] },
    ];
    expect(substituteVariables('proxy_host=~"$proxy_host"', variables, {}, window)).toBe('proxy_host=~".*"');
    expect(substituteVariables('proxy_host=~"${proxy_host:regex}"', variables, {}, window)).toBe('proxy_host=~".*"');
  });

  it('leaves non-regex formats empty for an unresolvable $__all, rather than guessing at wildcard syntax', () => {
    const variables: TemplateVariable[] = [
      { name: 'proxy_host', type: 'query', current: { value: '$__all' }, includeAll: true, options: [] },
    ];
    expect(substituteVariables('hosts: ${proxy_host:csv}', variables, {}, window)).toBe('hosts: ');
  });

  it('replaces built-in time macros', () => {
    const result = substituteVariables('time >= $__from and time <= $__to, step=$__interval', [], {}, window);
    expect(result).toContain(`${window.fromMs}`);
    expect(result).toContain(`${window.toMs}`);
    expect(result).toMatch(/step=\d+[a-z]/);
  });

  it('computes $__interval from an explicit maxDataPoints (the same value sent to /api/ds/query), not a hardcoded assumption', () => {
    // 24h window: 100 points (a "small window" assumption) buckets much coarser than 2000 (a "big display").
    const narrow = substituteVariables('step=$__interval', [], {}, dayWindow, 100);
    const wide = substituteVariables('step=$__interval', [], {}, dayWindow, 2000);
    expect(narrow).toBe('step=30m');
    expect(wide).toBe('step=1m');
  });

  it('defaults $__interval to the same big-display point budget as MAX_DATA_POINTS when no maxDataPoints is passed (#53)', () => {
    const omitted = substituteVariables('step=$__interval', [], {}, dayWindow);
    const explicit = substituteVariables('step=$__interval', [], {}, dayWindow, DEFAULT_MAX_DATA_POINTS);
    expect(omitted).toBe(explicit);
    expect(omitted).toBe('step=1m');
  });

  it('replaces $timeFilter with an InfluxQL-style clause', () => {
    const result = substituteVariables('SELECT * FROM cpu WHERE $timeFilter', [], {}, window);
    expect(result).toBe(`SELECT * FROM cpu WHERE time >= ${window.fromMs}ms and time <= ${window.toMs}ms`);
  });

  it('does not partially match a longer variable name sharing a prefix', () => {
    const variables: TemplateVariable[] = [
      { name: 'service', type: 'custom', current: { value: 'A' } },
      { name: 'service_name', type: 'custom', current: { value: 'B' } },
    ];
    const result = substituteVariables('$service_name and $service', variables, {}, window);
    expect(result).toBe('B and A');
  });

  it('substitutes the [[name]] bracket form', () => {
    const variables: TemplateVariable[] = [{ name: 'host', type: 'custom', current: { value: 'web1' } }];
    expect(substituteVariables('SELECT WHERE h=[[host]]', variables, {}, window)).toBe('SELECT WHERE h=web1');
  });

  it('substitutes a multi-value [[name]] as a regex alternation', () => {
    const variables: TemplateVariable[] = [{ name: 'host', type: 'custom', current: { value: ['a', 'b'] } }];
    expect(substituteVariables('h=~"[[host]]"', variables, {}, window)).toBe('h=~"(a|b)"');
  });

  // `$'`, `` $` ``, `$&` and `$1` are JS replacement patterns — inserting a
  // value containing one via a string replacement rewrites the surrounding
  // query instead of substituting literally. Each form is exercised because
  // they expand differently ($' = text after the match, $` = text before).
  it.each([
    ["a$'b", 'trailing-context'],
    ['a$`b', 'leading-context'],
    ['a$&b', 'whole-match'],
    ['a$1b', 'capture-group'],
  ])('inserts a value containing %s literally in the [[name]] form', (value) => {
    const variables: TemplateVariable[] = [{ name: 'host', type: 'custom', current: { value } }];
    expect(substituteVariables('SELECT WHERE h=[[host]] AND x=1', variables, {}, window)).toBe(
      `SELECT WHERE h=${value} AND x=1`,
    );
  });

  it('treats $-bearing values identically across the $name, ${name} and [[name]] forms', () => {
    const variables: TemplateVariable[] = [{ name: 'host', type: 'custom', current: { value: "a$'b" } }];
    const expected = "h=a$'b";
    expect(substituteVariables('h=$host', variables, {}, window)).toBe(expected);
    expect(substituteVariables('h=${host}', variables, {}, window)).toBe(expected);
    expect(substituteVariables('h=[[host]]', variables, {}, window)).toBe(expected);
  });
});

describe('substituteTargetFields', () => {
  it('substitutes expr for Prometheus targets and leaves other fields untouched', () => {
    const variables: TemplateVariable[] = [{ name: 'service', type: 'custom', current: { value: 'checkout' } }];
    const result = substituteTargetFields(
      { refId: 'A', expr: 'up{service="$service"}', legendFormat: '{{service}}' },
      variables,
      {},
      window,
    );
    expect(result.expr).toBe('up{service="checkout"}');
    expect(result.legendFormat).toBe('{{service}}');
  });

  it('substitutes query for InfluxQL targets', () => {
    const variables: TemplateVariable[] = [{ name: 'host', type: 'custom', current: { value: 'db1' } }];
    const result = substituteTargetFields({ refId: 'A', query: 'SELECT mean("value") FROM cpu WHERE host = \'$host\'' }, variables, {}, window);
    expect(result.query).toBe("SELECT mean(\"value\") FROM cpu WHERE host = 'db1'");
  });

  it('substitutes a variable embedded inside a builder-mode InfluxQL tag filter value', () => {
    const variables: TemplateVariable[] = [{ name: 'host', type: 'query', current: { value: 'telegraf-api-prd' } }];
    const result = substituteTargetFields(
      {
        refId: 'A',
        measurement: 'influx_proxy_backend_status',
        policy: 'raw',
        tags: [{ key: 'host::tag', operator: '=~', value: '/^$host$/' }],
      },
      variables,
      {},
      window,
    );
    expect(result.tags).toEqual([{ key: 'host::tag', operator: '=~', value: '/^telegraf-api-prd$/' }]);
    expect(result.measurement).toBe('influx_proxy_backend_status');
    expect(result.policy).toBe('raw');
  });

  it('resolves an unresolvable $__all inside a builder-mode tag filter to a wildcard, not /^$/ (real incident: this silently zeroed every panel on a live dashboard)', () => {
    const variables: TemplateVariable[] = [
      { name: 'proxy_host', type: 'query', current: { value: '$__all' }, includeAll: true, options: [] },
    ];
    const result = substituteTargetFields(
      { refId: 'A', tags: [{ key: 'proxy_host::tag', operator: '=~', value: '/^$proxy_host$/' }] },
      variables,
      {},
      window,
    );
    expect(result.tags).toEqual([{ key: 'proxy_host::tag', operator: '=~', value: '/^.*$/' }]);
  });

  it('substitutes builder-mode fields using an explicit override', () => {
    const variables: TemplateVariable[] = [{ name: 'host', type: 'query', current: { value: 'default-host' } }];
    const overrides = { host: ['telegraf-api-platform-monitoring-prd'] };
    const result = substituteTargetFields(
      { refId: 'A', tags: [{ key: 'host::tag', operator: '=~', value: '/^$host$/' }] },
      variables,
      overrides,
      window,
    );
    expect(result.tags).toEqual([{ key: 'host::tag', operator: '=~', value: '/^telegraf-api-platform-monitoring-prd$/' }]);
  });
});

describe('resolveDatasourceVariable', () => {
  it('resolves a $name-style datasource variable reference to its current value', () => {
    const variables: TemplateVariable[] = [{ name: 'datasource', type: 'datasource', current: { value: 'prom1' } }];
    expect(resolveDatasourceVariable('$datasource', variables, {})).toBe('prom1');
  });

  it('resolves a ${name}-style reference, including Grafana\'s ${DS_PROMETHEUS} convention', () => {
    const variables: TemplateVariable[] = [{ name: 'DS_PROMETHEUS', type: 'datasource', current: { value: 'prom1' } }];
    expect(resolveDatasourceVariable('${DS_PROMETHEUS}', variables, {})).toBe('prom1');
  });

  it('prefers an override over the dashboard current value, same as query-text substitution', () => {
    const variables: TemplateVariable[] = [{ name: 'datasource', type: 'datasource', current: { value: 'prom1' } }];
    expect(resolveDatasourceVariable('$datasource', variables, { datasource: ['prom2'] })).toBe('prom2');
  });

  it('returns the ref unchanged when it is not a variable reference (a real UID or a legacy literal name)', () => {
    const variables: TemplateVariable[] = [];
    expect(resolveDatasourceVariable('prom1', variables, {})).toBe('prom1');
    expect(resolveDatasourceVariable('Griffin-ELB', variables, {})).toBe('Griffin-ELB');
  });

  it('returns undefined for a variable reference the dashboard does not define', () => {
    expect(resolveDatasourceVariable('$missing', [], {})).toBeUndefined();
  });
});
