// src/host/index.ts
import z from "@deepseek-ai/schemastery";
var name = "dsh-impl-gate";
var inject = [];
var Config = z.object({
  enabled: z.boolean().default(true).description("Enable the plugin.")
});
function apply(ctx, config) {
  if (!config.enabled) return;
  ctx.effect(() => {
    console.info(`[${name}] ${"0.1.0"} loaded`);
    return () => console.info(`[${name}] unloaded`);
  });
}
export {
  Config,
  apply,
  inject,
  name
};
