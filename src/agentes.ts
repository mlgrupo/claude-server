// =============================================================================
// Agentes especializados: o Claude que outros sistemas (o HofOS, por exemplo)
// chamam por HTTP em POST /api/v1/agentes/executar.
//
// Cada agente é um Claude Code sem ferramenta nenhuma, com modelo, esforço e
// vagas próprios: o "rápido" (Haiku) responde e encerra; o "estrategista"
// (Opus) demora mais e entrega com qualidade. Quem chama manda o prompt de
// sistema, a mensagem e, se quiser, um esquema JSON e imagens; a resposta volta
// com os eventos do Claude Code (init, rate_limit_event, result), no mesmo
// formato do `claude -p --output-format stream-json`.
//
// Sem ferramenta, o texto de terceiros que chega no prompt (mensagem de lead,
// por exemplo) não consegue mexer em nada no servidor.
//
// Os agentes rodam com a chave da API (AGENTES_ANTHROPIC_API_KEY), nunca com a
// assinatura de alguém da equipe: sem a chave, recusam com 503 e quem chamou
// segue pelo caminho dele.
// =============================================================================

import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { agentEnv, config } from './config.js';
import { esquecerUsoNoEscritorio, registrarUsoNoEscritorio } from './escritorio.js';

export type Esforco = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Origem = 'tela' | 'automatico';

export interface Agente {
  id: string;
  nome: string;
  descricao: string;
  modelo: string;
  esforco: Esforco;
  /** Quantos pedidos desse agente rodam ao mesmo tempo. */
  simultaneos: number;
  /** Teto de um pedido (fila + execução), em segundos. */
  limiteSegundos: number;
}

const AGENTES_PADRAO: Agente[] = [
  {
    id: 'rapido',
    nome: 'Agente rápido',
    descricao: 'Classificações, temperatura, extrações e JSON curtos: responde e encerra.',
    modelo: 'haiku',
    esforco: 'low',
    simultaneos: 4,
    limiteSegundos: 120,
  },
  {
    id: 'analista',
    nome: 'Analista',
    descricao: 'Resumos e análises de conversa, call, atendimento e funil.',
    modelo: 'sonnet',
    esforco: 'medium',
    simultaneos: 3,
    limiteSegundos: 300,
  },
  {
    id: 'estrategista',
    nome: 'Estrategista',
    descricao: 'Roteiros, campanhas, newsletter, blog e relatórios: qualidade acima de velocidade.',
    modelo: 'opus',
    esforco: 'high',
    simultaneos: 2,
    limiteSegundos: 600,
  },
  {
    id: 'hofos-ai',
    nome: 'HofOS AI',
    descricao: 'O chat da equipe no HofOS: decide a próxima ferramenta ou responde.',
    modelo: 'sonnet',
    esforco: 'medium',
    simultaneos: 3,
    limiteSegundos: 300,
  },
  {
    id: 'editor-de-video',
    nome: 'Editor de vídeo',
    descricao: 'Plano de edição e ajustes dos vídeos do editor do HofOS.',
    modelo: 'opus',
    esforco: 'high',
    simultaneos: 2,
    limiteSegundos: 600,
  },
];

