// =============================================================================
// Contas: mais de um login do Claude Code, do Codex e do Gemini CLI no mesmo
// servidor, e a troca de qual está em uso.
//
// Cada ferramenta continua lendo o login do lugar de sempre (a "pasta viva"):
//   Claude  ~/.claude/.credentials.json + "oauthAccount" do ~/.claude.json
//   Codex   ~/.codex/auth.json
//   Gemini  ~/.gemini/oauth_creds.json + google_accounts.json
// As outras contas ficam guardadas em DATA_DIR/contas/<ferramenta>/<id>/. Trocar
// = guardar a conta viva (os tokens dela renovam com o uso) e pôr a escolhida
// no lugar. Sessões, configurações e skills ficam como estão.
//
// O login de uma conta nova roda no terminal web, pelo fluxo da própria
// ferramenta, numa pasta à parte (`habblaud-conta entrar <ferramenta>`).
//
// Os agentes do HofOS não usam estas contas: usam a chave da API
// (AGENTES_ANTHROPIC_API_KEY). Cada conta aqui é de uma pessoa da equipe.
// =============================================================================

import crypto from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

export const PROVEDORES = ['claude', 'codex', 'gemini'] as const;
export type Provedor = (typeof PROVEDORES)[number];

export class ErroDeConta extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ContaSalva {
  id: string;
  provedor: Provedor;
  email: string | null;
  /** Nome para mostrar quando não há e-mail (ex.: chave da API). */
  nome: string | null;
  plano: string | null;
  salvaEm: string;
  usadaEm?: string;
}

interface Identidade {
  chave: string;
  email: string | null;
  nome: string | null;
  plano: string | null;
  /** Claude: o "oauthAccount" do .claude.json, que diz de quem é o login. */
  perfil?: unknown;
}

/** Onde a ferramenta lê o login. */
interface Origem {
  pasta: string;
  /** Claude: o .claude.json que tem o "oauthAccount". */
  configGlobal?: string;
}

const ARQUIVOS: Record<Provedor, string[]> = {
  claude: ['.credentials.json'],
  codex: ['auth.json'],
  gemini: ['oauth_creds.json', 'google_accounts.json'],
};

export const NOMES: Record<Provedor, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
const BINARIOS: Record<Provedor, string> = { claude: 'claude', codex: 'codex', gemini: 'gemini' };
const ARQUIVO_DO_PERFIL = 'perfil.json';
const ARQUIVO_DA_CONTA = 'conta.json';
const ID_RE = /^[a-f0-9]{16}$/;

export function ehProvedor(v: unknown): v is Provedor {
  return typeof v === 'string' && (PROVEDORES as readonly string[]).includes(v);
}

