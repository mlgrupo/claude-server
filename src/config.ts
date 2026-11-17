import path from 'node:path';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

function num(name: string, fallback: number): number {
  const v = env(name);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const dataDir = path.resolve(env('DATA_DIR') ?? '/data');
const effortRaw = (env('CLAUDE_EFFORT') ?? 'high') as Effort;
const reflectRaw = env('BRAIN_REFLECT') ?? 'auto';

export const config = {
  port: num('PORT', 3000),
  dataDir,
  workspaceDir: path.resolve(env('WORKSPACE_DIR') ?? path.join(dataDir, 'workspace')),
  brainDir: path.resolve(env('BRAIN_DIR') ?? path.join(dataDir, 'brain')),
  appDir: path.join(dataDir, 'app'),

  // Acesso ao servidor
  appPassword: env('APP_PASSWORD'),
  apiToken: env('API_TOKEN'),
  sessionSecret: env('SESSION_SECRET'),
  secureCookies: env('NODE_ENV') === 'production',

  // Agente
  model: env('CLAUDE_MODEL') ?? 'claude-opus-5-5',
  effort: EFFORTS.includes(effortRaw) ? effortRaw : 'high',
  maxTurns: env('MAX_TURNS') ? num('MAX_TURNS', 200) : undefined,
  maxConcurrentRuns: num('MAX_CONCURRENT_RUNS', 3),
  runTimeoutMs: num('RUN_TIMEOUT_MIN', 60) * 60_000,

  // Cérebro
  brainReflect: (['auto', 'always', 'off'].includes(reflectRaw) ? reflectRaw : 'auto') as 'auto' | 'always' | 'off',
  brainModel: env('BRAIN_MODEL'),

  // Terminal web
  terminalEnabled: env('TERMINAL') !== 'off',
  terminalIdleMs: num('TERMINAL_IDLE_MIN', 60) * 60_000,

  // Agentes especializados (POST /api/v1/agentes/executar)
  agentesAjustes: env('AGENTES'),
  /** Modelo opcional do Codex; sem ele, usa o padrão disponível na assinatura ativa. */
  agentesCodexModel: env('AGENTES_CODEX_MODEL'),
  agentesDir: path.resolve(env('AGENTES_DIR') ?? path.join(dataDir, 'agentes')),
  agentesMaxSimultaneos: num('AGENTES_MAX_SIMULTANEOS', 10),
  agentesFilaMaxima: num('AGENTES_FILA_MAXIMA', 60),
  /**
   * Chave da API da Anthropic só dos agentes (o HofOS e outros sistemas). As
   * assinaturas em Contas são das pessoas da equipe, para o chat e o terminal.
   */
  agentesApiKey: env('AGENTES_ANTHROPIC_API_KEY'),
  agentesRetencaoDias: num('AGENTES_RETENCAO_DIAS', 3),
  /** Tokens de sistemas que só chamam os agentes: "hofos:<token>,outro:<token>". */
  clientTokens: lerTokensDeClientes(env('CLIENT_TOKENS')),

  // Escritório (Habblaud): os agentes trabalhando ao vivo, em pixel art.
  escritorio: env('ESCRITORIO') !== 'off',
  escritorioDir: path.resolve(env('ESCRITORIO_DIR') ?? '/opt/habblaud'),
  escritorioPorta: num('ESCRITORIO_PORTA', 4748),
  /** Domínio(s) público(s) do escritório, separados por vírgula. */
  escritorioHosts: env('ESCRITORIO_HOSTS'),
  /** Endereço público do Habblaud (para o escritório mandar de volta ao login). */
  appUrl: env('APP_URL')?.replace(/\/+$/, '') ?? (env('RAILWAY_PUBLIC_DOMAIN') ? `https://${env('RAILWAY_PUBLIC_DOMAIN')}` : undefined),
};

function lerTokensDeClientes(raw: string | undefined): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const par of (raw ?? '').split(',')) {
    const i = par.indexOf(':');
    if (i <= 0) continue;
    const nome = par.slice(0, i).trim();
    const token = par.slice(i + 1).trim();
    if (/^[a-z0-9-]{2,32}$/.test(nome) && token) mapa.set(token, nome);
  }
  return mapa;
}

/** Variáveis que só o servidor precisa — nunca vão para o processo do agente. */
export const SERVER_ONLY_SECRETS = ['APP_PASSWORD', 'API_TOKEN', 'SESSION_SECRET', 'CLIENT_TOKENS', 'AGENTES_ANTHROPIC_API_KEY'];

export function agentEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env };
  for (const k of SERVER_ONLY_SECRETS) delete out[k];
  return out;
}

export function validateConfig(): string[] {
  const problems: string[] = [];
  if (!config.appPassword) problems.push('APP_PASSWORD não definida — o servidor não sobe sem senha (ele executa comandos sem aprovação).');
  else if (config.appPassword.length < 12) problems.push('APP_PASSWORD precisa ter pelo menos 12 caracteres.');
  if (config.apiToken && config.apiToken.length < 24) problems.push('API_TOKEN precisa ter pelo menos 24 caracteres.');
  for (const [token, nome] of config.clientTokens) {
    if (token.length < 24) problems.push(`CLIENT_TOKENS: o token de "${nome}" precisa ter pelo menos 24 caracteres.`);
    if (config.apiToken && token === config.apiToken) problems.push(`CLIENT_TOKENS: o token de "${nome}" não pode ser o API_TOKEN.`);
  }
  return problems;
}