const ESFORCOS: Esforco[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const ID_VALIDO = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** AGENTES (JSON) ajusta os padrões ou cria agentes: {"estrategista":{"modelo":"sonnet"},"novo":{...}}. */
export function carregarAgentes(json: string | undefined): Map<string, Agente> {
  const mapa = new Map(AGENTES_PADRAO.map((a) => [a.id, { ...a }]));
  if (!json) return mapa;
  let ajustes: Record<string, Partial<Agente>>;
  try {
    ajustes = JSON.parse(json);
  } catch {
    console.error('[agentes] AGENTES não é JSON válido — usando os padrões.');
    return mapa;
  }
  for (const [id, ajuste] of Object.entries(ajustes ?? {})) {
    if (!ID_VALIDO.test(id) || !ajuste || typeof ajuste !== 'object') continue;
    const base = mapa.get(id) ?? {
      id,
      nome: id,
      descricao: '',
      modelo: 'sonnet',
      esforco: 'medium' as Esforco,
      simultaneos: 2,
      limiteSegundos: 300,
    };
    mapa.set(id, {
      ...base,
      ...(typeof ajuste.nome === 'string' ? { nome: ajuste.nome } : {}),
      ...(typeof ajuste.descricao === 'string' ? { descricao: ajuste.descricao } : {}),
      ...(typeof ajuste.modelo === 'string' && ajuste.modelo.trim() ? { modelo: ajuste.modelo.trim() } : {}),
      ...(ESFORCOS.includes(ajuste.esforco as Esforco) ? { esforco: ajuste.esforco as Esforco } : {}),
      ...(Number(ajuste.simultaneos) >= 1 ? { simultaneos: Math.min(Math.floor(Number(ajuste.simultaneos)), 20) } : {}),
      ...(Number(ajuste.limiteSegundos) >= 10 ? { limiteSegundos: Math.min(Math.floor(Number(ajuste.limiteSegundos)), 1800) } : {}),
    });
  }
  return mapa;
}

const agentes = carregarAgentes(config.agentesAjustes);

export function listaDeAgentes(): Agente[] {
  return [...agentes.values()];
}

/**
 * Qual agente atende, pela função do produto que chamou (o rótulo `feature`
 * do HofOS). O pedido explícito vence; função sem regra vai pelo porte.
 */
const AGENTE_PELA_FUNCAO: Array<[RegExp, string]> = [
  [/^suporte\.agente$/, 'hofos-ai'],
  [/^video\./, 'editor-de-video'],
  [/^(roteiros\.|marketing\.|deals\.relatorio$|playbook\.|raio_x$|trilha\.|esteira\.sugestoes$)/, 'estrategista'],
  [
    /^(conversa\.resumo$|analise_call$|ligacao\.resumo$|atendimento\.|posvendas\.|etapa\.(analisador|reanalise)$|cadencia\.sugestao$|suporte\.anexo$|piloto_perfil\.|trafego\.|treinamentos\.|simulador\.analise$|criativo\.julgamento$)/,
    'analista',
  ],
  [/^(cadencia\.|etapa\.classificador$|agendamento\.|comprovante\.|ofx\.|esteira\.slack$|suporte\.sonda$|workflow\.)/, 'rapido'],
];

export function escolherAgente(
  pedido: { agente?: string; feature?: string; nivel?: string },
  mapa: Map<string, Agente> = agentes,
): Agente {
  const explicito = pedido.agente ? mapa.get(pedido.agente) : undefined;
  if (explicito) return explicito;
  const feature = pedido.feature ?? '';
  const regra = AGENTE_PELA_FUNCAO.find(([re]) => re.test(feature));
  let id = regra ? regra[1] : pedido.nivel === 'forte' ? 'analista' : 'rapido';
  // Pedido marcado como forte nunca cai no agente rápido.
  if (id === 'rapido' && pedido.nivel === 'forte') id = 'analista';
  return mapa.get(id) ?? mapa.get('rapido') ?? [...mapa.values()][0];
}

// ---------------------------------------------------------------------------
// Uso da assinatura da equipe (a conta do Claude em uso no chat e no
// terminal), para o medidor da tela de Agentes e o escritório. Os agentes não
// gastam a assinatura: rodam com a chave da API (AGENTES_ANTHROPIC_API_KEY).
// ---------------------------------------------------------------------------

interface LimiteDaAssinatura {
  utilizacao: number | null;
  renovaEm: number | null;
  status: string | null;
  tipo: string | null;
  em: number;
}

// A última leitura vai para o disco: depois de um deploy, o medidor não zera.
const ARQUIVO_DO_LIMITE = path.join(config.agentesDir, 'limite-da-assinatura.json');
let limite: LimiteDaAssinatura | null = lerLimiteGuardado();
let gravandoLimite: Promise<void> = Promise.resolve();

function lerLimiteGuardado(): LimiteDaAssinatura | null {
  try {
    const salvo = JSON.parse(readFileSync(ARQUIVO_DO_LIMITE, 'utf8')) as LimiteDaAssinatura;
    return typeof salvo?.em === 'number' ? salvo : null;
  } catch {
    return null;
  }
}

export function registrarLimite(info: Record<string, unknown> | undefined): void {
  if (!info) return;
  registrarUsoNoEscritorio(info);
  const janelas = Object.values((info.unifiedWindows as Record<string, { utilization?: unknown }>) ?? {})
    .map((j) => j?.utilization)
    .filter((u): u is number => typeof u === 'number');
  const direta = typeof info.utilization === 'number' ? [info.utilization] : [];
  const todas = [...janelas, ...direta];
  limite = {
    utilizacao: todas.length ? Math.max(...todas) : null,
    renovaEm: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null,
    status: typeof info.status === 'string' ? info.status : null,
    tipo: typeof info.rateLimitType === 'string' ? info.rateLimitType : null,
    em: Date.now(),
  };
  const conteudo = JSON.stringify(limite);
  gravandoLimite = gravandoLimite
    .then(async () => {
      await fs.mkdir(config.agentesDir, { recursive: true });
      await fs.writeFile(`${ARQUIVO_DO_LIMITE}.tmp`, conteudo);
      await fs.rename(`${ARQUIVO_DO_LIMITE}.tmp`, ARQUIVO_DO_LIMITE);
    })
    .catch(() => undefined);
}

/** Trocou a conta do Claude: o uso guardado era da outra. */
export function esquecerLimite(): void {
  limite = null;
  esquecerUsoNoEscritorio();
  gravandoLimite = gravandoLimite.then(() => fs.rm(ARQUIVO_DO_LIMITE, { force: true })).catch(() => undefined);
  avisar();
}

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------

export interface Imagem {
  mime: string;
  base64: string;
}

export interface PedidoDeAgente {
  id: string;
  agente: Agente;
  sistema: string;
  prompt: string;
  esquema?: Record<string, unknown>;
  imagens: Imagem[];
  origem: Origem;
  assunto: string;
  empresa: string;
  feature: string;
  cliente: string;
  prazo: number;
}

export interface RespostaDeAgente {
  id: string;
  agente: string;
  modelo: string;
  esperaMs: number;
  duracaoMs: number;
  eventos: unknown[];
}

export class ErroDeAgente extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    mensagem: string,
    readonly eventos?: unknown[],
  ) {
    super(mensagem);
  }
}

