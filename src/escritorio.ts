// =============================================================================
// Escritório: o Habblaud (github.com/marmottajr/habblaud, MIT) rodando dentro
// do container, lendo as sessões do Claude Code daqui. Cada agente vira uma
// sala e cada pedido, um personagem trabalhando ao vivo.
//
//   navegador ──► /escritorio (login do Habblaud) ──► passe de uso único
//            ──► domínio do escritório (porta ESCRITORIO_PORTA, este portão)
//            ──► confere o cookie do escritório e repassa ──► Habblaud em 127.0.0.1:4747
//
// O Habblaud só escuta no loopback; quem chega de fora passa sempre pelo
// portão. O portão manda um Host interno que NÃO é loopback: para o Habblaud
// o acesso é "de fora", então terminal, mensagens e aprovações ficam
// desligados mesmo que alguém os ligue por engano. Só leitura.
// =============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { cookieDoEscritorio, sessaoDoEscritorioValida, usarPasseDoEscritorio } from './auth.js';
import { agentEnv, config } from './config.js';

const PORTA_DO_HABBLAUD = 4747;
/** Nome que o portão usa no Host: liberado no Habblaud, mas não é loopback. */
const HOST_INTERNO = 'escritorio.habblaud.interno';

let processo: ChildProcess | null = null;
let portao: http.Server | null = null;
let parando = false;
let tentativas = 0;
let ativoDesde: number | null = null;

