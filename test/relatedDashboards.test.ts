import { describe, expect, it } from 'vitest';
import { extractRelatedDashboardUids } from '../src/knowledge/relatedDashboards.js';

describe('extractRelatedDashboardUids', () => {
  it('extracts a dashboard uid from a links object', () => {
    const json = { links: { opsDashboard: '/d/product-status-manageddatabase?from=${__from}&to=${__to}' } };
    expect(extractRelatedDashboardUids(json)).toEqual(['product-status-manageddatabase']);
  });

  it('extracts every dashboard uid from a nested dependencies array, deduping repeats', () => {
    const json = {
      links: { opsDashboard: '/d/product-status-manageddatabase' },
      sli: {
        controlPlane: {
          dependencies: [
            { ref: 'compute', url: '/d/product-status-ec2-sli?from=${__from}&to=${__to}' },
            { ref: 'blockstorage', url: '/d/product-status-nbs-sli' },
            { ref: 'iam', url: null },
          ],
        },
        dataPlane: {
          dependencies: [{ ref: 'compute', url: '/d/product-status-ec2-sli' }],
        },
      },
    };
    expect(extractRelatedDashboardUids(json).sort()).toEqual(
      ['product-status-ec2-sli', 'product-status-manageddatabase', 'product-status-nbs-sli'].sort(),
    );
  });

  it('ignores non-dashboard links (docs/wiki urls with no /d/ segment)', () => {
    const json = { docs: { ops: 'https://wiki.example.com/wiki/spaces/SE/pages/496238667' } };
    expect(extractRelatedDashboardUids(json)).toEqual([]);
  });

  it('returns an empty array for undefined, null, or primitive json', () => {
    expect(extractRelatedDashboardUids(undefined)).toEqual([]);
    expect(extractRelatedDashboardUids(null)).toEqual([]);
    expect(extractRelatedDashboardUids('just a string')).toEqual([]);
    expect(extractRelatedDashboardUids(42)).toEqual([]);
  });
});
