/**
 * Test-only Node resolver for TypeScript's extensionless relative imports.
 * Next's bundler resolves these in production. This shim has no network access,
 * only retries a missing relative import with the literal ".ts" suffix.
 */
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".") ||
          /\.[cm]?[jt]sx?$/.test(specifier)) throw error;
      return nextResolve(specifier + ".ts", context);
    }
  },
});
