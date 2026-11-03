/** Only HTTPS is allowed, except for this computer (test servers). */
export function assertSafeUrl(u: string) {
  const url = new URL(u);
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('The address must use https.');
}
