import type { GrafanaClient } from '../grafana/client.js';
import type { AlertmanagerAlert, RulerAlertRule } from '../grafana/types.js';
import { parseGrafanaUrl } from './urlParser.js';

export interface AlertContext {
  source: 'webhook' | 'pasted-json' | 'url';
  alertName?: string;
  status?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  dashboardUid?: string;
  panelId?: number;
  ruleUid?: string;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
  fingerprint?: string;
  /** Variable values captured from a panel/dashboard link, keyed by variable name. */
  variables: Record<string, string[]>;
  /** Best-effort threshold description, when derivable from the rule definition. */
  threshold?: string;
  /** The alert rule's query targets, when resolved via ruleUid. */
  ruleQueries?: RulerAlertRule['data'];
  warnings: string[];
}

/** A Grafana Alertmanager-style webhook payload (contact point POST body). */
export interface WebhookPayload {
  receiver?: string;
  status?: string;
  alerts: AlertmanagerAlert[];
  groupLabels?: Record<string, string>;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
}

function isWebhookPayload(value: unknown): value is WebhookPayload {
  return typeof value === 'object' && value !== null && Array.isArray((value as WebhookPayload).alerts);
}

function isSingleAlert(value: unknown): value is AlertmanagerAlert {
  return (
    typeof value === 'object' &&
    value !== null &&
    'labels' in value &&
    'annotations' in value &&
    !('alerts' in value)
  );
}

function extractDashboardLink(alert: AlertmanagerAlert, warnings: string[]): {
  dashboardUid?: string;
  panelId?: number;
  variables: Record<string, string[]>;
} {
  const dashUidAnnotation = alert.annotations?.__dashboardUid__;
  const panelIdAnnotation = alert.annotations?.__panelId__;
  if (dashUidAnnotation) {
    return {
      dashboardUid: dashUidAnnotation,
      panelId: panelIdAnnotation ? Number.parseInt(panelIdAnnotation, 10) : undefined,
      variables: {},
    };
  }

  for (const link of [alert.panelURL, alert.dashboardURL, alert.generatorURL]) {
    if (!link) continue;
    try {
      const parsed = parseGrafanaUrl(link);
      if (parsed.type === 'dashboard') {
        return { dashboardUid: parsed.uid, panelId: parsed.panelId, variables: parsed.vars };
      }
    } catch {
      // Not every generatorURL is a dashboard link (rule-only alerts point at
      // /alerting/grafana/:uid/view instead) — that's expected, not an error.
    }
  }

  warnings.push(
    'Could not resolve a dashboard/panel link from the alert (no __dashboardUid__ annotation or dashboard-shaped URL). ' +
      'This alert rule may not be linked to a specific panel; use find_related_dashboards with the alert labels instead.',
  );
  return { variables: {} };
}

function fromAlertmanagerAlert(alert: AlertmanagerAlert, source: AlertContext['source']): AlertContext {
  const warnings: string[] = [];
  const { dashboardUid, panelId, variables } = extractDashboardLink(alert, warnings);
  return {
    source,
    alertName: alert.labels?.alertname,
    status: alert.status?.state,
    labels: alert.labels ?? {},
    annotations: alert.annotations ?? {},
    dashboardUid,
    panelId,
    startsAt: alert.startsAt,
    endsAt: alert.status?.state === 'resolved' ? alert.endsAt : undefined,
    generatorURL: alert.generatorURL,
    fingerprint: alert.fingerprint,
    variables,
    warnings,
  };
}

/** Extracts a best-effort human-readable threshold description from a rule's condition. */
function describeThreshold(rule: RulerAlertRule): string | undefined {
  const conditionQuery = rule.data.find((q) => q.refId === rule.condition);
  const model = conditionQuery?.model as { conditions?: Array<{ evaluator?: { type?: string; params?: number[] } }> } | undefined;
  const evaluator = model?.conditions?.[0]?.evaluator;
  if (!evaluator?.type || !evaluator.params) return undefined;
  return `${evaluator.type} ${evaluator.params.join(', ')}`;
}

/**
 * Normalizes a webhook payload, a single pasted alert JSON object, or a
 * Grafana URL (dashboard/panel/alert-rule) into a structured AlertContext.
 * Given only a rule/generator URL, it fetches the rule definition to recover
 * the dashboard/panel link and query targets.
 */
export async function resolveAlertContext(
  input: { webhookPayload?: unknown; alertJson?: unknown; url?: string; fingerprint?: string },
  client: GrafanaClient,
): Promise<AlertContext> {
  if (input.webhookPayload !== undefined) {
    if (!isWebhookPayload(input.webhookPayload)) {
      throw new Error('webhookPayload does not look like a Grafana Alertmanager webhook body (missing "alerts" array)');
    }
    const alerts = input.webhookPayload.alerts;
    const chosen = input.fingerprint ? alerts.find((a) => a.fingerprint === input.fingerprint) : alerts[0];
    if (!chosen) {
      throw new Error(
        input.fingerprint
          ? `No alert with fingerprint ${input.fingerprint} found in webhook payload`
          : 'Webhook payload contained no alerts',
      );
    }
    return fromAlertmanagerAlert(chosen, 'webhook');
  }

  if (input.alertJson !== undefined) {
    if (!isSingleAlert(input.alertJson)) {
      throw new Error('alertJson does not look like a single Grafana alert object (expected labels/annotations)');
    }
    return fromAlertmanagerAlert(input.alertJson, 'pasted-json');
  }

  if (input.url) {
    const parsed = parseGrafanaUrl(input.url);
    if (parsed.type === 'dashboard') {
      return {
        source: 'url',
        labels: {},
        annotations: {},
        dashboardUid: parsed.uid,
        panelId: parsed.panelId,
        variables: parsed.vars,
        warnings: [],
      };
    }

    // Alert-rule URL: fetch the rule to recover its dashboard/panel link,
    // labels, and query targets.
    const rule = await client.getAlertRuleByUid(parsed.ruleUid);
    const warnings: string[] = [];
    const dashUid = rule.annotations?.__dashboardUid__;
    const panelIdStr = rule.annotations?.__panelId__;
    if (!dashUid) {
      warnings.push(
        `Alert rule "${rule.title}" has no linked dashboard panel. Use find_related_dashboards with the rule's labels to locate relevant dashboards.`,
      );
    }
    return {
      source: 'url',
      alertName: rule.title,
      ruleUid: rule.uid,
      labels: rule.labels ?? {},
      annotations: rule.annotations ?? {},
      dashboardUid: dashUid,
      panelId: panelIdStr ? Number.parseInt(panelIdStr, 10) : undefined,
      variables: {},
      threshold: describeThreshold(rule),
      ruleQueries: rule.data,
      warnings,
    };
  }

  throw new Error('Must provide one of webhookPayload, alertJson, or url');
}
