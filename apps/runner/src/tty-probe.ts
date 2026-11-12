import { nodeTerminal } from './terminal/author-mode.js';

// Throwaway: shows whether keyboard input reaches an Nx target.
const io = nodeTerminal();
io.print(
  `stdin.isTTY=${String(process.stdin.isTTY)} stdout.isTTY=${String(process.stdout.isTTY)}`,
);
const line = await io.ask('type a line: ');
io.print(`echo: ${line}`);
