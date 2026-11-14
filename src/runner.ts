import crypto from 'node:crypto';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { registrarLimite } from './agentes.js';
import { commitBrain, reflectionPrompt, systemPromptAppend } from './brain.js';
import { agentEnv, config } from './config.js';
import {
  type ChatMessage,
  type RunMeta,
  type Segment,
  type ToolSegment,
  createConversation,
  getConversation,
  updateConversation,
} from './store.js';

// Ferramentas que dependem de um humano respondendo — num servidor autônomo elas só travariam a tarefa.
const NEEDS_HUMAN_TOOLS = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];
// A consolidação de memória só lê e escreve arquivos.
const REFLECTION_BLOCKED_TOOLS = [...NEEDS_HUMAN_TOOLS, 'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit'];

export type RunEventBody =
  | { type: 'started'; conversationId: string; model: string }
  | { type: 'text_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; summary: string }
  | { type: 'tool_result'; id: string; isError: boolean; preview: string }
  | { type: 'notice'; message: string }
  | { type: 'result'; status: RunMeta['status']; text: string; durationMs?: number; numTurns?: number; costUsd?: number }
  | { type: 'brain'; status: 'started' | 'done' | 'error'; summary?: string }
  | { type: 'done' };

export type RunEvent = RunEventBody & { seq: number; at: number };

export interface Run {
  id: string;
  conversationId: string;
  model: string;
  status: 'running' | RunMeta['status'];
  startedAt: number;
  finishedAt?: number;
  resultText?: string;
  meta?: RunMeta;
  brainSummary?: string;
  events: RunEvent[];
  listeners: Set<(e: RunEvent) => void>;
  abort: AbortController;
  closed: boolean;
  /** Resolve quando a resposta principal termina (a consolidação de memória pode continuar depois). */
  completion: Promise<void>;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const runs = new Map<string, Run>();
const activeByConversation = new Map<string, string>();
const RUN_RETENTION_MS = 60 * 60 * 1000;
const MODEL_RE = /^[a-z0-9][a-z0-9.\-[\]]{1,60}$/i;

export function getRun(id: string): Run | undefined {
  return runs.get(id);
}

export function activeRunFor(conversationId: string): string | undefined {
  return activeByConversation.get(conversationId);
}

export function runningCount(): number {
  return activeByConversation.size;
}

export function subscribe(run: Run, listener: (e: RunEvent) => void): () => void {
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}

function emit(run: Run, body: RunEventBody): void {
  const event = { ...body, seq: run.events.length + 1, at: Date.now() } as RunEvent;
  run.events.push(event);
  for (const l of run.listeners) {
    try {
      l(event);
    } catch {
      /* ouvinte desconectado */
    }
  }
}

function closeRun(run: Run): void {
  if (run.closed) return;
  emit(run, { type: 'done' });
  run.closed = true;
  run.listeners.clear();
  setTimeout(() => runs.delete(run.id), RUN_RETENTION_MS).unref();
}

export async function startRun(input: { message: string; conversationId?: string; model?: string }): Promise<Run> {
  const message = (input.message ?? '').trim();
  if (!message) throw new HttpError(400, 'mensagem vazia');
  if (message.length > 200_000) throw new HttpError(413, 'mensagem grande demais');
  const model = input.model?.trim() || config.model;
  if (!MODEL_RE.test(model)) throw new HttpError(400, 'modelo inválido');

  let conversationId = input.conversationId;
  if (conversationId) {
    if (!(await getConversation(conversationId))) throw new HttpError(404, 'conversa não encontrada');
    if (activeByConversation.has(conversationId)) throw new HttpError(409, 'essa conversa já tem uma tarefa em andamento');
  }
  if (runningCount() >= config.maxConcurrentRuns) {
    throw new HttpError(429, `limite de ${config.maxConcurrentRuns} tarefas simultâneas atingido — aguarde uma terminar`);
  }
  if (!conversationId) conversationId = (await createConversation(message)).id;
  if (activeByConversation.has(conversationId)) throw new HttpError(409, 'essa conversa já tem uma tarefa em andamento');

  let resolveCompletion!: () => void;
  const run: Run = {
    id: crypto.randomUUID(),
    conversationId,
    model,
    status: 'running',
    startedAt: Date.now(),
    events: [],
    listeners: new Set(),
    abort: new AbortController(),
    closed: false,
    completion: new Promise<void>((r) => (resolveCompletion = r)),
  };
  runs.set(run.id, run);
  activeByConversation.set(conversationId, run.id);

  await updateConversation(conversationId, (c) => {
    c.messages.push({ role: 'user', text: message, createdAt: new Date().toISOString(), runId: run.id });
  });
  emit(run, { type: 'started', conversationId, model });

  void execute(run, message)
    .catch((err) => {
      console.error(`[run ${run.id}] erro inesperado`, err);
      if (run.status === 'running') {
        run.status = 'error';
        run.resultText = `Erro inesperado: ${(err as Error).message}`;
        run.finishedAt = Date.now();
        emit(run, { type: 'result', status: 'error', text: run.resultText });
      }
    })
    .finally(() => {
      if (activeByConversation.get(run.conversationId) === run.id) activeByConversation.delete(run.conversationId);
      resolveCompletion();
      if (!run.closed && run.status !== 'success') closeRun(run);
    });
  return run;
}

export function stopRun(run: Run): void {
  if (run.status === 'running') run.abort.abort();
}

export function abortAll(): void {
  for (const run of runs.values()) stopRun(run);
}

// ---------------------------------------------------------------------------

async function baseOptions(model: string, abort: AbortController): Promise<Options> {
  return {
    cwd: config.workspaceDir,
    model,
    effort: config.effort,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: await systemPromptAppend() },
    settingSources: ['user', 'project', 'local'],
    additionalDirectories: [config.brainDir],
    abortController: abort,
    env: agentEnv(),
    stderr: (data: string) => process.stderr.write(`[claude] ${data}`),
  };
}

async function execute(run: Run, message: string): Promise<void> {
  const conv = await getConversation(run.conversationId);
  const assistant: ChatMessage = { role: 'assistant', createdAt: new Date().toISOString(), runId: run.id, segments: [] };
  const segments = assistant.segments as Segment[];
  const tools = new Map<string, ToolSegment>();
  let sessionId = conv?.sessionId;
  let usedTools = false;
  let meta: RunMeta = { status: 'error' };
  let resultText = '';

  const timer = setTimeout(() => {
    emit(run, { type: 'notice', message: `Tempo limite de ${config.runTimeoutMs / 60_000} min atingido — interrompendo.` });
    run.abort.abort();
  }, config.runTimeoutMs);

  const handle = (msg: SDKMessage): void => {
    if (msg.type === 'rate_limit_event') {
      // O chat também gasta a assinatura: o teto dos agentes e o escritório enxergam.
      registrarLimite(msg.rate_limit_info as unknown as Record<string, unknown>);
      return;
    }
    if (msg.type === 'system' && msg.subtype === 'init') {
      if (msg.session_id !== sessionId) {
        sessionId = msg.session_id;
        void updateConversation(run.conversationId, (c) => {
          c.sessionId = msg.session_id;
        }).catch(() => undefined);
      }
      return;
    }
    if (msg.type === 'stream_event') {
      if (msg.parent_tool_use_id !== null) return;
      const ev = msg.event as { type: string; content_block?: { type: string }; delta?: { type: string; text?: string } };
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') emit(run, { type: 'text_start' });
      else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        emit(run, { type: 'text_delta', text: ev.delta.text });
      }
      return;
    }
    if (msg.type === 'assistant') {
      if (msg.error) emit(run, { type: 'notice', message: describeError(msg.error) });
      if (msg.parent_tool_use_id !== null) return;
      for (const block of msg.message.content as unknown as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          segments.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          usedTools = true;
          const seg: ToolSegment = {
            type: 'tool',
            id: String(block.id),
            name: String(block.name),
            summary: summarizeTool(String(block.name), block.input),
          };
          segments.push(seg);
          tools.set(seg.id, seg);
          emit(run, { type: 'tool_use', id: seg.id, name: seg.name, summary: seg.summary });
        }
      }
      return;
    }
    if (msg.type === 'user') {
      if (msg.parent_tool_use_id !== null) return;
      const content = msg.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content as unknown as Array<Record<string, unknown>>) {
        if (block.type !== 'tool_result') continue;
        const id = String(block.tool_use_id);
        const isError = block.is_error === true;
        const preview = previewResult(block.content);
        const seg = tools.get(id);
        if (seg) {
          seg.result = preview;
          seg.isError = isError;
        }
        emit(run, { type: 'tool_result', id, isError, preview });
      }
      return;
    }
    if (msg.type === 'result') {
      const ok = msg.subtype === 'success' && !msg.is_error;
      meta = { status: ok ? 'success' : 'error', durationMs: msg.duration_ms, numTurns: msg.num_turns, costUsd: msg.total_cost_usd };
      resultText = msg.subtype === 'success' ? msg.result : msg.errors?.join('\n') || msg.subtype;
    }
  };

  const consume = async (resume: string | undefined): Promise<void> => {
    const options: Options = {
      ...(await baseOptions(run.model, run.abort)),
      includePartialMessages: true,
      disallowedTools: NEEDS_HUMAN_TOOLS,
      ...(config.maxTurns ? { maxTurns: config.maxTurns } : {}),
      ...(resume ? { resume } : {}),
    };
    for await (const msg of query({ prompt: message, options })) handle(msg);
  };

  try {
    let firstError: unknown;
    try {
      await consume(sessionId);
    } catch (err) {
      firstError = err;
    }
    // Sessão antiga sumiu (ex.: volume recriado): recomeça do zero em vez de falhar.
    const failure = `${firstError instanceof Error ? firstError.message : ''}\n${meta.status === 'error' ? resultText : ''}`;
    const resumeFailed =
      sessionId !== undefined &&
      segments.length === 0 &&
      !run.abort.signal.aborted &&
      (firstError !== undefined || meta.status === 'error') &&
      /no conversation found|session.*not found|could not resume|failed to resume/i.test(failure);
    if (resumeFailed) {
      emit(run, { type: 'notice', message: 'Não consegui retomar a sessão anterior — começando uma nova com o cérebro atual.' });
      sessionId = undefined;
      meta = { status: 'error' };
      resultText = '';
      await consume(undefined);
    } else if (firstError !== undefined) throw firstError;
    if (run.abort.signal.aborted) meta = { ...meta, status: 'aborted' };
  } catch (err) {
    if (run.abort.signal.aborted) {
      meta = { ...meta, status: 'aborted' };
    } else {
      meta = { status: 'error' };
      resultText = `Erro ao executar o agente: ${(err as Error).message}`;
      console.error(`[run ${run.id}]`, err);
    }
  } finally {
    clearTimeout(timer);
  }

  if (meta.status === 'aborted') resultText = resultText || 'Tarefa interrompida.';
  if (meta.status !== 'success' && resultText) segments.push({ type: 'text', text: `⚠️ ${resultText}` });
  if (meta.status === 'success' && !segments.some((s) => s.type === 'text') && resultText) {
    segments.push({ type: 'text', text: resultText });
  }
  meta.durationMs ??= Date.now() - run.startedAt;
  assistant.meta = meta;

  await updateConversation(run.conversationId, (c) => {
    c.messages.push(assistant);
  }).catch((err) => console.error(`[run ${run.id}] falha ao salvar resposta`, err));

  run.status = meta.status;
  run.meta = meta;
  run.resultText = resultText;
  run.finishedAt = Date.now();
  emit(run, { type: 'result', status: meta.status, text: resultText, durationMs: meta.durationMs, numTurns: meta.numTurns, costUsd: meta.costUsd });

  const shouldReflect =
    meta.status === 'success' &&
    sessionId !== undefined &&
    config.brainReflect !== 'off' &&
    (config.brainReflect === 'always' || usedTools || /lembr|memoriz|esque[cç]|anot|guard[ae]|aprend/i.test(message));

  if (!shouldReflect || !sessionId) return closeRun(run);

  // A resposta já foi entregue; libera a conversa e consolida a memória em segundo plano.
  if (activeByConversation.get(run.conversationId) === run.id) activeByConversation.delete(run.conversationId);
  void reflect(run, sessionId).finally(() => closeRun(run));
}

