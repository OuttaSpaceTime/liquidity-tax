/**
 * Strip secrets from text before it is printed or logged. viem and other
 * clients embed the full request URL (which carries the API key) in thrown
 * error messages and stacks; this scrubs them so keys never reach stdout/stderr
 * or pasted logs. Pass the known secret values plus generic URL patterns are
 * always masked as a backstop.
 */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== undefined && secret !== '') out = out.split(secret).join('***');
  }
  // Backstop patterns, in case a key reaches us that is not in `secrets`:
  //   Alchemy/Infura path keys (…/v2/<key>) and api-key=<token> query params.
  return out
    .replace(/\/v2\/[A-Za-z0-9_-]+/g, '/v2/***')
    .replace(/api-key=[A-Za-z0-9_-]+/gi, 'api-key=***');
}
