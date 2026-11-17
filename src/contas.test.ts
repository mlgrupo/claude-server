import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexAssinaturaAtiva } from './contas.js';

async function comCodexHome(auth: Record<string, unknown> | undefined, verificar: () => void): Promise<void> {
  const anterior = process.env.CODEX_HOME;
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), 'habblaud-contas-test-'));
  try {
    process.env.CODEX_HOME = pasta;
    if (auth) await fs.writeFile(path.join(pasta, 'auth.json'), JSON.stringify(auth));
    verificar();
  } finally {
    if (anterior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = anterior;
    await fs.rm(pasta, { recursive: true, force: true });
  }
}

test('assinatura Codex fica inativa sem auth.json', async () => {
  await comCodexHome(undefined, () => assert.equal(codexAssinaturaAtiva(), false));
});

test('assinatura Codex recusa autenticação somente por API key', async () => {
  await comCodexHome({ OPENAI_API_KEY: 'sk-test' }, () => assert.equal(codexAssinaturaAtiva(), false));
});

test('assinatura Codex aceita refresh token do ChatGPT', async () => {
  await comCodexHome(
    { tokens: { refresh_token: 'refresh-test', account_id: 'acct-test' } },
    () => assert.equal(codexAssinaturaAtiva(), true),
  );
});
