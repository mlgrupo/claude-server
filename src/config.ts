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
};

/** Variáveis que só o servidor precisa — nunca vão para o processo do agente. */
export const SERVER_ONLY_SECRETS = ['APP_PASSWORD', 'API_TOKEN', 'SESSION_SECRET'];

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
  return problems;
}

export function hasClaudeCredentials(): boolean {
  return Boolean(env('CLAUDE_CODE_OAUTH_TOKEN') || env('ANTHROPIC_API_KEY'));
}
