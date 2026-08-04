# Contributing / PR guidelines

## Branch naming

Create branches from `main`, using a type prefix + short description:

| Prefix | Purpose |
|--------|---------|
| `feat/` | New feature |
| `fix/` | Bug fix |
| `ci/` | CI / workflow |
| `docs/` | Documentation |
| `refactor/` | Refactor (no behavior change) |
| `chore/` | Misc (deps, config) |

## Commit style (Conventional Commits)

`type(scope): description`, e.g.:

- `feat: add checkpoint/resume ...`
- `fix(tui): summary panel scroll ...`
- `ci: add GitHub Actions workflow`

Types: `feat` / `fix` / `ci` / `docs` / `refactor` / `chore`. Scope is optional.

## PR workflow

1. Branch from the latest `main` (with a type prefix).
2. Commit (Conventional Commits); make sure `npm test` is green locally.
3. Push the branch → open a PR → `main`.
4. Apply the matching label (see below).
5. Wait for CI to pass (tsc + smoke + build).
6. Merge (prefer **squash merge** so `main` history stays one commit per PR).

## Labels

| Label | Color | Purpose |
|-------|-------|---------|
| `enhancement` | green | New feature |
| `bug` | red | Bug fix |
| `harness` | blue | Harness core (orchestration / execution / tools) |
| `ci` | green | CI / workflow |
| `documentation` | blue | Documentation |
| `dependencies` | blue | Dependency updates |

## Branch protection (suggested; enable in repo Settings)

Settings → Branches → Add rule (`main`):
- ✅ Require a pull request before merging (1 review)
- ✅ Require status checks to pass before merging → check `test`
- ✅ Require branches to be up to date before merging
- (Optional) forbid force push to `main`, forbid deletion of `main`

## Notes

- `npm test` runs only offline smoke tests (no real API / secrets), so CI and
  local behave the same.
- `models.json` contains real keys and is gitignored — never commit it.
