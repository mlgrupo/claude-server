import fs from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import { config } from './config.js';

/** Tipos que o navegador pode abrir direto sem risco de executar script na origem do Habblaud. */
const INLINE_EXT = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico',
  '.txt', '.log', '.md', '.csv', '.json',
  '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm', '.mov',
]);
const TEXT_EXT = new Set(['.txt', '.log', '.md', '.csv', '.json']);

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve um caminho relativo ao workspace, seguindo symlinks, e garante que ele não escapa do workspace. */
async function resolveInWorkspace(relRaw: unknown): Promise<string | undefined> {
  const rel = typeof relRaw === 'string' ? relRaw.replace(/^\/+/, '') : '';
  if (rel.includes('\0')) return undefined;
  const root = await fs.realpath(config.workspaceDir);
  const candidate = path.resolve(root, rel);
  if (!isInside(root, candidate)) return undefined;
  try {
    const real = await fs.realpath(candidate);
    return isInside(root, real) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** GET /api/files?path=<pasta> — lista uma pasta do workspace. */
export async function listFiles(req: Request, res: Response): Promise<void> {
  const abs = await resolveInWorkspace(req.query.path ?? '');
  const stat = abs ? await fs.stat(abs).catch(() => undefined) : undefined;
  if (!abs || !stat?.isDirectory()) {
    res.status(404).json({ error: 'pasta não encontrada' });
    return;
  }
  const root = await fs.realpath(config.workspaceDir);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const resolved = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(abs, e.name);
      const real = await fs.realpath(full).catch(() => undefined);
      if (!real || !isInside(root, real)) return undefined; // symlink que aponta para fora do workspace
      const s = await fs.stat(full).catch(() => undefined);
      return {
        name: e.name,
        path: path.relative(root, path.join(abs, e.name)),
        type: s?.isDirectory() ? 'dir' : 'file',
        size: s?.isFile() ? s.size : undefined,
        modifiedAt: s ? s.mtime.toISOString() : undefined,
      };
    }),
  );
  const items = resolved.filter((i) => i !== undefined);
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  res.json({ path: path.relative(root, abs), items });
}

/** GET /api/files/raw?path=<arquivo>[&download=1] — abre ou baixa um arquivo do workspace. */
export async function sendWorkspaceFile(req: Request, res: Response): Promise<void> {
  const abs = await resolveInWorkspace(req.query.path);
  const stat = abs ? await fs.stat(abs).catch(() => undefined) : undefined;
  if (!abs || !stat?.isFile()) {
    res.status(404).json({ error: 'arquivo não encontrado' });
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  const name = path.basename(abs);
  const inline = INLINE_EXT.has(ext) && req.query.download !== '1';

  // HTML, SVG etc. sempre como download: abertos inline rodariam script com a sessão do usuário.
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'private, no-cache');
  if (TEXT_EXT.has(ext)) {
    res.type(ext === '.json' ? 'application/json' : 'text/plain');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  }
  res.sendFile(abs, { dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: 'falha ao enviar o arquivo' });
  });
}
