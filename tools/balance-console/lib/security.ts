export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      /token|secret|api[_-]?key|authorization/i.test(key) ? '[СКРЫТО]' : redactSecrets(child),
    ]));
  }
  return value;
}
