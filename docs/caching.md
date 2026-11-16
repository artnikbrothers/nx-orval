# Caching, inputs and outputs

## Outputs

Read from each Orval project's `output`:

| Config | Cached |
| --- | --- |
| `workspace: './src/generated'` | that folder |
| `target: 'src/api/petstore.ts'` (`single`, `split`) | `src/api/petstore.*` only |
| `mode: 'tags'`, `'tags-split'` | the target's folder |
| `schemas`, `operationSchemas` | those folders |

Keep generated code in its own folder. If an output would cover the project root, or anything sits outside the workspace, caching is off for that config. `nx show project <name>` says why.

## Inputs

- the project's files, minus generated outputs
- files the config imports by relative path, also from outside the project (`../../tools/orval/base.ts`)
- the spec, spec files next to it, and relative `$ref`s
- the root formatter config
- the installed Orval version

Not tracked: package imports and env vars.

## Remote specs

A URL spec cannot be hashed, so it is not cached. Set `cacheRemoteSpecs: true` to cache anyway; refresh with `--skip-nx-cache`.

## Env files

Configs that `import 'dotenv/config'` get their `.env.local`, `.env` or `.env.example` at graph time. Real env vars win.

## Where to put the spec

The client -> spec edge is project-level: any change in the spec's project marks the client affected. Keep specs in a small project of their own (for example `api-spec`). If the edge makes a cycle, set `inferDependencies: false`.
