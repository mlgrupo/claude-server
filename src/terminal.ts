import crypto from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import * as pty from 'node-pty';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { isAuthenticated } from './auth.js';
import { agentEnv, config } from './config.js';

/*
 * Terminal web: um shell (bash) num pseudo-terminal, ligado ao navegador por WebSocket.
 *
 * A sessão sobrevive à queda da conexão: o shell continua rodando e guarda as últimas
 * saídas; ao reconectar (mesma aba, outra aba ou outro aparelho) a tela é reconstruída.
 * Sem ninguém conectado por TERMINAL_IDLE_MIN minutos, o shell é encerrado.
 *
 * Protocolo (frames de texto): o primeiro caractere diz o tipo.
 *   cliente → servidor: "0" + teclas digitadas | "1" + JSON {type:"resize",cols,rows} | {type:"kill"}
 *   servidor → cliente: "0" + saída do shell   | "1" + JSON {type:"session"|"exit"|"error", ...}
 */

const WS_PATH = '/api/terminal';
const MAX_SESSIONS = 5;
const SCROLLBACK_CHARS = 400_000;
const HIGH_WATER = 2 * 1024 * 1024; // pausa o shell se o navegador não acompanha a saída
const LOW_WATER = 256 * 1024;

interface Session {
  id: string;
  proc: pty.IPty;
  sockets: Set<WebSocket>;
  buffer: string;
  createdAt: number;
  lastActivity: number;
  idleTimer?: NodeJS.Timeout;
  paused: boolean;
  exited: boolean;
}

const sessions = new Map<string, Session>();

const short = (id: string) => id.slice(0, 8);

function send(ws: WebSocket, kind: '0' | '1', payload: string): void {
  if (ws.readyState === ws.OPEN) ws.send(kind + payload);
}

function control(ws: WebSocket, msg: Record<string, unknown>): void {
  send(ws, '1', JSON.stringify(msg));
}

function toText(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function clampSize(value: unknown, fallback: number, max: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 2 && n <= max ? n : fallback;
}

function shellCommand(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] };
  return { file: '/bin/bash', args: [] };
}

function trimBuffer(s: Session): void {
  let cut = s.buffer.length - SCROLLBACK_CHARS;
  // Começa numa quebra de linha para não reconstruir a tela a partir do meio de uma sequência ANSI.
  const nl = s.buffer.indexOf('\n', cut);
  if (nl !== -1 && nl - cut < 4096) cut = nl + 1;
  s.buffer = s.buffer.slice(cut);
}

function maxBuffered(s: Session): number {
  let max = 0;
  for (const ws of s.sockets) max = Math.max(max, ws.bufferedAmount);
  return max;
}

function applyBackpressure(s: Session): void {
  if (s.paused || maxBuffered(s) < HIGH_WATER) return;
  s.paused = true;
  s.proc.pause();
  const check = () => {
    if (s.exited) return;
    if (maxBuffered(s) <= LOW_WATER) {
      s.paused = false;
      s.proc.resume();
    } else setTimeout(check, 50);
  };
  setTimeout(check, 50);
}

function createSession(cols: number, rows: number): Session {
  const { file, args } = shellCommand();
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: config.workspaceDir,
    // Mesmo ambiente do agente: as senhas do próprio servidor não entram no shell.
    env: { ...agentEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'C.UTF-8' },
  });
  const now = Date.now();
  const s: Session = {
    id: crypto.randomUUID(),
    proc,
    sockets: new Set(),
    buffer: '',
    createdAt: now,
    lastActivity: now,
    paused: false,
    exited: false,
  };
  sessions.set(s.id, s);

  proc.onData((data) => {
    s.buffer += data;
    if (s.buffer.length > SCROLLBACK_CHARS * 1.25) trimBuffer(s);
    for (const ws of s.sockets) send(ws, '0', data);
    applyBackpressure(s);
  });

  proc.onExit(({ exitCode, signal }) => {
    s.exited = true;
    sessions.delete(s.id);
    clearTimeout(s.idleTimer);
    console.log(`[terminal] sessão ${short(s.id)} encerrada (código ${exitCode}${signal ? `, sinal ${signal}` : ''})`);
    for (const ws of s.sockets) {
      control(ws, { type: 'exit', code: exitCode, signal: signal || undefined });
      ws.close(1000, 'shell encerrado');
    }
    s.sockets.clear();
  });

  return s;
}

function killSession(s: Session, reason: string): void {
  if (s.exited) return;
  sessions.delete(s.id); // libera a vaga já; o onExit faz o resto
  console.log(`[terminal] encerrando sessão ${short(s.id)}: ${reason}`);
  try {
    s.proc.kill();
  } catch {
    /* já terminou */
  }
  // Processos que ignoram SIGHUP não seguram a sessão para sempre.
  setTimeout(() => {
    if (s.exited) return;
    try {
      s.proc.kill('SIGKILL');
    } catch {
      /* já terminou */
    }
  }, 3_000).unref();
}

