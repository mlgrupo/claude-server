import fs from 'node:fs/promises';

const [modo, ...args] = process.argv.slice(2);
const valor = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

if (modo === 'hang') {
  setInterval(() => undefined, 1_000);
} else {
  const resposta = valor('--output-last-message');
  await fs.writeFile(resposta, modo === 'invalid-json' ? 'não-json' : '{"ok":true}');
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'fake', model: 'gpt-fake' })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 3 } })}\n`);
}
