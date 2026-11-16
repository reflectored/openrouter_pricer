/**
 * Injects an OpenRouter upstream provider order into every request.
 *
 * Loaded by `orp` through:
 *   ori pi --model <id> -- -e /path/to/routing-extension.ts
 *
 * The wrapper sets OPENROUTER_PROVIDER_ORDER (comma-separated slugs) and
 * OPENROUTER_ALLOW_FALLBACKS=0|1 for the child process only.
 *
 * This module also drops the OpenRouter key from the environment. `ori pi`
 * re-exports the stored credential as OPENROUTER_API_KEY for the launched
 * harness, so stripping it in `orp` alone is not enough: without this every
 * shell the agent runs (`env`, `printenv`, any child process) can read it.
 * Set ORP_KEEP_KEY_ENV=1 to skip the scrub.
 */

const KEY_ENV_VARS = [
  "OPENROUTER_API_KEY",
  "OR_API_KEY",
  "OPENROUTER_KEY",
];

function scrubKeyEnv(): void {
  if (process.env.ORP_KEEP_KEY_ENV === "1") return;
  for (const name of KEY_ENV_VARS) delete process.env[name];
}

// Runs while Pi loads its extensions, before the first request and before any
// agent tool call can spawn a process.
scrubKeyEnv();

export default function routingExtension(pi: any) {
  pi.on(
    "before_provider_request",
    (event: any, ctx: any) => {
      scrubKeyEnv();

      const order = (process.env.OPENROUTER_PROVIDER_ORDER ?? "")
        .split(",")
        .map((slug) => slug.trim())
        .filter(Boolean);

      if (order.length === 0) return;
      if (ctx?.model?.provider && ctx.model.provider !== "openrouter") return;

      const payload = event?.payload;
      if (!payload || typeof payload !== "object") return;

      const existing =
        payload.provider && typeof payload.provider === "object"
          ? payload.provider
          : {};

      return {
        ...payload,
        provider: {
          ...existing,
          order,
          allow_fallbacks: process.env.OPENROUTER_ALLOW_FALLBACKS !== "0",
        },
      };
    }
  );
}
