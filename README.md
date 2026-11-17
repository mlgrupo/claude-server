# Habblaud — servidor autônomo do Claude

Servidor que roda o Claude (via [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)) num container no Railway, acessível por chat web e por API em **https://claude-server-production-bf2fccdc.up.railway.app** (domínio próprio a definir).

- **Autônomo:** roda em modo `bypassPermissions` e nunca pede aprovação. Ferramentas que dependem de um humano (perguntas, modo plano) ficam desligadas.
- **Cérebro que aprende:** depois de cada tarefa, um fork da sessão revisa o que aconteceu e grava os aprendizados em `/data/brain` (notas em markdown + índice + diário), versionado com git. O índice entra no prompt de toda conversa nova.
- **Persistente:** conversas, sessões do Claude, cérebro, skills e workspace ficam no volume `/data`.
- **Terminal no navegador:** um shell `bash` no container, pelo menu *Terminal* da interface, com Claude Code, Codex e Gemini CLI.
- **Contas:** cada pessoa da equipe entra com a própria conta do Claude, do Codex e do Gemini, e escolhe qual está em uso (menu *Contas*).
- **Agentes especializados:** outros sistemas (o HofOS, por exemplo) chamam `POST /api/v1/agentes/executar`; todos os pedidos usam exclusivamente a assinatura ChatGPT/Codex selecionada em **Contas**, sem fallback para Claude ou API.
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
| `/data/home` | HOME do usuário `node`: `~/.claude` (sessões, skills), `~/.codex`, `~/.gemini`, gitconfig, `~/.local`, `~/.npm-global` |
| `/data/contas` | logins guardados do Claude, do Codex e do Gemini (pasta 700, arquivos 600) |
| `/data/app` | conversas do chat |

O container roda como usuário `node` (o Claude Code recusa o modo bypass como root), com `sudo` sem senha.

## Deploy no Railway

1. No Railway, crie um serviço a partir deste repositório (o `railway.json` já aponta para o `Dockerfile`).
2. **Adicione um volume** montado em `/data` (sem ele, tudo some a cada deploy).
3. **Variáveis** (veja `.env.example`): `APP_PASSWORD`, `API_TOKEN`. Opcional: `GH_TOKEN` para o agente do chat usar o GitHub.
4. **Entre com as contas:** abra o Habblaud, vá em **Contas** e entre no Claude para o chat e no Codex com uma conta ChatGPT para os pedidos do HofOS. Uma `OPENAI_API_KEY` no Codex não vale como assinatura. (Com `CLAUDE_CODE_OAUTH_TOKEN` definido, o chat usa sempre esse token e a troca de conta do Claude não tem efeito.)
5. **Domínio próprio (opcional):** em *Settings → Networking → Custom Domain*, adicione o domínio (ex.: `app.habblaud.com`) e crie na Cloudflare o CNAME indicado pelo Railway. Atenção: `habblaud.com` (raiz) hoje serve a landing page do Habblaud.

## Terminal

O item **Terminal** na barra lateral abre um shell `bash` no container, como usuário `node` (com `sudo`), começando em `/data/workspace`. É o mesmo ambiente do agente: as senhas do servidor (`APP_PASSWORD`, `API_TOKEN`, `SESSION_SECRET`) não aparecem nele.

- **A sessão sobrevive à conexão:** se a página fechar ou a rede cair, o shell continua rodando. Ao voltar, a tela recente é reconstruída. Outra aba ou outro aparelho entra na mesma sessão.
- **Encerramento:** sem ninguém conectado por 60 minutos (`TERMINAL_IDLE_MIN`), o shell é finalizado. Para tarefas mais longas, use `tmux` (já instalado) ou `nohup`. Um deploy novo também encerra o shell, porque reinicia o container.
- **Copiar e colar:** Ctrl+C com texto selecionado copia; sem seleção, interrompe o comando. Ctrl+V cola.
- **Celular:** uma fileira de teclas extras (Esc, Tab, Ctrl, setas e ^C) aparece embaixo do terminal.
- **Desligar:** `TERMINAL=off`.