interface NaFila {
  pedido: PedidoDeAgente;
  entrou: number;
  resolve: (r: RespostaDeAgente) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
}

interface Rodando {
  pedido: PedidoDeAgente;
  desde: number;
  abort: AbortController;
}

const fila: NaFila[] = [];
const rodando = new Map<string, Rodando>();

/** Fração mínima do prazo que precisa sobrar para valer a pena começar. */
const SOBRA_MINIMA_MS = 10_000;

function rodandoDoAgente(id: string): number {
  let n = 0;
  for (const r of rodando.values()) if (r.pedido.agente.id === id) n++;
  return n;
}

function naFilaDoAgente(id: string): number {
  return fila.filter((f) => f.pedido.agente.id === id).length;
}

// O mesmo pedido (mesmo cliente + id) chegando de novo — reenvio do cliente ou
// da borda do Railway — recebe a mesma resposta em vez de rodar outra vez.
const emAndamento = new Map<string, Promise<RespostaDeAgente>>();
const concluidos = new Map<string, { ate: number; resposta?: RespostaDeAgente; erro?: ErroDeAgente }>();
const LEMBRAR_RESULTADO_MS = 5 * 60_000;
const MAX_LEMBRADOS = 500;

export function executarAgente(pedido: PedidoDeAgente): Promise<RespostaDeAgente> {
  const agora = Date.now();
  for (const [chave, item] of concluidos) if (item.ate <= agora) concluidos.delete(chave);
  const chave = `${pedido.cliente}:${pedido.id}`;
  const rodandoIgual = emAndamento.get(chave);
  if (rodandoIgual) {
    console.log(`[agentes] pedido ${pedido.id} repetido enquanto rodava: devolve o mesmo resultado`);
    return rodandoIgual;
  }
  const jaFeito = concluidos.get(chave);
  if (jaFeito) {
    console.log(`[agentes] pedido ${pedido.id} repetido depois de terminar: devolve o resultado guardado`);
    return jaFeito.resposta ? Promise.resolve(jaFeito.resposta) : Promise.reject(jaFeito.erro);
  }
  const promessa = admitir(pedido);
  emAndamento.set(chave, promessa);
  const lembrar = (item: { resposta?: RespostaDeAgente; erro?: ErroDeAgente }) => {
    if (concluidos.size >= MAX_LEMBRADOS) concluidos.delete(concluidos.keys().next().value as string);
    concluidos.set(chave, { ate: Date.now() + LEMBRAR_RESULTADO_MS, ...item });
  };
  promessa
    .then(
      (resposta) => lembrar({ resposta }),
      // Recusa por vaga ou limite não fica guardada: tentar de novo depois pode dar certo.
      (erro) => {
        if (erro instanceof ErroDeAgente && erro.status !== 429 && erro.status !== 503) lembrar({ erro });
      },
    )
    .finally(() => emAndamento.delete(chave));
  return promessa;
}

