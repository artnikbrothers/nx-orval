# nx-orval

[![npm](https://img.shields.io/npm/v/nx-orval.svg)](https://www.npmjs.com/package/nx-orval)
[![CI](https://github.com/artnikbrothers/nx-orval/actions/workflows/ci.yml/badge.svg)](https://github.com/artnikbrothers/nx-orval/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/artnikbrothers/nx-orval/blob/main/LICENSE)

Nx plugin for [Orval](https://orval.dev). Add type-safe API clients to an Nx monorepo in one command, and let Nx cache, graph and `affected` them like any other task.

```sh
npx nx add nx-orval
```

## Why

Running Orval in a monorepo by hand means a script per client, no caching, and clients that silently go stale when a backend changes its OpenAPI file. `nx-orval` fixes that:

- **Inferred targets.** Any project with an `orval.config.{ts,mts,cts,js,mjs,cjs}` gets an `orval` target, also when the config sits in a subfolder (`src/lib/orval-config/`). No `project.json` wiring.
- **Real caching.** Inputs are the config and everything it imports, the local spec files and the installed Orval version. Outputs are read from the config, so a cache hit restores the generated files.
- **`nx affected` across projects.** When a client's spec lives in another project (say `apps/api/openapi.yaml`), the plugin adds a graph edge from the client to that project. Change the spec, and the client and everything that imports it shows up as affected. The edge is project-level, so any change in the spec's project marks the client affected; turn it off with `inferDependencies: false`.
- **Generators.** `init` registers the plugin and installs Orval. `api` scaffolds a client library (or adds a config to an existing project) for any Orval client: fetch, axios, React/Vue/Svelte/Solid Query, Angular, SWR, Pinia Colada, Hono, Effect, MCP, Zod, Valibot, and runs Orval once so the library is usable right away.

## Quick start

```sh
npx nx add nx-orval            # installs the package, registers the plugin in nx.json, adds orval
npx nx g nx-orval:api petstore --spec=apps/api/openapi.yaml --client=react-query
npx nx run petstore:orval      # cache hit
npx nx affected -t orval       # clients whose spec project changed
```

No spec yet? Leave out `--spec` and the new library starts from a sample `openapi.yaml`.

`nx g nx-orval:api` creates the library and runs Orval once, so `src/generated` exists when the command returns. Pass `--skipGenerate` to only scaffold. `nx list nx-orval` shows everything the plugin provides.

Already use Orval? The plugin needs no configuration for existing setups:

```sh
npx nx add nx-orval
npx nx show projects --with-target orval   # every project with an orval.config.* file
npx nx run-many -t orval
```

A package.json script such as `"generate:api": "orval"` keeps working, but it runs uncached; call the inferred target instead. `nx show project <name>` says why a target is not cached.

## Compatibility

| | Supported | Notes |
| --- | --- | --- |
| Nx | 22, 23, 24 | CI runs the end-to-end suite against Nx 22 and 24 |
| Orval | 7 and 8 | The inferred target works with both. The `api` generator writes an Orval 8 config, and Valibot output needs Orval 8.48 or newer |
| Node | 20.19 or newer | Orval 8 itself needs Node 22.18 or newer. CI runs the unit tests on Node 20.19, 22 and 24 |
| `@nx/js` | 22 to 24 | Optional. The `api` generator uses it to create libraries, and installs it at the workspace's Nx version when missing |

## The api generator

```sh
npx nx g nx-orval:api petstore --spec=apps/api/openapi.yaml --client=react-query
```

A new library is created with `@nx/js:library`, so it matches the workspace layout. It goes where the workspace keeps packages: the first package manager workspaces glob of the form `<dir>/*` decides the folder (`packages/*` gives `packages/petstore`), and without workspaces it is `libs/petstore`. Use `--directory` to put it somewhere else. With package manager workspaces you get a `package.json`-based project named after its package (`@scope/petstore`, so run `nx run @scope/petstore:orval`); with TS path aliases, a `project.json` project named `petstore`. The library also gets a short README and keeps `src/generated` out of lint.

After creating the library the generator installs the packages the generated code imports (axios, TanStack Query, SWR, Zod, Valibot, MSW for `--mock`), keeping versions the workspace already has, and runs `orval` once. Framework clients (Angular, Hono, Effect, MCP, Solid Start, Pinia Colada) expect the app to have their framework already.

| Option | Effect |
| --- | --- |
| `name` | API name, used as the Orval project key and the library name; with `--project` it defaults to the project's name |
| `--directory=<path>` | where to create the library |
| `--project=<name>` | adds the config to an existing project instead of creating a library; needs `--spec` or an `openapi.*` file in the project root |
| `--spec=<path or URL>` | the OpenAPI spec; a new library starts from a sample spec when omitted |
| `--client=<client>` | the Orval client to generate, `fetch` by default |
| `--httpClient=fetch\|axios` | HTTP layer for query clients |
| `--validation=zod\|valibot` | adds a second config entry with runtime schemas in `src/generated/<validation>`, exported as a `zod` / `valibot` namespace |
| `--mock` | MSW mocks |
| `--tags=<a,b>` | Nx tags for the new library |
| `--linter=<linter>` | linter for the new library, the one the workspace already uses by default |
| `--skipGenerate` | do not run Orval after creating the library |

The generated `orval.config.ts` starts from settings that work well in a monorepo:

| Setting | Why |
| --- | --- |
| `mode: 'tags'` | one file per API tag instead of one large file |
| `schemas: './models'`, `operationSchemas: './models/operations'` | models apart from per-operation params and bodies |
| `indexFiles: true` | one import path for the whole client |
| header without the Orval version | upgrading Orval does not rewrite every file |
| `formatter` | the one the workspace already has (oxfmt, Biome or Prettier), none otherwise |
| `tsconfig` | the library's own tsconfig |

## Generated code

Decide whether `src/generated` lives in git. Both work with the inferred target.

**Commit it.** Consumers need no extra setup, and API changes show up in code review. Let CI prove the committed files are current:

```sh
npx nx run-many -t orval && git diff --exit-code
```

**Keep it out of git.** Add `src/generated` to `.gitignore` and make everything that imports a client generate it first. In `nx.json`:

```jsonc
{
  "targetDefaults": {
    "build": { "dependsOn": ["^build", "orval", "^orval"] },
    "typecheck": { "dependsOn": ["orval", "^orval"] },
    "test": { "dependsOn": ["^orval"] }
  }
}
```

Nx skips `orval` in projects that have no such target, so the defaults can stay global. Add `lint` the same way if your lint rules need the generated types.

Either way, a `.gitattributes` line such as `**/src/generated/** linguist-generated=true` makes GitHub collapse the generated files in diffs.

## Plugin options

```jsonc
// nx.json
{
  "plugins": [
    {
      "plugin": "nx-orval",
      "options": {
        "targetName": "orval",        // name of the inferred target
        "cacheRemoteSpecs": false,    // see below
        "inferDependencies": true     // client -> spec-owner graph edge
      }
    }
  ]
}
```

Specs fetched from a URL cannot be hashed by Nx, so targets with a remote spec are not cached unless `cacheRemoteSpecs` is `true`. With it on, a cached client stays stale until the config or Orval version changes; refresh with `--skip-nx-cache`.

Configs that `import 'dotenv/config'` get their own `.env.local`, `.env` or `.env.example` applied while the plugin reads them, so env-driven spec URLs resolve at graph time. Real env vars always win.

If a config cannot be evaluated at graph time (it throws, or needs an env var), the plugin still infers a runnable `orval` target, just without caching.

## Outputs

Outputs come from each Orval project's `output` block:

| Config | Cached output |
| --- | --- |
| `workspace: './src/generated'` | the workspace folder |
| `target: 'src/api/petstore.ts'` (mode `single` / `split`) | `src/api/petstore.*` only, so hand-written neighbours stay untouched |
| `mode: 'tags'` / `'tags-split'` | the target's folder |
| `schemas`, `operationSchemas` | those folders |

Keep generated code in its own folder (the `api` generator uses `src/generated`). If an output would cover the project root, or a spec or output sits outside the workspace, caching is switched off for that config, so a cache restore can never overwrite hand-written files. `nx show project <name>` lists the reason in the target's description ("Caching off: ..."); run with `NX_VERBOSE_LOGGING=true` for more detail.

Inputs are the project's own files (config, mutators, transformers) minus the generated outputs, the formatter config at the workspace root, and the installed Orval version. For a spec outside the project they are the spec, the `*.yaml`, `*.yml` and `*.json` files under its folder (`package.json`, `project.json` and `tsconfig*.json` excluded), and the files it `$ref`s with relative paths. Relative imports of the config are tracked too, including shared base configs from outside the project (`../../tools/orval/base.ts`): editing one re-reads the config and invalidates the task. Package imports (`node_modules`) and env vars a config reads are not tracked.

## Where to put the spec

The graph edge from a client to the project that owns its spec is project-level. With the spec inside a backend app, any change in that app marks the client, and everything importing it, as affected. Keep specs in a small dedicated project (just the `openapi.yaml`, for example `api-spec`) so only spec edits trigger `affected`. If the edge closes a dependency cycle, for example a backend that imports the client for contract tests, set `inferDependencies: false`.

## Executor

For explicit `project.json` targets:

```json
{
  "targets": {
    "codegen": {
      "executor": "nx-orval:generate",
      "options": { "config": "libs/petstore/orval.config.ts", "project": "petstore" }
    }
  }
}
```

`config` defaults to the project's `orval.config.*`. `project` filters to one Orval project key. `args` passes extra CLI flags.

## Development

```sh
npm ci
npx nx run-many -t lint test build
npx nx e2e nx-orval-e2e      # about 3 minutes, starts a local registry on 127.0.0.1 only
```

Set `NX_ORVAL_E2E_NX_VERSION` to run the end-to-end suite against another Nx version. See [CONTRIBUTING.md](https://github.com/artnikbrothers/nx-orval/blob/main/CONTRIBUTING.md) for the workflow, and [open an issue](https://github.com/artnikbrothers/nx-orval/issues) for bugs and ideas. Security reports go through [SECURITY.md](https://github.com/artnikbrothers/nx-orval/blob/main/SECURITY.md).

## License

[MIT](https://github.com/artnikbrothers/nx-orval/blob/main/LICENSE)