function mostRecent(): Session | undefined {
  let best: Session | undefined;
  for (const s of sessions.values()) if (!best || s.lastActivity > best.lastActivity) best = s;
  return best;
}

/** Abre vaga encerrando a sessão desconectada há mais tempo. */
function evictDetached(): boolean {
  let oldest: Session | undefined;
  for (const s of sessions.values()) {
    if (s.sockets.size) continue;
    if (!oldest || s.lastActivity < oldest.lastActivity) oldest = s;
  }
  if (!oldest) return false;
  killSession(oldest, 'limite de sessões — era a mais antiga sem ninguém conectado');
  return true;
}

function attach(ws: WebSocket, s: Session, created: boolean): void {
  clearTimeout(s.idleTimer);
  s.idleTimer = undefined;
  s.lastActivity = Date.now();
  s.sockets.add(ws);

  control(ws, { type: 'session', id: s.id, created, createdAt: new Date(s.createdAt).toISOString() });
  if (s.buffer) send(ws, '0', s.buffer);

  ws.on('message', (raw) => {
    const msg = toText(raw);
    if (msg[0] === '0') {
      s.lastActivity = Date.now();
      try {
        s.proc.write(msg.slice(1));
      } catch {
        /* shell já saiu */
      }
      return;
    }
    if (msg[0] !== '1') return;
    let c: { type?: string; cols?: unknown; rows?: unknown };
    try {
      c = JSON.parse(msg.slice(1));
    } catch {
      return;
    }
    if (c?.type === 'resize') {
      const cols = clampSize(c.cols, s.proc.cols, 1000);
      const rows = clampSize(c.rows, s.proc.rows, 500);
      if (cols !== s.proc.cols || rows !== s.proc.rows) {
        try {
          s.proc.resize(cols, rows);
        } catch {
          /* shell já saiu */
        }
      }
    } else if (c?.type === 'kill') {
      killSession(s, 'pedido pelo usuário');
    }
  });

  ws.on('close', () => {
    s.sockets.delete(ws);
    if (!s.sockets.size && !s.exited) {
      s.idleTimer = setTimeout(() => killSession(s, 'ninguém conectado'), config.terminalIdleMs);
      s.idleTimer.unref();
    }
  });
}

function onConnection(ws: WebSocket, url: URL, ip: string): void {
  const requested = url.searchParams.get('session');
  const fresh = url.searchParams.get('new') === '1';
  const cols = clampSize(url.searchParams.get('cols'), 100, 1000);
  const rows = clampSize(url.searchParams.get('rows'), 30, 500);

  // Sem sessão pedida: volta para a mais recente (o terminal "continua de onde parou").
  // Sessão pedida que já não existe: abre uma nova, e o navegador avisa que a anterior terminou.
  let s = requested ? sessions.get(requested) : undefined;
  if (!s && !requested && !fresh) s = mostRecent();

  let created = false;
  if (!s) {
    if (sessions.size >= MAX_SESSIONS && !evictDetached()) {
      control(ws, { type: 'error', message: `Já existem ${MAX_SESSIONS} terminais conectados. Feche um deles antes de abrir outro.` });
      ws.close(1013, 'limite de sessões');
      return;
    }
    try {
      s = createSession(cols, rows);
    } catch (err) {
      control(ws, { type: 'error', message: `Não consegui abrir o shell: ${(err as Error).message}` });
      ws.close(1011, 'falha ao abrir o shell');
      return;
    }
    created = true;
    console.log(`[terminal] sessão ${short(s.id)} aberta por ${ip}`);
  } else {
    console.log(`[terminal] ${ip} conectou na sessão ${short(s.id)}`);
  }
  attach(ws, s, created);
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'desconhecido';
}

/** Navegadores sempre mandam Origin no WebSocket: só aceita a própria origem (evita sequestro por outro site). */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // clientes fora do navegador (ex.: websocat com Bearer)
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const fwdHost = req.headers['x-forwarded-host'];
  const expected = ((Array.isArray(fwdHost) ? fwdHost[0] : fwdHost)?.split(',')[0]?.trim() || req.headers.host || '').toLowerCase();
  return host === expected;
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.on('error', () => undefined);
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function attachTerminal(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== WS_PATH || !config.terminalEnabled) return reject(socket, 404, 'Not Found');
    if (!sameOrigin(req)) return reject(socket, 403, 'Forbidden');
    if (!isAuthenticated(req)) return reject(socket, 401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      onConnection(ws, url, clientIp(req));
    });
  });

  // Ping a cada 30 s: mantém a conexão viva no proxy e derruba conexões mortas.
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 30_000);
  ping.unref();
}

export function terminalCount(): number {
  return sessions.size;
}

export function closeAllTerminals(): void {
  for (const s of [...sessions.values()]) killSession(s, 'servidor encerrando');
}
