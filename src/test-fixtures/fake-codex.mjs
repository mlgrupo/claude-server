import fs from 'node:fs/promises';

const [modo, ...args] = process.argv.slice(2);
const valor = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

if (modo === 'exit-early') {
  process.exit(7);
} else if (modo === 'auth-error') {
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'fake-auth', model: 'gpt-fake' })}\n`);
  process.stderr.write('401 Unauthorized: refresh token is invalid or revoked\n');
  process.exit(1);
} else if (modo === 'hang') {
  setInterval(() => undefined, 1_000);
} else if (modo === 'missing-response-no-final') {
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'fake-missing', model: 'gpt-fake' })}\n`);
} else {
  const resposta = valor('--output-last-message');
  await fs.writeFile(resposta, modo === 'invalid-json' ? 'não-json' : '{"ok":true}');
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'fake', model: 'gpt-fake' })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 3 } })}\n`);
}
