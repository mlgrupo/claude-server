import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  ErroDeAgente,
  agentesOcupados,
  executarAgente,
  iniciarLimpezaDosAgentes,
  lerPedido,
  ouvirPainel,
  painelDosAgentes,
  pararTodosOsAgentes,
} from './agentes.js';
import { login, logout, requireAgentAccess, requireAuth, requireJsonBody } from './auth.js';
import { brainHistory, initBrain, listBrainFiles, readBrainFile } from './brain.js';
import { config, hasClaudeCredentials, validateConfig } from './config.js';
import { estadoDoEscritorio, iniciarEscritorio, pararEscritorio } from './escritorio.js';
import { listFiles, sendWorkspaceFile } from './files.js';
import { HttpError, abortAll, activeRunFor, getRun, runningCount, startRun, stopRun, subscribe, type Run, type RunEvent } from './runner.js';
import { deleteConversation, getConversation, initStore, listConversations } from './store.js';
import { attachTerminal, closeAllTerminals, terminalCount } from './terminal.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function runView(run: Run) {
  return {
    runId: run.id,
    conversationId: run.conversationId,
    model: run.model,
    status: run.status,
    startedAt: new Date(run.startedAt).toISOString(),
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : undefined,
    result: run.resultText,
    meta: run.meta,
    brain: run.brainSummary,
  };
}

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

