const SECRET_KEY_PATTERN = /(password|passwd|secret|token|apikey|api_key|authorization|bearer|private_key|privatekey)/i;

const REDACTED = '[REDACTED]';

/**
 * Recursively redacts secret-shaped fields (by key name) and any string
 * value matching a configured customer-identifier pattern, before data is
 * returned to the model. Applied to every tool's output.
 */
export function redact<T>(value: T, customPatterns: RegExp[] = []): T {
  return redactValue(value, customPatterns) as T;
}

function redactValue(value: unknown, customPatterns: RegExp[]): unknown {
  if (typeof value === 'string') {
    return redactString(value, customPatterns);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, customPatterns));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactValue(val, customPatterns);
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