function admitir(pedido: PedidoDeAgente): Promise<RespostaDeAgente> {
  if (!config.agentesApiKey) {
    // Quem chamou segue pelo caminho dele (o HofOS cai na API própria na hora).
    const msg = 'os agentes usam a chave da API e AGENTES_ANTHROPIC_API_KEY não está definida';
    registrar(pedido, 'recusado', 0, 0, null, msg);
    return Promise.reject(new ErroDeAgente(503, 'sem_chave_da_api', msg));
  }
  const { agente } = pedido;
  const esperando = naFilaDoAgente(agente.id);
  const cheia =
    pedido.origem === 'automatico' ? esperando >= agente.simultaneos * 2 : fila.length >= config.agentesFilaMaxima;
  if (cheia) {
    const msg = `fila do agente ${agente.id} cheia (${esperando} esperando)`;
    registrar(pedido, 'recusado', 0, 0, null, msg);
    return Promise.reject(new ErroDeAgente(429, 'fila_cheia', msg));
  }

  return new Promise<RespostaDeAgente>((resolve, reject) => {
    const entrou = Date.now();
    const item: NaFila = {
      pedido,
      entrou,
      resolve,
      reject,
      // Não começou a tempo: devolve logo, quem chamou segue pelo caminho dele.
      timer: setTimeout(() => {
        const i = fila.indexOf(item);
        if (i === -1) return;
        fila.splice(i, 1);
        const msg = `o pedido esperou ${Math.round((Date.now() - entrou) / 1000)} s na fila sem vaga`;
        registrar(pedido, 'recusado', Date.now() - entrou, 0, null, msg);
        reject(new ErroDeAgente(429, 'fila_demorada', msg));
        avisar();
      }, Math.max(0, pedido.prazo - entrou - SOBRA_MINIMA_MS)),
    };
    // Pedido de tela passa na frente dos automáticos.
    const posicao = pedido.origem === 'tela' ? fila.findIndex((f) => f.pedido.origem !== 'tela') : -1;
    if (posicao === -1) fila.push(item);
    else fila.splice(posicao, 0, item);
    avisar();
    despachar();
  });
}

