import { createInterface } from 'node:readline';

/** Author mode: a human at a real terminal, not Claude Code. */
export function isAuthorMode(
  env: NodeJS.ProcessEnv,
  stdinTTY: boolean,
  stdoutTTY: boolean,
): boolean {
  return stdinTTY && stdoutTTY && !env['CLAUDECODE'];
}

export interface TerminalIO {
  print(line: string): void;
  ask(prompt: string): Promise<string>;
}

/** Thrown by `ask` when stdin closes (EOF) or Ctrl+C before an answer. */
export class InputClosedError extends Error {
  constructor() {
    super('the terminal input closed before an answer');
    this.name = 'InputClosedError';
  }
}

/**
 * The real terminal. `ask` rejects with `InputClosedError` when the input
 * closes before an answer, so a caller never waits forever. Ctrl+C at a
 * prompt is passed on as the process's SIGINT before the prompt closes.
 */
export function nodeTerminal(
  streams: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
  } = { input: process.stdin, output: process.stdout },
): TerminalIO {
  return {
    print(line) {
      streams.output.write(`${line}\n`);
    },
    ask(prompt) {
      const rl = createInterface(streams);
      return new Promise((resolve, reject) => {
        let answered = false;
        rl.once('close', () => {
          if (!answered) reject(new InputClosedError());
        });
        rl.on('SIGINT', () => {
          process.emit('SIGINT', 'SIGINT');
          rl.close();
        });
        rl.question(prompt, (answer) => {
          answered = true;
          rl.close();
          resolve(answer);
        });
      });
    },
  };
}
