// src/host/index.ts
import z from "@deepseek-ai/schemastery";

// src/host/tools.ts
import { randomUUID } from "node:crypto";
import fs7 from "node:fs";
import os from "node:os";
import path6 from "node:path";

// src/host/assertions/a1.ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
function setDiff(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}
async function findNodeDirs(root) {
  const found = [];
  const walk2 = async (dir, rel, depth) => {
    if (depth > 6) return;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    if (rel.length > 0 && entries.some((entry) => entry.isFile() && entry.name === "spec.md")) {
      found.push(rel);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      await walk2(path.join(dir, entry.name), rel.length > 0 ? `${rel}/${entry.name}` : entry.name, depth + 1);
    }
  };
  await walk2(root, "", 0);
  return found.sort();
}
async function findPair(outDir) {
  let entries;
  try {
    entries = await fs.promises.readdir(outDir);
  } catch {
    return null;
  }
  const mdFile = entries.find((name2) => name2.endsWith("\u6307\u4EE4\u5305.md"));
  const jsonFile = entries.find((name2) => name2.endsWith("manifest.json"));
  if (mdFile === void 0 || jsonFile === void 0) return null;
  return { mdFile: path.join(outDir, mdFile), jsonFile: path.join(outDir, jsonFile) };
}
function parseInstructionMd(md) {
  const modules = /* @__PURE__ */ new Set();
  const items = /* @__PURE__ */ new Set();
  const title = /^# 实现指令包 · (.+)$/m.exec(md);
  if (title?.[1] !== void 0) modules.add(title[1].trim());
  for (const match of md.matchAll(/由 `([^`]+)` 的/g)) {
    if (match[1] !== void 0) modules.add(match[1].trim());
  }
  for (const match of md.matchAll(/^### ([A-Z]\d+)\b/gm)) {
    if (match[1] !== void 0) items.add(match[1]);
  }
  for (const block of md.matchAll(/```text\r?\n([\s\S]*?)```/g)) {
    for (const line of (block[1] ?? "").split(/\r?\n/)) {
      const item = /^([A-Z]\d+)\s/.exec(line);
      if (item?.[1] !== void 0) items.add(item[1]);
    }
  }
  return { modules, items };
}
function parseManifest(raw) {
  const manifest = JSON.parse(raw);
  const modules = /* @__PURE__ */ new Set();
  const items = /* @__PURE__ */ new Set();
  for (const value of [manifest.name, manifest.target]) {
    if (typeof value === "string" && value.length > 0) modules.add(value);
  }
  const contract = manifest.contract ?? {};
  for (const key of ["exposes", "needs", "constraints"]) {
    const section = contract[key];
    if (!Array.isArray(section)) continue;
    for (const item of section) {
      if (typeof item?.id === "string") items.add(item.id);
    }
  }
  const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
  for (const dependency of dependencies) {
    for (const key of ["provider_name", "provider", "link_to"]) {
      const value = dependency[key];
      if (typeof value === "string" && value.length > 0) modules.add(value);
    }
    const expose = dependency.expose;
    if (typeof expose?.id === "string") items.add(expose.id);
    const constraints = dependency.provider_constraints;
    if (Array.isArray(constraints)) {
      for (const item of constraints) {
        if (typeof item?.id === "string") items.add(item.id);
      }
    }
  }
  return { modules, items };
}
function describePair(rel, md, manifest, mdText, jsonText) {
  const moduleDiffA = setDiff(md.modules, manifest.modules);
  const moduleDiffB = setDiff(manifest.modules, md.modules);
  const itemDiffA = setDiff(md.items, manifest.items);
  const itemDiffB = setDiff(manifest.items, md.items);
  const ok = moduleDiffA.length === 0 && moduleDiffB.length === 0 && itemDiffA.length === 0 && itemDiffB.length === 0;
  const parts = [
    `node=${rel}`,
    `modules=${md.modules.size}/${manifest.modules.size}`,
    `items=${md.items.size}/${manifest.items.size}`,
    `md_sha256=${sha256(mdText)}`,
    `manifest_sha256=${sha256(jsonText)}`
  ];
  if (!ok) {
    parts.push(
      `modules_only_md=[${moduleDiffA.join(",")}]`,
      `modules_only_manifest=[${moduleDiffB.join(",")}]`,
      `items_only_md=[${itemDiffA.join(",")}]`,
      `items_only_manifest=[${itemDiffB.join(",")}]`
    );
  }
  return { ok, line: parts.join(" ") };
}
var checkA1 = async (ctx) => {
  const nodes = await findNodeDirs(ctx.graphRoot);
  if (nodes.length === 0) {
    return { status: "NOT-RUN", evidence: "", reason: "MISSING_INSTRUCTION_PACKAGE" };
  }
  const tempRoot = await ctx.newTempDir("impl-gate-a1-");
  const lines = [];
  const problems = [];
  try {
    for (const [index, rel] of nodes.entries()) {
      const outDir = path.join(tempRoot, `pkg-${index}`);
      const result = await ctx.run(["export", rel, "--root", ctx.graphRoot, "--out", outDir]);
      if (result.exitCode !== 0) {
        problems.push(`node=${rel} export_exit=${result.exitCode} stderr=${result.stderr.trim().slice(-300)}`);
        continue;
      }
      const pair = await findPair(outDir);
      if (pair === null) {
        problems.push(`node=${rel} export_produced_no_package_pair`);
        continue;
      }
      const [mdText, jsonText] = await Promise.all([
        fs.promises.readFile(pair.mdFile, "utf8"),
        fs.promises.readFile(pair.jsonFile, "utf8")
      ]);
      const md = parseInstructionMd(mdText);
      const manifest = parseManifest(jsonText);
      const described = describePair(rel, md, manifest, mdText, jsonText);
      lines.push(described.line);
      if (!described.ok) problems.push(described.line);
    }
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
  if (problems.length > 0) {
    return { status: "FAIL", evidence: problems.join(" | ") };
  }
  return { status: "PASS", evidence: lines.join(" | ") };
};

// src/host/checklist.ts
import fs2 from "node:fs";
var NOT_RUN_REASONS = /* @__PURE__ */ new Set([
  "MISSING_INSTRUCTION_PACKAGE",
  "CHECKLIST_NOT_PROVIDED",
  "IMPL_ROOT_NOT_PROVIDED",
  "LANGUAGE_UNSUPPORTED",
  "GIT_UNAVAILABLE",
  "SLOW_CHECK_DISABLED",
  "NETWORK_BLOCK_UNSUPPORTED",
  "SCHEMA_UNAVAILABLE",
  "D4_GRAPH_INVALID",
  "GUI_REQUIRES_MANUAL_CHECK",
  "NOT_IMPLEMENTED",
  "MANUAL_REVIEW_REQUIRED",
  "MAPPING_TABLE_NOT_PROVIDED"
]);
var CHECKLIST_STATUSES = /* @__PURE__ */ new Set(["PASS", "FAIL", "NOT-RUN"]);
function splitRow(line) {
  const trimmed = line.trim();
  const cells = trimmed.split("|");
  if (trimmed.startsWith("|")) cells.shift();
  if (trimmed.endsWith("|")) cells.pop();
  return cells.map((cell) => cell.trim());
}
function isSeparator(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}
function parseChecklist(text, filePath) {
  const rows = /* @__PURE__ */ new Map();
  const duplicatedIds = [];
  const errors = [];
  const uncovered = /* @__PURE__ */ new Set();
  let hasUncoveredSection = false;
  let inUncovered = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#")) {
      inUncovered = /未覆盖/.test(line);
      if (inUncovered) hasUncoveredSection = true;
      continue;
    }
    if (inUncovered) {
      for (const token of line.split(/[\s,，、|]+/)) {
        if (/^[ABMQ]\d+$/.test(token)) uncovered.add(token);
      }
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells.length < 4 || isSeparator(cells)) continue;
    const [id, status, evidence, reason] = cells;
    if (id === void 0 || id.toLowerCase() === "id") continue;
    if (id.length === 0) continue;
    if (rows.has(id)) duplicatedIds.push(id);
    rows.set(id, { id, status: status ?? "", evidence: evidence ?? "", reason: reason ?? "" });
  }
  for (const row of rows.values()) {
    if (!CHECKLIST_STATUSES.has(row.status)) {
      errors.push(`${row.id}: status "${row.status}" is not one of PASS/FAIL/NOT-RUN`);
    }
    if (!/^(command|file):\s*\S/.test(row.evidence)) {
      errors.push(`${row.id}: evidence must start with "command:" or "file:"`);
    }
    if (row.status === "NOT-RUN") {
      if (row.reason.length === 0) errors.push(`${row.id}: NOT-RUN requires a reason`);
      else if (!NOT_RUN_REASONS.has(row.reason)) errors.push(`${row.id}: reason "${row.reason}" is not a \xA75 code`);
    } else if (row.reason.length > 0) {
      errors.push(`${row.id}: reason is only allowed on NOT-RUN`);
    }
  }
  if (duplicatedIds.length > 0) errors.unshift(`duplicate ids: ${duplicatedIds.join(", ")}`);
  return { path: filePath, provided: true, rows, duplicatedIds, uncovered, hasUncoveredSection, errors };
}
function loadChecklist(filePath) {
  try {
    const text = fs2.readFileSync(filePath, "utf8");
    return parseChecklist(text, filePath);
  } catch {
    return {
      path: filePath,
      provided: false,
      rows: /* @__PURE__ */ new Map(),
      duplicatedIds: [],
      uncovered: /* @__PURE__ */ new Set(),
      hasUncoveredSection: false,
      errors: []
    };
  }
}
function auditChecklist(list) {
  const notRun = new Set(
    [...list.rows.values()].filter((row) => row.status === "NOT-RUN").map((row) => row.id)
  );
  return {
    notRun,
    onlyInReport: [...notRun].filter((id) => !list.uncovered.has(id)),
    onlyInSection: [...list.uncovered].filter((id) => !notRun.has(id)),
    sectionMissingButNeeded: notRun.size > 0 && !list.hasUncoveredSection
  };
}

// src/host/specgraph.ts
import { spawn } from "node:child_process";
import fs3 from "node:fs";
import path2 from "node:path";
var SpecgraphError = class extends Error {
  code;
  detail;
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
};
var MAX_STDOUT = 4 * 1024 * 1024;
var MAX_STDERR = 64 * 1024;
function splitCommand(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    if (token.length > 0) tokens.push(token);
  }
  return tokens;
}
function resolveArgv(command, pythonPath) {
  const argv = splitCommand(command);
  if (argv.length === 0) argv.push("python", "-m", "specgraph");
  const first = argv[0];
  if (first === void 0) return argv;
  if (pythonPath.length > 0 && /^python(\d+(?:\.\d+)*)?(\.exe)?$/i.test(path2.basename(first))) {
    argv[0] = pythonPath;
  }
  return argv;
}
function findSpecgraphHome(start) {
  let dir = path2.resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs3.existsSync(path2.join(dir, "specgraph", "__init__.py"))) return dir;
    const parent = path2.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return void 0;
}
function runSpecgraph(runner, args) {
  const executable = runner.argv[0];
  if (executable === void 0) {
    return Promise.reject(new SpecgraphError("E_PYTHON_MISSING", "specgraphCommand resolved to an empty argv"));
  }
  return runProcess([executable, ...runner.argv.slice(1), ...args], runner);
}
function runProcess(argv, runner) {
  return new Promise((resolve, reject) => {
    const executable = argv[0];
    if (executable === void 0) {
      reject(new SpecgraphError("E_PYTHON_MISSING", "empty argv"));
      return;
    }
    const child = spawn(executable, argv.slice(1), {
      cwd: runner.cwd !== void 0 && runner.cwd.length > 0 ? runner.cwd : void 0,
      env: runner.env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.max(1e3, runner.timeoutMs));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_STDOUT) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR) stderr += chunk;
    });
    child.on("error", (error) => {
      finish(() => {
        if (error.code === "ENOENT") {
          reject(new SpecgraphError("E_PYTHON_MISSING", `cannot start "${executable}": ${error.message}`));
        } else if (error.code === "EPERM" || error.code === "EACCES") {
          reject(new SpecgraphError("E_SPAWN_DENIED", `permission denied starting "${executable}"`, error.message));
        } else {
          reject(new SpecgraphError("E_SPAWN_DENIED", `failed to start "${executable}": ${error.message}`));
        }
      });
    });
    child.on("close", (code) => {
      finish(() => {
        if (timedOut) {
          reject(new SpecgraphError("E_TIMEOUT", `specgraph did not finish within ${runner.timeoutMs} ms`, stderr.slice(-4096)));
          return;
        }
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
    });
  });
}

// src/host/assertions/input.ts
function checklistMissing() {
  return { status: "NOT-RUN", evidence: "", reason: "CHECKLIST_NOT_PROVIDED" };
}
function firstProblems(problems, limit = 6) {
  if (problems.length === 0) return "";
  const head = problems.slice(0, limit).join(" | ");
  return problems.length > limit ? `${head} | +${problems.length - limit} more` : head;
}
var checkA2 = async (ctx) => {
  if (!ctx.checklist.provided) return checklistMissing();
  const expected = new Set(ctx.checks.map((item) => item.id));
  const actual = new Set(ctx.checklist.rows.keys());
  const missing = [...expected].filter((id) => !actual.has(id));
  const unknown = [...actual].filter((id) => !expected.has(id));
  const problems = [];
  if (ctx.checklist.rows.size !== ctx.checks.length) {
    problems.push(`row count ${ctx.checklist.rows.size} != ${ctx.checks.length}`);
  }
  if (ctx.checklist.duplicatedIds.length > 0) {
    problems.push(`duplicate ids: ${ctx.checklist.duplicatedIds.join(", ")}`);
  }
  if (missing.length > 0) problems.push(`missing ids: ${missing.join(", ")}`);
  if (unknown.length > 0) problems.push(`unknown ids: ${unknown.join(", ")}`);
  for (const row of ctx.checklist.rows.values()) {
    if (row.status !== "PASS" && row.status !== "FAIL" && row.status !== "NOT-RUN") {
      problems.push(`${row.id}: status "${row.status}"`);
    } else if (row.status === "NOT-RUN" && row.reason.length === 0) {
      problems.push(`${row.id}: NOT-RUN without reason`);
    } else if (row.status !== "NOT-RUN" && row.reason.length > 0) {
      problems.push(`${row.id}: reason on ${row.status}`);
    }
  }
  const evidence = `rows=${ctx.checklist.rows.size} expected=${ctx.checks.length} missing=${missing.length} unknown=${unknown.length} duplicates=${ctx.checklist.duplicatedIds.length} problem_count=${problems.length}`;
  return problems.length === 0 ? { status: "PASS", evidence } : { status: "FAIL", evidence: `${evidence} :: ${firstProblems(problems)}` };
};
var EXIT_MARKER = /\bexit:\s*(-?\d+)/;
var COMMAND_SPLIT = /;\s*|\s+\|\s+/;
function commandPayload(evidence) {
  const rest = evidence.replace(/^command:\s*/i, "");
  return rest.split(COMMAND_SPLIT)[0]?.trim() ?? "";
}
var checkA3 = async (ctx) => {
  if (!ctx.checklist.provided) return checklistMissing();
  const problems = [];
  let prefixOk = 0;
  const runnable = [];
  for (const row of ctx.checklist.rows.values()) {
    const isCommand = /^command:\s*\S/i.test(row.evidence);
    const isFile = /^file:\s*\S/i.test(row.evidence);
    if (!isCommand && !isFile) {
      problems.push(`${row.id}: evidence lacks command:/file: prefix`);
      continue;
    }
    prefixOk += 1;
    if (isFile) {
      if (!/:\d+$/.test(row.evidence.replace(/^file:\s*/i, ""))) {
        problems.push(`${row.id}: file evidence lacks :line`);
      }
      continue;
    }
    const exitMatch = EXIT_MARKER.exec(row.evidence);
    if (exitMatch === null) {
      problems.push(`${row.id}: command evidence lacks exit: marker`);
      continue;
    }
    const payload = commandPayload(row.evidence);
    const argv = splitCommand(payload);
    if (argv.length < 2 || argv.includes("-m") === false || argv.includes("specgraph") === false) continue;
    if (runnable.length < 3) runnable.push({ id: row.id, argv, expected: Number(exitMatch[1]) });
  }
  const results = [];
  for (const sample of runnable) {
    try {
      const output = await ctx.runArgv(sample.argv);
      results.push(`${sample.id}=${output.exitCode}`);
      if (output.exitCode !== sample.expected) {
        problems.push(`${sample.id}: replayed exit ${output.exitCode} != ${sample.expected}`);
      }
    } catch (error) {
      problems.push(`${sample.id}: replay failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const evidence = `rows=${ctx.checklist.rows.size} prefix_ok=${prefixOk} sampled=${runnable.length} replay=[${results.join(",")}] problems=${problems.length}`;
  return problems.length === 0 ? { status: "PASS", evidence } : { status: "FAIL", evidence: `${evidence} :: ${firstProblems(problems)}` };
};
var checkA4 = async (ctx) => {
  if (!ctx.checklist.provided) return checklistMissing();
  const audit = auditChecklist(ctx.checklist);
  const { notRun, onlyInReport, onlyInSection, sectionMissingButNeeded } = audit;
  const problems = [];
  if (sectionMissingButNeeded) problems.push('missing "\u672A\u8986\u76D6" section');
  if (onlyInReport.length > 0) problems.push(`NOT-RUN not listed: ${onlyInReport.join(", ")}`);
  if (onlyInSection.length > 0) problems.push(`listed but not NOT-RUN: ${onlyInSection.join(", ")}`);
  const evidence = `notRun=${notRun.size} uncovered=${ctx.checklist.uncovered.size} section=${ctx.checklist.hasUncoveredSection} missing_from_section=${onlyInReport.length} extra_in_section=${onlyInSection.length}`;
  return problems.length === 0 ? { status: "PASS", evidence } : { status: "FAIL", evidence: `${evidence} :: ${firstProblems(problems)}` };
};
var checkA5 = async (ctx) => {
  let current;
  try {
    current = await ctx.hashGraph();
  } catch (error) {
    return {
      status: "FAIL",
      evidence: `hash failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  const before = ctx.preGraphHashes;
  const changed = [];
  const added = [];
  const removed = [];
  for (const key of Object.keys(before)) {
    if (!(key in current)) removed.push(key);
    else if (current[key] !== before[key]) changed.push(key);
  }
  for (const key of Object.keys(current)) {
    if (!(key in before)) added.push(key);
  }
  const files = Object.keys(before).length;
  const stable = files - changed.length - removed.length;
  const digest = Object.values(before).join("").slice(0, 16);
  const evidence = `files=${files} stable=${stable} changed=${changed.length} added=${added.length} removed=${removed.length} digest=${digest}`;
  const problems = [...changed, ...removed].map((file) => `changed: ${file}`);
  problems.push(...added.map((file) => `appeared: ${file}`));
  if (problems.length === 0 && files === 0) {
    return { status: "FAIL", evidence: `${evidence} :: no spec.md/graph.toml found under graphRoot` };
  }
  return problems.length === 0 ? { status: "PASS", evidence } : { status: "FAIL", evidence: `${evidence} :: ${firstProblems(problems)}` };
};

// src/host/assertions/q10.ts
import fs4 from "node:fs";
import path3 from "node:path";
async function firstSpecFile(root) {
  const walk2 = async (dir, depth) => {
    if (depth > 6) return null;
    const entries = await fs4.promises.readdir(dir, { withFileTypes: true });
    const spec = entries.find((entry) => entry.isFile() && entry.name === "spec.md");
    if (spec !== void 0) return path3.join(dir, "spec.md");
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const found = await walk2(path3.join(dir, entry.name), depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return walk2(root, 0);
}
var checkQ10 = async (ctx) => {
  const observations = [];
  const tempRoot = await ctx.newTempDir("impl-gate-q10-");
  try {
    const valid = await ctx.run(["check", ctx.graphRoot, "--json"]);
    observations.push(`valid_exit=${valid.exitCode} expected=0`);
    const broken = path3.join(tempRoot, "broken");
    await fs4.promises.cp(ctx.graphRoot, broken, { recursive: true });
    const victim = await firstSpecFile(broken);
    if (victim === null) {
      return { status: "FAIL", evidence: "broken_copy_has_no_spec.md_to_remove" };
    }
    await fs4.promises.rm(victim, { force: true });
    const invalid = await ctx.run(["check", broken, "--json"]);
    observations.push(`broken_exit=${invalid.exitCode} expected=1`);
    const usage = await ctx.run(["check", "--definitely-not-a-flag"]);
    observations.push(`usage_exit=${usage.exitCode} expected=2`);
    const ok = valid.exitCode === 0 && invalid.exitCode === 1 && usage.exitCode === 2;
    return { status: ok ? "PASS" : "FAIL", evidence: observations.join(" ") };
  } finally {
    await fs4.promises.rm(tempRoot, { recursive: true, force: true });
  }
};

// src/host/assertions/index.ts
var ASSERTIONS = {
  A1: checkA1,
  A2: checkA2,
  A3: checkA3,
  A4: checkA4,
  A5: checkA5,
  Q10: checkQ10
};

// src/host/checks.ts
import fs5 from "node:fs";
import path4 from "node:path";
import { fileURLToPath } from "node:url";
function checksFilePath() {
  return path4.resolve(path4.dirname(fileURLToPath(import.meta.url)), "..", "checks", "impl-gate.checks.json");
}
function loadChecks() {
  const file = checksFilePath();
  let parsed;
  try {
    parsed = JSON.parse(fs5.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
  const items = parsed?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`${file} has no items array`);
  }
  return items;
}

// src/host/graph-hash.ts
import { createHash as createHash2 } from "node:crypto";
import fs6 from "node:fs";
import path5 from "node:path";
var TARGET_NAMES = /* @__PURE__ */ new Set(["spec.md", "graph.toml"]);
var SKIP_DIRS = /* @__PURE__ */ new Set([".git", "node_modules", ".dsh-dev", ".impl-gate"]);
async function walk(dir, depth, out) {
  if (depth > 12) return;
  let entries;
  try {
    entries = await fs6.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const full = path5.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, depth + 1, out);
    } else if (entry.isFile() && TARGET_NAMES.has(entry.name)) {
      out.push(full);
    }
  }
}
async function hashContractFiles(root) {
  const files = [];
  await walk(root, 0, files);
  const hashes = {};
  for (const file of files) {
    try {
      const digest = createHash2("sha256").update(await fs6.promises.readFile(file)).digest("hex");
      hashes[path5.relative(root, file).split(path5.sep).join("/")] = digest.slice(0, 16);
    } catch {
      hashes[path5.relative(root, file).split(path5.sep).join("/")] = "unreadable";
    }
  }
  return hashes;
}

// src/host/tools.ts
var MAX_EVIDENCE = 2048;
var RUN_TTL_MS = 10 * 60 * 1e3;
var runs = /* @__PURE__ */ new Map();
function rememberRun(runId, payload, reasons) {
  runs.set(runId, { payload, reasons, finishedAt: Date.now() });
  for (const [key, record] of runs) {
    if (Date.now() - record.finishedAt > RUN_TTL_MS) runs.delete(key);
  }
}
function fail(code, message, detail) {
  return detail === void 0 ? { error: { code, message } } : { error: { code, message, detail } };
}
function failureFrom(error) {
  if (error instanceof SpecgraphError) return fail(error.code, error.message, error.detail);
  const message = error instanceof Error ? error.message : String(error);
  return fail("E_INTERNAL_INCONSISTENT", message);
}
function truncate(text) {
  return text.length <= MAX_EVIDENCE ? text : `${text.slice(0, MAX_EVIDENCE)}\u2026`;
}
function notRunReason(item, slow, implemented) {
  if (item.mode === "notrun") return item.notRunReason;
  if (item.mode === "manual") return "MANUAL_REVIEW_REQUIRED";
  if (item.runtime === "slow" && !slow) return "SLOW_CHECK_DISABLED";
  if (!implemented) return "NOT_IMPLEMENTED";
  return item.notRunReason;
}
async function runCheck(rawArgs, deps) {
  const startedAt = /* @__PURE__ */ new Date();
  const startedMs = Date.now();
  const args = rawArgs ?? {};
  const graphRootRaw = typeof args.graphRoot === "string" ? args.graphRoot : "";
  if (graphRootRaw.length === 0) return fail("E_ROOT_MISSING", "graphRoot is required");
  const graphRoot = path6.resolve(graphRootRaw);
  try {
    const stat = await fs7.promises.stat(graphRoot);
    if (!stat.isDirectory()) return fail("E_ROOT_MISSING", `graphRoot is not a directory: ${graphRoot}`);
  } catch {
    return fail("E_ROOT_MISSING", `graphRoot does not exist: ${graphRoot}`);
  }
  const config = deps.config;
  const implRootArg = typeof args.implRoot === "string" && args.implRoot.length > 0 ? args.implRoot : "";
  const implRoot = path6.resolve(implRootArg.length > 0 ? implRootArg : config.implRoot.length > 0 ? config.implRoot : graphRoot);
  const slow = args.slow === true || config.slow;
  let checks;
  try {
    checks = loadChecks();
  } catch (error) {
    return fail("E_INTERNAL_INCONSISTENT", error.message);
  }
  const runnerCwd = config.specgraphCwd.length > 0 ? config.specgraphCwd : void 0;
  const sourceHome = runnerCwd === void 0 ? findSpecgraphHome(graphRoot) : void 0;
  const runnerEnv = sourceHome === void 0 ? void 0 : {
    ...process.env,
    PYTHONPATH: [sourceHome, process.env.PYTHONPATH].filter((part) => part !== void 0 && part.length > 0).join(path6.delimiter)
  };
  const runner = {
    argv: resolveArgv(config.specgraphCommand, config.pythonPath),
    cwd: runnerCwd,
    env: runnerEnv,
    timeoutMs: config.timeoutMs
  };
  let graphRun;
  try {
    graphRun = await runSpecgraph(runner, ["check", graphRoot, "--json"]);
  } catch (error) {
    return failureFrom(error);
  }
  let parsed;
  try {
    parsed = JSON.parse(graphRun.stdout);
  } catch {
    return fail(
      "E_BAD_JSON",
      "specgraph check did not print JSON",
      (graphRun.stderr || graphRun.stdout).trim().slice(-4e3)
    );
  }
  const graphIssues = (Array.isArray(parsed.issues) ? parsed.issues : []).filter((issue) => typeof issue === "object" && issue !== null).map((issue) => ({
    code: String(issue.code ?? ""),
    node: String(issue.node ?? ""),
    item: String(issue.item ?? ""),
    line: Number(issue.line ?? 0)
  }));
  const runId = `run-${startedMs.toString(36)}-${randomUUID().slice(0, 8)}`;
  const base = {
    graphIssues,
    graphExitCode: graphRun.exitCode,
    runId,
    startedAt: startedAt.toISOString()
  };
  if (graphRun.exitCode !== 0 || parsed.ok !== true) {
    const payload2 = {
      ...base,
      passed: [],
      failed: [],
      notRun: checks.map((item) => item.id),
      evidence: [],
      durationMs: Date.now() - startedMs
    };
    const reasons2 = {};
    for (const item of checks) reasons2[item.id] = "D4_GRAPH_INVALID";
    rememberRun(runId, payload2, reasons2);
    return payload2;
  }
  const checklistArg = typeof args.checklistPath === "string" && args.checklistPath.length > 0 ? args.checklistPath : "";
  const checklistPath = path6.resolve(
    checklistArg.length > 0 ? checklistArg : path6.join(implRoot, ".impl-gate", "checklist.md")
  );
  const checklist = loadChecklist(checklistPath);
  const preGraphHashes = await hashContractFiles(graphRoot);
  const runArgv = (argv) => {
    const mapped = [...argv];
    const head = mapped[0];
    if (head !== void 0 && config.pythonPath.length > 0 && /^python(\d+(?:\.\d+)*)?(\.exe)?$/i.test(path6.basename(head))) {
      mapped[0] = config.pythonPath;
    }
    return runProcess(mapped, { cwd: runner.cwd, env: runner.env, timeoutMs: config.timeoutMs });
  };
  const ctx = {
    graphRoot,
    implRoot,
    slow,
    timeoutMs: config.timeoutMs,
    checks,
    checklist,
    preGraphHashes,
    run: (specArgs) => runSpecgraph({ argv: runner.argv, cwd: runner.cwd, env: runner.env, timeoutMs: config.timeoutMs }, specArgs),
    runArgv,
    hashGraph: () => hashContractFiles(graphRoot),
    newTempDir: (prefix) => fs7.promises.mkdtemp(path6.join(os.tmpdir(), prefix))
  };
  const passed = [];
  const failed = [];
  const notRun = [];
  const evidence = [];
  const reasons = {};
  for (const item of checks) {
    const assertion = ASSERTIONS[item.id];
    const gated = item.mode !== "auto" || item.runtime === "slow" && !slow || assertion === void 0;
    if (gated) {
      notRun.push(item.id);
      reasons[item.id] = notRunReason(item, slow, assertion !== void 0);
      continue;
    }
    try {
      const outcome = await assertion(ctx);
      if (outcome.status === "PASS") {
        passed.push(item.id);
        evidence.push({ id: item.id, text: truncate(outcome.evidence) });
      } else if (outcome.status === "FAIL") {
        failed.push(item.id);
        evidence.push({ id: item.id, text: truncate(outcome.evidence) });
      } else {
        notRun.push(item.id);
        reasons[item.id] = outcome.reason ?? item.notRunReason;
      }
    } catch (error) {
      failed.push(item.id);
      evidence.push({ id: item.id, text: truncate(`error: ${error instanceof Error ? error.message : String(error)}`) });
    }
  }
  const partition = /* @__PURE__ */ new Set([...passed, ...failed, ...notRun]);
  if (partition.size !== checks.length || passed.length + failed.length + notRun.length !== checks.length) {
    return fail("E_INTERNAL_INCONSISTENT", `assertion partition is not a clean split of ${checks.length} ids`);
  }
  const payload = {
    ...base,
    passed,
    failed,
    notRun,
    evidence,
    durationMs: Date.now() - startedMs
  };
  rememberRun(runId, payload, reasons);
  return payload;
}
function renderCheck(_args, value) {
  const payload = value;
  if (payload.error !== void 0) {
    return [{ type: "text", text: `impl_gate_check failed: ${payload.error.code} \u2014 ${payload.error.message}` }];
  }
  const passed = payload.passed ?? [];
  const failed = payload.failed ?? [];
  const notRun = payload.notRun ?? [];
  const lines = [`impl_gate_check ${payload.runId ?? ""}: PASS ${passed.length} / FAIL ${failed.length} / NOT-RUN ${notRun.length} (32)`];
  if (failed.length > 0) lines.push(`FAIL: ${failed.join(", ")}`);
  if (notRun.length > 0) lines.push(`NOT-RUN: ${notRun.join(", ")}`);
  if (payload.graphExitCode !== void 0 && payload.graphExitCode !== 0) {
    lines.push(`graphExitCode=${payload.graphExitCode}, ${(payload.graphIssues ?? []).length} issue(s)`);
  }
  return [{ type: "text", text: lines.join("\n") }];
}
var errorSchema = {
  type: "object",
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    detail: { type: "string" }
  },
  required: ["code", "message"],
  additionalProperties: false
};
var checkOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    passed: { type: "array", items: { type: "string" } },
    failed: { type: "array", items: { type: "string" } },
    notRun: { type: "array", items: { type: "string" } },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" }
        },
        required: ["id", "text"],
        additionalProperties: false
      }
    },
    graphIssues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string" },
          node: { type: "string" },
          item: { type: "string" },
          line: { type: "number" }
        },
        required: ["code", "node", "item"],
        additionalProperties: false
      }
    },
    graphExitCode: { type: "number" },
    runId: { type: "string" },
    startedAt: { type: "string" },
    durationMs: { type: "number" },
    error: errorSchema
  }
};
var checkParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    graphRoot: {
      type: "string",
      description: "\u89C4\u683C\u56FE\u8C31\u6839\u76EE\u5F55\uFF08\u542B graph.toml \u4E0E\u5404\u8282\u70B9 spec.md\uFF09\u3002\u5FC5\u586B\u3002"
    },
    implRoot: {
      type: "string",
      description: "\u5B9E\u73B0\u6839\u76EE\u5F55\uFF0C\u9ED8\u8BA4\u7B49\u4E8E graphRoot\u3002\u53EA\u5F71\u54CD B \u7EC4\u4E0E Q5\u2013Q8\u3002"
    },
    slow: {
      type: "boolean",
      description: "\u8FD0\u884C slow \u65AD\u8A00\uFF08Q1 \u4F9D\u8D56\u5BA1\u8BA1\uFF09\u3002\u9ED8\u8BA4\u5173\u95ED\u3002"
    },
    checklistPath: {
      type: "string",
      description: "\u4EA4\u4ED8\u7684\u52FE\u9009\u8868\u8DEF\u5F84\uFF0C\u7F3A\u7701 <implRoot>/.impl-gate/checklist.md\u3002"
    }
  },
  required: ["graphRoot"]
};
var stubOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: { error: errorSchema }
};
function buildTools(deps) {
  const check = {
    name: "impl_gate_check",
    description: "Run the 32 IMPL-GATE assertions against a spec-graph root. Calls `python -m specgraph check --json` first; an invalid graph makes every assertion NOT-RUN with D4_GRAPH_INVALID. Does not do GUI checks, does not render a canvas, and never writes into the inspected project.",
    parameters: checkParameters,
    output: { schema: checkOutputSchema, render: renderCheck },
    async execute(args) {
      try {
        return await runCheck(args, deps);
      } catch (error) {
        return failureFrom(error);
      }
    }
  };
  const stub = (name2, description) => ({
    name: name2,
    description,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "\u89C4\u683C\u56FE\u8C31\u6839\u76EE\u5F55\u3002" },
        runId: { type: "string", description: "impl_gate_check \u8FD4\u56DE\u7684 runId\uFF1B\u7F3A\u7701\u8868\u793A\u6700\u8FD1\u4E00\u6B21\u8FD0\u884C\u3002" }
      },
      required: ["root"]
    },
    output: {
      schema: stubOutputSchema,
      render: (_args, value) => {
        const v = value;
        return [{ type: "text", text: `${name2} is not implemented yet: ${v.error?.code ?? "E_NOT_IMPLEMENTED"}` }];
      }
    },
    async execute(_args) {
      return fail("E_NOT_IMPLEMENTED", `${name2} ships in Step 4; use impl_gate_check for now`);
    }
  });
  return [
    check,
    stub("impl_gate_report", "Summarise a previous impl_gate_check run as PASS/FAIL/NOT-RUN per assertion. Does not re-run checks."),
    stub("impl_gate_verify_contract", "Check that A1\u2013A5 passed in one previous impl_gate_check run. Does not re-run checks.")
  ];
}

// src/host/index.ts
var name = "dsh-impl-gate";
var inject = ["tools"];
var Config = z.object({
  enabled: z.boolean().default(true).description("Enable the plugin."),
  specgraphCommand: z.string().default("python -m specgraph").description("specgraph \u547D\u4EE4\uFF1B\u9ED8\u8BA4 python -m specgraph\u3002"),
  pythonPath: z.string().default("").description("\u66FF\u6362\u547D\u4EE4\u9996\u4E2A python \u8BCD\u5143\uFF1B\u4E3A\u7A7A\u8868\u793A\u7528 PATH \u91CC\u7684 python\u3002"),
  specgraphCwd: z.string().default("").description("\u8FD0\u884C specgraph \u5B50\u8FDB\u7A0B\u7684\u5DE5\u4F5C\u76EE\u5F55\uFF1B\u6E90\u7801\u65B9\u5F0F\u5B89\u88C5\u65F6\u6307\u5411 spec-graph \u4ED3\u5E93\u3002"),
  timeoutMs: z.number().default(3e4).description("\u5355\u6B21 specgraph \u8C03\u7528\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09\u3002"),
  implRoot: z.string().default("").description("\u5B9E\u73B0\u6839\u76EE\u5F55\u7F3A\u7701\u503C\uFF1B\u4E3A\u7A7A\u65F6\u4F7F\u7528 graphRoot\u3002"),
  slow: z.boolean().default(false).description("\u9ED8\u8BA4\u662F\u5426\u8FD0\u884C slow \u65AD\u8A00\u3002")
});
function apply(ctx, config) {
  if (!config.enabled) return;
  const deps = {
    config: {
      specgraphCommand: config.specgraphCommand,
      pythonPath: config.pythonPath,
      specgraphCwd: config.specgraphCwd,
      timeoutMs: config.timeoutMs,
      implRoot: config.implRoot,
      slow: config.slow
    }
  };
  ctx.effect(() => {
    const disposers = buildTools(deps).map((tool) => ctx.tools.register(tool));
    return () => {
      for (const dispose of disposers) {
        if (typeof dispose === "function") dispose();
      }
    };
  });
}
export {
  Config,
  apply,
  auditChecklist,
  buildTools,
  inject,
  name,
  parseChecklist
};
