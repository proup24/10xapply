import { z } from 'zod';

export const environmentSchema = z.object({
  API_KEY: z.string().min(32).regex(/^\S+$/),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
});

export type Environment = z.infer<typeof environmentSchema>;

/**
 * Validates the process environment. The error names the failing variables
 * only; it never carries a value, so a bad key cannot leak into a log.
 */
export function loadEnvironment(env: NodeJS.ProcessEnv): Environment {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    const names = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ];
    throw new Error(`Invalid environment: ${names.join(', ')}`);
  }
  return result.data;
}
