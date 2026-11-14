# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-bookworm-slim AS build
# node-pty (terminal web) compila um módulo nativo no Linux.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- escritório: Habblaud (github.com/marmottajr/habblaud, MIT) ----------
# Fixado num commit (v1.0.3) para o build ser reproduzível e o código revisável.
FROM node:22-bookworm-slim AS escritorio
ARG HABBLAUD_COMMIT=faa1a012b5fbf632c66dc6801c5383e53a542406
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q . \
 && git remote add origin https://github.com/marmottajr/habblaud.git \
 && git fetch -q --depth 1 origin "$HABBLAUD_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && npm ci --no-audit --no-fund \
 && npm run build

# ---------- runtime ----------
FROM node:22-bookworm-slim

# Ferramentas que o agente usa no dia a dia (git, gh, busca, python…) + gosu/sudo.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client gnupg \
      jq ripgrep less nano procps unzip zip tmux \
      python3 python3-pip python3-venv \
      build-essential \
      gosu sudo \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 # O Claude Code recusa o modo bypass como root: o agente roda como "node", com sudo sem senha.
 && echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node && chmod 0440 /etc/sudoers.d/node

# Codex (OpenAI) e Gemini CLI (Google) no terminal, cada pessoa com a própria conta (tela Contas).
# Versões fixas: atualizar é trocar aqui. O Gemini não se atualiza sozinho (padrão do sistema).
# O comando `gemini` vira o bin/gemini deste repositório (lê a chave da conta em uso).
ARG CODEX_VERSION=0.169.0
ARG GEMINI_CLI_VERSION=0.68.0
RUN npm install -g --no-audit --no-fund "@openai/codex@${CODEX_VERSION}" "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
 && npm cache clean --force \
 && rm /usr/local/bin/gemini \
 && mkdir -p /etc/gemini-cli \
 && echo '{"general":{"enableAutoUpdate":false,"enableAutoUpdateNotification":false}}' > /etc/gemini-cli/system-defaults.json

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    HOME=/data/home \
    NPM_CONFIG_PREFIX=/data/home/.npm-global \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PATH=/data/home/.npm-global/bin:/data/home/.local/bin:$PATH \
    DISABLE_AUTOUPDATER=1 \
    IS_DOCKER=1

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY brain-template ./brain-template
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
# habblaud-conta (login de outra conta) e o invólucro do gemini.
COPY --chmod=0755 bin/gemini bin/habblaud-conta /usr/local/bin/
# O servidor do Habblaud não tem dependência de runtime: basta o dist/ e o package.json.
COPY --from=escritorio /src/dist /opt/habblaud/dist
COPY --from=escritorio /src/package.json /opt/habblaud/package.json

# 3000: o Habblaud (chat, terminal, agentes). 4748: o escritório, com login próprio.
EXPOSE 3000 4748
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
