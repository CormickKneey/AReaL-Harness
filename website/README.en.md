# AReaL-Harness website

[中文](README.md) | **English**

The bilingual marketing and download website is an independent React/Vite application. It uses the selected dark visual design, the existing brand assets, and the real TUI screenshot. The screenshot retains its original aspect ratio and includes a link to the complete image. The original is taller than the selected visual concept.

## Local development

Use Node.js 22. Run these commands in `website/`.

```sh
npm ci
npm run dev -- --host 127.0.0.1
```

The default language is English. The EN / 中文 controls translate the page, document metadata, accessible labels, and documentation destinations. The `lang=en` or `lang=zh` query parameter overrides the saved language. The URL also retains the selected client, channel, platform, and section. Local storage is optional.

```sh
npm run build
npm run check
npm run test:sites
```

The static website is in `dist/client/`. Relative asset URLs support a GitHub Pages project path, including fork repository paths. The Sites packaging files also produce `dist/server/` and `dist/.openai/`. Upload only `dist/client/` to Pages.

`check` verifies release ordering and channel separation, missing-package behavior, trusted asset URLs, upload completeness, translation parity, atomic refresh failures, and built relative assets. Browser acceptance is still needed for appearance, interactions, and responsive layout.

## Release catalog

Visitors read the `src/generated/releases.json` snapshot included in the site build. Ordinary development and builds use the committed snapshot without requesting the GitHub API. Pages deployments refresh the catalog before building. Download sources always come from the official `areal-project/AReaL-Harness` repository, regardless of the repository hosting this site.

```sh
npm run refresh:releases
npm run refresh:releases -- --input saved-github-releases.json
```

The optional `GH_TOKEN` environment variable authenticates the build script only. It is never included in browser code. Saved input must contain the full GitHub releases array, including asset `state`, `size`, and `browser_download_url`. The script validates the selected releases and writes the catalog atomically. A failed refresh exits with an error and preserves the previous snapshot.

GUI tags use `gui-v<version>`. TUI tags use `v<version>`. Draft and metadata tags are excluded. Each client and channel selects the highest numeric SemVer before checking packages. Stable requires both a final version and `prerelease=false`. Other recognized published versions belong to Preview. A missing package does not fall back to an older version or another channel.

GUI supports macOS Apple Silicon only and prefers the release DMG, then ZIP. TUI supports macOS ARM64 and Linux x86_64 with glibc 2.35+. TUI downloads use the complete archive with the matching release installer and checksums. You can copy the selected archive download command or its direct URL. The command downloads the archive. Follow the existing installation guide for setup. The site links the existing installation guides and does not execute installers.

Preview releases are for early testing and may be unstable. macOS preview builds are not notarized. The stable GUI signing statement applies to that distribution only. It does not imply that the TUI or all Runtime binaries are notarized.

## GitHub Pages

The workflow in `../.github/workflows/website.yml` builds and checks website changes on pull requests and pushes to `main`. A manual run also defaults to validation only.

Add the workflow to the hosting repository's default branch and enable Actions. An administrator first selects **GitHub Actions** as the Pages source and allows the `github-pages` environment to deploy from the default branch. If the environment requires approval, automatic deployments also wait for approval. The workflow configures an existing Pages site and does not enable Pages automatically.

Set the non-secret repository variable `WEBSITE_AUTO_DEPLOY=true` in the hosting repository to enable automatic deployment. No new secret is required. When the official repository hosts the site, `release.published` immediately queues a default-branch deployment through a relay. This covers stable releases and preview releases published from drafts. A successful relay means the deployment request was accepted. Creating a draft does not trigger deployment.

An hourly schedule at minute 17 reads official Releases. It covers fork hosting, publication with `GITHUB_TOKEN` that suppresses subsequent events, and older tags without the relay workflow. Every scheduled run builds and deploys, so there are 24 baseline deployment attempts per day. Website source changes merged into the default branch also deploy on the next scheduled run. GitHub can delay or drop scheduled runs and disables schedules in public repositories after 60 days without activity. This is not a strict one-hour synchronization SLA.

To deploy manually, run **Website** from the default branch with **deploy** set to `true`. Manual deployment does not require the automatic deployment variable. Other branches cannot deploy. Pull requests, pushes, and manual validation do not deploy directly.

Every deployment checks out the default branch and refreshes the complete GUI stable, GUI preview, TUI stable, and TUI preview catalog. It then builds, checks, uploads `dist/client/`, and deploys. The existing TUI download command and direct URL still use the same catalog. Only the deployment job has Pages and identity-token write permissions. All deployments share one concurrency group and leave an active deployment running. A refresh, build, or check failure preserves the last successful site. Refreshes update only the runner workspace and do not commit the snapshot. Run the explicit refresh command and commit the generated catalog when updating the ordinary offline snapshot.
