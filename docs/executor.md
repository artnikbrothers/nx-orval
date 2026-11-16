# Executor

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

| Option | |
| --- | --- |
| `config` | defaults to the project's `orval.config.*` |
| `project` | one Orval project key |
| `args` | extra CLI flags |
