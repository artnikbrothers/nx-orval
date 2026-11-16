# Contributing

Thanks for helping with nx-orval. Bug reports, ideas and pull requests are welcome.

## Setup

```sh
npm ci
```

Use Node 22.18 or newer; the repo develops against Orval 8, which needs it. The plugin itself supports Node 20.19.

## Test

```sh
npx nx run-many -t lint test build
```

Add or update unit tests next to the code (`*.spec.ts`) for every behaviour change.

## End-to-end

```sh
npx nx e2e nx-orval-e2e
```

It builds the plugin, publishes it to a local registry that listens on `127.0.0.1` only, creates a fresh Nx workspace and runs `nx add nx-orval` and the generators in it. Takes about 3 minutes. To run it against another Nx version:

```sh
NX_ORVAL_E2E_NX_VERSION=22.7.12 npx nx e2e nx-orval-e2e --skip-nx-cache
```

Set `NX_ORVAL_E2E_KEEP=1` to keep the workspace in `packages/nx-orval-e2e/tmp` for inspection.

## Pull requests

- One logical change per pull request, with tests.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `chore:`, and `feat!:` for breaking changes. Releases and the changelog are generated from them.
- Do not edit `CHANGELOG.md`; `nx release` writes it.
- Keep `README.md` and `packages/nx-orval/README.md` identical. The first is the GitHub page, the second is the npm page, and CI checks they match.
- Code is functional TypeScript: no classes, no `any`.

## Releasing

Maintainers only.

```sh
npx nx release --dry-run                  # preview the version, changelog and tag
npx nx release <version> --skip-publish
```

`nx release` bumps the version, updates `CHANGELOG.md`, commits, tags `v<version>`, pushes and creates the GitHub release. The tag starts the Release workflow, which builds that tag and publishes to npm with provenance through trusted publishing, so no npm token is stored. Run the workflow by hand with a tag name to repeat a publish.

First release: `CHANGELOG.md` already has the 0.1.0 entry, so skip `nx release` for it. npm only accepts a trusted publisher for a package that exists, so publish 0.1.0 once from your machine, link the workflow, then tag it:

```sh
npx nx run-many -t build -p nx-orval
npm publish dist/packages/nx-orval --provenance=false     # provenance needs CI, so turn it off for this one
npm trust github nx-orval --file release.yml --repo artnikbrothers/nx-orval --env npm --allow-publish
git tag v0.1.0 && git push origin v0.1.0                  # the workflow sees 0.1.0 on npm and publishes nothing
gh release create v0.1.0 --title v0.1.0 --notes-file CHANGELOG.md
```

Use `nx release` from 0.1.1 on.
