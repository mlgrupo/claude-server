#!/bin/sh
# Prepara o volume persistente e derruba os privilégios para o usuário "node".
set -e

DATA_DIR="${DATA_DIR:-/data}"
APP_USER=node

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR/home" "$DATA_DIR/workspace" "$DATA_DIR/brain" "$DATA_DIR/app"

  # Volumes do Railway nascem com dono root. Ajusta só quando precisa (chown -R pode ser lento).
  if [ "$(stat -c %U "$DATA_DIR/home")" != "$APP_USER" ] || [ "$(stat -c %U "$DATA_DIR/workspace")" != "$APP_USER" ]; then
    echo "[entrypoint] ajustando permissões de $DATA_DIR"
    chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
  fi
  chown "$APP_USER:$APP_USER" "$DATA_DIR" "$DATA_DIR/home" "$DATA_DIR/workspace" "$DATA_DIR/brain" "$DATA_DIR/app"

  as_user() { gosu "$APP_USER" env HOME="$DATA_DIR/home" "$@"; }

  # Identidade do git para commits feitos pelo agente.
  if ! as_user git config --global user.name >/dev/null 2>&1; then
    as_user git config --global user.name "${GIT_USER_NAME:-Habblaud Agent}"
    as_user git config --global user.email "${GIT_USER_EMAIL:-agent@habblaud.com}"
  fi
  as_user git config --global init.defaultBranch main

  # Com GH_TOKEN definido, gh e git (HTTPS) ficam autenticados no GitHub.
  if [ -n "$GH_TOKEN" ]; then
    as_user gh auth setup-git >/dev/null 2>&1 || echo "[entrypoint] aviso: gh auth setup-git falhou"
  fi

  exec gosu "$APP_USER" env HOME="$DATA_DIR/home" "$@"
fi

exec "$@"
