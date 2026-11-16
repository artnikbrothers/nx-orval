## 0.1.0 (2026-11-16)

First public release.

### Features

- Inferred `orval` target for every project with an `orval.config.*` file, including configs in subfolders. Inputs are the config, its imports, local specs and the installed Orval version; outputs are read from the config, so a cache hit restores the generated files.
- `nx affected` across projects: a client whose spec lives in another project gets a graph edge to that project (`inferDependencies`).
- `nx-orval:init` generator, also run by `nx add nx-orval`: registers the plugin in `nx.json` and adds Orval.
- `nx-orval:api` generator: creates a client library with `@nx/js:library` (or adds a config to an existing project) for any Orval client, optionally with Zod or Valibot validation and MSW mocks. The library lands in the workspace layout (`packages/<name>` with package manager workspaces on `packages/*`, otherwise `libs/<name>`) and Orval runs once right after it is created (`--skipGenerate` to opt out).
- `nx-orval:generate` executor for explicit `project.json` targets.
- Works with Nx 22 to 24 and Orval 7 to 8 (the `api` generator targets Orval 8).
