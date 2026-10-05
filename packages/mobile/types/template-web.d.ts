/**
 * Backend type surface for the mobile tsc program only.
 *
 * `packages/web/src/api` is a Bun/Node server codebase (`process.cwd()`,
 * `Bun.spawn`, `import.meta.dir`…). Importing `AppRouterClient` straight from
 * `@template/web` pulls every one of those files into Expo's tsc program, where
 * `expo-modules-core` declares a global `process` typed `{ env: ProcessEnv }` —
 * so the server code can never type-check there, whatever `types` we set.
 *
 * `tsconfig.json` maps `@template/web` to this file: mobile keeps a typed oRPC
 * client, web keeps ownership of the real types (`bun run typecheck:api` in
 * `packages/web`). The import is type-only, so runtime is unchanged.
 *
 * Keep this mirroring `router` in `packages/web/src/api/index.ts` — one entry
 * per oRPC procedure, `Client<Context, Input, Output, Error>`.
 */
declare module "@template/web" {
  import type { Client } from "@orpc/client";

  export type AppRouterClient = {
    ping: Client<Record<never, never>, void | undefined, { message: string }, Error>;
  };

  export type AppRouter = AppRouterClient;
}
