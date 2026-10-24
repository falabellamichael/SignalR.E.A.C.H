import { isIP } from 'node:net';

const loopback = ip => ip === '::1' || /^127\./.test(ip || '') || /^::ffff:127\./.test(ip || '');
// This endpoint is not on the public relay proxy allowlist. Match the relay's
// direct local-owner boundary, including DNS rebinding and tunnel protection.
export function operatorKeyRequest(req) {
  if (!loopback(req.socket.remoteAddress) || req.headers.origin) return false;
  if (['x-reach-client-ip','x-forwarded-for','x-forwarded-host','x-forwarded-proto','forwarded','cf-connecting-ip']
    .some(name => req.headers[name])) return false;
  try {
    const host = new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, '');
    return isIP(host) !== 0 && loopback(host);
  } catch { return false; }
}
