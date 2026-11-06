<!-- Writing guide: playbooks/reference/readme.md. Keep the same sections as README.md. -->

# Impl Gate

[简体中文](README.md) | English

<!-- npm:start -->[![npm](https://img.shields.io/npm/v/dsh-impl-gate?logo=npm)](https://www.npmjs.com/package/dsh-impl-gate) <!-- npm:end -->[![CI](https://github.com/mofei/dsh-impl-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/mofei/dsh-impl-gate/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/mofei/dsh-impl-gate?sort=semver)](https://github.com/mofei/dsh-impl-gate/releases/latest) [![License](https://img.shields.io/github/license/mofei/dsh-impl-gate)](LICENSE) [![Maintained with RED](https://img.shields.io/badge/maintained_with-RED-C1121F)](https://github.com/exoticknight/red)

<!-- Listing badges: add a row here only after each listing is confirmed. See playbooks/reference/badges.md. -->

Local implementation gate that turns 32 IMPL-GATE assertions into callable DSH tools for DeepSeek Harness.

## Features

- TODO: **Benefit to the user**: how it works. 3–6 bullets, only what exists today.

## Install

No DSH version floor is declared in package metadata; feature compatibility depends on the DSH APIs in use. See the verification record. Use a `headless` profile.

<!-- npm:start -->

### From npm (recommended)

```sh
dsh plugin --profile headless add dsh-impl-gate
```

<!-- npm:end -->

### From GitHub

Pinned to a release tag:

```sh
dsh plugin --profile headless add github:mofei/dsh-impl-gate#v0.1.0
```

Restart DSH (or the desktop app) and reload the page. The command installs into the DSH you normally use; if you set your own `DSH_HOME`, run it in that same environment.

Installing from source is for development; see [docs/development.md](docs/development.md).

## Usage

1. TODO: first-use steps with the real English UI labels, e.g. **Settings → Plugins → Impl Gate**.

## Configuration

| Key       | Default | Description        |
| --------- | ------- | ------------------ |
| `enabled` | `true`  | Enable the plugin. |

TODO: where settings are stored; for API keys, that they go to the DSH credential store and are shown masked.

## Update, roll back, remove

See the [release notes](https://github.com/mofei/dsh-impl-gate/releases) for version changes and upgrade instructions.

To update or roll back, name the version, then restart DSH (for 24 hours after a release, an install without a version may still pick the previous one):

<!-- npm:start -->

```sh
dsh plugin --profile headless add dsh-impl-gate@X.Y.Z
```

<!-- npm:end -->

```sh
dsh plugin --profile headless add github:mofei/dsh-impl-gate#vX.Y.Z
```

To remove:

```sh
dsh plugin --profile headless remove dsh-impl-gate
```

TODO: what stays behind after removal (settings, browser storage, files), or "Nothing is left behind."

## Privacy and data

TODO: which network endpoints the plugin contacts, which files it writes, which credentials it stores. Write "None." when there are none.

## Compatibility

See [docs/compatibility.md](docs/compatibility.md).

## Development

See [docs/development.md](docs/development.md) and [CONTRIBUTING.md](CONTRIBUTING.md). When an AI agent develops, releases or maintains the plugin, have it read [AGENTS.md](AGENTS.md) first.

## License

[Apache License 2.0](LICENSE)
