# Fork customizations (PDiTO)

This fork of the CLI Proxy API Management Center adds pages without changing upstream
behavior, so upstream changes merge in cleanly.

## Rules

- Fork-only code lives in `src/custom/` and `tests/custom*.test.ts`. Upstream never touches
  these paths.
- Upstream files are touched in exactly two places, one line each plus an import:
  - `src/router/MainRoutes.tsx`: `...customRoutes,` before the catch-all route.
  - `src/components/layout/MainLayout.tsx`: `...customObserveNavItems,` at the top of the
    Observe group.
- Text strings are registered at runtime in `src/custom/i18n.ts` under `pd_overview.*`. Do not
  edit upstream locale files.
- Reuse upstream data hooks, stores and components by importing them. If an upstream rename
  breaks the build, fix the import here rather than editing upstream code.

## Pages

- **Quota Overview** (`#/quota-overview`): pooled weekly capacity per provider, a ledger of
  credentials in `fill-first` routing order with the first available credential marked, and
  upstream's cards and quota-window timeline. It shares the quota cache with the official
  Quota Management page, loads unloaded credentials on open and refreshes every 15 minutes
  while visible.

## Sync and release

`.github/workflows/pd-sync-release.yml` runs every six hours, on demand and on pushes to `main`.
It merges `router-for-me/Cli-Proxy-API-Management-Center` `main`, runs `bun run verify`, pushes
the merge and publishes `management.html` as the latest release, tagged
`pd-<upstream version>-<commit>`. A merge conflict or failed check opens an issue and publishes
nothing. GitHub does not let the workflow push upstream changes to `.github/workflows/`; when
that happens the run opens an issue, and the merge is done locally:

```bash
git fetch upstream && git merge upstream/main && bun run verify && git push origin main
```

CLIProxyAPI serves this build when its config has
`management.panel-github-repository: "https://github.com/PDiTO/Cli-Proxy-API-Management-Center"`.
It checks for a new release every three hours. Pointing that setting back at the upstream
repository restores the official panel.