function pastaDoClaude(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function pastaDoCodex(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function pastaDeDados(): string {
  return path.join(config.dataDir, 'escritorio');
}

function pastaDeUso(): string {
  return path.join(pastaDeDados(), 'uso');
}

/** Domínio público do escritório (o que aponta para ESCRITORIO_PORTA no Railway). */
export function hostDoEscritorio(): string | null {
  return config.escritorioHosts?.split(',')[0]?.trim() || null;
}

export function escritorioDisponivel(): boolean {
  return config.escritorio && existsSync(path.join(config.escritorioDir, 'dist', 'server', 'index.js'));
}

export function estadoDoEscritorio() {
  return {
    ligado: escritorioDisponivel(),
    rodando: !!processo && ativoDesde !== null,
    // A interface abre por /escritorio, que faz o login no domínio do escritório.
    url: escritorioDisponivel() && hostDoEscritorio() ? '/escritorio' : null,
  };
}

export async function iniciarEscritorio(): Promise<void> {
  if (!config.escritorio) return;
  if (!escritorioDisponivel()) {
    console.log(`[escritorio] Habblaud não encontrado em ${config.escritorioDir} — escritório desligado.`);
    return;
  }
  await fs.mkdir(pastaDeUso(), { recursive: true });
  parando = false;
  subir();
  abrirPortao();
}

function subir(): void {
  const env: Record<string, string | undefined> = {
    ...agentEnv(),
    // Credenciais do Claude não servem para o Habblaud: ele só lê arquivos.
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    ANTHROPIC_API_KEY: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    NODE_ENV: 'production',
    HABBLAUD_HOST: '127.0.0.1',
    HABBLAUD_PORT: String(PORTA_DO_HABBLAUD),
    HABBLAUD_CLAUDE_DIRS: pastaDoClaude(),
    HABBLAUD_DATA_DIR: pastaDeDados(),
    HABBLAUD_USAGE_DIR: pastaDeUso(),
    HABBLAUD_LANG: 'pt-BR',
    HABBLAUD_WORLD: '0',
    HABBLAUD_UPDATE_CHECK: '0',
    // As sessões do Codex no terminal também aparecem (só leitura).
    HABBLAUD_CODEX: '1',
    HABBLAUD_CODEX_DIRS: pastaDoCodex(),
    HABBLAUD_TERMINAL: '0',
    HABBLAUD_MENSAGENS: '0',
    HABBLAUD_PTY: '0',
    HABBLAUD_ALLOWED_HOSTS: HOST_INTERNO,
  };
  const filho = spawn(process.execPath, [path.join(config.escritorioDir, 'dist', 'server', 'index.js')], {
    cwd: config.escritorioDir,
    env: env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processo = filho;
  const inicio = Date.now();
  const linha = (dado: Buffer) => {
    for (const l of dado.toString().split('\n')) if (l.trim()) console.log(`[escritorio] ${l}`);
  };
  filho.stdout?.on('data', linha);
  filho.stderr?.on('data', linha);
  filho.on('spawn', () => {
    ativoDesde = Date.now();
  });
  filho.on('exit', (codigo, sinal) => {
    processo = null;
    ativoDesde = null;
    if (parando) return;
    // Ficou de pé um bom tempo: a próxima queda recomeça a contagem.
    if (Date.now() - inicio > 5 * 60_000) tentativas = 0;
    tentativas++;
    const espera = Math.min(60_000, 2_000 * 2 ** Math.min(tentativas, 5));
    console.warn(`[escritorio] Habblaud saiu (código ${codigo ?? '-'}, sinal ${sinal ?? '-'}); sobe de novo em ${espera / 1000} s.`);
    setTimeout(() => {
      if (!parando) subir();
    }, espera).unref();
  });
}

// ---------------------------------------------------------------------------
// Portão: a porta pública do escritório.
// ---------------------------------------------------------------------------

function abrirPortao(): void {
  if (portao) return;
  portao = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://portao');
    if (url.pathname === '/__entrar') return entrar(url, res);
    if (!sessaoDoEscritorioValida(req)) return semLogin(req, res);
    repassar(req, res);
  });
  // O Habblaud não usa WebSocket com o World desligado: upgrade não passa.
  portao.on('upgrade', (_req, socket) => socket.destroy());
  portao.requestTimeout = 0; // o tempo real (SSE) fica aberto
  portao.listen(config.escritorioPorta, '0.0.0.0', () => {
    console.log(`[escritorio] portão na porta ${config.escritorioPorta} → Habblaud em 127.0.0.1:${PORTA_DO_HABBLAUD}`);
  });
  portao.on('error', (err) => console.error(`[escritorio] portão: ${String(err)}`));
}

/** Troca o passe (emitido por /escritorio, já logado) pelo cookie deste domínio. */
function entrar(url: URL, res: http.ServerResponse): void {
  const passe = url.searchParams.get('passe') ?? '';
  if (!usarPasseDoEscritorio(passe)) {
    res.writeHead(302, { Location: config.appUrl ? `${config.appUrl}/escritorio` : '/', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  res.writeHead(302, {
    'Set-Cookie': cookieDoEscritorio(),
    // Tira o passe da barra de endereço.
    Location: '/',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end();
}

function semLogin(req: http.IncomingMessage, res: http.ServerResponse): void {
  const pagina = (req.headers.accept ?? '').includes('text/html') && (req.method === 'GET' || req.method === 'HEAD');
  if (pagina && config.appUrl) {
    // Passa pelo login do Habblaud, que manda de volta com um passe.
    res.writeHead(302, { Location: `${config.appUrl}/escritorio`, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const corpo = pagina
    ? '<!doctype html><meta charset="utf-8"><title>Escritório</title><p style="font:16px system-ui;padding:2rem">Entre no Habblaud e abra o <b>Escritório</b> pelo menu.</p>'
    : JSON.stringify({ error: 'faça login pelo Habblaud (/escritorio)' });
  res.writeHead(pagina ? 200 : 401, {
    'Content-Type': pagina ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(corpo);
}

function repassar(req: http.IncomingMessage, res: http.ServerResponse): void {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: HOST_INTERNO };
  // O cookie do portão não interessa ao Habblaud.
  delete headers.cookie;
  if (headers.origin) headers.origin = `http://${HOST_INTERNO}`;
  const ida = http.request(
    { host: '127.0.0.1', port: PORTA_DO_HABBLAUD, method: req.method, path: req.url, headers },
    (volta) => {
      res.writeHead(volta.statusCode ?? 502, { ...volta.headers, 'X-Accel-Buffering': 'no' });
      volta.pipe(res);
    },
  );
  ida.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('O escritório está subindo. Atualize a página em alguns segundos.');
    } else {
      res.destroy();
    }
  });
  // Quem fechou a aba encerra a conexão com o Habblaud também (tempo real/SSE).
  res.on('close', () => ida.destroy());
  req.pipe(ida);
}

export function pararEscritorio(): void {
  parando = true;
  processo?.kill('SIGTERM');
  portao?.close();
}

// ---------------------------------------------------------------------------
// Uso da assinatura no escritório (janela de 5 h e semana), no formato do
// "statusline tap" do Habblaud: <uso>/<conta>.json.
// ---------------------------------------------------------------------------

const janelas = new Map<string, { utilization: number; resets_at?: number }>();
let gravando: Promise<void> = Promise.resolve();

function arquivoDeUso(): string {
  return path.join(pastaDeUso(), `${path.basename(pastaDoClaude())}.json`);
}

/** Trocou a conta do Claude: o uso mostrado era da conta anterior. */
export function esquecerUsoNoEscritorio(): void {
  janelas.clear();
  const arquivo = arquivoDeUso();
  gravando = gravando.then(() => fs.rm(arquivo, { force: true })).catch(() => undefined);
}

/** As janelas do evento: `unifiedWindows` ({five_hour: {utilization, resetsAt}, ...}) e, se vier, a do topo. */
export function janelasDoEvento(info: Record<string, unknown>): Array<[string, number, number | undefined]> {
  const saida: Array<[string, number, number | undefined]> = [];
  const unificadas = (info.unifiedWindows ?? {}) as Record<string, { utilization?: unknown; resetsAt?: unknown }>;
  for (const [tipo, j] of Object.entries(unificadas)) {
    if (typeof j?.utilization === 'number') saida.push([tipo, j.utilization, typeof j.resetsAt === 'number' ? j.resetsAt : undefined]);
  }
  if (typeof info.rateLimitType === 'string' && typeof info.utilization === 'number' && !unificadas[info.rateLimitType]) {
    saida.push([info.rateLimitType, info.utilization, typeof info.resetsAt === 'number' ? info.resetsAt : undefined]);
  }
  return saida;
}

export function registrarUsoNoEscritorio(info: Record<string, unknown> | undefined): void {
  if (!config.escritorio || !info) return;
  let mudou = false;
  for (const [tipo, u, renova] of janelasDoEvento(info)) {
    if (tipo !== 'five_hour' && tipo !== 'seven_day') continue;
    // O Claude Code manda fração (0 a 1); o Habblaud espera porcentagem.
    const porcentagem = u <= 1 ? Math.round(u * 1000) / 10 : Math.round(u * 10) / 10;
    janelas.set(tipo, { utilization: porcentagem, ...(renova ? { resets_at: renova } : {}) });
    mudou = true;
  }
  if (!mudou) return;
  const dir = pastaDoClaude();
  const arquivo = arquivoDeUso();
  const conteudo = JSON.stringify({
    accountId: path.basename(dir),
    configDir: dir,
    fetchedAt: Date.now(),
    ...Object.fromEntries(janelas),
  });
  gravando = gravando
    .then(async () => {
      await fs.mkdir(pastaDeUso(), { recursive: true });
      const tmp = `${arquivo}.tmp`;
      await fs.writeFile(tmp, conteudo);
      await fs.rename(tmp, arquivo);
    })
    .catch(() => undefined);
}
