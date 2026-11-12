import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { config } from './config.js';

const run = promisify(execFile);
const TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'brain-template');
const INDEX_LIMIT = 30_000; // caracteres do índice injetados no prompt

const today = () => new Date().toISOString().slice(0, 10);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyMissing(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyMissing(s, d);
    else if (!(await exists(d))) await fs.copyFile(s, d);
  }
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', config.brainDir, ...args], { timeout: 30_000 });
  return stdout.trim();
}

/** Cria a estrutura do cérebro (sem sobrescrever nada) e versiona com git. */
export async function initBrain(): Promise<void> {
  await copyMissing(TEMPLATE_DIR, config.brainDir);
  await fs.mkdir(path.join(config.brainDir, 'notas'), { recursive: true });
  try {
    if (!(await exists(path.join(config.brainDir, '.git')))) {
      await git('init', '-q');
      await git('config', 'user.name', 'Habblaud Brain');
      await git('config', 'user.email', 'brain@habblaud.local');
    }
    await commitBrain('estado inicial / alterações manuais');
  } catch (err) {
    console.warn('[brain] git indisponível — cérebro sem histórico de versões:', (err as Error).message);
  }
}

/** Faz commit de tudo que mudou no cérebro. Retorna true se havia mudanças. */
export async function commitBrain(message: string): Promise<boolean> {
  try {
    await git('add', '-A');
    const status = await git('status', '--porcelain');
    if (!status) return false;
    await git('commit', '-q', '-m', message.slice(0, 200));
    return true;
  } catch (err) {
    console.warn('[brain] commit falhou:', (err as Error).message);
    return false;
  }
}

async function readIndex(): Promise<string> {
  try {
    const text = await fs.readFile(path.join(config.brainDir, 'INDEX.md'), 'utf8');
    return text.length > INDEX_LIMIT ? `${text.slice(0, INDEX_LIMIT)}\n\n…(índice truncado — consolide notas)` : text;
  } catch {
    return '(índice vazio)';
  }
}

export async function systemPromptAppend(): Promise<string> {
  const B = config.brainDir;
  const W = config.workspaceDir;
  return `
# Ambiente: Habblaud — servidor autônomo
- Você roda como agente autônomo num container Linux (Railway), acessado pelo usuário via chat web e API. Não existe humano para aprovar ações: todas as ferramentas estão liberadas. NUNCA peça permissão ou confirmação — decida e execute até concluir. Se faltar algo que só o usuário pode fornecer (uma credencial, uma decisão de negócio), conclua tudo o que der e termine dizendo exatamente o que falta.
- Diretório de trabalho: ${W}. Só /data persiste entre deploys; o resto do disco é apagado a cada deploy. Clone repositórios e crie projetos dentro de ${W}.
- Você tem sudo sem senha. Pacotes de sistema (apt) somem no próximo deploy; prefira instalar em ~ (npm global, pip --user, binários em ~/.local/bin), que fica em /data e persiste.
- Responda em português do Brasil, direto ao ponto. A resposta final aparece num chat web com markdown.
- Verifique antes de afirmar que algo funciona (rode, teste, confira a saída).
- Nunca exponha valores de tokens, senhas ou variáveis de ambiente sensíveis na resposta, em commits ou nas notas.
- Para entregar um arquivo ao usuário (PDF, planilha, imagem, zip…), salve-o dentro de ${W} e responda com um link markdown relativo: [nome](/api/files/raw?path=<caminho relativo a ${W}, URL-encoded>). Acrescente &download=1 para forçar o download. O link só abre para quem está logado no Habblaud — não use hosts públicos de arquivos.

# Cérebro (memória de longo prazo)
Você tem um cérebro persistente em ${B} que acumula o que você aprende resolvendo problemas, de uma conversa para outra.
- O índice está logo abaixo. Antes de começar uma tarefa, leia (Read) as notas relevantes ao assunto: elas trazem soluções, armadilhas e preferências já descobertas. Não repita erros que já estão registrados.
- Se o usuário pedir para lembrar ou esquecer algo, atualize o cérebro na hora (nota + linha no INDEX.md).
- Ao fim de cada tarefa, um processo de consolidação revisa a conversa e registra os aprendizados automaticamente — você não precisa fazer isso sozinho.
- Procedimentos repetíveis podem virar skills em ~/.claude/skills/<nome>/SKILL.md e ficam disponíveis em todas as conversas.

## Índice atual do cérebro (${B}/INDEX.md)
${await readIndex()}
`.trim();
}

export function reflectionPrompt(): string {
  const B = config.brainDir;
  return `
[CONSOLIDAÇÃO DE MEMÓRIA — etapa automática; o usuário não lê esta resposta]
A tarefa acima terminou. Agora atue como consolidador do seu cérebro em ${B}. Revise a conversa inteira e registre o que vai te deixar melhor nas próximas tarefas.

Registre só o que for reutilizável:
- Soluções para problemas não triviais e o raciocínio que levou a elas.
- Erros, armadilhas e becos sem saída, e como foram contornados.
- Preferências, convenções e decisões do usuário/empresa.
- Fatos sobre projetos, repositórios, serviços e infraestrutura (nomes, URLs, onde fica cada coisa) — NUNCA valores de senhas, tokens ou chaves.
- Comandos e procedimentos úteis. Se um procedimento tiver vários passos e for se repetir, crie também uma skill em ~/.claude/skills/<nome>/SKILL.md (frontmatter com name e description).

Não registre: detalhes efêmeros desta conversa, obviedades, nem o que já está registrado.

Como registrar:
1. Leia ${B}/INDEX.md e as notas relacionadas antes de escrever.
2. Prefira atualizar uma nota existente a criar outra. Corrija ou apague o que se mostrou errado.
3. Cada nota é ${B}/notas/<slug-em-kebab-case>.md neste formato:
   ---
   titulo: <título>
   tags: [tag1, tag2]
   atualizado: ${today()}
   ---
   Contexto → solução → como aplicar da próxima vez.
4. Mantenha ${B}/INDEX.md com uma linha por nota — \`- [Título](notas/slug.md) — quando usar\` — agrupadas por tema. Máximo ~150 linhas; se passar disso, funda notas parecidas.
5. Acrescente uma linha em ${B}/diario.md: \`- ${today()} — <tarefa em poucas palavras> → <resultado>\`.

Se nada novo foi aprendido, só acrescente a linha no diário. Termine com UMA linha dizendo o que mudou no cérebro.
`.trim();
}

// ---- Leitura do cérebro pela API ----
export interface BrainFile {
  path: string;
  size: number;
  updatedAt: string;
}

export async function listBrainFiles(): Promise<BrainFile[]> {
  const out: BrainFile[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const st = await fs.stat(full);
        out.push({
          path: path.relative(config.brainDir, full).split(path.sep).join('/'),
          size: st.size,
          updatedAt: st.mtime.toISOString(),
        });
      }
    }
  }
  await walk(config.brainDir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readBrainFile(rel: string): Promise<string | undefined> {
  const full = path.resolve(config.brainDir, rel);
  if (!full.startsWith(config.brainDir + path.sep)) return undefined;
  if (full.split(path.sep).some((p) => p.startsWith('.'))) return undefined;
  try {
    return await fs.readFile(full, 'utf8');
  } catch {
    return undefined;
  }
}

export async function brainHistory(limit = 30): Promise<{ hash: string; date: string; message: string }[]> {
  try {
    const out = await git('log', `-${limit}`, '--pretty=format:%h%x09%cI%x09%s');
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, date, ...msg] = line.split('\t');
        return { hash, date, message: msg.join('\t') };
      });
  } catch {
    return [];
  }
}