export function ehIdDeConta(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

// ---------------------------------------------------------------------------
// Caminhos
// ---------------------------------------------------------------------------

export function pastaDasContas(): string {
  return path.join(config.dataDir, 'contas');
}

/** Pasta temporária dos logins em andamento (no volume, para não misturar com /tmp). */
export function pastaDosLogins(): string {
  return path.join(pastaDasContas(), '.entrando');
}

export function origemViva(p: Provedor): Origem {
  const home = os.homedir();
  if (p === 'claude') {
    const dir = process.env.CLAUDE_CONFIG_DIR;
    return dir
      ? { pasta: dir, configGlobal: path.join(dir, '.claude.json') }
      : { pasta: path.join(home, '.claude'), configGlobal: path.join(home, '.claude.json') };
  }
  if (p === 'codex') return { pasta: process.env.CODEX_HOME || path.join(home, '.codex') };
  return { pasta: path.join(process.env.GEMINI_CLI_HOME || home, '.gemini') };
}

/** Origem de um login feito numa pasta à parte (`habblaud-conta entrar`). */
export function origemDoLogin(p: Provedor, pasta: string): Origem {
  if (p === 'claude') return { pasta, configGlobal: path.join(pasta, '.claude.json') };
  if (p === 'gemini') return { pasta: path.join(pasta, '.gemini') };
  return { pasta };
}

function pastaDaConta(p: Provedor, id: string): string {
  return path.join(pastaDasContas(), p, id);
}

const RAIZ_DO_APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Caminho do executável da ferramenta, ou null se não estiver instalada. */
export function binarioDe(p: Provedor): string | null {
  const nome = BINARIOS[p];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']) {
      const alvo = path.join(dir, nome + ext);
      try {
        if (statSync(alvo).isFile()) return alvo;
      } catch {
        // não está nessa pasta
      }
    }
  }
  // O Agent SDK traz o próprio Claude Code.
  if (p === 'claude') {
    const doSdk = path.join(RAIZ_DO_APP, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude');
    if (existsSync(doSdk)) return doSdk;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Leitura do login
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function lerJson(arquivo: string): Obj | null {
  try {
    const v = JSON.parse(readFileSync(arquivo, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
  } catch {
    return null;
  }
}

function obj(v: unknown): Obj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function resumo(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** Corpo de um JWT, sem conferir assinatura: só para mostrar de quem é a conta. */
function corpoDoJwt(token: unknown): Obj | null {
  const parte = typeof token === 'string' ? token.split('.')[1] : undefined;
  if (!parte) return null;
  try {
    return obj(JSON.parse(Buffer.from(parte, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

function maiuscula(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** De quem é o login que está nessa origem, ou null se não há login. */
export function identificar(p: Provedor, o: Origem): Identidade | null {
  if (p === 'claude') {
    const cred = obj(lerJson(path.join(o.pasta, '.credentials.json'))?.claudeAiOauth);
    const token = str(cred?.refreshToken) ?? str(cred?.accessToken);
    if (!cred || !token) return null;
    const perfil = o.configGlobal ? obj(lerJson(o.configGlobal)?.oauthAccount) : null;
    const email = str(perfil?.emailAddress);
    const org = str(perfil?.organizationName);
    const tipo = str(cred.subscriptionType);
    return {
      chave: `${str(perfil?.accountUuid) ?? email ?? resumo(token)}:${str(perfil?.organizationUuid) ?? ''}`,
      email,
      // A organização pessoal se chama "<e-mail>'s Organization": não acrescenta nada.
      nome: org && !/'s Organization$/.test(org) ? org : null,
      plano: str(perfil?.planDisplayName) ?? (tipo ? maiuscula(tipo) : null),
      perfil: perfil ?? undefined,
    };
  }
  if (p === 'codex') {
    const auth = lerJson(path.join(o.pasta, 'auth.json'));
    if (!auth) return null;
    const tokens = obj(auth.tokens);
    const idToken = typeof tokens?.id_token === 'string' ? tokens.id_token : obj(tokens?.id_token)?.raw_jwt;
    const jwt = corpoDoJwt(idToken);
    if (jwt || str(tokens?.refresh_token)) {
      const info = obj(jwt?.['https://api.openai.com/auth']);
      const email = str(jwt?.email);
      const plano = str(info?.chatgpt_plan_type);
      return {
        chave: `chatgpt:${email ?? resumo(String(tokens?.refresh_token))}:${str(tokens?.account_id) ?? str(info?.chatgpt_account_id) ?? ''}`,
        email,
        nome: null,
        plano: plano ? `ChatGPT ${maiuscula(plano)}` : 'ChatGPT',
      };
    }
    const chave = str(auth.OPENAI_API_KEY);
    if (!chave) return null;
    return { chave: `apikey:${resumo(chave)}`, email: null, nome: `Chave da API …${chave.slice(-4)}`, plano: 'Chave da API' };
  }
  const cred = lerJson(path.join(o.pasta, 'oauth_creds.json'));
  const token = str(cred?.refresh_token) ?? str(cred?.access_token);
  if (!cred || !token) return null;
  const email = str(lerJson(path.join(o.pasta, 'google_accounts.json'))?.active) ?? str(corpoDoJwt(cred.id_token)?.email);
  return { chave: email ?? resumo(token), email, nome: null, plano: 'Conta Google' };
}

function idDe(p: Provedor, ident: Identidade): string {
  return resumo(`${p}:${ident.chave}`);
}

// ---------------------------------------------------------------------------
// Escrita segura
// ---------------------------------------------------------------------------

async function gravarAtomico(arquivo: string, conteudo: string | Buffer): Promise<void> {
  const tmp = `${arquivo}.habblaud-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, conteudo, { mode: 0o600 });
  await fs.rename(tmp, arquivo);
}

/** Grava só se mudou: a sincronização roda sempre e não precisa reescrever o disco. */
async function gravarSeMudou(arquivo: string, conteudo: Buffer): Promise<void> {
  try {
    if ((await fs.readFile(arquivo)).equals(conteudo)) return;
  } catch {
    // ainda não existe
  }
  await gravarAtomico(arquivo, conteudo);
}

/**
 * Trava no estilo do Claude Code (uma pasta "<arquivo>.lock"), para não
 * reescrever o .claude.json no meio de uma gravação dele.
 */
async function comTrava<T>(arquivo: string, fn: () => Promise<T>): Promise<T> {
  const trava = `${arquivo}.lock`;
  const limite = Date.now() + 5_000;
  for (;;) {
    try {
      await fs.mkdir(trava);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        // Trava esquecida por um processo que morreu.
        if (Date.now() - (await fs.stat(trava)).mtimeMs > 10_000) await fs.rm(trava, { recursive: true, force: true });
      } catch {
        // sumiu entre uma olhada e outra
      }
      if (Date.now() > limite) throw new ErroDeConta(503, `${path.basename(arquivo)} está ocupado; tente de novo em instantes`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(trava, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Uma troca por vez neste processo.
let fila: Promise<unknown> = Promise.resolve();
function emOrdem<T>(fn: () => Promise<T>): Promise<T> {
  const r = fila.then(fn, fn);
  fila = r.catch(() => undefined);
  return r;
}

// ---------------------------------------------------------------------------
// Guardar, listar, usar, remover
// ---------------------------------------------------------------------------

/** Guarda o login dessa origem entre as contas. Devolve o id, ou null se não há login. */
export async function guardar(p: Provedor, o: Origem): Promise<string | null> {
  const ident = identificar(p, o);
  if (!ident) return null;
  const id = idDe(p, ident);
  const destino = pastaDaConta(p, id);
  await fs.mkdir(destino, { recursive: true, mode: 0o700 });
  for (const nome of ARQUIVOS[p]) {
    try {
      await gravarSeMudou(path.join(destino, nome), await fs.readFile(path.join(o.pasta, nome)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  if (p === 'claude' && ident.perfil) {
    await gravarSeMudou(path.join(destino, ARQUIVO_DO_PERFIL), Buffer.from(JSON.stringify(ident.perfil)));
  }
  const anterior = lerJson(path.join(destino, ARQUIVO_DA_CONTA)) as Partial<ContaSalva> | null;
  const meta: ContaSalva = {
    id,
    provedor: p,
    email: ident.email,
    nome: ident.nome,
    plano: ident.plano,
    salvaEm: anterior?.salvaEm ?? new Date().toISOString(),
    ...(anterior?.usadaEm ? { usadaEm: anterior.usadaEm } : {}),
  };
  await gravarSeMudou(path.join(destino, ARQUIVO_DA_CONTA), Buffer.from(JSON.stringify(meta, null, 2)));
  return id;
}

/** Guarda a conta em uso (os tokens dela renovam com o uso). Devolve o id dela. */
export function sincronizar(p: Provedor): Promise<string | null> {
  return emOrdem(() => guardar(p, origemViva(p)));
}

async function contasSalvas(p: Provedor): Promise<ContaSalva[]> {
  const pasta = path.join(pastaDasContas(), p);
  let ids: string[];
  try {
    ids = (await fs.readdir(pasta)).filter(ehIdDeConta);
  } catch {
    return [];
  }
  const contas: ContaSalva[] = [];
  for (const id of ids) {
    const meta = lerJson(path.join(pasta, id, ARQUIVO_DA_CONTA)) as ContaSalva | null;
    if (meta?.id === id) contas.push(meta);
  }
  return contas.sort((a, b) => (a.email ?? a.nome ?? '').localeCompare(b.email ?? b.nome ?? ''));
}

export interface ResumoDaFerramenta {
  nome: string;
  instalado: boolean;
  /** Id da conta em uso, ou null se ninguém está logado. */
  ativa: string | null;
  contas: ContaSalva[];
}

export async function listarContas(): Promise<Record<Provedor, ResumoDaFerramenta>> {
  const saida = {} as Record<Provedor, ResumoDaFerramenta>;
  for (const p of PROVEDORES) {
    let ativa: string | null = null;
    try {
      // A conta em uso entra (ou se atualiza) na lista: é assim que a primeira conta aparece.
      ativa = await sincronizar(p);
    } catch (err) {
      console.error(`[contas] não consegui guardar a conta do ${NOMES[p]} em uso: ${(err as Error).message}`);
    }
    saida[p] = { nome: NOMES[p], instalado: binarioDe(p) !== null, ativa, contas: await contasSalvas(p) };
  }
  return saida;
}

/** Põe a conta guardada no lugar da que está em uso. */
export function usarConta(p: Provedor, id: string): Promise<ContaSalva> {
  return emOrdem(async () => {
    const pasta = pastaDaConta(p, id);
    const meta = lerJson(path.join(pasta, ARQUIVO_DA_CONTA)) as ContaSalva | null;
    if (!meta || meta.id !== id) throw new ErroDeConta(404, 'conta não encontrada');
    const viva = origemViva(p);
    // Antes de sair da conta atual, guarda os tokens dela como estão agora.
    await guardar(p, viva);

    await fs.mkdir(viva.pasta, { recursive: true, mode: 0o700 });
    for (const nome of ARQUIVOS[p]) {
      const alvo = path.join(viva.pasta, nome);
      let conteudo: Buffer | null = null;
      try {
        conteudo = await fs.readFile(path.join(pasta, nome));
      } catch {
        // essa conta não tem esse arquivo
      }
      const escrever = () => (conteudo ? gravarAtomico(alvo, conteudo) : fs.rm(alvo, { force: true }));
      await (p === 'claude' ? comTrava(alvo, escrever) : escrever());
    }

    if (p === 'claude' && viva.configGlobal) {
      const perfil = lerJson(path.join(pasta, ARQUIVO_DO_PERFIL));
      const arquivo = viva.configGlobal;
      await comTrava(arquivo, async () => {
        const atual = lerJson(arquivo) ?? {};
        if (perfil) atual.oauthAccount = perfil;
        else delete atual.oauthAccount;
        await gravarAtomico(arquivo, JSON.stringify(atual, null, 2));
      });
    }

    if (p === 'gemini') {
      // O login do Google só vale com o Gemini configurado para ele.
      const arquivo = path.join(viva.pasta, 'settings.json');
      const atual = existsSync(arquivo) ? lerJson(arquivo) : {};
      if (atual) {
        const seguranca = obj(atual.security) ?? {};
        const auth = obj(seguranca.auth) ?? {};
        if (auth.selectedType !== 'oauth-personal') {
          auth.selectedType = 'oauth-personal';
          seguranca.auth = auth;
          atual.security = seguranca;
          await gravarAtomico(arquivo, JSON.stringify(atual, null, 2));
        }
      }
    }

    const usada: ContaSalva = { ...meta, usadaEm: new Date().toISOString() };
    await gravarAtomico(path.join(pasta, ARQUIVO_DA_CONTA), JSON.stringify(usada, null, 2));
    console.log(`[contas] ${NOMES[p]}: em uso agora ${meta.email ?? meta.nome ?? id}`);
    return usada;
  });
}

export function removerConta(p: Provedor, id: string): Promise<void> {
  return emOrdem(async () => {
    const ident = identificar(p, origemViva(p));
    if (ident && idDe(p, ident) === id) {
      throw new ErroDeConta(409, 'essa é a conta em uso: troque para outra antes de remover');
    }
    const pasta = pastaDaConta(p, id);
    if (!existsSync(pasta)) throw new ErroDeConta(404, 'conta não encontrada');
    await fs.rm(pasta, { recursive: true, force: true });
    console.log(`[contas] ${NOMES[p]}: conta ${id} removida`);
  });
}

// ---------------------------------------------------------------------------
// Rotina do servidor
// ---------------------------------------------------------------------------

export async function iniciarContas(): Promise<NodeJS.Timeout> {
  await fs.mkdir(pastaDasContas(), { recursive: true, mode: 0o700 });
  await fs.chmod(pastaDasContas(), 0o700).catch(() => undefined);
  // O escritório observa a pasta do Codex: ela precisa existir.
  await fs.mkdir(origemViva('codex').pasta, { recursive: true }).catch(() => undefined);
  // Logins que ficaram pela metade (terminal fechado no meio).
  try {
    const corte = Date.now() - 60 * 60_000;
    for (const nome of await fs.readdir(pastaDosLogins())) {
      const alvo = path.join(pastaDosLogins(), nome);
      if ((await fs.stat(alvo)).mtimeMs < corte) await fs.rm(alvo, { recursive: true, force: true });
    }
  } catch {
    // nenhum login em andamento
  }
  const guardarTodas = async () => {
    for (const p of PROVEDORES) await sincronizar(p).catch(() => undefined);
  };
  await guardarTodas();
  // Os tokens da conta em uso renovam sozinhos: a cópia guardada acompanha.
  const t = setInterval(() => void guardarTodas(), 10 * 60_000);
  t.unref();
  return t;
}

/** O Claude está logado (no lugar de sempre ou por variável)? */
export function claudeLogado(): boolean {
  return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || identificar('claude', origemViva('claude')));
}
