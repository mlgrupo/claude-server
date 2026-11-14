# Habblaud — servidor autônomo do Claude

Servidor que roda o Claude (via [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)) num container no Railway, acessível por chat web e por API em **https://claude-server-production-bf2fccdc.up.railway.app** (domínio próprio a definir).

- **Autônomo:** roda em modo `bypassPermissions` e nunca pede aprovação. Ferramentas que dependem de um humano (perguntas, modo plano) ficam desligadas.
- **Cérebro que aprende:** depois de cada tarefa, um fork da sessão revisa o que aconteceu e grava os aprendizados em `/data/brain` (notas em markdown + índice + diário), versionado com git. O índice entra no prompt de toda conversa nova.
- **Persistente:** conversas, sessões do Claude, cérebro, skills e workspace ficam no volume `/data`.
- **Terminal no navegador:** um shell `bash` no container, pelo menu *Terminal* da interface.
- **Agentes especializados:** outros sistemas (o HofOS, por exemplo) chamam o Claude por HTTP em `POST /api/v1/agentes/executar`. Pedido rápido vai para o agente rápido (Haiku), que responde e encerra; o que pede qualidade vai para o estrategista (Opus).
- **Escritório:** o [Habblaud](https://github.com/marmottajr/habblaud) (pixel art, MIT) mostra cada agente trabalhando ao vivo, num endereço próprio com login.

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

## Terminal

O item **Terminal** na barra lateral abre um shell `bash` no container, como usuário `node` (com `sudo`), começando em `/data/workspace`. É o mesmo ambiente do agente: as senhas do servidor (`APP_PASSWORD`, `API_TOKEN`, `SESSION_SECRET`) não aparecem nele.

- **A sessão sobrevive à conexão:** se a página fechar ou a rede cair, o shell continua rodando. Ao voltar, a tela recente é reconstruída. Outra aba ou outro aparelho entra na mesma sessão.
- **Encerramento:** sem ninguém conectado por 60 minutos (`TERMINAL_IDLE_MIN`), o shell é finalizado. Para tarefas mais longas, use `tmux` (já instalado) ou `nohup`. Um deploy novo também encerra o shell, porque reinicia o container.
- **Copiar e colar:** Ctrl+C com texto selecionado copia; sem seleção, interrompe o comando. Ctrl+V cola.
- **Celular:** uma fileira de teclas extras (Esc, Tab, Ctrl, setas e ^C) aparece embaixo do terminal.
- **Desligar:** `TERMINAL=off`.

Só o que fica em `/data` persiste entre deploys (veja a tabela acima).

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

## Agentes especializados

Para outros sistemas usarem o Claude do servidor. Cada agente é um Claude Code **sem ferramenta nenhuma** (o texto que chega no prompt, como a mensagem de um lead, não consegue mexer em nada no servidor), com modelo, esforço e vagas próprios:

| Agente | Modelo | Para quê | Vagas | Teto |
|---|---|---|---|---|
| `rapido` | Haiku | temperatura, classificação, extrações e JSON curtos | 4 | 2 min |
| `analista` | Sonnet | resumos e análises de conversa, call, atendimento | 3 | 5 min |
| `estrategista` | Opus, esforço alto | roteiros, campanhas, newsletter, blog, relatórios | 2 | 10 min |
| `hofos-ai` | Sonnet | o chat da equipe no HofOS | 3 | 5 min |
| `editor-de-video` | Opus, esforço alto | plano e ajustes do editor de vídeo do HofOS | 2 | 10 min |

```sh
curl -X POST https://claude-server-production-bf2fccdc.up.railway.app/api/v1/agentes/executar \
  -H "Authorization: Bearer $TOKEN_DO_SISTEMA" -H "Content-Type: application/json" \
  -d '{
    "feature": "cadencia.temperatura",
    "sistema": "Você classifica a temperatura do lead.",
    "prompt": "Lead: quero agendar ainda esta semana, qual o valor?",
    "esquema": {"type":"object","properties":{"temperatura":{"type":"string","enum":["fria","morna","quente"]}},"required":["temperatura"]},
    "origem": "automatico",
    "assunto": "Temperatura do lead",
    "empresa": "Reconecta Vendas"
  }'
```

- **Quem atende:** `agente` explícito, senão pela função (`feature`, os rótulos do HofOS: `roteiros.*` → estrategista, `conversa.resumo` → analista, `cadencia.*` → rápido…), senão pelo porte (`nivel`: `rapido` | `forte`). Pedido forte nunca cai no rápido.
- **Corpo:** `prompt` (obrigatório), `sistema`, `esquema` (JSON Schema: a resposta volta em `structured_output`), `imagens` (`[{mime, base64}]`, até 8 e 15 MB), `limiteSegundos`, `origem` (`tela` passa na frente de `automatico`), `assunto`, `empresa` (rótulos do painel; nunca o conteúdo).
- **Resposta (200):** `{ id, agente, modelo, esperaMs, duracaoMs, eventos }`. `eventos` são os mesmos do `claude -p --output-format stream-json`: `system/init`, `rate_limit_event` e `result` (com `result`, `structured_output` e `usage`).
- **Sem vaga agora (429):** `fila_cheia`, `fila_demorada` ou `assinatura_no_limite`. Siga pelo seu caminho (API, outra fila). A fila automática de cada agente aceita até 2× as vagas; pedidos automáticos param quando a assinatura passa de 70% da janela, e os de tela, de 95%, para sobrar assinatura para a equipe.
- **Tokens:** `CLIENT_TOKENS=hofos:<token>,outro:<token>` (24+ caracteres cada). Um token de sistema só chama `/api/v1/agentes/*` — nada de chat, terminal ou arquivos. A senha e o `API_TOKEN` também servem.
- **Ajustes sem deploy de código:** `AGENTES='{"estrategista":{"modelo":"sonnet"},"rapido":{"simultaneos":6}}'` (campos: `nome`, `descricao`, `modelo`, `esforco`, `simultaneos`, `limiteSegundos`; um id novo cria um agente). `AGENTES_MAX_SIMULTANEOS` (8) limita o total de Claude Codes rodando.
- **Painel:** a tela **Agentes** da interface mostra quem está trabalhando, a fila, os números do dia e o uso da assinatura (`GET /api/v1/agentes` devolve o mesmo em JSON). As transcrições dos agentes ficam `AGENTES_RETENCAO_DIAS` (3) dias.

## Escritório (Habblaud)

O [Habblaud](https://github.com/marmottajr/habblaud) (MIT, fixado na v1.0.3 no `Dockerfile`) roda dentro do container e lê as sessões do Claude Code daqui: cada agente vira uma sala, cada pedido, um personagem trabalhando, e os medidores de 5 h e da semana mostram o uso da assinatura.

- **Como abrir:** item **Escritório** no menu, ou `/escritorio` no endereço do Habblaud. Com o login do Habblaud feito, ele emite um passe de uso único (60 s) e abre o domínio do escritório já logado — sem segunda senha.
- O Habblaud escuta só em `127.0.0.1:4747`. A porta `4748` (`ESCRITORIO_PORTA`) é um portão do próprio servidor: confere o cookie do escritório em toda requisição e repassa ao Habblaud (inclusive o tempo real, SSE). Sem login, a página volta para `/escritorio` (`APP_URL`) e a API responde 401.
- No Railway, um domínio próprio aponta para a porta 4748; ponha esse domínio em `ESCRITORIO_HOSTS` e o endereço do Habblaud em `APP_URL`. O HTTPS fica com o Railway.
- Só leitura: o portão manda ao Habblaud um Host interno que não é local, então terminal, mensagens, aprovações e "novo agente" ficam desligados de qualquer jeito; o Habblaud World e a checagem de versão também (nada sai do container).
- Roda com o mesmo usuário do agente (as transcrições do Claude Code são privadas, 600), então enxerga os mesmos arquivos. `ESCRITORIO=off` desliga.

## Desenvolvimento local

```sh
npm install
cp .env.example .env   # preencha APP_PASSWORD e API_TOKEN
DATA_DIR=./data APP_PASSWORD=... API_TOKEN=... npm run dev
```
Localmente, sem `CLAUDE_CODE_OAUTH_TOKEN`, o SDK usa o login do Claude Code da sua máquina.

## Segurança

Este servidor executa qualquer comando sem aprovação e fica exposto na internet. **A senha e o API token dão um shell no servidor** (pelo agente e pelo terminal web) e acesso às credenciais configuradas nele.

- Use senha e token longos e aleatórios; troque se vazarem (trocar `APP_PASSWORD` derruba todas as sessões web).
- `APP_PASSWORD`, `API_TOKEN`, `SESSION_SECRET` e `CLIENT_TOKENS` não são repassadas ao agente. As demais variáveis (`CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`…) são visíveis para ele.
- Conteúdo da web que o agente lê pode tentar manipulá-lo (prompt injection). Dê ao `GH_TOKEN` e a outras credenciais só as permissões necessárias.
- O login tem limite de 10 tentativas a cada 15 minutos por IP.
- O terminal (WebSocket em `/api/terminal`) exige o mesmo login e só aceita conexões vindas da própria página, o que impede que outro site o abra usando o seu cookie. Aberturas de sessão ficam no log do Railway, com o IP.

**Assinatura vs. API:** o token de `claude setup-token` usa os limites da sua assinatura Pro/Max — serve para uso próprio e da sua equipe. Para oferecer o agente a clientes ou terceiros, os termos da Anthropic exigem `ANTHROPIC_API_KEY`.
