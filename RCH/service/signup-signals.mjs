import { isIP } from 'node:net';

// Only the local relay may supply its already-validated client IP.
export function signupSignals(req, deviceId) {
  const peer = req.socket?.remoteAddress || '';
  const forwarded = req.headers?.['x-reach-client-ip'];
  let ip = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)
    && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : peer;
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return { ip: isIP(ip) ? ip : null,
    deviceId: typeof deviceId === 'string' && /^[a-f0-9]{32,64}$/i.test(deviceId) ? deviceId.toLowerCase() : null };
}