Só o que fica em `/data` persiste entre deploys (veja a tabela acima).

## Contas

A tela **Contas** mostra os logins do Claude Code, do Codex e do Gemini CLI guardados no servidor e qual está em uso em cada um. O chat usa a conta Claude ativa; todos os pedidos do HofOS usam a assinatura ChatGPT/Codex ativa.

- **Entrar com outra conta:** abre um terminal rodando `habblaud-conta entrar claude|codex|gemini`, que faz o login pelo fluxo da própria ferramenta numa pasta à parte. A conta em uso não muda; a nova fica guardada. Claude: abra o link e cole o código. Codex: código do dispositivo da conta do ChatGPT, ou uma chave da API da OpenAI. Gemini: chave da API do [AI Studio](https://aistudio.google.com/app/apikey), conferida com o Google antes de guardar (o Google encerrou o login gratuito com conta Google no Gemini CLI: "no longer supported for Gemini Code Assist for individuals"); a conta Google continua como opção para quem tem o Gemini Code Assist pago.
- **Chave do Gemini:** fica em `~/.gemini/habblaud-api-key` (600), e o comando `gemini` (o `bin/gemini` deste repositório) a passa como `GEMINI_API_KEY`. O cofre do próprio Gemini não serve no container: ele criptografa com o nome da máquina, que muda a cada deploy.
- **Usar esta:** guarda a conta em uso (os tokens dela renovam com o uso) e põe a escolhida no lugar: `~/.claude/.credentials.json` e o `oauthAccount` do `~/.claude.json`, `~/.codex/auth.json`, `~/.gemini/habblaud-api-key` ou `~/.gemini/oauth_creds.json`. Sessões, configurações e skills continuam as mesmas. A troca do Claude é recusada enquanto houver tarefa do chat; a do Codex, enquanto houver pedido do HofOS. Terminais já abertos precisam ser reiniciados para pegar outra conta.
- **Remover:** apaga o login guardado (a conta em uso não pode ser removida).
- A conta em uso entra na lista sozinha; a cada 10 minutos a cópia guardada acompanha os tokens renovados.
- `habblaud-conta listar` mostra as contas no terminal. API: `GET /api/contas`, `POST /api/contas/:ferramenta/:id/usar`, `DELETE /api/contas/:ferramenta/:id`.

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

Para outros sistemas usarem a assinatura Codex ativa do servidor. Cada pedido roda em um `codex exec` efêmero, com shell, busca, apps, plugins, MCPs, browser, computador e subagentes desligados. O texto que chega no prompt, como a mensagem de um lead, não consegue acessar arquivos nem executar comandos no servidor. Os perfis abaixo controlam fila, vagas e prazo; todos usam o mesmo Codex:

| Agente | Modelo | Para quê | Vagas | Teto |
|---|---|---|---|---|
| `rapido` | Codex | análises de conversa (cadência, etapa, temperatura), comprovantes, posts do Instagram (piloto de perfil), Raio-X, playbook | 6 | 2 min |
| `analista` | Codex | resumos de call, atendimento, pós-vendas, tráfego, treinamentos | 3 | 5 min |
| `estrategista` | Codex | roteiros, campanhas, newsletter, blog, relatórios | 2 | 10 min |
| `hofos-ai` | Codex | o chat da equipe no HofOS | 3 | 5 min |
| `editor-de-video` | Codex | plano de edição e ajustes dos vídeos do editor do HofOS | 2 | 10 min |

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

- **Quem atende:** `agente` explícito, senão pela função (`feature`, os rótulos do HofOS: `roteiros.*` → estrategista, `analise_call` → analista, `cadencia.*`, `etapa.*`, `comprovante.*`, `piloto_perfil.*` → rápido…), que vale mesmo com `nivel: forte`; função fora da tabela vai pelo porte (`nivel`: `rapido` | `forte`). Os perfis mudam apenas fila, concorrência e prazo.
- **Corpo:** `prompt` (obrigatório), `sistema`, `esquema` (JSON Schema: a resposta volta em `structured_output`), `imagens` (`[{mime, base64}]`, até 8 e 15 MB), `limiteSegundos`, `origem` (`tela` passa na frente de `automatico`), `assunto`, `empresa` e o campo legado `privado`. Todas as execuções Codex são efêmeras e não deixam transcrição local.
- **Resposta (200):** `{ id, agente, modelo, esperaMs, duracaoMs, eventos }`. Para compatibilidade com o HofOS, `eventos` contém `system/init` e `result`, com `result`, `structured_output` e `usage`.
- **Credencial:** os agentes usam somente a conta ChatGPT/Codex ativa na tela **Contas**. Uma conta configurada apenas com `OPENAI_API_KEY` é recusada. Sem assinatura, todo pedido volta com **503** `sem_assinatura_codex`; não existe fallback para Claude ou API.
- **Sem vaga agora (429):** `fila_cheia` ou `fila_demorada`. A fila automática de cada perfil aceita até 2× as vagas.
- **Tokens:** `CLIENT_TOKENS=hofos:<token>,outro:<token>` (24+ caracteres cada). Um token de sistema só chama `/api/v1/agentes/*` — nada de chat, terminal ou arquivos. A senha e o `API_TOKEN` também servem.
- **Ajustes sem deploy de código:** `AGENTES='{"rapido":{"simultaneos":6}}'` ajusta nome, descrição, vagas e prazo; `AGENTES_CODEX_MODEL` fixa um modelo, e vazio usa o padrão da assinatura. `AGENTES_MAX_SIMULTANEOS` (10) limita o total de Codex rodando.
- **Painel:** a tela **Agentes** mostra quem está trabalhando, fila, números do dia e se a assinatura Codex está ativa (`GET /api/v1/agentes` devolve o mesmo em JSON). O medidor separado continua representando a assinatura Claude do chat.

## Escritório (Habblaud)

O [Habblaud](https://github.com/marmottajr/habblaud) (MIT, fixado na v1.0.3 no `Dockerfile`) roda dentro do container e lê as sessões persistentes do Claude Code e do Codex. Os pedidos do HofOS são efêmeros e aparecem no painel **Agentes**, não como sessões no escritório. Os medidores de 5 h e da semana mostram o uso da conta Claude do chat.

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
Localmente, o SDK usa o login do Claude Code da sua máquina (e a tela Contas mostra e troca esse mesmo login).

## Segurança

Este servidor executa qualquer comando sem aprovação e fica exposto na internet. **A senha e o API token dão um shell no servidor** (pelo agente e pelo terminal web) e acesso às credenciais configuradas nele.

- Use senha e token longos e aleatórios; troque se vazarem (trocar `APP_PASSWORD` derruba todas as sessões web).
- `APP_PASSWORD`, `API_TOKEN`, `SESSION_SECRET`, `CLIENT_TOKENS` e a variável legada `AGENTES_ANTHROPIC_API_KEY` não são repassadas ao chat, terminal nem executor Codex. A chave legada não é mais usada. As demais variáveis (`GH_TOKEN`…) continuam visíveis apenas para o agente principal do chat.
- Os logins guardados em `/data/contas` dão acesso às contas de quem entrou: quem tem a senha do Habblaud consegue usá-las pelo terminal. Remova a conta de quem sair da equipe.
- Conteúdo da web que o agente lê pode tentar manipulá-lo (prompt injection). Dê ao `GH_TOKEN` e a outras credenciais só as permissões necessárias.
- O login tem limite de 10 tentativas a cada 15 minutos por IP.
- O terminal (WebSocket em `/api/terminal`) exige o mesmo login e só aceita conexões vindas da própria página, o que impede que outro site o abra usando o seu cookie. Aberturas de sessão ficam no log do Railway, com o IP.

**Assinaturas:** o chat Claude e os agentes Codex usam contas e limites separados. Os pedidos do HofOS compartilham os limites da conta ChatGPT/Codex ativa; ao esgotá-los, falham explicitamente e não migram para API nem para Claude.
