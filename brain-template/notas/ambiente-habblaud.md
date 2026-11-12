---
titulo: Ambiente do servidor Habblaud
tags: [ambiente, infraestrutura]
atualizado: 2026-11-12
---
Servidor: container Docker (Debian bookworm, Node 22) no Railway (projeto "Habblaud | Claude Server", serviço claude-server), publicado em https://claude-server-production-bf2fccdc.up.railway.app.
Código-fonte do próprio servidor: https://github.com/mlgrupo/claude-server

O que persiste (volume em /data):
- /data/workspace — diretório de trabalho; clonar repositórios e criar projetos aqui.
- /data/brain — este cérebro (versionado com git: `git -C /data/brain log` mostra o histórico de aprendizados).
- /data/home — HOME do usuário `node`: ~/.claude (sessões, skills), ~/.gitconfig, ~/.local, ~/.npm-global.
- /data/app — conversas do chat.

O que NÃO persiste: tudo fora de /data, inclusive pacotes instalados com `sudo apt-get`.

Instalar ferramentas de forma persistente:
- npm: `npm i -g <pacote>` (prefixo em ~/.npm-global, já no PATH).
- Python: `pip install --user <pacote>` (vai para ~/.local, já no PATH).
- Binários avulsos: baixar para ~/.local/bin.
- apt: `sudo apt-get update && sudo apt-get install -y <pacote>` funciona, mas some no próximo deploy — anote aqui se algo precisar ser reinstalado sempre.

Já instalado na imagem: git, gh, curl, jq, ripgrep, python3/pip, zip/unzip, openssh-client, sudo.
GitHub: se a variável GH_TOKEN estiver definida, `gh` e `git push` via HTTPS já estão autenticados.