function despachar(): void {
  for (let i = 0; i < fila.length && rodando.size < config.agentesMaxSimultaneos; ) {
    const item = fila[i];
    if (rodandoDoAgente(item.pedido.agente.id) >= item.pedido.agente.simultaneos) {
      i++;
      continue;
    }
    fila.splice(i, 1);
    clearTimeout(item.timer);
    const espera = Date.now() - item.entrou;
    void rodar(item.pedido, espera).then(item.resolve, item.reject).finally(() => {
      despachar();
      avisar();
    });
  }
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

/** Pasta de trabalho do agente: vira a "sala" dele no escritório. */
export function pastaDoAgente(id: string): string {
  return path.join(config.agentesDir, id);
}

function promptComImagens(pedido: PedidoDeAgente): AsyncIterable<SDKUserMessage> {
  const conteudo = [
    { type: 'text', text: pedido.prompt },
    ...pedido.imagens.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mime, data: img.base64 },
    })),
  ];
  return (async function* () {
    yield {
      type: 'user',
      message: { role: 'user', content: conteudo },
      parent_tool_use_id: null,
      session_id: '',
    } as unknown as SDKUserMessage;
  })();
}

async function rodar(pedido: PedidoDeAgente, esperaMs: number): Promise<RespostaDeAgente> {
  const abort = new AbortController();
  const inicio = Date.now();
  rodando.set(pedido.id, { pedido, desde: inicio, abort });
  avisar();
  const restante = Math.max(SOBRA_MINIMA_MS, pedido.prazo - inicio);
  let estourou = false;
  const timer = setTimeout(() => {
    estourou = true;
    abort.abort();
  }, restante);

  const { agente } = pedido;
  const cwd = pastaDoAgente(agente.id);
  const eventos: unknown[] = [];
  let modelo = agente.modelo;
  try {
    await fs.mkdir(cwd, { recursive: true });
    const options: Options = {
      cwd,
      model: agente.modelo,
      // O Haiku não tem nível de esforço: só manda para os outros.
      ...(/haiku/i.test(agente.modelo) ? {} : { effort: agente.esforco }),
      systemPrompt: pedido.sistema.trim() || 'Você é um assistente. Responda em português do Brasil.',
      tools: [],
      settingSources: [],
      maxTurns: pedido.esquema ? 4 : 2,
      ...(pedido.esquema ? { outputFormat: { type: 'json_schema', schema: pedido.esquema } } : {}),
      abortController: abort,
      // A chave da API vem antes do login da assinatura no Claude Code: os
      // agentes nunca gastam a conta de quem está usando o chat.
      env: { ...agentEnv(), ANTHROPIC_API_KEY: config.agentesApiKey, CLAUDE_CODE_OAUTH_TOKEN: undefined },
      stderr: (data: string) => process.stderr.write(`[agente ${agente.id}] ${data}`),
    };
    const prompt = pedido.imagens.length ? promptComImagens(pedido) : pedido.prompt;
    for await (const msg of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
      const m = msg as Record<string, unknown>;
      if (m.type === 'system' && m.subtype === 'init') {
        if (typeof m.model === 'string') modelo = m.model;
        eventos.push({ type: 'system', subtype: 'init', model: m.model, session_id: m.session_id });
      } else if (m.type === 'rate_limit_event') {
        // Limite da chave da API, não da assinatura: não mexe no medidor.
        eventos.push(m);
      } else if (m.type === 'result') {
        eventos.push(m);
      }
    }
    const resultado = eventos.find((e) => (e as { type?: string }).type === 'result') as
      | { is_error?: boolean; subtype?: string; result?: string; usage?: Record<string, number> }
      | undefined;
    const duracao = Date.now() - inicio;
    if (!resultado) {
      registrar(pedido, 'erro', esperaMs, duracao, modelo, 'o Claude Code terminou sem resultado');
      throw new ErroDeAgente(502, 'sem_resultado', 'o Claude Code terminou sem resultado', eventos);
    }
    if (resultado.is_error) {
      const motivo = [resultado.subtype, resultado.result].filter(Boolean).join(': ').slice(0, 300);
      registrar(pedido, 'erro', esperaMs, duracao, modelo, motivo);
      throw new ErroDeAgente(502, 'erro_do_claude', motivo || 'o Claude devolveu erro', eventos);
    }
    registrar(pedido, 'ok', esperaMs, duracao, modelo, null, resultado.usage);
    return { id: pedido.id, agente: agente.id, modelo, esperaMs, duracaoMs: duracao, eventos };
  } catch (err) {
    if (err instanceof ErroDeAgente) throw err;
    const duracao = Date.now() - inicio;
    if (estourou) {
      const msg = `sem resposta em ${Math.round(restante / 1000)} s`;
      registrar(pedido, 'erro', esperaMs, duracao, modelo, msg);
      throw new ErroDeAgente(504, 'tempo_esgotado', msg, eventos);
    }
    const msg = err instanceof Error ? err.message : String(err);
    registrar(pedido, 'erro', esperaMs, duracao, modelo, msg.slice(0, 300));
    throw new ErroDeAgente(502, 'falha', msg.slice(0, 300), eventos);
  } finally {
    clearTimeout(timer);
    rodando.delete(pedido.id);
  }
}

