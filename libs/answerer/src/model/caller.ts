import type { z } from 'zod';
import type { CallStat, Role } from '../types.js';

export interface ModelRequest<T> {
  role: Role;
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}

export interface ModelResponse<T> {
  value: T;
  stat: CallStat;
}

export interface ModelCaller {
  call<T>(req: ModelRequest<T>): Promise<ModelResponse<T>>;
}

/** Transient failure after retries. The message never holds prompt, bank or output text. */
export class ModelCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCallError';
  }
}

/** Sign-in problem or usage limit. Stops the run; never retried. */
export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}
