# nx-orval

[![npm](https://img.shields.io/npm/v/nx-orval.svg)](https://www.npmjs.com/package/nx-orval)
[![CI](https://github.com/artnikbrothers/nx-orval/actions/workflows/ci.yml/badge.svg)](https://github.com/artnikbrothers/nx-orval/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/artnikbrothers/nx-orval/blob/main/LICENSE)

[Orval](https://orval.dev) in an Nx monorepo: cached, in the project graph, one command to add a client.

```sh
npx nx add nx-orval
```

## What you get

- An `orval` target for every project with an `orval.config.*`. No `project.json` wiring.
- Real Nx caching: a cache hit restores the generated files.
- `nx affected`: change a spec, and its clients rebuild.
- `nx g nx-orval:api`: a new client library in one command.

## Quick start

```sh
npx nx g nx-orval:api petstore --spec=apps/api/openapi.yaml --client=react-query
npx nx run petstore:orval     # cache hit
npx nx affected -t orval      # clients whose spec changed
```

No spec yet? Drop `--spec` to start from a sample.

Already use Orval? `nx add nx-orval` is enough, then `nx run-many -t orval`.

## The `api` generator

Creates a library, writes `orval.config.ts`, installs what the client imports, runs Orval once.

| Option | Default | |
| --- | --- | --- |
| `--spec` | sample spec | path or URL |
| `--client` | `fetch` | any Orval client: `react-query`, `axios`, `zod`, `valibot`, ... |
| `--validation` | none | `zod` or `valibot` schemas next to the client |
| `--httpClient` | Orval's | `fetch` or `axios` for query clients |
| `--mock` | off | MSW mocks |
| `--directory` | `packages/<name>` or `libs/<name>` | follows your workspaces |
| `--project` | | add to an existing project instead |
| `--skipGenerate` | off | scaffold only |

The config starts with monorepo-friendly defaults: one file per API tag, models apart from operation params, the formatter your repo already uses, and a header that does not change when Orval updates.

## Plugin options

```jsonc
// nx.json
{
  "plugins": [
    {
      "plugin": "nx-orval",
      "options": {
        "targetName": "orval",
        "cacheRemoteSpecs": false,   // cache clients built from a URL spec
        "inferDependencies": true    // client -> spec project graph edge
      }
    }
  ]
}
```

## Compatibility

| | Versions |
| --- | --- |
| Nx | 22-24 |
| Orval | 7-8 (`api` generator: 8, valibot: 8.48+) |
| Node | 20.19+ (Orval 8 needs 22.18+) |

## More

- [Caching, inputs and outputs](https://github.com/artnikbrothers/nx-orval/blob/main/docs/caching.md)
- [Commit generated code or not](https://github.com/artnikbrothers/nx-orval/blob/main/docs/generated-code.md)
- [Executor for explicit targets](https://github.com/artnikbrothers/nx-orval/blob/main/docs/executor.md)
- [Contributing](https://github.com/artnikbrothers/nx-orval/blob/main/CONTRIBUTING.md)

## License

[MIT](https://github.com/artnikbrothers/nx-orval/blob/main/LICENSE)
