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

export function nodeTerminal(): TerminalIO {
  return {
    print(line) {
      process.stdout.write(`${line}\n`);
    },
    ask(prompt) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
          rl.close();
          resolve(answer);
        });
      });
    },
  };
}