export function pararTodosOsAgentes(): void {
  for (const r of rodando.values()) r.abort.abort();
  for (const item of fila.splice(0)) {
    clearTimeout(item.timer);
    item.reject(new ErroDeAgente(503, 'desligando', 'o servidor está reiniciando'));
  }
}

export function agentesOcupados(): number {
  return rodando.size;
}

// ---------------------------------------------------------------------------
// Validação do corpo do POST
// ---------------------------------------------------------------------------

const MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGENS = 8;
const MAX_BYTES_DE_IMAGEM = 15 * 1024 * 1024;

function texto(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export function lerPedido(corpo: unknown, cliente: string, agora = Date.now()): PedidoDeAgente {
  const b = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  const prompt = typeof b.prompt === 'string' ? b.prompt : '';
  if (!prompt.trim()) throw new ErroDeAgente(400, 'pedido_invalido', 'falta o campo "prompt"');
  if (prompt.length > 600_000) throw new ErroDeAgente(413, 'pedido_grande', 'o prompt passa de 600 mil caracteres');
  const sistema = typeof b.sistema === 'string' ? b.sistema : '';
  if (sistema.length > 300_000) throw new ErroDeAgente(413, 'pedido_grande', 'o sistema passa de 300 mil caracteres');

  let esquema: Record<string, unknown> | undefined;
  if (b.esquema !== undefined && b.esquema !== null) {
    const bruto = typeof b.esquema === 'string' ? safeJson(b.esquema) : b.esquema;
    if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) {
      throw new ErroDeAgente(400, 'pedido_invalido', '"esquema" precisa ser um objeto JSON Schema');
    }
    esquema = bruto as Record<string, unknown>;
  }

  const imagens: Imagem[] = [];
  if (Array.isArray(b.imagens)) {
    if (b.imagens.length > MAX_IMAGENS) throw new ErroDeAgente(413, 'pedido_grande', `no máximo ${MAX_IMAGENS} imagens`);
    let bytes = 0;
    for (const img of b.imagens as Array<Record<string, unknown>>) {
      const mime = texto(img?.mime, 40).toLowerCase();
      const base64 = typeof img?.base64 === 'string' ? img.base64.replace(/\s+/g, '') : '';
      if (!MIMES.has(mime) || !/^[A-Za-z0-9+/]+=*$/.test(base64)) {
        throw new ErroDeAgente(400, 'pedido_invalido', 'imagem precisa de "mime" (png, jpeg, gif ou webp) e "base64"');
      }
      bytes += Math.floor((base64.length * 3) / 4);
      imagens.push({ mime, base64 });
    }
    if (bytes > MAX_BYTES_DE_IMAGEM) throw new ErroDeAgente(413, 'pedido_grande', 'as imagens passam de 15 MB');
  }

  const origem: Origem = b.origem === 'tela' ? 'tela' : 'automatico';
  const agente = escolherAgente({
    agente: texto(b.agente, 40) || undefined,
    feature: texto(b.feature, 80) || undefined,
    nivel: texto(b.nivel, 20) || undefined,
  });
  const pedidoS = Number(b.limiteSegundos);
  const limiteS = Math.min(
    Number.isFinite(pedidoS) && pedidoS >= 10 ? pedidoS : agente.limiteSegundos,
    agente.limiteSegundos,
  );
  const id = /^[A-Za-z0-9_-]{8,64}$/.test(texto(b.id, 64)) ? texto(b.id, 64) : randomUUID();
  return {
    id,
    agente,
    sistema,
    prompt,
    esquema,
    imagens,
    origem,
    assunto: texto(b.assunto, 120) || 'Pedido de IA',
    empresa: texto(b.empresa, 120),
    feature: texto(b.feature, 80),
    cliente,
    prazo: agora + limiteS * 1000,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Estatísticas e painel (o que o escritório e a tela de Agentes mostram)
// ---------------------------------------------------------------------------

type Status = 'ok' | 'erro' | 'recusado';

interface Registro {
  id: string;
  agente: string;
  assunto: string;
  empresa: string;
  feature: string;
  cliente: string;
  origem: Origem;
  status: Status;
  motivo: string | null;
  modelo: string | null;
  esperaMs: number;
  duracaoMs: number;
  tokensEntrada: number;
  tokensSaida: number;
  em: string;
}

interface Contagem {
  ok: number;
  erro: number;
  recusado: number;
  duracaoTotalMs: number;
  tokensEntrada: number;
  tokensSaida: number;
}

const ultimos: Registro[] = [];
const MAX_ULTIMOS = 100;
let dia = hoje();
let porAgente = new Map<string, Contagem>();

function hoje(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

function contagem(id: string): Contagem {
  if (dia !== hoje()) {
    dia = hoje();
    porAgente = new Map();
  }
  let c = porAgente.get(id);
  if (!c) {
    c = { ok: 0, erro: 0, recusado: 0, duracaoTotalMs: 0, tokensEntrada: 0, tokensSaida: 0 };
    porAgente.set(id, c);
  }
  return c;
}

function registrar(
  pedido: PedidoDeAgente,
  status: Status,
  esperaMs: number,
  duracaoMs: number,
  modelo: string | null,
  motivo: string | null,
  usage?: Record<string, number>,
): void {
  const entrada =
    (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
  const saida = usage?.output_tokens ?? 0;
  const c = contagem(pedido.agente.id);
  c[status]++;
  if (status === 'ok') {
    c.duracaoTotalMs += duracaoMs;
    c.tokensEntrada += entrada;
    c.tokensSaida += saida;
  }
  ultimos.unshift({
    id: pedido.id,
    agente: pedido.agente.id,
    assunto: pedido.assunto,
    empresa: pedido.empresa,
    feature: pedido.feature,
    cliente: pedido.cliente,
    origem: pedido.origem,
    status,
    motivo,
    modelo,
    esperaMs,
    duracaoMs,
    tokensEntrada: entrada,
    tokensSaida: saida,
    em: new Date().toISOString(),
  });
  ultimos.length = Math.min(ultimos.length, MAX_ULTIMOS);
  const tempo = status === 'recusado' ? '' : ` em ${(duracaoMs / 1000).toFixed(1)} s (fila ${(esperaMs / 1000).toFixed(1)} s)`;
  console.log(
    `[agentes] ${pedido.agente.id} · ${pedido.assunto}${pedido.empresa ? ` · ${pedido.empresa}` : ''} · ${pedido.cliente} → ${status}${tempo}${motivo ? `: ${motivo}` : ''}`,
  );
  avisar();
}

export function painelDosAgentes() {
  if (dia !== hoje()) contagem('_');
  return {
    dia,
    maxSimultaneos: config.agentesMaxSimultaneos,
    /** Como os agentes se autenticam: só com a chave da API. */
    credencial: config.agentesApiKey ? 'chave_da_api' : 'sem_chave',
    /** Uso da assinatura da equipe (chat e terminal), não dos agentes. */
    assinatura: limite
      ? {
          utilizacao: limite.utilizacao,
          renovaEm: limite.renovaEm ? new Date(limite.renovaEm).toISOString() : null,
          status: limite.status,
          tipo: limite.tipo,
          atualizadoEm: new Date(limite.em).toISOString(),
        }
      : null,
    agentes: listaDeAgentes().map((a) => {
      const c = porAgente.get(a.id) ?? { ok: 0, erro: 0, recusado: 0, duracaoTotalMs: 0, tokensEntrada: 0, tokensSaida: 0 };
      return {
        ...a,
        rodando: [...rodando.values()]
          .filter((r) => r.pedido.agente.id === a.id)
          .map((r) => ({
            id: r.pedido.id,
            assunto: r.pedido.assunto,
            empresa: r.pedido.empresa,
            origem: r.pedido.origem,
            desde: new Date(r.desde).toISOString(),
          })),
        naFila: naFilaDoAgente(a.id),
        hoje: {
          ok: c.ok,
          erro: c.erro,
          recusado: c.recusado,
          mediaMs: c.ok ? Math.round(c.duracaoTotalMs / c.ok) : null,
          tokensEntrada: c.tokensEntrada,
          tokensSaida: c.tokensSaida,
        },
      };
    }),
    ultimos,
  };
}

// Quem acompanha o painel ao vivo (SSE da tela de Agentes).
const ouvintes = new Set<() => void>();
let avisoPendente = false;

function avisar(): void {
  if (avisoPendente) return;
  avisoPendente = true;
  setTimeout(() => {
    avisoPendente = false;
    for (const f of ouvintes) f();
  }, 250);
}

export function ouvirPainel(f: () => void): () => void {
  ouvintes.add(f);
  return () => ouvintes.delete(f);
}

// ---------------------------------------------------------------------------
// Limpeza: as transcrições dos agentes ficam AGENTES_RETENCAO_DIAS dias.
// ---------------------------------------------------------------------------

function pastaDeProjetosDoClaude(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

/** O Claude Code guarda a sessão em projects/<cwd com tudo que não é letra/número trocado por "-">. */
export function pastaDeSessoes(cwd: string): string {
  return path.join(pastaDeProjetosDoClaude(), cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

async function limparAntigas(): Promise<void> {
  const corte = Date.now() - config.agentesRetencaoDias * 24 * 60 * 60 * 1000;
  let apagadas = 0;
  for (const a of listaDeAgentes()) {
    const pasta = pastaDeSessoes(pastaDoAgente(a.id));
    let itens: import('node:fs').Dirent[];
    try {
      itens = await fs.readdir(pasta, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of itens) {
      const alvo = path.join(pasta, item.name);
      try {
        const st = await fs.stat(alvo);
        if (st.mtimeMs >= corte) continue;
        await fs.rm(alvo, { recursive: true, force: true });
        apagadas++;
      } catch {
        // Arquivo sumiu no meio: tudo bem.
      }
    }
  }
  if (apagadas) console.log(`[agentes] limpeza: ${apagadas} sessões com mais de ${config.agentesRetencaoDias} dias apagadas`);
}

export function iniciarLimpezaDosAgentes(): NodeJS.Timeout {
  void limparAntigas();
  const t = setInterval(() => void limparAntigas(), 6 * 60 * 60 * 1000);
  t.unref();
  return t;
}
