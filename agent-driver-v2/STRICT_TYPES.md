# TypeScript 7 strict consumers

The current AI 6 declaration graph needs a temporary `@ai-sdk/provider-utils@4.0.65` type patch under `exactOptionalPropertyTypes: true`. The Driver exports the complete AI Tool and message types. It does not narrow those types, disable strict checking, or patch consumers in a postinstall hook.

This package ships `patches/provider-utils-4.0.65.patch`. **A dependency's pnpm settings are not inherited by its consumers.** Copy that asset into your application's versioned `patches/` directory and configure your application's package manager:

```json
{
  "dependencies": {
    "@aotui/agent-driver-v2": "0.3.0",
    "ai": "6.0.326",
    "@ai-sdk/provider-utils": "4.0.65",
    "zod": "3.25.76"
  },
  "devDependencies": {
    "@types/json-schema": "7.0.15"
  },
  "pnpm": {
    "patchedDependencies": {
      "@ai-sdk/provider-utils@4.0.65": "patches/provider-utils-4.0.65.patch"
    }
  }
}
```

If bootstrapping from an installed Driver, copy its patch before enabling the setting:

```sh
mkdir -p patches
cp node_modules/@aotui/agent-driver-v2/patches/provider-utils-4.0.65.patch patches/
pnpm install
```

Commit your patch, manifest and lockfile. Subsequent clean installs use `pnpm install --frozen-lockfile`; pnpm verifies and applies the recorded patch. Keep `strict: true`, `exactOptionalPropertyTypes: true`, and `skipLibCheck: false`. Do not override every provider-utils major to 4.x: older providers retain their own compatible dependencies.

The patch changes only `NeverOptional`'s erased generic branch in source and declarations. Runtime JavaScript and concrete Tool input/output contracts are unchanged. Remove this explicit temporary consumer requirement when a verified formal upstream release incorporates the fix. A normal Driver tar alone does not automatically repair third-party declarations.

For this repository’s `./run.sh` local links, Driver development uses the same Zod 3.25.76 peer context as Host. Keep the linked packages’ peer contexts aligned: mixing separately installed Zod 3 and Zod 4 contexts produces distinct `provider-utils` schema identities even with the same AI version and patch. This is an installation requirement for the local graph, not a replacement Tool type or a global override of older provider dependencies.
