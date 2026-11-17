# HofOS via assinatura do Codex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer todo pedido do HofOS que chega a `/api/v1/agentes/executar` executar exclusivamente no Codex com a assinatura ChatGPT ativa, sem fallback e sem expor ferramentas ou arquivos do servidor.

**Architecture:** Um adaptador novo executará `codex exec` de forma efêmera, sem ferramentas e dentro de um diretório temporário vazio. `src/agentes.ts` manterá fila, idempotência e métricas, mas delegará inferência ao adaptador e converterá a resposta para o contrato de eventos que o HofOS já consome.

**Tech Stack:** Node.js 22, TypeScript 7, `node:child_process`, Codex CLI 0.169.0, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-16-hofos-codex-assinatura-design.md`

## Global Constraints

- O executor aceita apenas autenticação ChatGPT/Codex; `OPENAI_API_KEY` deve ser recusada.
- Nenhum pedido do HofOS pode cair silenciosamente em Claude ou API.
- URL, autenticação, campos do pedido, filas, idempotência e envelope da resposta permanecem compatíveis.
- Cada execução deve ser efêmera e não pode oferecer shell, busca, apps, plugins, MCPs, browser, computador ou subagentes.
- Arquivos temporários devem ter permissão privada e ser removidos em sucesso, erro, cancelamento e timeout.
- `AGENTES_CODEX_MODEL` é opcional; sem ele vale o modelo padrão da assinatura.

## Review Focus

- `auth.json` válido mas contendo somente `OPENAI_API_KEY`: responder 503 `sem_assinatura_codex`, sem iniciar processo.
- JSONL com linhas parciais ou evento final ausente: responder 502 e preservar eventos válidos para diagnóstico.
- Cancelamento/timeout durante geração: encerrar o processo e apagar imagens, esquema e resposta temporários.
- JSON estruturado inválido apesar de exit code zero: responder 502, nunca devolver texto como `structured_output` válido.
- Troca de conta Codex durante pedido em execução: responder 409 e manter a credencial da execução intacta.

---

### Task 1: Test harness e detecção da assinatura Codex

**Files:**
- Modify: `package.json`
- Modify: `src/contas.ts`
- Create: `src/contas.test.ts`

**Interfaces:**
- Consumes: `identificar('codex', origemViva('codex'))` e `binarioDe('codex')` existentes.
- Produces: `codexAssinaturaAtiva(): boolean`, usada pelo executor e pelo painel.

- [ ] **Step 1: Adicionar o comando de testes**

Definir `scripts.test` como `tsx --test src/*.test.ts` sem adicionar dependências.

- [ ] **Step 2: Escrever testes inicialmente falhos para `codexAssinaturaAtiva()`**

Em `src/contas.test.ts`, isolar `CODEX_HOME` em pasta temporária e verificar:

```ts
assert.equal(codexAssinaturaAtiva(), false); // sem auth.json
assert.equal(codexAssinaturaAtiva(), false); // auth.json somente com OPENAI_API_KEY
assert.equal(codexAssinaturaAtiva(), true);  // tokens.refresh_token de ChatGPT
```

Cada teste restaura a variável de ambiente e apaga a pasta no `finally`.

- [ ] **Step 3: Rodar o teste e confirmar a falha esperada**

Run: `npm test -- --test-name-pattern="assinatura Codex"`
Expected: FAIL porque `codexAssinaturaAtiva` ainda não existe.

- [ ] **Step 4: Implementar `codexAssinaturaAtiva(): boolean`**

Em `src/contas.ts`, retornar `true` somente quando `identificar('codex', origemViva('codex'))` existir e seu plano não for `Chave da API`.

- [ ] **Step 5: Rodar os testes**

Run: `npm test`
Expected: PASS nos três cenários.

- [ ] **Step 6: Commit**

```bash
git add package.json src/contas.ts src/contas.test.ts
git commit -m "test: detect active Codex subscription"
```

### Task 2: Executor Codex efêmero e sem ferramentas

**Files:**
- Create: `src/codex-agente.ts`
- Create: `src/codex-agente.test.ts`
- Modify: `src/config.ts`

**Interfaces:**
- Consumes: `binarioDe('codex')`, `origemViva('codex').pasta`, `config.agentesDir`, `config.agentesCodexModel`.
- Produces: `executarNoCodex(pedido: PedidoCodex, signal: AbortSignal, deps?: DependenciasCodex): Promise<ResultadoCodex>`; exporta também `comporPromptCodex`, `argumentosCodex` e `converterJsonlCodex` para testes puros.

- [ ] **Step 1: Escrever testes inicialmente falhos das funções puras**

Cobrir em `src/codex-agente.test.ts`:

```ts
assert.match(comporPromptCodex({ sistema: 'REGRA', prompt: 'DADO' }), /REGRA[\s\S]*DADO/);
assert(argumentosCodex(...).includes('--ephemeral'));
assert(argumentosCodex(...).includes('shell_tool') && argumentosCodex(...).includes('--disable'));
assert.equal(converterJsonlCodex(jsonl).resposta, 'ok');
assert.deepEqual(converterJsonlCodex(jsonlComUsage).usage, { input_tokens: 10, output_tokens: 4 });
```

O teste de argumentos também exige `--ignore-user-config`, `--ignore-rules`, `--sandbox read-only`, `web_search="disabled"`, `--output-last-message` e os desligamentos de apps, plugins, browser, computador e multiagente.

- [ ] **Step 2: Rodar os testes e confirmar a falha esperada**

Run: `npm test -- --test-name-pattern="Codex"`
Expected: FAIL porque `src/codex-agente.ts` ainda não existe.

- [ ] **Step 3: Implementar os tipos e funções puras**

Criar:

```ts
export interface PedidoCodex { id: string; sistema: string; prompt: string; esquema?: Record<string, unknown>; imagens: Array<{ mime: string; base64: string }>; limiteMs: number; }
export interface ResultadoCodex { modelo: string; resposta: string; structuredOutput?: unknown; usage?: Record<string, number>; eventos: unknown[]; }
export interface DependenciasCodex { binario?: string; prefixoArgs?: string[]; agentesDir?: string; }
export function comporPromptCodex(pedido: Pick<PedidoCodex, 'sistema' | 'prompt'>): string;
export function argumentosCodex(arquivos: ArquivosTemporarios, modelo?: string): string[];
export function converterJsonlCodex(jsonl: string, resposta: string, esquema?: Record<string, unknown>): ResultadoCodex;
export function executarNoCodex(pedido: PedidoCodex, signal: AbortSignal, deps?: DependenciasCodex): Promise<ResultadoCodex>;
```

`converterJsonlCodex` deve extrair o modelo e usage quando existirem, rejeitar ausência de conclusão e fazer `JSON.parse` da resposta quando houver esquema.

- [ ] **Step 4: Implementar `executarNoCodex` com ambiente mínimo**

Criar diretório com `fs.mkdtemp` dentro de `config.agentesDir`, materializar esquema/imagens com modo `0o600`, iniciar o binário com `spawn` sem shell e enviar o prompt por stdin. O `env` deve conter apenas variáveis operacionais necessárias (`PATH`, `HOME`, `CODEX_HOME`, locale e temporários), nunca `GH_TOKEN` ou segredos do servidor.

- [ ] **Step 5: Escrever testes de integração com binário falso**

Injetar `process.execPath` em `deps.binario`, um fixture `.mjs` em `deps.prefixoArgs` e uma pasta temporária em `deps.agentesDir`. Verificar sucesso, exit code não zero, abort, JSON estruturado inválido e remoção da pasta temporária em todos os casos. O fixture grava JSONL e a última resposta nos caminhos recebidos sem fazer rede.

- [ ] **Step 6: Rodar os testes**

Run: `npm test`
Expected: PASS, sem processo real do Codex e sem consumo da assinatura.

- [ ] **Step 7: Commit**

```bash
git add src/codex-agente.ts src/codex-agente.test.ts src/config.ts
git commit -m "feat: add isolated Codex subscription executor"
```

### Task 3: Ligar a fila do HofOS ao Codex

**Files:**
- Modify: `src/agentes.ts`
- Create: `src/agentes.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `codexAssinaturaAtiva()` e `executarNoCodex(...)` das Tasks 1 e 2.
- Produces: o mesmo `executarAgente(pedido): Promise<RespostaDeAgente>` já consumido por `src/server.ts`, `agentesOcupados()` para bloquear troca de conta e `eventosDoResultadoCodex(resultado: ResultadoCodex): unknown[]` para conversão testável do contrato.

- [ ] **Step 1: Escrever testes falhos do roteamento**

Usar `executarAgente` com `CODEX_HOME` temporário sem login para testar a recusa antes de spawn, e `eventosDoResultadoCodex` para testar o contrato de sucesso:

```ts
await assert.rejects(executarAgente(pedido), (e: ErroDeAgente) => e.status === 503 && e.codigo === 'sem_assinatura_codex');
assert.equal(resposta.eventos[0].type, 'system');
assert.equal(resultado.type, 'result');
assert.equal(resultado.result, 'resposta Codex');
assert.deepEqual(resultado.structured_output, { ok: true });
```

Os testes de JSONL final ausente, cancelamento e timeout pertencem ao adaptador da Task 2; aqui verificar também que nenhum evento gerado contém comandos ou dados do ambiente.

- [ ] **Step 2: Rodar os testes e confirmar que ainda usam o caminho Claude**

Run: `npm test -- --test-name-pattern="roteamento HofOS"`
Expected: FAIL com credencial/execução Claude atual.

- [ ] **Step 3: Substituir a execução Claude pela execução Codex**

Remover o uso de `@anthropic-ai/claude-agent-sdk` de `src/agentes.ts`. Em `admitir`, exigir binário e assinatura Codex. Em `rodar`, chamar `executarNoCodex`, converter sua resposta para eventos `system/init` e `result`, preservar métricas, fila, idempotência, imagens e timeout existentes.

- [ ] **Step 4: Bloquear troca de conta Codex durante agentes ativos**

Em `src/server.ts`, fazer `/contas/codex/:id/usar` retornar 409 quando `agentesOcupados() > 0`, com mensagem para aguardar os pedidos do HofOS.

- [ ] **Step 5: Rodar os testes e typecheck**

Run: `npm test`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/agentes.ts src/agentes.test.ts src/server.ts
git commit -m "feat: route HofOS agents through Codex subscription"
```

### Task 4: Configuração, painel e documentação

**Files:**
- Modify: `.env.example`
- Modify: `src/config.ts`
- Modify: `src/server.ts`
- Modify: `public/app.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: `codexAssinaturaAtiva()` e `config.agentesCodexModel`.
- Produces: painel e documentação coerentes com `assinatura_codex | sem_assinatura_codex`.

- [ ] **Step 1: Escrever teste falho do estado do painel**

Adicionar em `src/agentes.test.ts` casos que esperam `painelDosAgentes().credencial` igual a `assinatura_codex` ou `sem_assinatura_codex`, nunca `chave_da_api`.

- [ ] **Step 2: Atualizar configuração e painel**

Ler `AGENTES_CODEX_MODEL` em `src/config.ts` e remover `AGENTES_ANTHROPIC_API_KEY` do controle dos agentes. Manter o nome legado em `SERVER_ONLY_SECRETS` para que uma variável ainda configurada no Railway continue protegida e nunca seja repassada a processos. Atualizar `painelDosAgentes()` e `contasComAgentes()` para a credencial Codex.

- [ ] **Step 3: Atualizar textos da interface**

Trocar as mensagens que dizem que os agentes usam chave da API por textos que informem a assinatura Codex ativa, seus limites compartilhados e a ausência de fallback.

- [ ] **Step 4: Atualizar README e `.env.example`**

Documentar Codex-only, `AGENTES_CODEX_MODEL`, erros `sem_assinatura_codex`, execução sem ferramentas e necessidade de apontar todas as chamadas do HofOS para o endpoint. Remover instruções que ainda atribuam agentes à chave Anthropic.

- [ ] **Step 5: Executar verificação completa**

Run: `npm test`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm run build`
Expected: exit 0 e `dist/codex-agente.js` gerado.

- [ ] **Step 6: Conferir o diff e segredos**

Run: `git diff --check`
Expected: sem erros.

Run: `rg -n "AGENTES_ANTHROPIC_API_KEY|ANTHROPIC_API_KEY: config.agentesApiKey|sem_chave_da_api" src public README.md .env.example`
Expected: nenhuma referência ativa ao caminho antigo dos agentes.

- [ ] **Step 7: Commit**

```bash
git add .env.example src/config.ts src/server.ts public/app.js README.md docs/superpowers/specs/2026-11-16-hofos-codex-assinatura-design.md docs/superpowers/plans/2026-11-16-hofos-codex-assinatura.md
git commit -m "docs: describe Codex-only HofOS routing"
```
