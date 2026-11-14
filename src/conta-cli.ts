// habblaud-conta: entra com outra conta do Claude, do Codex ou do Gemini no
// terminal web, pelo login da própria ferramenta, numa pasta à parte (a conta
// em uso não muda). No fim, a conta fica guardada em Contas.
//
//   habblaud-conta entrar claude|codex|gemini
//   habblaud-conta listar

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {
  NOMES,
  PROVEDORES,
  type Provedor,
  binarioDe,
  ehProvedor,
  guardar,
  identificar,
  listarContas,
  origemDoLogin,
  origemViva,
  pastaDosLogins,
  usarConta,
} from './contas.js';

const negrito = (s: string) => `\x1b[1m${s}\x1b[0m`;
const fraco = (s: string) => `\x1b[2m${s}\x1b[0m`;
const verde = (s: string) => `\x1b[32m${s}\x1b[0m`;
const vermelho = (s: string) => `\x1b[31m${s}\x1b[0m`;

function rodar(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, entrada?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const filho = spawn(cmd, args, { env, cwd, stdio: [entrada === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
    if (entrada !== undefined) filho.stdin?.end(entrada);
    filho.on('error', reject);
    filho.on('exit', (codigo, sinal) => resolve(codigo ?? (sinal ? 130 : 1)));
  });
}

function perguntar(texto: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    rl.question(texto, (resposta) => {
      rl.close();
      resolve(resposta.trim());
    });
  });
}

/** Lê uma linha sem mostrar o que é digitado (chave da API). Ctrl+C desiste. */
function perguntarOculto(texto: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let valor = '';
    process.stdout.write(texto);
    stdin.setRawMode?.(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const fim = () => {
      stdin.off('data', aoDigitar);
      stdin.setRawMode?.(false);
      stdin.pause();
      process.stdout.write('\n');
      // Colar pode chegar entre as marcas de "bracketed paste" do terminal.
      resolve(valor.replace(/\x1b\[20[01]~/g, '').trim());
    };
    const aoDigitar = (pedaco: string) => {
      for (const c of pedaco) {
        if (c === '\r' || c === '\n') return fim();
        if (c === '\u0003') {
          valor = '';
          return fim();
        }
        if (c === '\u007f' || c === '\b') valor = valor.slice(0, -1);
        else if (c >= ' ' || c === '\x1b') valor += c;
      }
    };
    stdin.on('data', aoDigitar);
  });
}

async function entrar(p: Provedor): Promise<number> {
  const bin = binarioDe(p);
  if (!bin) {
    console.error(vermelho(`O ${NOMES[p]} não está instalado neste servidor.`));
    return 1;
  }
  await fs.mkdir(pastaDosLogins(), { recursive: true, mode: 0o700 });
  const pasta = path.join(pastaDosLogins(), `${p}-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(pasta, { recursive: true, mode: 0o700 });

  // Ctrl+C vai para a ferramenta; este processo espera ela sair para limpar a pasta.
  const ignorar = () => undefined;
  process.on('SIGINT', ignorar);
  try {
    console.log(`\n${negrito(`Entrar com outra conta do ${NOMES[p]}`)}`);
    console.log(fraco('A conta em uso continua a mesma. Esta fica guardada em Contas.\n'));
    let codigo: number;
    if (p === 'claude') {
      console.log('Abra o link que vai aparecer, entre com a sua conta e cole aqui o código que o site mostrar.\n');
      codigo = await rodar(bin, ['auth', 'login', '--claudeai'], { ...process.env, CLAUDE_CONFIG_DIR: pasta }, pasta);
    } else if (p === 'codex') {
      console.log('Como quer entrar?');
      console.log('  1) Conta do ChatGPT (código no navegador)');
      console.log('  2) Chave da API da OpenAI');
      const modo = (await perguntar('Escolha [1]: ')) || '1';
      const env = { ...process.env, CODEX_HOME: pasta, OPENAI_API_KEY: undefined };
      if (modo === '2') {
        const chave = await perguntarOculto('Cole a chave (não aparece na tela): ');
        if (!chave) {
          console.error(vermelho('Nenhuma chave informada.'));
          return 1;
        }
        codigo = await rodar(bin, ['login', '--with-api-key'], env, pasta, `${chave}\n`);
      } else {
        console.log(
          fraco('\nSe o ChatGPT recusar o código, ative "login por código do dispositivo" para o Codex nas configurações de segurança da conta.\n'),
        );
        codigo = await rodar(bin, ['login', '--device-auth'], env, pasta);
      }
    } else {
      await fs.mkdir(path.join(pasta, '.gemini'), { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(pasta, '.gemini', 'settings.json'),
        JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }, null, 2),
        { mode: 0o600 },
      );
      console.log('Abra o link que vai aparecer, entre com a conta Google e cole aqui o código de autorização.');
      console.log(`Quando o Gemini abrir já logado, digite ${negrito('/quit')} para terminar.\n`);
      codigo = await rodar(bin, [], { ...process.env, GEMINI_CLI_HOME: pasta, NO_BROWSER: 'true', GEMINI_API_KEY: undefined }, pasta);
    }

    const origem = origemDoLogin(p, pasta);
    const ident = identificar(p, origem);
    if (!ident) {
      console.error(vermelho(`\nNão deu para entrar (o ${NOMES[p]} saiu com código ${codigo}). Nada foi guardado.`));
      return 1;
    }
    const id = await guardar(p, origem);
    const quem = ident.email ?? ident.nome ?? 'conta sem e-mail';
    // Primeira conta dessa ferramenta: já fica em uso.
    if (id && !identificar(p, origemViva(p))) {
      await usarConta(p, id);
      console.log(verde(`\nPronto: ${quem} está em uso no ${NOMES[p]}.`));
    } else {
      console.log(verde(`\nPronto: ${quem} foi guardada.`));
      console.log('Para usar, abra Contas no menu do Habblaud e toque em "Usar esta".');
    }
    return 0;
  } finally {
    process.off('SIGINT', ignorar);
    await fs.rm(pasta, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function listar(): Promise<number> {
  const todas = await listarContas();
  for (const p of PROVEDORES) {
    const f = todas[p];
    console.log(negrito(`${f.nome}${f.instalado ? '' : ' (não instalado)'}`));
    if (!f.contas.length) console.log(fraco('  nenhuma conta'));
    for (const c of f.contas) {
      const marca = c.id === f.ativa ? verde('● em uso') : fraco('○');
      console.log(`  ${marca} ${c.email ?? c.nome ?? c.id}${c.plano ? fraco(` · ${c.plano}`) : ''}`);
    }
  }
  return 0;
}

async function main(): Promise<number> {
  const [comando, alvo] = process.argv.slice(2);
  if (comando === 'entrar' && ehProvedor(alvo)) return entrar(alvo);
  if (comando === 'listar') return listar();
  console.log('Uso: habblaud-conta entrar claude|codex|gemini');
  console.log('     habblaud-conta listar');
  return comando ? 1 : 0;
}

main().then(
  (codigo) => process.exit(codigo),
  (err) => {
    console.error(vermelho(`Erro: ${(err as Error).message}`));
    process.exit(1);
  },
);
