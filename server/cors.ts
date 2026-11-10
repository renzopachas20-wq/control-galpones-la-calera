import type { RequestHandler } from 'express';

export function apiCors(allowedOrigins: string | undefined, cloudRun: boolean, development: boolean): RequestHandler {
  const allowed = new Set((allowedOrigins ?? '').split(',').map(origin => origin.trim()).filter(Boolean));
  const loopback = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
  return (req, res, next) => {
    res.vary('Origin');
    const origin = req.get('Origin');
    if (!origin) {
      next();
      return;
    }
    const forwarded = cloudRun ? req.get('X-Forwarded-Proto')?.split(',')[0].trim() : undefined;
    const protocol = forwarded === 'https' ? 'https' : req.protocol;
    const sameOrigin = origin === `${protocol}://${req.get('Host')}`;
    if (!sameOrigin && !allowed.has(origin) && !(development && loopback.test(origin))) {
      res.status(403).json({ code: 'ORIGIN_FORBIDDEN', message: 'El origen de la solicitud no está autorizado.' });
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.sendStatus(204);
      return;
    }
    next();
  };
}
