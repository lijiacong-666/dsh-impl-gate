# 30 · Release a version

Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`:

```
gate (tag == v<package.json version>, metadata, no placeholders)
  → ci (full matrix: ubuntu/windows × Node 22.19/24)
  → npm (OIDC Trusted Publishing; skipped if the version is already on npm or NPM_PUBLISH=false)
  → github-release (auto-generated notes + optional introduction; GitHub adds the source archives)
```

For an npm plugin's very first release, do 20-npm §3 instead; it covers `v0.1.0`. For a GitHub-only plugin's first release, the version is already `0.1.0`, so start at step 3.

## In this repository (2026-11): staged publish, approved in the browser

The pipeline above assumes OIDC Trusted Publishing, which needs a GitHub-hosted runner that can reach npm. Here the maintainer publishes **from the local machine** first, then pushes the tag; the workflow's npm job then prints `dsh-impl-gate@X.Y.Z is already on npm; skipping.` That is expected, not a failure.

Why the detour: the npm account uses a **security key (passkey)** for two-factor auth. The npm CLI cannot complete a WebAuthn prompt, so `npm publish` fails with:

```text
403 Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

Bypass-2FA tokens are deprecated (removed January 2027) and the granular-token page no longer offers the checkbox, so the working path is **staged publish + one human approval**:

```sh
# ~/.npmrc: a granular token with publish rights, scoped key (npm 11 rejects a bare _authToken)
# //registry.npmjs.org/:_authToken=***
npm whoami                     # must print the publishing account
npm stage publish              # prints "staged with id <uuid>"
```

Then open npmjs.com → **Staged Packages**, review the tarball, and approve with the passkey. `npm stage approve <id>` cannot help: it needs an OTP and prints the authorization URL masked as `***`.

Verify after approval:

```sh
npm view dsh-impl-gate version dist.shasum
npm pack --dry-run --json      # compare the shasum with what npm reports
```

Notes specific to this plugin:

- **Version, tag and `lib/` move together.** `pnpm verify` rebuilds `lib/` (the version is baked in), so bump → verify → commit → tag.
- **Tags can be pushed while npm is unreachable.** If `git push` fails with `Failed to connect to github.com port 443`, keep the local tag and push later; the staged version on npm is independent of the tag.
- **Old tags may never have triggered a workflow.** When the network came back, `v0.3.1`, `v0.3.2` and `v0.3.4` were released through the API because their tag pushes happened during an outage. Creating a Release by hand for an existing tag is fine; creating a second tag for the same version is not.
- **A stale staged version cannot be edited.** If you spot a bug after staging, bump the patch (0.4.6 → 0.4.7) and stage again; rejecting the old stage also needs the browser.

## Preconditions

- On `main`, working tree clean, up to date with `origin/main`.
- The latest CI run on `main` is green: `gh run list --workflow ci.yml -b main -L 1`.

## Release notes during development

GitHub Releases are the version history; the plugin READMEs link there, including on npm. There is no separately maintained `CHANGELOG.md`.

Use descriptive PR titles: they become the release entries. For categorization, apply labels to the PR itself (an issue's labels are not enough):

| PR label | Release section |
| --- | --- |
| `breaking-change` | Breaking Changes |
| `enhancement` | Features |
| `bug` | Fixes |
| Anything else or no label | Other Changes |

The first matching category in `.github/release.yml` wins. GitHub supplies author attribution, contributor information and the full comparison link. It does not infer features from source code. PRs are optional: direct pushes still release, but changes without PRs may need a written introduction to be described clearly.

GitHub chooses the previous release automatically. Check the comparison range during release verification, especially when using prereleases or maintaining multiple release lines. If a plugin needs a fixed baseline, adapt its workflow to pass `--notes-start-tag` before tagging. See [GitHub's generated notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes).

## 1. Choose the version

Semantic Versioning. Before 1.0.0, a breaking change bumps the minor version (0.3.x → 0.4.0) and everything else bumps the patch. Use a prerelease (`0.4.0-rc.1`) to let users try a change early; it goes to npm `next` and is marked as a GitHub prerelease.

## 2. Update files

- Optional: `docs/release-notes/vX.Y.Z.md` for highlights or migration steps prepended to the automatic GitHub Release notes. See [the example](../docs/release-notes/README.md).
- `README.md` and `README.en.md`: check them against the "When to update" table in [reference/readme.md](reference/readme.md), and update the pinned `github:<owner>/<name>#vX.Y.Z` install command.
- If the verified DSH version changed: update the places listed in [40-maintain.md](40-maintain.md) § New DSH version, step 4.

## 3. Bump, build, check

```sh
npm version X.Y.Z --no-git-tag-version
pnpm verify
pnpm check:release vX.Y.Z
```

The version is baked into `lib/`, so `pnpm verify` rebuilds it and `lib/` changes.

## 4. Commit and wait for CI

```sh
git add -A
git commit -m "chore: release vX.Y.Z"
git push origin main
gh run watch "$(gh run list --workflow ci.yml -b main -L 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

## 5. Tag

```sh
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
gh run watch "$(gh run list --workflow release.yml -L 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

## 6. Verify

```sh
gh release view vX.Y.Z --json tagName,isPrerelease,url,body
npm view dsh-impl-gate@X.Y.Z version dist.shasum          # npm plugins
```

Reproduce a user install in a throwaway DSH home. Always name the exact version: for 24 hours pnpm prefers the previous release ([reference/installing.md](reference/installing.md)).

```sh
npm pack --dry-run --json                  # compare shasum with npm view
dsh plugin --profile <profile> add dsh-impl-gate@X.Y.Z   # then confirm the tools load
```

Each run must end with "Smoke test passed". The script never touches the user's own DSH home; do not replace it with hand-written `DSH_HOME=… dsh …` commands.

## Recovery

Find the failed job first: `gh run view <run-id> --log-failed`.

| Where it failed       | What was published  | Do this                                                                                                                                                                                                                   |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate` or `ci`        | Nothing             | Fix on `main`. Ask the user before moving the tag, then delete it (`git push origin :refs/tags/vX.Y.Z`, `git tag -d vX.Y.Z`; the tag ruleset needs admin bypass) and tag the fixed commit. Alternatively release X.Y.Z+1. |
| `npm`, config problem | Nothing             | Fix the Trusted Publisher or environment (20-npm Troubleshooting), then **Re-run failed jobs** on the same run.                                                                                                           |
| `github-release`      | npm has the version | **Re-run failed jobs** only. The npm job skips because the version exists. Never re-tag a version npm already has.                                                                                                        |
| Released but broken   | Everything          | Never reuse the number. Fix, release X.Y.Z+1, then ask the user to run `npm deprecate <name>@X.Y.Z "<reason>"`.                                                                                                           |

## Done when

- [ ] The release workflow is green
- [ ] The GitHub Release `vX.Y.Z` contains the optional introduction and generated notes; check the PR categories, attribution and comparison range
- [ ] npm shows the version with provenance (npm plugins)
- [ ] The smoke install works
- [ ] After the first release, continue with [50-listings.md](50-listings.md). After later releases, only when the description or install command changed
