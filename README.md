# ⎈ ArgoCD Helm Chart Scanner

Find outdated Helm charts in your ArgoCD `Application` manifests. Route each update to a report, a tracking issue, or a ready-to-merge pull request, and keep a `HELM_CHANGELOG.md` audit trail of every chart version that lands in your repo.

- **Zero config, read-only by default.** One step gives you a job summary of every outdated chart.
- **Routing per update type.** For example, send major/minor updates to issues for human review and low-risk patch updates to PRs.
- **No noise.** Exactly one open issue *or* PR per chart source. It is updated in place when a newer version ships and closed automatically once you upgrade.
- **Audit trail.** `HELM_CHANGELOG.md` records upgrades, downgrades, additions, removals and non-semver changes, with release-notes links.
- **Insights.** Flags charts deprecated upstream and the same chart pinned to different versions across environments.
- **Any public registry, no extra tools.** Helm HTTP repositories and OCI registries (`ghcr.io`, Docker Hub, `public.ecr.aws`, …), with or without `oci://`.

## Quick start

```yaml
name: Helm chart scan
on:
  schedule:
    - cron: "0 1 * * *"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: juniyadi/argocd-helm-chart-scanner@v1
```

The results appear in the run's job summary.

Even report-only runs compute the changelog (the first run writes a baseline, so `changelog-updated` is `true`); set `changelog-file: ""` to skip it.

## Recipes

### Issues for major/minor, PRs for patch

```yaml
permissions:
  contents: write
  issues: write
  pull-requests: write

steps:
  - uses: actions/checkout@v7
  - uses: juniyadi/argocd-helm-chart-scanner@v1
    with:
      path: clusters
      issue-types: major,minor
      pr-types: patch
```

PR mode needs **Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"** enabled.

### Make scanner PRs trigger your CI

PRs opened with the default `GITHUB_TOKEN` do not trigger other workflows. Pass a PAT or GitHub App token instead:

```yaml
  - uses: juniyadi/argocd-helm-chart-scanner@v1
    with:
      pr-types: patch
      token: ${{ secrets.HELM_SCANNER_TOKEN }}
```

### Commit `HELM_CHANGELOG.md`

The action writes the changelog into the workspace but never commits it. Pick how it lands:

```yaml
permissions:
  contents: write
  pull-requests: write

steps:
  - id: scan
    uses: juniyadi/argocd-helm-chart-scanner@v1
  - if: steps.scan.outputs.changelog-updated == 'true'
    uses: peter-evans/create-pull-request@v8
    with:
      branch: helm-scanner/changelog
      title: "docs: update HELM_CHANGELOG.md"
      commit-message: "docs: update HELM_CHANGELOG.md"
      add-paths: HELM_CHANGELOG.md
```

This needs `contents: write`, `pull-requests: write` and **Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"** enabled.

Merge the changelog PR before the next scheduled run. If it stays open, the next run regenerates the entries under its own date and the `closes #n` links from the earlier run are lost. Alternatively, commit the file directly (for example with `stefanzweifel/git-auto-commit-action`).

The first run only records a baseline. Entries start appearing once a chart version changes.

### Scanning several paths

Use one step per path:

```yaml
steps:
  - uses: actions/checkout@v7
  - uses: juniyadi/argocd-helm-chart-scanner@v1
    with:
      path: clusters/dev
  - uses: juniyadi/argocd-helm-chart-scanner@v1
    with:
      path: clusters/prod
```

Each run only closes trackers and records changelog entries for keys under its own `path`. Both steps may share one changelog file.

### Notify the owners

List people or teams in `mentions`. Use one step per path to route each path to its own owners:

```yaml
  - uses: juniyadi/argocd-helm-chart-scanner@v1
    with:
      path: clusters/prod
      issue-types: major,minor
      mentions: acme/platform-team,alice
```

Owners are notified when an issue or PR is created. Open trackers get the Owners row on the next run. Team mentions only notify when the token can see the team. If the default `GITHUB_TOKEN` does not notify your team, pass a PAT or GitHub App token through `token`.

## Inputs

| Input | Default | Description |
|---|---|---|
| `path` | `.` | Directory scanned recursively for `*.yml` / `*.yaml`. |
| `issue-types` | `''` | Comma list of `major`, `minor`, `patch` that get a tracking issue. |
| `pr-types` | `''` | Comma list of `major`, `minor`, `patch` that get a PR bumping `targetRevision`. Wins over `issue-types`. |
| `labels` | `helm-update` | Comma list of labels for issues and PRs. The **first** label is used to find existing trackers. Missing labels are created. |
| `mentions` | `''` | Comma list of users or `org/team` (`@` optional) listed as **Owners** in every issue and PR body, so they get notified. |
| `changelog-file` | `HELM_CHANGELOG.md` | Changelog path relative to the repo root. Empty disables it. |
| `token` | `${{ github.token }}` | Token for `gh` and `git push`. |

When both `issue-types` and `pr-types` are empty, the action only reports.

## Outputs

| Output | Description |
|---|---|
| `updates` | JSON array: `{file, app, chart, repoURL, current, latest, type, deprecated, action, url}` per outdated chart source. `action` is `report`, `issue`, `pr`, or `manual`. |
| `updates-count` | Number of outdated chart sources. |
| `changelog-updated` | `true` when the changelog file was written. |

## Permissions

| Mode | Permissions |
|---|---|
| Report only | `contents: read` |
| Issues | `contents: read`, `issues: write`, `pull-requests: read` |
| PRs (with or without issues) | `contents: write`, `issues: write`, `pull-requests: write` |

Tracker modes always read both issues and PRs, so each chart source keeps a single tracker even when you switch between issue and PR routing. Labels are created through the issues API.

## How tracking works

- Each chart source is identified by `<file>#<app>/<chart>`. That key is stored as a hidden marker in the issue or PR body.
- A newer upstream version updates the existing issue or PR in place. PR branches (`helm-scanner/…`) are force-pushed only when the target version changes.
- Once `targetRevision` reaches the latest version, the tracker is closed with a comment. It is also closed if the chart source disappears.
- A registry error never closes a tracker.
- If `pr-types` matches but the scanner cannot safely edit the file (zero or several matching `targetRevision` lines), it opens an issue marked **manual** instead.
- Removing the tracking label from an issue or PR detaches it from the scanner.
- Upstream release notes are embedded as plain text, so mentions, issue references and HTML in them stay inert.
- Run PR mode from the default branch: PRs are built on the checked-out commit and target the default branch.

## Changelog format

```markdown
## 2026-09-19

- **external-secrets** `0.9.20` → `0.10.0` (MINOR) · `clusters/prod/external-secrets.yaml` · [release notes](…) · closes #42
- **redis** added at `19.0.0` · `clusters/dev/redis.yaml`
```

The file ends with a `<!-- helm-scanner-state: … -->` line that holds the last seen versions. Do not edit it by hand.

## Limitations

- Public registries and Helm repositories only; no credentials support yet.
- `ApplicationSet` templates are not scanned.
- Non-semver `targetRevision` values (`1.2.*`, `HEAD`) are reported but never tracked.
- `github.com` only; GitHub Enterprise Server is not supported yet.
- Linux and macOS runners; Windows is not supported.
- Runs on GitHub-hosted runners out of the box. Self-hosted runners need `gh`, `git` and `unzip` installed (`unzip` is used by `setup-bun`).
- PR mode expects the repository to be checked out at the workspace root.

## License

[MIT](LICENSE)
