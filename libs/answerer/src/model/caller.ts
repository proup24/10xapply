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
