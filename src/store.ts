import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export interface TextSegment {
  type: 'text';
  text: string;
}
export interface ToolSegment {
  type: 'tool';
  id: string;
  name: string;
  summary: string;
  result?: string;
  isError?: boolean;
}
export type Segment = TextSegment | ToolSegment;

export interface RunMeta {
  status: 'success' | 'error' | 'aborted';
  durationMs?: number;
  numTurns?: number;
  costUsd?: number;
  brain?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  createdAt: string;
  runId?: string;
  text?: string; // mensagem do usuário
  segments?: Segment[]; // resposta do agente
  meta?: RunMeta;
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
}

export interface Conversation extends ConversationMeta {
  messages: ChatMessage[];
}

const convDir = () => path.join(config.appDir, 'conversations');
const indexFile = () => path.join(config.appDir, 'conversations.json');
const ID_RE = /^[a-z0-9-]{8,64}$/;

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}

// ---- Locks por chave: cada conversa (e o índice) é escrita uma operação por vez ----
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

let index: ConversationMeta[] = [];

export async function initStore(): Promise<void> {
  await fs.mkdir(convDir(), { recursive: true });
  try {
    index = JSON.parse(await fs.readFile(indexFile(), 'utf8'));
  } catch {
    index = [];
  }
}

function persistIndex(): Promise<void> {
  return withLock('__index__', () => writeAtomic(indexFile(), JSON.stringify(index, null, 2))).catch((err) => {
    console.error('[store] falha ao salvar índice', err);
  });
}

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

export function listConversations(): ConversationMeta[] {
  return [...index].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  if (!isValidId(id)) return undefined;
  try {
    return JSON.parse(await fs.readFile(path.join(convDir(), `${id}.json`), 'utf8'));
  } catch {
    return undefined;
  }
}

async function writeConversation(conv: Conversation): Promise<void> {
  conv.updatedAt = new Date().toISOString();
  await writeAtomic(path.join(convDir(), `${conv.id}.json`), JSON.stringify(conv, null, 2));
  const meta: ConversationMeta = {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    sessionId: conv.sessionId,
  };
  const i = index.findIndex((c) => c.id === conv.id);
  if (i === -1) index.push(meta);
  else index[i] = meta;
  await persistIndex();
}

export function createConversation(firstMessage: string): Promise<Conversation> {
  const now = new Date().toISOString();
  const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 70) || 'Nova conversa';
  const conv: Conversation = { id: crypto.randomUUID(), title, createdAt: now, updatedAt: now, messages: [] };
  return withLock(conv.id, async () => {
    await writeConversation(conv);
    return conv;
  });
}

/** Lê a versão mais recente do disco, aplica a mudança e salva — sem corrida entre escritores. */
export function updateConversation(id: string, mutate: (conv: Conversation) => void): Promise<Conversation> {
  return withLock(id, async () => {
    const conv = await getConversation(id);
    if (!conv) throw new Error(`conversa ${id} não encontrada`);
    mutate(conv);
    await writeConversation(conv);
    return conv;
  });
}

export function deleteConversation(id: string): Promise<boolean> {
  if (!isValidId(id)) return Promise.resolve(false);
  return withLock(id, async () => {
    const i = index.findIndex((c) => c.id === id);
    if (i === -1) return false;
    index.splice(i, 1);
    await fs.rm(path.join(convDir(), `${id}.json`), { force: true });
    await persistIndex();
    return true;
  });
}
