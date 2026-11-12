import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';

const COOKIE = 'hb_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Sem SESSION_SECRET, a chave deriva da senha: trocar a senha derruba todas as sessões.
const secret =
  config.sessionSecret ??
  crypto.createHash('sha256').update(`habblaud-session:${config.appPassword ?? ''}`).digest('hex');

function hmac(value: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

function validSessionCookie(req: Request): boolean {
  const raw = readCookie(req, COOKIE);
  if (!raw) return false;
  const [exp, sig] = raw.split('.');
  if (!exp || !sig) return false;
  if (!safeEqual(sig, hmac(exp))) return false;
  return Number(exp) > Date.now();
}

function validBearer(req: Request): boolean {
  if (!config.apiToken) return false;
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return false;
  return safeEqual(h.slice(7).trim(), config.apiToken);
}

export function isAuthenticated(req: Request): boolean {
  return validBearer(req) || validSessionCookie(req);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'não autenticado' });
}

/** Bloqueia POST/DELETE vindos de formulários de outros sites (CSRF) quando a auth é por cookie. */
export function requireJsonBody(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.headers.authorization?.startsWith('Bearer ')) return next();
  if (req.is('application/json')) return next();
  res.status(415).json({ error: 'use Content-Type: application/json' });
}

// ---- Login com limite de tentativas por IP ----
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function login(req: Request, res: Response): void {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = attempts.get(ip);
  if (entry && entry.resetAt > now && entry.count >= MAX_ATTEMPTS) {
    res.status(429).json({ error: 'muitas tentativas — aguarde alguns minutos' });
    return;
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!config.appPassword || !safeEqual(password, config.appPassword)) {
    const e = entry && entry.resetAt > now ? entry : { count: 0, resetAt: now + WINDOW_MS };
    e.count++;
    attempts.set(ip, e);
    res.status(401).json({ error: 'senha incorreta' });
    return;
  }
  attempts.delete(ip);
  const exp = String(now + MAX_AGE_MS);
  res.cookie(COOKIE, `${exp}.${hmac(exp)}`, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    maxAge: MAX_AGE_MS,
    path: '/',
  });
  res.json({ ok: true });
}

export function logout(_req: Request, res: Response): void {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}
