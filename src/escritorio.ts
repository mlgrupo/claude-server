// =============================================================================
// Escritório: o Habblaud (github.com/marmottajr/habblaud, MIT) rodando dentro
// do container, lendo as sessões do Claude Code daqui. Cada agente vira uma
// sala e cada pedido, um personagem trabalhando ao vivo.
//
// O Habblaud escuta em 127.0.0.1:4747 (porta local, sem login) e na porta
// remota ESCRITORIO_PORTA (4748), que exige usuário e senha em toda
// requisição. Só a remota tem domínio público no Railway; o HTTPS fica com o
// Railway. A senha é a mesma do Habblaud (APP_PASSWORD), guardada como hash.
// Modo só leitura: nada de terminal, mensagens ou aprovações pelo escritório.
// =============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, scrypt } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentEnv, config } from './config.js';

let processo: ChildProcess | null = null;
let parando = false;
let tentativas = 0;
let ativoDesde: number | null = null;

function pastaDoClaude(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function pastaDeDados(): string {
  return path.join(config.dataDir, 'escritorio');
}

function pastaDeUso(): string {
  return path.join(pastaDeDados(), 'uso');
}

/** O mesmo formato do `npm run remote:setup` do Habblaud: scrypt:<logN>:<r>:<p>:<sal>:<hash>. */
export function hashDaSenha(senha: string, sal = randomBytes(16)): Promise<string> {
  const logN = 15;
  const r = 8;
  const p = 1;
  return new Promise((ok, falha) =>
    scrypt(senha.normalize('NFC'), sal, 32, { N: 2 ** logN, r, p, maxmem: 256 * 2 ** logN * r }, (err, chave) =>
      err ? falha(err) : ok(`scrypt:${logN}:${r}:${p}:${sal.toString('base64url')}:${chave.toString('base64url')}`),
    ),
  );
}

export function escritorioDisponivel(): boolean {
  return config.escritorio && existsSync(path.join(config.escritorioDir, 'dist', 'server', 'index.js'));
}

export function estadoDoEscritorio() {
  const host = config.escritorioHosts?.split(',')[0]?.trim();
  return {
    ligado: escritorioDisponivel(),
    rodando: !!processo && ativoDesde !== null,
    url: host ? `https://${host}` : null,
    usuario: config.escritorioUsuario,
  };
}

export async function iniciarEscritorio(): Promise<void> {
  if (!config.escritorio) return;
  if (!escritorioDisponivel()) {
    console.log(`[escritorio] Habblaud não encontrado em ${config.escritorioDir} — escritório desligado.`);
    return;
  }
  await fs.mkdir(pastaDeUso(), { recursive: true });
  const hash = await hashDaSenha(config.appPassword ?? '');
  parando = false;
  subir(hash);
}

function subir(hash: string): void {
  const env: Record<string, string | undefined> = {
    ...agentEnv(),
    // Credenciais do Claude não servem para o Habblaud: ele só lê arquivos.
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    ANTHROPIC_API_KEY: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    NODE_ENV: 'production',
    HABBLAUD_HOST: '127.0.0.1',
    HABBLAUD_PORT: '4747',
    HABBLAUD_CLAUDE_DIRS: pastaDoClaude(),
    HABBLAUD_DATA_DIR: pastaDeDados(),
    HABBLAUD_USAGE_DIR: pastaDeUso(),
    HABBLAUD_LANG: 'pt-BR',
    HABBLAUD_WORLD: '0',
    HABBLAUD_UPDATE_CHECK: '0',
    HABBLAUD_CODEX: '0',
    HABBLAUD_TERMINAL: '0',
    HABBLAUD_MENSAGENS: '0',
    HABBLAUD_PTY: '0',
    HABBLAUD_REMOTE_USER: config.escritorioUsuario,
    HABBLAUD_REMOTE_PASSWORD_HASH: hash,
    HABBLAUD_REMOTE_HOST: '0.0.0.0',
    HABBLAUD_REMOTE_PORT: String(config.escritorioPorta),
    // O TLS termina no Railway; daqui até o container é a rede interna dele.
    HABBLAUD_REMOTE_INSECURE_HTTP: '1',
    HABBLAUD_REMOTE_ALLOW: 'none',
    HABBLAUD_ALLOWED_HOSTS: config.escritorioHosts ?? '',
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
      if (!parando) subir(hash);
    }, espera).unref();
  });
}

export function pararEscritorio(): void {
  parando = true;
  processo?.kill('SIGTERM');
}

// ---------------------------------------------------------------------------
// Uso da assinatura no escritório (janela de 5 h e semana), no formato do
// "statusline tap" do Habblaud: <uso>/<conta>.json.
// ---------------------------------------------------------------------------

const janelas = new Map<string, { utilization: number; resets_at?: number }>();
let gravando: Promise<void> = Promise.resolve();

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
  const arquivo = path.join(pastaDeUso(), `${path.basename(dir)}.json`);
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
