# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim

# Ferramentas que o agente usa no dia a dia (git, gh, busca, python…) + gosu/sudo.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client gnupg \
      jq ripgrep less nano procps unzip zip \
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

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
