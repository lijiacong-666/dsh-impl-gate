<!-- Writing guide: playbooks/reference/readme.md. Keep the same sections as README.md. -->

# Impl Gate

[简体中文](README.md) | English

<!-- npm:start -->[![npm](https://img.shields.io/npm/v/dsh-impl-gate?logo=npm)](https://www.npmjs.com/package/dsh-impl-gate) <!-- npm:end -->[![Maintained with RED](https://img.shields.io/badge/maintained_with-RED-C1121F)](https://github.com/exoticknight/red)

Turns the 32 IMPL-GATE assertions into three callable DSH tools: give it a spec-graph root and get PASS / FAIL / NOT-RUN with per-item evidence.

## What it is

- **Calls, does not reimplement**: every check spawns `python -m specgraph check --json` and returns its issues verbatim (`graphIssues` + `graphExitCode`).
- **32 verdicts, one by one**: groups A (deliverables), B (implementation boundary), M (modules/imports), Q (quality); each id yields `status` + `evidence` (≤2 KB). Anything unjudgeable is NOT-RUN, never a guess.
- **Three tools**: `impl_gate_check` runs once and caches; `impl_gate_report` renders the summary and checklist; `impl_gate_verify_contract` re-checks only A1–A5.

## What it does not do

- It does not build graphs, edit the project's `spec.md` / `graph.toml`, or generate code; temp files go to the system temp dir only.
- It does not parse the project's source code (only `mapping.md`, the checklist, and contract-file hashes around A5).
- It does not use the network; Q4 (network block) is always NOT-RUN and makes no request.
- It does not judge GUIs: M7 / M10 are always NOT-RUN with `GUI_REQUIRES_MANUAL_CHECK`.
- It does not inline or read specgraph internals; when they are unavailable it returns an error code.

## Minimal example

```sh
# desktop app: replace --profile headless with your profile (e.g. desktop)
dsh plugin --profile headless add dsh-impl-gate
```

Then call it once (`graphRoot` = your graph root):

```json
{ "graphRoot": "D:\\work\\my-graph", "implRoot": "D:\\work\\my-impl" }
```

Real output (local examples/01 plus a test implRoot):

```text
impl_gate_check run-mw633k0l-6039b086: PASS 10 / FAIL 0 / NOT-RUN 22 (32)
NOT-RUN: B3, B4, B6, M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8, Q9
```

The payload also carries `passed[]`, `failed[]`, `notRun[]`, `evidence[]` (`{id,text}`), `graphIssues[]`, `graphExitCode`, and `runId`. Pass that `runId` to report / verify_contract to reuse the same run.

<!-- npm:start -->

### From npm (recommended)

```sh
dsh plugin --profile headless add dsh-impl-gate
```

<!-- npm:end -->

Restart DSH (or the desktop app) and reload the page. The command installs into the DSH you normally use; if you set your own `DSH_HOME`, run it in that same environment. Installing from source is for development; see [docs/development.md](docs/development.md).

## Input formats

### Checklist `<implRoot>/.impl-gate/checklist.md`

Four columns, 32 rows, no duplicate or missing ids:

```markdown
| id | status | evidence | reason |
|----|--------|----------|--------|
| A1 | PASS | command: python -m specgraph export 支付服务 --root <graphRoot> --out <tmp>; exit: 0 |  |
| B1 | FAIL | command: python tools/check_mapping.py; exit: 1 |  |
| Q1 | NOT-RUN | file: docs/q1.md:12 | SLOW_CHECK_DISABLED |

The sample shows only 3 rows (a real file has 32). Angle-bracket tokens such as `<graphRoot>` and `<tmp>` are placeholders and are skipped on replay: neither A3 sampling nor M/Q replay executes a command containing them.
```

- `status` is exactly `PASS`, `FAIL`, or `NOT-RUN`.
- `evidence` starts with `command:` or `file:`; `command:` carries `exit: <code>`, `file:` carries `:line`. A3 replays up to 3 commands and compares the declared exit code.
- `reason` is required only for `NOT-RUN` and must come from the code table below; leave it empty otherwise.
- Every NOT-RUN id must also appear under `## 未覆盖`; A4 requires both sets to be equal.

### Mapping `<implRoot>/.impl-gate/mapping.md`

Three columns, covering every NEED item in the graph:

```markdown
| 需求ID | 模块 | 条目 |
|--------|------|------|
| N1 | 支付服务 | E1 |
| N2 | 订单服务 | E2 |
```

The three header names are fixed; each module must be a real node folder and each cell must be filled. B5 requires every module to appear at least once.

## Tool parameters

| Tool | Parameters | Notes |
|------|------------|-------|
| `impl_gate_check` | `graphRoot` (required), `implRoot`, `checklistPath`, `slow` | Runs once; `checklistPath` defaults to `<implRoot>/.impl-gate/checklist.md` |
| `impl_gate_report` | `root` (required), `runId` | Reads the cache; without `runId` uses the latest run for that root |
| `impl_gate_verify_contract` | `root` (required), `runId` | Re-checks A1–A5 only, never re-runs the other assertions |
| `impl_gate_compose` | `outDir` (required), `requirement`, `name`, `stack`, `mode`, `overwrite`, `specgraphCwd` | `plan` writes `compose-plan.json` and `SPEC-DRAFT.md`; `materialize` emits the graph, `SPEC.md` and `export/` |

`SPEC.md` lives at `<outDir>/SPEC.md`, beside the graph root rather than inside it: on case-insensitive Windows a graph-root `SPEC.md` is read as the root node `spec.md` and produces false `SECTION_MISSING` / `IMPL_LANGUAGE` findings. `ownership` records it, and spec-graph's `check` does not see it (expected) — deviation D-13.

### Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Enable the plugin. |
| `specgraphCommand` | `python -m specgraph` | Command used to call specgraph. |
| `pythonPath` | empty | Interpreter path replacing the first python token. |
| `specgraphCwd` | empty | cwd for specgraph; point it at the spec-graph repo for source installs. |
| `timeoutMs` | `30000` | Per-call timeout; the child is killed and `E_TIMEOUT` returned. |
| `implRoot` | empty | Default implementation root; falls back to `graphRoot`. |
| `slow` | `false` | Run the slow assertion (Q1). |
| `allowCommandReplay` | `false` | Replay M/Q evidence commands (≤5, 120 s timeout, first token `python`/`pnpm`/`node`, cwd pinned to `implRoot`). |

**`pythonPath` precedence**: configured `pythonPath` > PATH `python`. When set and the command's first token is python it replaces that token; otherwise the command runs verbatim. The DSH bundled interpreter is not auto-detected; put its absolute path in `pythonPath` when needed.

When `specgraphCwd` is empty the plugin walks up from `graphRoot` looking for `specgraph/__init__.py` and injects that directory into the child's `PYTHONPATH` (D-06); the resolved path is recorded in A1 evidence.

## Error codes and NOT-RUN reasons

| Error code | Meaning |
|------------|---------|
| `E_ROOT_MISSING` | Root missing or not a directory |
| `E_PYTHON_MISSING` | Interpreter not found (spawn ENOENT) |
| `E_SPAWN_DENIED` | Permission denied (EPERM / EACCES) |
| `E_TIMEOUT` | Exceeded `timeoutMs`; child killed |
| `E_BAD_JSON` | specgraph output is not valid JSON |
| `E_NO_PRIOR_RUN` | No cached run: never ran, different root, or lost on plugin reload |
| `E_RUN_EXPIRED` | Cache older than 10 minutes |
| `E_INTERNAL_INCONSISTENT` | 32-id partition dirty, or uncovered set ≠ NOT-RUN set |

| NOT-RUN reason | Trigger |
|----------------|---------|
| `MISSING_INSTRUCTION_PACKAGE` | A1: no exportable node in the graph |
| `CHECKLIST_NOT_PROVIDED` | A2–A4: checklist missing |
| `IMPL_ROOT_NOT_PROVIDED` | B group and Q5–Q7: no `implRoot`, indistinguishable from the graph root |
| `LANGUAGE_UNSUPPORTED` | Q2: implementation language unsupported |
| `SLOW_CHECK_DISABLED` | Q1: `slow=false` |
| `NETWORK_BLOCK_UNSUPPORTED` | Q4: this tool does not use the network |
| `SCHEMA_UNAVAILABLE` | Q8: no schema to validate |
| `D4_GRAPH_INVALID` | Invalid graph: all 32 NOT-RUN, `graphIssues` returned verbatim |
| `GUI_REQUIRES_MANUAL_CHECK` | M7 / M10: needs a human to look at the GUI |
| `NOT_IMPLEMENTED` | No landing implemented for that id |
| `MANUAL_REVIEW_REQUIRED` | B4: decision record maintained by a human |
| `MAPPING_TABLE_NOT_PROVIDED` | B1: no `mapping.md` |
| `EXEC_DISABLED` | M/Q: replay disabled, or the 5-command budget is spent |
| `HUMAN_PROCESS_REQUIRED` | B6: process item (release notes / commit message) left to a human |
| `EVIDENCE_TOKEN_UNSPECIFIED` | B3/replay: evidence is not a runnable command |

## Boundaries

- The cache is in-process only, keyed by `runId` + normalized root, TTL 10 minutes; a plugin reload clears it, so `E_NO_PRIOR_RUN` there is normal — run `impl_gate_check` again.
- `allowCommandReplay` is off by default, so 15 M/Q ids are `EXEC_DISABLED`; when enabled only the first 5 run, the rest are `EXEC_DISABLED` with `skipped=replay_budget_exhausted`.
- B3 / B4 / B6 are always NOT-RUN (D-10); B1 / B2 / B5 / B7 use mechanical proxies (D-11) listed below.
- Q4 never touches the network; M7 / M10 never judge a GUI.
- An invalid graph makes all 32 NOT-RUN with a non-zero `graphExitCode` and verbatim `graphIssues` (sample 02 behaves this way).

## Deviations

Every implementation decision that differs from the checklist or the task book is registered in [docs/deviations.md](docs/deviations.md) (D-01 … D-12).

## Manual review items

Four checklist assertions are process/semantic rather than mechanical; v1 leaves them to a human (D-11):

1. Mapping row count = total manifest items (original B1).
2. Implementation exports / routes ⊆ instruction-package exposes (original B2).
3. Git history shows a matching test run within one commit of each module change (original B5).
4. Any FAIL's reproduction command runs as-is and matches the report (original B7).

The mechanical proxies are: B1 checks `mapping.md` covers every NEED item, B2 checks checklist ids ⊆ checks.json ids, B5 checks every mapping module appears at least once, B7 checks FAIL rows carry `repro:`. Passing the proxies does not satisfy the four originals; both are required for hand-off.

## Update, roll back, remove

See the [npm versions page](https://www.npmjs.com/package/dsh-impl-gate?activeTab=versions) for the version list.

To update or roll back, name the version, then restart DSH (for 24 hours after a release, an install without a version may still pick the previous one):

<!-- npm:start -->

```sh
dsh plugin --profile headless add dsh-impl-gate@X.Y.Z
```

<!-- npm:end -->

To remove:

```sh
dsh plugin --profile headless remove dsh-impl-gate
```

Nothing is left behind after removal; the cache dies with the process.

## Privacy and data

- No network requests (which is also why Q4 is always NOT-RUN).
- Reads: `spec.md` / `graph.toml` under `graphRoot`, `<implRoot>/.impl-gate/checklist.md`, `mapping.md`.
- Writes: system temp directory only (exported instruction packages, A5 copies), deleted afterwards; never the project under test.
- No credentials stored and no environment secrets read.

## Compatibility

See [docs/compatibility.md](docs/compatibility.md).

## Development

```sh
pnpm install
pnpm verify        # typecheck → build lib/ → node --test → package-content check
```

A source install is linked into the profile via `dsh plugin add <repo>`. After `pnpm verify`, **hot reload does not happen automatically**: the profile must reconcile once — most reliably by toggling `dsh-impl-gate` off and on in the plugin page. Touching files or mtimes does not reload. After a reload, confirm `impl_gate_check` / `impl_gate_report` / `impl_gate_verify_contract` are in the tool list before calling them.

See [docs/development.md](docs/development.md) and [CONTRIBUTING.md](CONTRIBUTING.md). When an AI agent develops, releases or maintains the plugin, have it read [AGENTS.md](AGENTS.md) first.

## License

[Apache License 2.0](LICENSE)