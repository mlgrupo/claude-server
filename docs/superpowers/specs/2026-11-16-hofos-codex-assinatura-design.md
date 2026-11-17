# HofOS via assinatura do Codex

## Intenção

Fazer todos os pedidos que já chegam do HofOS em `POST /api/v1/agentes/executar`
serem atendidos pelo Codex usando exclusivamente a conta ChatGPT/Codex selecionada
na tela **Contas**. Nesta primeira entrega, o executor de agentes não chama Claude
nem usa chaves das APIs da Anthropic ou da OpenAI.

## Objetivos

- Manter a URL, a autenticação por `CLIENT_TOKENS`, o corpo e o formato de resposta
  que o HofOS já utiliza.
- Reaproveitar a fila, prioridades, limites, idempotência, tempos máximos e painel
  dos agentes existentes.
- Exigir uma conta ChatGPT autenticada no Codex; uma conta configurada apenas com
  `OPENAI_API_KEY` não satisfaz o requisito de “assinatura”.
- Suportar os campos atuais `sistema`, `prompt`, `esquema` e `imagens`.
- Não permitir que texto recebido das clínicas acesse shell, MCPs, plugins,
  skills, regras locais, workspace ou sessões anteriores.
- Não persistir o conteúdo das execuções do HofOS no histórico local do Codex.

## Não objetivos

- Migrar nesta etapa o chat principal do Habblaud ou o terminal para o Codex.
- Implementar Claude como segundo provedor ou fallback automático.
- Alterar chamadas que o próprio HofOS ainda envie diretamente a outro provedor;
  essas precisam ser redirecionadas no repositório do HofOS para este endpoint.
- Contornar limites de uso, bloqueios ou indisponibilidade da assinatura. Quando a
  assinatura não puder responder, a API devolverá erro explícito.

## Restrições e segurança

- O executor será `codex exec`, usando o `CODEX_HOME` vivo que a tela **Contas**
  já administra.
- Cada pedido usará diretório temporário vazio, `--ephemeral`,
  `--ignore-user-config`, `--ignore-rules`, sandbox somente leitura e aprovação
  desativada.
- Ferramentas locais e remotas serão desligadas por configuração, em especial
  shell, busca web, apps, plugins, MCPs, browser, computador e subagentes.
- Arquivos temporários de imagens, esquema e resposta terão permissão privada e
  serão apagados no `finally`, inclusive em erro ou timeout.
- A troca da conta Codex ficará bloqueada enquanto houver agente do HofOS em
  execução, evitando renovação ou substituição concorrente de credenciais.
- O risco comercial já aceito é usar a assinatura da empresa para automações que
  processam dados das clínicas; o sistema não fará fallback silencioso para API.

## Contrato e fluxo

1. O HofOS continua chamando `POST /api/v1/agentes/executar` com o token atual.
2. A validação escolhe o perfil de fila (`rapido`, `analista`, `estrategista`,
   `hofos-ai` ou `editor-de-video`) como hoje. Esses perfis passam a controlar
   somente prioridade, concorrência e timeout; todos executam no Codex.
3. Antes de admitir o pedido, o servidor confirma que o Codex está instalado e
   que a conta ativa é uma assinatura ChatGPT, não uma chave de API.
4. `sistema` e `prompt` são compostos em uma instrução única, com separação clara
   entre regras e conteúdo. Imagens são materializadas apenas no diretório
   temporário e passadas com `--image`.
5. Quando há `esquema`, ele é passado a `--output-schema`; a última mensagem é
   capturada por `--output-last-message` e validada como JSON.
6. A saída JSONL do Codex é convertida para os eventos que o HofOS já espera:
   `system/init` e `result`. O `result` contém `result`, `structured_output`,
   `usage` e `is_error` quando aplicável.
7. Timeout encerra o processo inteiro. Falha de login retorna 503
   `sem_assinatura_codex`; falha do Codex retorna 502; estouro de prazo retorna
   504. Não existe fallback para Claude ou API.

## Configuração e observabilidade

- `AGENTES_CODEX_MODEL` será opcional. Sem ele, o Codex escolhe o modelo padrão
  disponível na assinatura ativa; com ele, o servidor passa `--model`.
- O painel mostrará `assinatura_codex` ou `sem_assinatura_codex` como credencial e
  registrará modelo, duração, espera e tokens quando fornecidos pelo JSONL.
- `AGENTES_ANTHROPIC_API_KEY` deixa de controlar os agentes e será removida da
  documentação e dos textos da interface, sem afetar o chat Claude do Habblaud.

## Abordagens consideradas

1. **APIs corporativas:** mais adequada para integração comercial e escala, mas
   rejeitada porque a decisão foi forçar o uso da assinatura.
2. **Assinatura para tudo:** escolhida. Centraliza o consumo na conta Codex ativa,
   ao custo de limites compartilhados e maior fragilidade operacional.
3. **Híbrido:** assinatura para uso humano e API para automações, recomendado
   inicialmente, mas rejeitado nesta etapa.

## Verificação

- Testes unitários cobrirão detecção de assinatura versus chave de API, composição
  do prompt, argumentos seguros do processo, conversão do JSONL e saída estruturada.
- Testes do executor usarão um processo Codex falso para validar sucesso, timeout,
  erro, imagens e limpeza sem consumir a assinatura.
- `npm test`, `npm run typecheck` e `npm run build` deverão passar.
- Uma chamada real controlada será deixada como verificação de implantação, pois
  depende da conta Codex autenticada no Railway e consome a assinatura.
