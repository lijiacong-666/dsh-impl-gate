# Compatibility

| Item | Value |
|------|-------|
| DSH install gate | None — `engines.dsh` is `*` and the optional `@deepseek-ai/dsh` peer is `*` |
| Verified host | DSH desktop app on Windows 11 (the build installed at `D:\deep_harness`, `version` reports `44.7.0`); headless CLI verified for `dsh plugin add` and profile toggling |
| Verified profiles | `desktop` (npm install and source junction); `headless` for the CLI paths |
| Node.js | `>=22.14.0` (relaxed in 0.3.10; DSH's bundled runtime is 22.14) |
| Python | `>=3.11` with `specgraph` importable — required by `compose` and by `check`/`export`; see [install-specgraph.md](install-specgraph.md) |
| Client module | None. The plugin is host-side only: no `./client`, no DOM anchors, no UI slots. |
| Package manager | npm or pnpm for installation; the plugin itself has one runtime dependency (`@deepseek-ai/schemastery`) |

## Integration contracts

What the plugin relies on, and what happens when it is absent.

1. **Tools service.** The plugin exports `inject = ['tools']` and registers seven tools through `ctx.tools.register` inside `ctx.effect`. If the host has no `tools` service the plugin does not activate; nothing else in the plugin runs.
2. **Tool schema subset.** DSH validates each tool's JSON schema at registration and rejects unsupported constructs. Observed failure in 0.2.0: `JsonSchemaError: unsupported JSON schema: schema.properties.evidence.additionalProperties must be a boolean; … type arrays are not supported`. The plugin now stays inside the subset (`additionalProperties: false` on objects, single `type` strings, arrays of objects instead of maps) and `tests/tool-schema.test.mjs` mirrors the host rules.
3. **Bundle patch.** `package.json` declares `dsh.bundle.patch: ./cordis.patch.yml`; the patch inserts one loader entry (`dsh-impl-gate`). A profile that also inserts the same id by hand fails with a duplicate loader entry.
4. **Hot reload.** Building does not reload the profile, and touching file mtimes does not either. The loaded module is replaced only when the profile reconciles — in practice by toggling the plugin off/on in the plugin page, or by removing and re-adding its bundle entry. After a reload, confirm the tools appear before calling them.
5. **Filesystem expectations.** The plugin writes only under `outDir` (graph, `SPEC.md`, `export/`, `.impl-gate/`, `tasks/`), never inside the implementation tree — `impl_gate_record` only spawns the acceptance commands with `cwd = implRoot`. When `impl_gate_record` runs a module's tests, those tests may write wherever they like; that is the project's business.
6. **Process spawning.** `compose`/`check` spawn the specgraph CLI; `record` spawns acceptance commands. A sandbox that denies `child_process.spawn` surfaces as `E_SPAWN_DENIED` (create/spawn EPERM); `record` reports the same condition per acceptance row.

## Manual verification

Observed on Windows 11, DSH desktop build at `D:\deep_harness` (`version` = `44.7.0`), plugin installed both from npm and as a source junction.

- **2026-11-08** — seven tools listed after a profile toggle: `impl_gate_check`, `impl_gate_report`, `impl_gate_verify_contract`, `impl_gate_compose`, `impl_gate_init`, `impl_gate_review`, `impl_gate_record`.
- **2026-11-08** — `impl_gate_check` on `login-demo`: `PASS 10 / FAIL 0 / NOT-RUN 22`; `impl_gate_report` with and without `runId` after a plugin reload still answered from `.impl-gate/runs/` on disk (memory cache is 10 minutes, disk is 24 hours).
- **2026-11-09** — `impl_gate_compose materialize` on `run-log` while implementation code already existed: after 0.3.9, files outside `ownership.json` are left alone and only generated paths are refused.
- **2026-11-10** — `impl_gate_record` on the pillbox e2e: 49 acceptance commands, `PASS 49 / FAIL 0`, evidence written to `.impl-gate/ac-evidence.json`; a deliberately failing row produced `FAIL` with the log tail.
- **2026-11-11** — `impl_gate_check` on the same directory: evidence, coverage, review round, consistency and readiness all rendered in one call; deleting one evidence row turned readiness into `not ready — 1 reason(s)`.
- **2026-11-11** — `dsh --profile desktop --dump-config` is rejected by the host (`profile "desktop" is managed exclusively by the Electron application`); verification used a scratch `DSH_HOME` profile plus the plugin page instead.

When the DSH version changes, re-check the tool schema subset first — it is the most likely thing to break silently.