## Bench Baselines

JSON baseline files live here, named `<git-commit-sha>.json`.

Generate via:

```bash
pnpm --filter @universe-editor/editor bench -- --reporter=json --outputFile=bench/baselines/$(git rev-parse --short HEAD).json
```

The committed JSON becomes the reference for detecting performance regressions.
CI compares new runs against the most recent committed baseline.
