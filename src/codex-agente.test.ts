import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  argumentosCodex,
  comporPromptCodex,
  converterJsonlCodex,
  ErroCodex,
  executarNoCodex,
  type ArquivosTemporarios,
  type PedidoCodex,
} from './codex-agente.js';

const fixture = fileURLToPath(new URL('./test-fixtures/fake-codex.mjs', import.meta.url));

const arquivos: ArquivosTemporarios = {
  cwd: '/tmp/pedido',
  resposta: '/tmp/pedido/resposta.txt',
  esquema: '/tmp/pedido/esquema.json',
  imagens: ['/tmp/pedido/imagem-0.png'],
};

test('Codex separa instrução de sistema do conteúdo recebido', () => {
  const prompt = comporPromptCodex({ sistema: 'REGRA DA EMPRESA', prompt: 'DADO DA CLÍNICA' });
  assert.match(prompt, /INSTRUÇÕES DO SISTEMA[\s\S]*REGRA DA EMPRESA/);
  assert.match(prompt, /CONTEÚDO DO PEDIDO[\s\S]*DADO DA CLÍNICA/);
});

test('Codex é iniciado efêmero e sem ferramentas locais ou remotas', () => {
  const args = argumentosCodex(arquivos, 'gpt-test');
  for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) {
    assert(args.includes(flag), `faltou ${flag}`);
  }
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert(args.includes('web_search="disabled"'));
  for (const recurso of ['shell_tool', 'apps', 'plugins', 'browser_use', 'computer_use', 'multi_agent']) {
    const i = args.indexOf(recurso);
    assert(i > 0 && args[i - 1] === '--disable', `${recurso} não foi desligado`);
  }
  assert(args.includes('--output-last-message'));
  assert(args.includes('--output-schema'));
  assert(args.includes('--image'));
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gpt-test']);
  assert.equal(args.at(-1), '-');
});

test('Codex converte JSONL concluído e contabiliza tokens', () => {
  const jsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1', model: 'gpt-test' }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 4 } }),
  ].join('\n');
  const resultado = converterJsonlCodex(jsonl, 'ok');
  assert.equal(resultado.resposta, 'ok');
  assert.equal(resultado.modelo, 'gpt-test');
  assert.deepEqual(resultado.usage, { input_tokens: 10, output_tokens: 4 });
  assert.equal(resultado.eventos.length, 2);
});

test('Codex exige evento final de conclusão', () => {
  assert.throws(() => converterJsonlCodex(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }), 'incompleta'),
    (err: unknown) => {
      assert(err instanceof ErroCodex);
      assert.match(err.message, /sem evento turn\.completed/);
      assert.deepEqual(err.eventos, [{ type: 'thread.started', thread_id: 'thread-1' }]);
      return true;
    });
});

test('Codex preserva eventos válidos anteriores a uma linha JSONL truncada', () => {
  const primeiro = { type: 'thread.started', thread_id: 'thread-1', model: 'gpt-test' };
  assert.throws(() => converterJsonlCodex(`${JSON.stringify(primeiro)}\n{"type":`, 'incompleta'), (err: unknown) => {
    assert(err instanceof ErroCodex);
    assert.match(err.message, /JSONL inválido/);
    assert.deepEqual(err.eventos, [primeiro]);
    return true;
  });
});

test('Codex rejeita resposta estruturada que não seja JSON válido', () => {
  const jsonl = JSON.stringify({ type: 'turn.completed', usage: {} });
  assert.throws(() => converterJsonlCodex(jsonl, 'não-json', { type: 'object' }), /JSON estruturado inválido/);
});

function pedido(esquema?: Record<string, unknown>): PedidoCodex {
  return {
    id: 'pedido-teste',
    sistema: 'Responda objetivamente.',
    prompt: 'Analise este dado.',
    esquema,
    imagens: [],
    limiteMs: 30_000,
  };
}

test('executor Codex usa processo real controlado e remove arquivos temporários', async () => {
  const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'habblaud-codex-test-'));
  try {
    const resultado = await executarNoCodex(pedido({ type: 'object' }), new AbortController().signal, {
      binario: process.execPath,
      prefixoArgs: [fixture, 'success'],
      agentesDir: raiz,
    });
    assert.equal(resultado.resposta, '{"ok":true}');
    assert.deepEqual(resultado.structuredOutput, { ok: true });
    assert.deepEqual(await fs.readdir(raiz), []);
  } finally {
    await fs.rm(raiz, { recursive: true, force: true });
  }
});

