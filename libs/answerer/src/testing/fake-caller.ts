import type {
  ModelCaller,
  ModelRequest,
  ModelResponse,
} from '../model/caller.js';

/** Scripted caller for tests: one function per call, in order. Throw to simulate a failure. */
export function fakeCaller(
  script: Array<(req: ModelRequest<unknown>) => unknown>,
): ModelCaller & { requests: ModelRequest<unknown>[] } {
  const requests: ModelRequest<unknown>[] = [];
  let next = 0;
  return {
    requests,
    async call<T>(req: ModelRequest<T>): Promise<ModelResponse<T>> {
      requests.push(req as ModelRequest<unknown>);
      const step = script[next++];
      if (!step) throw new Error('fakeCaller: script exhausted');
      const started = Date.now();
      const value = req.schema.parse(step(req as ModelRequest<unknown>));
      return {
        value,
        stat: {
          role: req.role,
          model: req.model,
          latencyMs: Date.now() - started,
          costUsd: null,
          ok: true,
        },
      };
    },
  };
}