async function reflect(run: Run, sessionId: string): Promise<void> {
  emit(run, { type: 'brain', status: 'started' });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15 * 60_000);
  try {
    let summary = '';
    const options: Options = {
      ...(await baseOptions(config.brainModel ?? run.model, abort)),
      resume: sessionId,
      forkSession: true, // não polui a conversa do usuário
      persistSession: false,
      maxTurns: 40,
      disallowedTools: REFLECTION_BLOCKED_TOOLS,
    };
    for await (const msg of query({ prompt: reflectionPrompt(), options })) {
      if (msg.type === 'result') summary = msg.subtype === 'success' ? msg.result : `consolidação falhou (${msg.subtype})`;
    }
    summary = summary.replace(/\s+/g, ' ').trim().slice(0, 300) || 'sem mudanças';
    const changed = await commitBrain(`aprendizado: ${summary}`);
    run.brainSummary = changed ? summary : `${summary} (nenhum arquivo alterado)`;
    emit(run, { type: 'brain', status: 'done', summary: run.brainSummary });
    await updateConversation(run.conversationId, (c) => {
      const m = c.messages.find((x) => x.runId === run.id && x.role === 'assistant');
      if (m?.meta) m.meta.brain = run.brainSummary;
    });
  } catch (err) {
    console.error(`[brain ${run.id}]`, err);
    emit(run, { type: 'brain', status: 'error', summary: (err as Error).message });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function summarizeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  let s: string;
  switch (name) {
    case 'Bash':
      s = str(i.command);
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      s = str(i.file_path);
      break;
    case 'NotebookEdit':
      s = str(i.notebook_path);
      break;
    case 'Glob':
    case 'Grep':
      s = str(i.pattern) + (i.path ? ` em ${str(i.path)}` : '');
      break;
    case 'WebFetch':
      s = str(i.url);
      break;
    case 'WebSearch':
      s = str(i.query);
      break;
    case 'Task':
    case 'Agent':
      s = str(i.description) || str(i.prompt);
      break;
    case 'TodoWrite':
      s = `${Array.isArray(i.todos) ? i.todos.length : 0} itens`;
      break;
    case 'Skill':
      s = str(i.skill) || str(i.command);
      break;
    default:
      s = JSON.stringify(i);
  }
  return clip(s.replace(/\s+/g, ' ').trim(), 300);
}

function previewResult(content: unknown): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b: Record<string, unknown>) => (b?.type === 'text' ? String(b.text ?? '') : b?.type === 'image' ? '[imagem]' : ''))
      .join('\n');
  }
  return clip(text, 4000);
}

function describeError(code: string): string {
  const map: Record<string, string> = {
    authentication_failed: 'Falha de autenticação com o Claude — entre de novo com a conta em Contas, no menu.',
    oauth_org_not_allowed: 'A organização desse token não tem acesso ao Claude Code.',
    billing_error: 'Problema de cobrança na conta do Claude.',
    rate_limit: 'Limite de uso da assinatura atingido — tente de novo mais tarde.',
    overloaded: 'API do Claude sobrecarregada — tentando de novo.',
    model_not_found: 'Modelo não encontrado ou indisponível nessa assinatura.',
    max_output_tokens: 'A resposta atingiu o limite de tamanho.',
  };
  return map[code] ?? `Erro do Claude: ${code}`;
}