async function main(): Promise<void> {
  const problems = validateConfig();
  if (problems.length) {
    for (const p of problems) console.error(`[config] ${p}`);
    process.exit(1);
  }
  if (!hasClaudeCredentials()) {
    console.warn('[config] Nem CLAUDE_CODE_OAUTH_TOKEN nem ANTHROPIC_API_KEY definidos — o agente vai falhar ao autenticar.');
  }

  await fs.mkdir(config.workspaceDir, { recursive: true });
  await fs.mkdir(config.appDir, { recursive: true });
  await initStore();
  await initBrain();

  await fs.mkdir(config.agentesDir, { recursive: true });
  iniciarLimpezaDosAgentes();
  await iniciarEscritorio();

  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  // Os agentes recebem imagens em base64: corpo maior só nessa rota.
  const jsonPadrao = express.json({ limit: '2mb' });
  const jsonDosAgentes = express.json({ limit: '25mb' });
  app.use((req, res, next) => (req.path.startsWith('/api/v1/agentes') ? jsonDosAgentes : jsonPadrao)(req, res, next));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // ---- Público ----
  app.get('/health', (_req, res) => {
    res.json({ ok: true, running: runningCount(), agentes: agentesOcupados() });
  });
  app.post('/api/login', requireJsonBody, login);
  app.post('/api/logout', logout);

  // ---- Agentes especializados: o login completo ou o token de um sistema (CLIENT_TOKENS) ----
  const v1 = express.Router();
  v1.use(requireAgentAccess, requireJsonBody);
  v1.get('/agentes', (_req, res) => {
    res.json(painelDosAgentes());
  });
  // Síncrono: espera a resposta (com fila). 429 = sem vaga agora, siga pelo seu caminho.
  v1.post(
    '/agentes/executar',
    asyncRoute(async (req, res) => {
      try {
        const pedido = lerPedido(req.body, String(res.locals.cliente ?? 'desconhecido'));
        res.json(await executarAgente(pedido));
      } catch (err) {
        if (err instanceof ErroDeAgente) {
          return res
            .status(err.status)
            .json({ erro: err.codigo, mensagem: err.message, ...(err.eventos?.length ? { eventos: err.eventos } : {}) });
        }
        throw err;
      }
    }),
  );
  app.use('/api/v1', v1);

  // ---- Protegido ----
  const api = express.Router();
  api.use(requireAuth, requireJsonBody);

  api.get('/me', (_req, res) => {
    res.json({
      ok: true,
      model: config.model,
      effort: config.effort,
      brainReflect: config.brainReflect,
      credentials: hasClaudeCredentials(),
      running: runningCount(),
      terminal: config.terminalEnabled,
      terminals: terminalCount(),
    });
  });

  api.get('/conversations', (_req, res) => {
    res.json(listConversations());
  });

  api.get(
    '/conversations/:id',
    asyncRoute(async (req, res) => {
      const id = String(req.params.id);
      const conv = await getConversation(id);
      if (!conv) return res.status(404).json({ error: 'conversa não encontrada' });
      res.json({ ...conv, activeRunId: activeRunFor(id) });
    }),
  );

  api.delete(
    '/conversations/:id',
    asyncRoute(async (req, res) => {
      const id = String(req.params.id);
      if (activeRunFor(id)) return res.status(409).json({ error: 'pare a tarefa em andamento antes de apagar' });
      const ok = await deleteConversation(id);
      res.status(ok ? 200 : 404).json({ ok });
    }),
  );

  // Inicia uma tarefa e responde na hora; acompanhe por /runs/:id/events (SSE) ou /runs/:id.
  api.post(
    '/chat',
    asyncRoute(async (req, res) => {
      const run = await startRun({ message: req.body?.message, conversationId: req.body?.conversationId, model: req.body?.model });
      res.status(202).json({ runId: run.id, conversationId: run.conversationId });
    }),
  );

  // Síncrono: espera a resposta final. Ideal para n8n, scripts e outros sistemas.
  api.post(
    '/ask',
    asyncRoute(async (req, res) => {
      const run = await startRun({ message: req.body?.message, conversationId: req.body?.conversationId, model: req.body?.model });
      req.on('close', () => {
        if (!res.writableEnded && req.body?.stopOnDisconnect === true) stopRun(run);
      });
      await run.completion;
      res.json(runView(run));
    }),
  );

  api.get('/runs/:id', (req, res) => {
    const run = getRun(String(req.params.id));
    if (!run) return res.status(404).json({ error: 'execução não encontrada (expira 1h após terminar)' });
    res.json(runView(run));
  });

  api.post('/runs/:id/stop', (req, res) => {
    const run = getRun(String(req.params.id));
    if (!run) return res.status(404).json({ error: 'execução não encontrada' });
    stopRun(run);
    res.json({ ok: true });
  });

  api.get('/runs/:id/events', (req, res) => {
    const run = getRun(String(req.params.id));
    if (!run) return res.status(404).json({ error: 'execução não encontrada' });
    const after = Number(req.headers['last-event-id'] ?? req.query.after ?? 0) || 0;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (e: RunEvent) => res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    for (const e of run.events) if (e.seq > after) send(e);
    if (run.closed) return res.end();

    const unsubscribe = subscribe(run, (e) => {
      send(e);
      if (e.type === 'done') {
        cleanup();
        res.end();
      }
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    const cleanup = () => {
      clearInterval(ping);
      unsubscribe();
    };
    req.on('close', cleanup);
  });

  api.get(
    '/brain',
    asyncRoute(async (_req, res) => {
      res.json({ dir: config.brainDir, files: await listBrainFiles(), history: await brainHistory() });
    }),
  );

  api.get(
    '/brain/file',
    asyncRoute(async (req, res) => {
      const rel = String(req.query.path ?? '');
      const content = rel ? await readBrainFile(rel) : undefined;
      if (content === undefined) return res.status(404).json({ error: 'arquivo não encontrado' });
      res.json({ path: rel, content });
    }),
  );

  // Arquivos do workspace: o agente entrega links /api/files/raw?path=... no chat.
  api.get('/files', asyncRoute(listFiles));
  api.get('/files/raw', asyncRoute(sendWorkspaceFile));

  // Tela de Agentes: o painel ao vivo (SSE) e o endereço do escritório.
  api.get('/agentes', (_req, res) => {
    res.json({ ...painelDosAgentes(), escritorio: estadoDoEscritorio() });
  });
  api.get('/agentes/eventos', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const enviar = () => res.write(`data: ${JSON.stringify({ ...painelDosAgentes(), escritorio: estadoDoEscritorio() })}\n\n`);
    enviar();
    const parar = ouvirPainel(enviar);
    // Os cronômetros de quem está rodando andam mesmo sem evento novo.
    const relogio = setInterval(enviar, 5_000);
    req.on('close', () => {
      parar();
      clearInterval(relogio);
    });
  });

  app.use('/api', api);
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '5m' }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    // Corpo que não é JSON ou passou do limite: erro de quem chamou, não do servidor.
    const tipo = (err as { type?: string } | null)?.type;
    if (tipo === 'entity.parse.failed') return res.status(400).json({ error: 'corpo não é JSON válido', erro: 'json_invalido' });
    if (tipo === 'entity.too.large') return res.status(413).json({ error: 'corpo grande demais', erro: 'pedido_grande' });
    console.error('[http]', err);
    if (!res.headersSent) res.status(500).json({ error: 'erro interno' });
  });

  const server = app.listen(config.port, () => {
    console.log(`Habblaud ouvindo na porta ${config.port} — modelo ${config.model}, dados em ${config.dataDir}`);
  });
  server.requestTimeout = 0; // /api/ask e SSE podem durar muito
  server.headersTimeout = 65_000;
  attachTerminal(server); // WebSocket em /api/terminal

  const shutdown = (signal: string) => {
    console.log(`[${signal}] encerrando — interrompendo tarefas em andamento`);
    abortAll();
    pararTodosOsAgentes();
    pararEscritorio();
    closeAllTerminals();
    server.close();
    setTimeout(() => process.exit(0), 8_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
