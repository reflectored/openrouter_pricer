/**
 * Injects an OpenRouter upstream provider order into every request.
 *
 * Loaded by `orp` through:
 *   ori pi --model <id> -- -e /path/to/routing-extension.ts
 *
 * The wrapper sets OPENROUTER_PROVIDER_ORDER (comma-separated slugs) and
 * OPENROUTER_ALLOW_FALLBACKS=0|1 for the child process only.
 */
export default function routingExtension(pi: any) {
  pi.on(
    "before_provider_request",
    (event: any, ctx: any) => {
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
