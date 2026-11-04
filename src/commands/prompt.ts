import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { SalaryError } from '../errors.js';

/** Ask on the terminal. With `hidden`, typed characters are not echoed. Prompts go to stderr. */
export async function ask(question: string, { hidden = false, nonInteractiveHint = 'Run it in a terminal, or use `login --from-env` for development.' } = {}): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new SalaryError('INVALID_PARAMS', 'login needs an interactive terminal.', { hint: nonInteractiveHint });
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stderr.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => {
        if (hidden) process.stderr.write('\n');
        resolve(answer.trim());
      });
      muted = hidden;
    });
  } finally {
    rl.close();
  }
}
