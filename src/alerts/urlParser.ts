export interface ParsedDashboardUrl {
  type: 'dashboard';
  uid: string;
  slug?: string;
  panelId?: number;
  vars: Record<string, string[]>;
  from?: string;
  to?: string;
}

export interface ParsedAlertRuleUrl {
  type: 'alert-rule';
  ruleUid: string;
}

export type ParsedGrafanaUrl = ParsedDashboardUrl | ParsedAlertRuleUrl;

/**
 * Parses the Grafana URL shapes an on-call engineer would actually click:
 * dashboard/panel links (`/d/:uid/:slug`, `/d-solo/:uid/:slug`) and
 * alert-rule links (`/alerting/grafana/:ruleUid/view`).
 */
export function parseGrafanaUrl(rawUrl: string): ParsedGrafanaUrl {
  const url = new URL(rawUrl);

  const dashboardMatch = url.pathname.match(/\/d(?:-solo)?\/([^/]+)(?:\/([^/]+))?/);
  if (dashboardMatch) {
    const [, uid, slug] = dashboardMatch;
    const vars: Record<string, string[]> = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (key.startsWith('var-')) {
        const name = key.slice('var-'.length);
        (vars[name] ??= []).push(value);
      }
    }
    const panelIdRaw = url.searchParams.get('viewPanel') ?? url.searchParams.get('panelId');
    return {
      type: 'dashboard',
      uid: uid!,
      slug,
      panelId: panelIdRaw ? Number.parseInt(panelIdRaw, 10) : undefined,
      vars,
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
    };
  }

  const alertRuleMatch = url.pathname.match(/\/alerting\/grafana\/([^/]+)\/view/);
  if (alertRuleMatch) {
    return { type: 'alert-rule', ruleUid: alertRuleMatch[1]! };
  }

  throw new Error(
    `Unrecognized Grafana URL: ${rawUrl} (expected a dashboard/panel link "/d/:uid/..." or an alert rule link "/alerting/grafana/:uid/view")`,
  );
}
