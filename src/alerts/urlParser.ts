export interface ParsedDashboardUrl {
  type: 'dashboard';
  uid: string;
  slug?: string;
  panelId?: number;
  vars: Record<string, string[]>;
  /** var-* names that had one or more values dropped for containing characters unsafe to substitute into a query string (see isSafeVariableValue). */
  rejectedVars?: string[];
  from?: string;
  to?: string;
}

/**
 * A var-* value ends up substituted raw into a PromQL/InfluxQL query string
 * (dashboards/variables.ts's default formatValues branch escapes nothing),
 * and these values can originate from an attacker-controlled webhook payload
 * or pasted URL (alerts/ingest.ts) — not just a human clicking a real Grafana
 * link. Rather than escaping (which would risk diverging from what Grafana
 * itself would literally send for a given variable), reject values carrying
 * characters that could break out of the intended label/string context:
 * quotes and backtick (close a quoted string), backslash (escape sequences),
 * semicolon (InfluxQL statement separator), curly braces (PromQL matcher
 * block boundaries), "$" (macro/variable re-injection), and control
 * characters/newlines.
 */
const UNSAFE_VAR_VALUE_RE = /[\x00-\x1f\x7f"'`\\;{}$]/;

function isSafeVariableValue(value: string): boolean {
  return !UNSAFE_VAR_VALUE_RE.test(value);
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
    const rejectedVars = new Set<string>();
    for (const [key, value] of url.searchParams.entries()) {
      if (key.startsWith('var-')) {
        const name = key.slice('var-'.length);
        if (isSafeVariableValue(value)) {
          (vars[name] ??= []).push(value);
        } else {
          rejectedVars.add(name);
        }
      }
    }
    const panelIdRaw = url.searchParams.get('viewPanel') ?? url.searchParams.get('panelId');
    return {
      type: 'dashboard',
      uid: uid!,
      slug,
      panelId: panelIdRaw ? Number.parseInt(panelIdRaw, 10) : undefined,
      vars,
      ...(rejectedVars.size > 0 ? { rejectedVars: [...rejectedVars] } : {}),
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

const RELATIVE_TIME_RE = /^now(?:-(\d+)([smhdwMy]))?$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

function subtractMonths(fromMs: number, months: number): number {
  const d = new Date(fromMs);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
}

/**
 * Interprets one Grafana URL time-range param (a dashboard link's "from"/"to")
 * against a reference time: "now", "now-<N><unit>" (Grafana's relative-time
 * shorthand — s/m/h/d/w minutes-vs-months disambiguated by case, M for
 * months, y for years), an absolute epoch-ms numeric string, or an ISO 8601
 * date/time. Grafana's rounding shorthand ("now/d", "now-1d/d") isn't
 * supported — same best-effort-scope tradeoff as PromQL/InfluxQL extraction
 * elsewhere in this codebase; throws rather than silently mis-computing a
 * window from an expression it can't fully interpret.
 */
export function parseGrafanaTimeExpr(value: string, nowMs: number): number {
  const relative = value.match(RELATIVE_TIME_RE);
  if (relative) {
    const [, amountStr, unit] = relative;
    if (amountStr === undefined) return nowMs;
    const amount = Number(amountStr);
    if (unit === 'M') return subtractMonths(nowMs, amount);
    if (unit === 'y') return subtractMonths(nowMs, amount * 12);
    return nowMs - amount * UNIT_MS[unit!]!;
  }
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return parsed;
  throw new Error(
    `Could not parse Grafana time param "${value}" — expected "now", "now-<N><unit>" (s/m/h/d/w/M/y), an epoch-ms ` +
      'number, or an ISO 8601 date/time. Grafana\'s rounding shorthand ("now/d") is not supported.',
  );
}