test('executor Codex cancela processo e remove arquivos temporários', async () => {
  const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'habblaud-codex-abort-test-'));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 100);
  try {
    await assert.rejects(
      executarNoCodex(pedido(), abort.signal, {
        binario: process.execPath,
        prefixoArgs: [fixture, 'hang'],
        agentesDir: raiz,
      }),
      /cancelada/,
    );
    assert.deepEqual(await fs.readdir(raiz), []);
  } finally {
    clearTimeout(timer);
    await fs.rm(raiz, { recursive: true, force: true });
  }
});

test('executor Codex não inicia subprocesso se for cancelado durante a preparação', async () => {
  const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'habblaud-codex-prep-abort-test-'));
  const abort = new AbortController();
  try {
    await assert.rejects(
      executarNoCodex(pedido(), abort.signal, {
        binario: 'binario-que-nao-deve-ser-iniciado',
        agentesDir: raiz,
        prepararArquivos: async (_pedido, cwd) => {
          abort.abort();
          return { cwd, resposta: path.join(cwd, 'resposta.txt'), imagens: [] };
        },
      }),
      /cancelada/,
    );
    assert.deepEqual(await fs.readdir(raiz), []);
  } finally {
    await fs.rm(raiz, { recursive: true, force: true });
  }
});

test('executor Codex trata erro de stdin quando o subprocesso encerra cedo', async () => {
  const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'habblaud-codex-stdin-test-'));
  const grande = pedido();
  grande.prompt = 'x'.repeat(900_000);
  try {
    await assert.rejects(
      executarNoCodex(grande, new AbortController().signal, {
        binario: process.execPath,
        prefixoArgs: [fixture, 'exit-early'],
        agentesDir: raiz,
      }),
      /código 7|stdin/i,
    );
    assert.deepEqual(await fs.readdir(raiz), []);
  } finally {
    await fs.rm(raiz, { recursive: true, force: true });
  }
});

test('executor Codex classifica falha de autenticação e preserva eventos', async () => {
  const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'habblaud-codex-auth-test-'));
  try {
    await assert.rejects(
      executarNoCodex(pedido(), new AbortController().signal, {
        binario: process.execPath,
        prefixoArgs: [fixture, 'auth-error'],
        agentesDir: raiz,
      }),
      (err: unknown) => {
        assert(err instanceof ErroCodex);
        assert.equal(err.tipo, 'autenticacao');
        assert.equal(err.eventos.length, 1);
        return true;
      },
    );
  } finally {
    await fs.rm(raiz, { recursive: true, force: true });
  }
});

test('executor Codex aplica o prazo absoluto durante a leitura da resposta', async () => {
  const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'habblaud-codex-read-timeout-test-'));
  const limitado = pedido();
  limitado.limiteMs = 1_000;
  try {
    await assert.rejects(
      executarNoCodex(limitado, new AbortController().signal, {
        binario: process.execPath,
        prefixoArgs: [fixture, 'success'],
        agentesDir: raiz,
        lerResposta: (_arquivo, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('leitura interrompida')), { once: true });
          }),
      }),
      /excedeu o limite/,
    );
  } finally {
    await fs.rm(raiz, { recursive: true, force: true });
  }
});

test('executor Codex observa cancelamento durante a leitura da resposta', async () => {
  const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'habblaud-codex-read-abort-test-'));
  const abort = new AbortController();
  let avisarLeitura!: () => void;
  const leituraIniciada = new Promise<void>((resolve) => (avisarLeitura = resolve));
  try {
    const execucao = executarNoCodex(pedido(), abort.signal, {
      binario: process.execPath,
      prefixoArgs: [fixture, 'success'],
      agentesDir: raiz,
      lerResposta: (_arquivo, signal) =>
        new Promise((_resolve, reject) => {
          avisarLeitura();
          signal.addEventListener('abort', () => reject(new Error('leitura interrompida')), { once: true });
        }),
    });
    await leituraIniciada;
    abort.abort();
    await assert.rejects(execucao, /cancelada/);
  } finally {
    await fs.rm(raiz, { recursive: true, force: true });
  }
});

test('executor Codex preserva JSONL válido quando a resposta final está ausente', async () => {
  const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'habblaud-codex-missing-response-test-'));
  try {
    await assert.rejects(
      executarNoCodex(pedido(), new AbortController().signal, {
        binario: process.execPath,
        prefixoArgs: [fixture, 'missing-response-no-final'],
        agentesDir: raiz,
      }),
      (err: unknown) => {
        assert(err instanceof ErroCodex);
        assert.match(err.message, /sem evento turn\.completed/);
        assert.equal(err.eventos.length, 1);
        return true;
      },
    );
  } finally {
    await fs.rm(raiz, { recursive: true, force: true });
  }
});
