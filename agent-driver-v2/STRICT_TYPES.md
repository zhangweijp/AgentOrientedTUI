# TypeScript 7 strict consumers

The current AI 6 declaration graph needs a temporary `@ai-sdk/provider-utils@4.0.65` type patch under `exactOptionalPropertyTypes: true`. The Driver exports the complete AI Tool and message types. It does not narrow those types, disable strict checking, or patch consumers in a postinstall hook.

The Driver tar contains `patches/provider-utils-4.0.65.patch`. Before your first install, extract it into your application's versioned `patches/` directory.

```sh
mkdir -p patches
tar -xOf ../../artifacts/aotui-agent-driver-v2-0.3.2.tgz package/patches/provider-utils-4.0.65.patch > patches/provider-utils-4.0.65.patch
```

Add the exact dependencies and `patchedDependencies` to your consumer manifest. The paths below use the local delivery layout. The Driver itself also declares `@types/json-schema` as a direct dependency for its public types.

```json
{
  "dependencies": {
    "@aotui/agent-driver-v2": "file:../../artifacts/aotui-agent-driver-v2-0.3.2.tgz",
    "ai": "6.0.326",
    "@ai-sdk/provider-utils": "4.0.65",
    "zod": "4.6.7"
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

Run pnpm from the consumer directory to apply the patch and create its lockfile.

```sh
pnpm install
```

Commit your patch, manifest and lockfile. Subsequent clean installs use `pnpm install --frozen-lockfile`; pnpm verifies and applies the recorded patch. Keep `strict: true`, `exactOptionalPropertyTypes: true`, and `skipLibCheck: false`. Do not override every provider-utils major to 4.x: older providers retain their own compatible dependencies.

The patch changes only `NeverOptional`'s erased generic branch in source and declarations. Runtime JavaScript and concrete Tool input/output contracts are unchanged. Remove this explicit temporary consumer requirement when a verified formal upstream release incorporates the fix. A normal Driver tar alone does not automatically repair third-party declarations.

The repository Driver and Host use the same Zod 4.6.7 peer context. When linking a local Driver into a Host, keep their Zod versions aligned so TypeScript resolves one `provider-utils` schema identity.
