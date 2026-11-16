# Commit generated code or not

Both work.

## Commit it

Reviewable API changes, no setup for consumers. Check freshness in CI:

```sh
npx nx run-many -t orval && git diff --exit-code
```

## Ignore it

Add `src/generated` to `.gitignore`, then generate before anything that imports it:

```jsonc
// nx.json
{
  "targetDefaults": {
    "build": { "dependsOn": ["^build", "orval", "^orval"] },
    "typecheck": { "dependsOn": ["orval", "^orval"] },
    "test": { "dependsOn": ["^orval"] }
  }
}
```

Tip: `**/src/generated/** linguist-generated=true` in `.gitattributes` collapses generated files in GitHub diffs.
