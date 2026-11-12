# Habblaud — servidor autônomo do Claude

Servidor que roda o Claude (via [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)) num container no Railway, acessível por chat web e por API em **https://claude-server-production-bf2fccdc.up.railway.app** (domínio próprio a definir).

- **Autônomo:** roda em modo `bypassPermissions` e nunca pede aprovação. Ferramentas que dependem de um humano (perguntas, modo plano) ficam desligadas.
- **Cérebro que aprende:** depois de cada tarefa, um fork da sessão revisa o que aconteceu e grava os aprendizados em `/data/brain` (notas em markdown + índice + diário), versionado com git. O índice entra no prompt de toda conversa nova.
- **Persistente:** conversas, sessões do Claude, cérebro, skills e workspace ficam no volume `/data`.

## Como funciona

```
navegador / n8n / scripts
        │  HTTPS (senha ou Bearer token)
        ▼
Express (src/server.ts) ──► runner (src/runner.ts) ──► Agent SDK ──► Claude Code (subprocesso)
        │                         │                                      │
        │ SSE com eventos ao vivo │ ao terminar: fork da sessão          │ cwd: /data/workspace
        ▼                         ▼ "consolidação de memória"            ▼
   public/ (UI)             /data/brain  (INDEX.md, notas/, diario.md, .git)
```

| Caminho | O que guarda |
|---|---|
| `/data/workspace` | diretório de trabalho do agente (repositórios, projetos) |
| `/data/brain` | memória de longo prazo (versionada com git) |
| `/data/home` | HOME do usuário `node`: `~/.claude` (sessões, skills), gitconfig, `~/.local`, `~/.npm-global` |
| `/data/app` | conversas do chat |

O container roda como usuário `node` (o Claude Code recusa o modo bypass como root), com `sudo` sem senha.

## Deploy no Railway

1. **Gere o token da assinatura** na sua máquina (com o Claude Code instalado):
   ```sh
   claude setup-token
   ```
   Copie o token gerado (vale 1 ano).
2. No Railway, crie um serviço a partir deste repositório (o `railway.json` já aponta para o `Dockerfile`).
3. **Adicione um volume** montado em `/data` (sem ele, tudo some a cada deploy).
4. **Variáveis** (veja `.env.example`): `APP_PASSWORD`, `API_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`. Opcional: `GH_TOKEN` para o agente usar o GitHub.
5. **Domínio próprio (opcional):** em *Settings → Networking → Custom Domain*, adicione o domínio (ex.: `app.habblaud.com`) e crie na Cloudflare o CNAME indicado pelo Railway. Atenção: `habblaud.com` (raiz) hoje serve a landing page do Habblaud.

## API

Todas as rotas `/api/*` exigem `Authorization: Bearer $API_TOKEN` (ou o cookie do login web).

**Síncrono** — espera a resposta final (bom para n8n e scripts):
```sh
curl -X POST https://claude-server-production-bf2fccdc.up.railway.app/api/ask \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"message": "Liste os repositórios em /data/workspace"}'
```
Resposta: `{ runId, conversationId, status, result, meta, brain }`. Mande o `conversationId` de volta para continuar a mesma conversa.

**Assíncrono** — para tarefas longas:
```sh
# inicia
curl -X POST https://claude-server-production-bf2fccdc.up.railway.app/api/chat -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" -d '{"message": "..."}'
# → { "runId": "...", "conversationId": "..." }

curl https://claude-server-production-bf2fccdc.up.railway.app/api/runs/<runId> -H "Authorization: Bearer $API_TOKEN"          # status/resultado
curl -N https://claude-server-production-bf2fccdc.up.railway.app/api/runs/<runId>/events -H "Authorization: Bearer $API_TOKEN" # eventos ao vivo (SSE)
curl -X POST https://claude-server-production-bf2fccdc.up.railway.app/api/runs/<runId>/stop -H "Authorization: Bearer $API_TOKEN"
```

Corpo aceito em `/api/ask` e `/api/chat`: `message` (obrigatório), `conversationId`, `model` (ex.: `claude-sonnet-5-5`).

Outras rotas: `GET /api/conversations`, `GET|DELETE /api/conversations/:id`, `GET /api/brain`, `GET /api/brain/file?path=INDEX.md`, `GET /health` (pública).

## Desenvolvimento local

```sh
npm install
cp .env.example .env   # preencha APP_PASSWORD e API_TOKEN
DATA_DIR=./data APP_PASSWORD=... API_TOKEN=... npm run dev
```
Localmente, sem `CLAUDE_CODE_OAUTH_TOKEN`, o SDK usa o login do Claude Code da sua máquina.

## Segurança

Este servidor executa qualquer comando sem aprovação e fica exposto na internet. Na prática, **a senha e o API token dão um shell no servidor** e acesso às credenciais configuradas nele.

- Use senha e token longos e aleatórios; troque se vazarem (trocar `APP_PASSWORD` derruba todas as sessões web).
- `APP_PASSWORD`, `API_TOKEN` e `SESSION_SECRET` não são repassadas ao agente. As demais variáveis (`CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`…) são visíveis para ele.
- Conteúdo da web que o agente lê pode tentar manipulá-lo (prompt injection). Dê ao `GH_TOKEN` e a outras credenciais só as permissões necessárias.
- O login tem limite de 10 tentativas a cada 15 minutos por IP.

**Assinatura vs. API:** o token de `claude setup-token` usa os limites da sua assinatura Pro/Max — serve para uso próprio e da sua equipe. Para oferecer o agente a clientes ou terceiros, os termos da Anthropic exigem `ANTHROPIC_API_KEY`.
