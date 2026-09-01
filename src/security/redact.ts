// Separators are optional and either hyphen or underscore ([-_]?) so the
// hyphenated header/field forms redact too: `x-api-key`, `api-key` and
// `private-key` are exactly as secret-shaped as `apiKey`/`api_key`, but a
// fixed-underscore alternation (`api_key`) is a substring match that never
// reaches the hyphen form, leaking those values to the model (issue #150).
const SECRET_KEY_PATTERN = /(password|passwd|secret|token|api[-_]?key|authorization|bearer|private[-_]?key)/i;

const REDACTED = '[REDACTED]';

export interface RedactOptions {
  /**
   * Key names whose string values skip the customer-identifier patterns.
   *
   * This exists for one specific class of value: a URL that only stays useful
   * if it stays intact. `redactString` rewrites *inside* strings, so a
   * replayable Grafana link whose query text contains a matched identifier
   * doesn't come back masked — it comes back **broken**, which silently
   * converts an audit artifact into a dead link.
   *
   * An explicit key allowlist rather than a naming convention (e.g. "anything
   * ending in Url"): every exemption should be a deliberate, greppable act at
   * the call site, because each one is a hole in a guarantee that's otherwise
   * unconditional. Note this only ever waives `customPatterns` —
   * SECRET_KEY_PATTERN still masks a secret-shaped key even if it's listed
   * here, since nothing legitimately needs an unmasked password to function.
   */
  exempt?: readonly string[];
}

/**
 * Recursively redacts secret-shaped fields (by key name) and any string
 * value matching a configured customer-identifier pattern, before data is
 * returned to the model. Applied to every tool's output.
 *
 * See RedactOptions.exempt for the one narrow waiver, and CLAUDE.md for why the
 * exceptions to this are enumerated rather than pattern-matched.
 */
export function redact<T>(value: T, customPatterns: RegExp[] = [], options: RedactOptions = {}): T {
  return redactValue(value, customPatterns, options.exempt ?? []) as T;
}

function redactValue(value: unknown, customPatterns: RegExp[], exempt: readonly string[]): unknown {
  if (typeof value === 'string') {
    return redactString(value, customPatterns);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, customPatterns, exempt));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = REDACTED;
      } else if (exempt.includes(key)) {
        // Pass through untouched — including nested values, since an exempt key
        // holding an object (a query model, say) would be just as broken by a
        // partial rewrite as an exempt string.
        out[key] = val;
      } else {
        out[key] = redactValue(val, customPatterns, exempt);
      }
    }
    return out;
  }
  return value;
}

function redactString(value: string, customPatterns: RegExp[]): string {
  let result = value;
  for (const pattern of customPatterns) {
    result = result.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), REDACTED);
  }
  return result;
}
