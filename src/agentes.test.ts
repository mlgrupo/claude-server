import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ResultadoCodex } from './codex-agente.js';
import {
  ErroDeAgente,
  escolherAgente,
  eventosDoResultadoCodex,
  executarAgente,
  type PedidoDeAgente,
} from './agentes.js';

function pedido(): PedidoDeAgente {
  return {
    id: `pedido-${Date.now()}`,
    agente: escolherAgente({ agente: 'rapido' }),
    sistema: 'Classifique o dado.',
    prompt: 'Dado da clínica.',
    imagens: [],
    origem: 'automatico',
    assunto: 'Teste',
    empresa: 'Clínica teste',
    feature: 'cadencia.temperatura',
    cliente: 'teste',
    prazo: Date.now() + 30_000,
    privado: true,
  };
}

test('roteamento HofOS recusa pedido sem assinatura Codex', async () => {
  const anterior = process.env.CODEX_HOME;
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), 'habblaud-agentes-test-'));
  try {
    process.env.CODEX_HOME = pasta;
    await assert.rejects(executarAgente(pedido()), (err: unknown) => {
      assert(err instanceof ErroDeAgente);
      assert.equal(err.status, 503);
      assert.equal(err.codigo, 'sem_assinatura_codex');
      return true;
    });
  } finally {
    if (anterior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = anterior;
    await fs.rm(pasta, { recursive: true, force: true });
  }
});

test('roteamento HofOS preserva contrato de eventos com resultado Codex', () => {
  const resposta: ResultadoCodex = {
    modelo: 'gpt-test',
    resposta: '{"ok":true}',
    structuredOutput: { ok: true },
    usage: { input_tokens: 10, output_tokens: 4 },
    eventos: [{ type: 'turn.completed', command: 'não pode vazar' }],
  };
  const eventos = eventosDoResultadoCodex(resposta) as Array<Record<string, unknown>>;
  assert.deepEqual(eventos[0], {
    type: 'system',
    subtype: 'init',
    model: 'gpt-test',
    session_id: null,
    provider: 'codex',
  });
  assert.deepEqual(eventos[1], {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '{"ok":true}',
    structured_output: { ok: true },
    usage: { input_tokens: 10, output_tokens: 4 },
  });
  assert(!JSON.stringify(eventos).includes('não pode vazar'));
});
