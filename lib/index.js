// src/host/index.ts
import z from "@deepseek-ai/schemastery";

// src/host/tools.ts
import { randomUUID, createHash as createHash5 } from "node:crypto";
import fs12 from "node:fs";
import os2 from "node:os";
import path11 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/host/assertions/a1.ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
function setDiff(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}
function sha256(text2) {
  return createHash("sha256").update(text2, "utf8").digest("hex").slice(0, 16);
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
  return { status: "PASS", evidence: `${lines.join(" | ")} specgraph_home=${ctx.specgraphHome || "configured"}` };
};

// src/host/assertions/delivery.ts
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
var NOT_RUN = (reason, evidence) => ({ status: "NOT-RUN", evidence, reason });
async function walkSpecs(root, depth = 0) {
  if (depth > 6) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const dir = join(root, entry.name);
    const specFile = join(dir, "spec.md");
    try {
      await stat(specFile);
      found.push({ node: entry.name, file: specFile });
    } catch {
    }
    found.push(...await walkSpecs(dir, depth + 1));
  }
  return found;
}
async function collectNeeds(root) {
  const ids = /* @__PURE__ */ new Set();
  for (const spec of await walkSpecs(root)) {
    const text2 = await readFile(spec.file, "utf8");
    const section = text2.split(/^## /m).find((part) => part.startsWith("\u9700\u8981"));
    if (!section) continue;
    for (const match of section.matchAll(/^###\s+(N\d+)\b/gm)) {
      const id = match[1];
      if (id !== void 0) ids.add(id);
    }
  }
  return [...ids].sort();
}
function tableCells(line) {
  return line.split("|").slice(1, -1).map((cell3) => cell3.trim());
}
async function readMapping(path12) {
  let text2;
  try {
    text2 = await readFile(path12, "utf8");
  } catch {
    return void 0;
  }
  const lines = text2.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.includes("|") && /需求\s*ID/i.test(line) && line.includes("\u6A21\u5757"));
  if (headerIndex < 0) return [];
  const headerLine = lines[headerIndex];
  if (headerLine === void 0) return [];
  const header = tableCells(headerLine);
  const needIndex = header.findIndex((cell3) => /需求\s*ID/i.test(cell3));
  const moduleIndex = header.findIndex((cell3) => cell3.includes("\u6A21\u5757"));
  const itemIndex = header.findIndex((cell3) => cell3.includes("\u6761\u76EE"));
  const rows = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = tableCells(line);
    rows.push({
      need: cells[needIndex] ?? "",
      module: cells[moduleIndex] ?? "",
      item: cells[itemIndex] ?? ""
    });
  }
  return rows;
}
var mappingPath = (ctx) => join(ctx.implRoot, ".impl-gate", "mapping.md");
var checkB1 = async (ctx) => {
  const rows = await readMapping(mappingPath(ctx));
  if (rows === void 0) {
    return NOT_RUN("MAPPING_TABLE_NOT_PROVIDED", `missing: ${mappingPath(ctx)}`);
  }
  const needs = await collectNeeds(ctx.graphRoot);
  const covered = new Set(rows.map((row) => row.need));
  const missing = needs.filter((id) => !covered.has(id));
  const extra = [...covered].filter((id) => id !== "" && !needs.includes(id));
  if (missing.length > 0) {
    return {
      status: "FAIL",
      evidence: `mapping=${mappingPath(ctx)} needs=${needs.length} covered=${needs.length - missing.length} missing=${missing.join(",") || "-"}`
    };
  }
  return {
    status: "PASS",
    evidence: `mapping=${mappingPath(ctx)} needs=${needs.length} covered=${needs.length} extra=${extra.length}`
  };
};
var checkB2 = async (ctx) => {
  if (!ctx.checklist.provided) {
    return NOT_RUN("CHECKLIST_NOT_PROVIDED", `missing: ${ctx.checklist.path}`);
  }
  const known = new Set(ctx.checks.map((item) => item.id));
  const declared = [...ctx.checklist.rows.keys()];
  const extra = declared.filter((id) => !known.has(id));
  if (extra.length > 0) {
    return {
      status: "FAIL",
      evidence: `checklist_ids=${declared.length} checks_ids=${known.size} extra=${extra.join(",")}`
    };
  }
  return {
    status: "PASS",
    evidence: `checklist_ids=${declared.length} checks_ids=${known.size} extra=0`
  };
};
var checkB3 = async () => NOT_RUN("EVIDENCE_TOKEN_UNSPECIFIED", "\u9700\u4EBA\u5DE5\u68C0\u7D22\u6D4B\u8BD5\u540D/\u6CE8\u91CA\u4E2D\u7684 N/E/C \u7F16\u53F7\uFF0C\u5DE5\u5177\u4E0D\u505A\u8BED\u4E49\u68C0\u7D22\uFF08D-10\uFF09");
var checkB5 = async (ctx) => {
  const rows = await readMapping(mappingPath(ctx));
  if (rows === void 0) {
    return NOT_RUN("MAPPING_TABLE_NOT_PROVIDED", `missing: ${mappingPath(ctx)}`);
  }
  const modules = new Set((await walkSpecs(ctx.graphRoot)).map((spec) => spec.node));
  const emptyCells = rows.filter((row) => row.module === "" || row.item === "");
  const unknown = rows.filter((row) => row.module !== "" && !modules.has(row.module)).map((row) => row.module);
  const seen = new Set(rows.map((row) => row.module).filter(Boolean));
  if (emptyCells.length > 0 || unknown.length > 0) {
    return {
      status: "FAIL",
      evidence: `rows=${rows.length} modules=${seen.size} empty_cells=${emptyCells.length} unknown=${unknown.join(",") || "-"}`
    };
  }
  return {
    status: "PASS",
    evidence: `rows=${rows.length} modules=${seen.size} per_module_min=1 empty_cells=0`
  };
};
var checkB6 = async () => NOT_RUN("HUMAN_PROCESS_REQUIRED", "\u201C\u5931\u8D25\u5373\u505C\u201D\u662F\u6D41\u7A0B\u7EA6\u675F\uFF0C\u5DE5\u5177\u53EA\u4EA7\u51FA\u7ED3\u8BBA\uFF1B\u7531\u4EBA\u68C0\u67E5\u4EA4\u4ED8\u8BF4\u660E\uFF08D-10\uFF09");
var checkB7 = async (ctx) => {
  if (!ctx.checklist.provided) {
    return NOT_RUN("CHECKLIST_NOT_PROVIDED", `missing: ${ctx.checklist.path}`);
  }
  const failed = [...ctx.checklist.rows.values()].filter((row) => row.status === "FAIL");
  const missing = failed.filter((row) => !/repro\s*:/i.test(row.evidence)).map((row) => row.id);
  if (missing.length > 0) {
    return {
      status: "FAIL",
      evidence: `fail_rows=${failed.length} with_repro=${failed.length - missing.length} missing=${missing.join(",")}`
    };
  }
  return {
    status: "PASS",
    evidence: `fail_rows=${failed.length} with_repro=${failed.length} missing=0`
  };
};
var checkB4 = async () => NOT_RUN("MANUAL_REVIEW_REQUIRED", "\u88C1\u51B3\u8BB0\u5F55\u7531\u4EBA\u5DE5\u7EF4\u62A4\uFF08B4 manual\uFF09");

// src/host/assertions/input.ts
import fs4 from "node:fs";
import path3 from "node:path";

// src/host/checklist.ts
import fs2 from "node:fs";
var NOT_RUN_REASONS = /* @__PURE__ */ new Set([
  "MISSING_INSTRUCTION_PACKAGE",
  "CHECKLIST_NOT_PROVIDED",
  "IMPL_ROOT_NOT_PROVIDED",
  "LANGUAGE_UNSUPPORTED",
  "SLOW_CHECK_DISABLED",
  "NETWORK_BLOCK_UNSUPPORTED",
  "SCHEMA_UNAVAILABLE",
  "D4_GRAPH_INVALID",
  "GUI_REQUIRES_MANUAL_CHECK",
  "NOT_IMPLEMENTED",
  "MANUAL_REVIEW_REQUIRED",
  "MAPPING_TABLE_NOT_PROVIDED",
  "EXEC_DISABLED",
  "HUMAN_PROCESS_REQUIRED",
  "EVIDENCE_TOKEN_UNSPECIFIED"
]);
var CHECKLIST_STATUSES = /* @__PURE__ */ new Set(["PASS", "FAIL", "NOT-RUN"]);
function splitRow(line) {
  const trimmed = line.trim();
  const cells = trimmed.split("|");
  if (trimmed.startsWith("|")) cells.shift();
  if (trimmed.endsWith("|")) cells.pop();
  return cells.map((cell3) => cell3.trim());
}
function isSeparator(cells) {
  return cells.length > 0 && cells.every((cell3) => /^:?-{3,}:?$/.test(cell3));
}
function parseChecklist(text2, filePath) {
  const rows = /* @__PURE__ */ new Map();
  const duplicatedIds = [];
  const errors = [];
  const uncovered = /* @__PURE__ */ new Set();
  let hasUncoveredSection = false;
  let inUncovered = false;
  for (const rawLine of text2.split(/\r?\n/)) {
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
    const text2 = fs2.readFileSync(filePath, "utf8");
    return parseChecklist(text2, filePath);
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
function findSpecgraphHome(start, probed = []) {
  let dir = path2.resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    const hit = specgraphPackageRoot(dir);
    pushProbe(probed, hit === void 0 ? dir : `${dir} -> hit`);
    if (hit !== void 0) return hit;
    const parent = path2.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return void 0;
}
var PACKAGE_CANDIDATES = ["specgraph", path2.join("spec-graph", "specgraph"), path2.join("specgraph", "specgraph")];
function specgraphPackageRoot(dir) {
  for (const candidate of PACKAGE_CANDIDATES) {
    const init = path2.join(dir, candidate, "__init__.py");
    if (fs3.existsSync(init)) return path2.dirname(path2.dirname(init));
  }
  return void 0;
}
function pushProbe(probed, entry) {
  if (!probed.includes(entry)) probed.push(entry);
}
function formatProbed(probed, limit = 6) {
  if (probed.length === 0) return "none";
  const shown = probed.slice(0, limit).join(", ");
  const extra = probed.length - limit;
  return extra > 0 ? `${shown}, \u2026(+${extra} more)` : shown;
}
function runSpecgraph(runner, args) {
  const executable = runner.argv[0];
  if (executable === void 0) {
    return Promise.reject(new SpecgraphError("E_PYTHON_MISSING", "specgraphCommand resolved to an empty argv"));
  }
  return runProcess([executable, ...runner.argv.slice(1), ...args], runner);
}
function resolveSpecgraphEnv(input) {
  const baseEnv = input.env ?? process.env;
  const probed = [];
  let home;
  const explicit = input.home?.trim() ?? "";
  if (explicit.length > 0) {
    home = path2.resolve(explicit);
    probed.push(home);
  }
  if (home === void 0) {
    for (const start of input.startDirs ?? []) {
      if (start === void 0 || start.trim().length === 0) continue;
      const found = findSpecgraphHome(start, probed);
      if (found !== void 0) {
        home = found;
        break;
      }
    }
  }
  if (home === void 0) {
    const fromEnv = baseEnv.SPECGRAPH_HOME;
    if (fromEnv !== void 0 && fromEnv.length > 0) {
      const found = specgraphPackageRoot(path2.resolve(fromEnv));
      probed.push(found === void 0 ? `SPECGRAPH_HOME=${fromEnv}` : `SPECGRAPH_HOME=${fromEnv} -> hit`);
      if (found !== void 0) home = found;
    }
  }
  const env = { ...baseEnv };
  if (home !== void 0) {
    const existing = env.PYTHONPATH;
    env.PYTHONPATH = existing === void 0 || existing.length === 0 ? home : `${home}${path2.delimiter}${existing}`;
  }
  return { argv: resolveArgv(input.command, input.pythonPath), cwd: home, env, home, probed };
}
function importArgv(argv) {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === "-m" && argv[index + 1] === "specgraph") {
      return [...argv.slice(0, index), "-c", "import specgraph"];
    }
  }
  return [...argv, "-c", "import specgraph"];
}
async function preflightSpecgraph(environment, timeoutMs) {
  const argv = importArgv(environment.argv);
  const attempts = [];
  const bare = { ...environment.env };
  delete bare.PYTHONPATH;
  attempts.push(bare);
  if (environment.home !== void 0) {
    attempts.push({ ...environment.env, PYTHONPATH: environment.home });
  }
  let lastError = "";
  for (const env of attempts) {
    try {
      const output = await runProcess(argv, { cwd: environment.cwd, env, timeoutMs });
      if (output.exitCode === 0) return;
      lastError = `${output.stderr}
${output.stdout}`.trim();
    } catch (error) {
      lastError = error.message;
    }
  }
  throw new SpecgraphError(
    "PYTHON_ENV_MISSING",
    `python cannot import specgraph; set PYTHONPATH to the spec-graph root or configure specgraphCwd (probed: ${formatProbed(environment.probed)})`,
    lastError.slice(-2e3)
  );
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
  if (missing.length > 0) problems.push(`missing ids: ${missing.join(", ")}`);
  if (unknown.length > 0) problems.push(`unknown ids: ${unknown.join(", ")}`);
  for (const error of ctx.checklist.errors) problems.push(error);
  const evidence = `rows=${ctx.checklist.rows.size} expected=${ctx.checks.length} missing=${missing.length} unknown=${unknown.length} duplicates=${ctx.checklist.duplicatedIds.length} problem_count=${problems.length}`;
  return problems.length === 0 ? { status: "PASS", evidence } : { status: "FAIL", evidence: `${evidence} :: ${firstProblems(problems)}` };
};
var EXIT_MARKER = /\bexit:\s*(-?\d+)/;
var COMMAND_SPLIT = /;\s*|\s+\|\s+/;
function commandPayload(evidence) {
  const rest = evidence.replace(/^command:\s*/i, "");
  const withoutExit = rest.replace(/\s*\bexit:\s*-?\d+\b.*$/i, "");
  return (withoutExit.split(COMMAND_SPLIT)[0] ?? "").trim();
}
function evidenceRoots(ctx) {
  const roots = [ctx.implRoot, path3.dirname(ctx.implRoot), ctx.graphRoot, path3.dirname(ctx.graphRoot)];
  return roots.filter((root, index) => root !== "" && roots.indexOf(root) === index);
}
function resolveEvidenceFile(ctx, relative) {
  for (const root of evidenceRoots(ctx)) {
    const candidate = path3.resolve(root, relative);
    if (fs4.existsSync(candidate) && fs4.statSync(candidate).isFile()) return candidate;
  }
  return "";
}
function countLines(file) {
  const text2 = fs4.readFileSync(file, "utf8");
  if (text2 === "") return 0;
  return text2.split("\n").length - (text2.endsWith("\n") ? 1 : 0);
}
var checkA3 = async (ctx) => {
  if (!ctx.checklist.provided) return checklistMissing();
  const problems = [];
  let prefixOk = 0;
  let placeholders = 0;
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
      const target = row.evidence.replace(/^file:\s*/i, "");
      if (!/:\d+$/.test(target)) {
        problems.push(`${row.id}: file evidence lacks :line`);
        continue;
      }
      const line = Number(target.slice(target.lastIndexOf(":") + 1));
      const relative = target.slice(0, target.lastIndexOf(":"));
      const resolved = resolveEvidenceFile(ctx, relative);
      if (resolved !== "" && line > 0) {
        const total = countLines(resolved);
        if (line > total) problems.push(`${row.id}: ${relative}:${line} is past the end of the file (${total} lines)`);
      }
      continue;
    }
    const exitMatch = EXIT_MARKER.exec(row.evidence);
    if (exitMatch === null) {
      problems.push(`${row.id}: command evidence lacks exit: marker`);
      continue;
    }
    const payload = commandPayload(row.evidence);
    if (/<[^>]+>/.test(payload)) {
      placeholders += 1;
      continue;
    }
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
  const evidence = `rows=${ctx.checklist.rows.size} prefix_ok=${prefixOk} sampled=${runnable.length} placeholders_skipped=${placeholders} replay=[${results.join(",")}] problems=${problems.length}`;
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

// src/host/assertions/exec.ts
import { basename } from "node:path";
var REPLAY_TIMEOUT_MS = 12e4;
var REPLAY_LIMIT = 5;
var ALLOWED = [/^python(\d+(\.\d+)*)?(\.exe)?$/i, /^pnpm(\.cmd|\.exe)?$/i, /^node(\.exe)?$/i];
function firstTokenAllowed(token) {
  return ALLOWED.some((pattern) => pattern.test(basename(token)));
}
function parseReplayEvidence(evidence) {
  const match = /^command:\s*(.+?)(?:;\s*exit:\s*(-?\d+))?\s*$/s.exec(evidence);
  if (!match) return void 0;
  const command = match[1] ?? "";
  return { command: command.trim(), exitCode: match[2] === void 0 ? 0 : Number(match[2]) };
}
function makeReplayCheck(id) {
  return async (ctx) => {
    if (!ctx.allowCommandReplay) {
      return { status: "NOT-RUN", reason: "EXEC_DISABLED", evidence: `allowCommandReplay=false; id=${id}` };
    }
    const row = ctx.checklist.rows.get(id);
    if (!row) {
      return { status: "NOT-RUN", reason: "CHECKLIST_NOT_PROVIDED", evidence: `no checklist row for ${id}` };
    }
    const parsed = parseReplayEvidence(row.evidence);
    if (!parsed) {
      return { status: "NOT-RUN", reason: "EVIDENCE_TOKEN_UNSPECIFIED", evidence: `row ${id} evidence is not a command` };
    }
    if (/<[^>]+>/.test(parsed.command)) {
      return {
        status: "NOT-RUN",
        reason: "EVIDENCE_TOKEN_UNSPECIFIED",
        evidence: `row ${id} command contains a <placeholder>; skipped`
      };
    }
    const argv = splitCommand(parsed.command);
    const first = argv[0];
    if (first === void 0 || !firstTokenAllowed(first)) {
      return {
        status: "NOT-RUN",
        reason: "EVIDENCE_TOKEN_UNSPECIFIED",
        evidence: `row ${id} first token not allowed: ${argv[0] ?? "(empty)"}`
      };
    }
    if (ctx.replayBudget.remaining <= 0) {
      return {
        status: "NOT-RUN",
        reason: "EXEC_DISABLED",
        evidence: `skipped=replay_budget_exhausted limit=${REPLAY_LIMIT}`
      };
    }
    ctx.replayBudget.remaining -= 1;
    try {
      const out = await ctx.runImpl(argv);
      const head = (out.stdout || out.stderr).trim().split(/\r?\n/)[0]?.slice(0, 200) ?? "";
      if (out.exitCode === parsed.exitCode) {
        return { status: "PASS", evidence: `cmd=${parsed.command}; expected=${parsed.exitCode}; actual=${out.exitCode}` };
      }
      return {
        status: "FAIL",
        evidence: `cmd=${parsed.command}; exit_db=${parsed.exitCode}; run_again=${out.exitCode}; combined_head=${out.stderr || head}`
      };
    } catch (error) {
      const err = error;
      if (err.code === "E_TIMEOUT" || /timeout|did not finish within/i.test(err.message)) {
        return {
          status: "FAIL",
          evidence: `cmd=${parsed.command}; expected=${parsed.exitCode}; timeout=${REPLAY_TIMEOUT_MS}ms; spawn_error=${err.message}`
        };
      }
      return {
        status: "FAIL",
        evidence: `cmd=${parsed.command}; expected=${parsed.exitCode}; spawn_error=${err.message}`
      };
    }
  };
}

// src/host/assertions/modules.ts
var checkM1 = makeReplayCheck("M1");
var checkM2 = makeReplayCheck("M2");
var checkM3 = makeReplayCheck("M3");
var checkM4 = makeReplayCheck("M4");
var checkM5 = makeReplayCheck("M5");
var checkM6 = makeReplayCheck("M6");
var checkM8 = makeReplayCheck("M8");
var checkM9 = makeReplayCheck("M9");

// src/host/assertions/q10.ts
import fs5 from "node:fs";
import path4 from "node:path";
var checkQ10 = async (ctx) => {
  const observations = [];
  const tempRoot = await ctx.newTempDir("impl-gate-q10-");
  try {
    const valid = await ctx.run(["check", ctx.graphRoot, "--json"]);
    observations.push(`valid_exit=${valid.exitCode} expected=0`);
    const broken = path4.join(tempRoot, "broken");
    await fs5.promises.cp(ctx.graphRoot, broken, { recursive: true });
    await fs5.promises.writeFile(path4.join(broken, "graph.toml"), "[[link]\n", "utf8");
    const invalid = await ctx.run(["check", broken, "--json"]);
    observations.push(`broken_exit=${invalid.exitCode} expected=1`);
    const usage = await ctx.run(["check", "--definitely-not-a-flag"]);
    observations.push(`usage_exit=${usage.exitCode} expected=2`);
    const ok = valid.exitCode === 0 && invalid.exitCode === 1 && usage.exitCode === 2;
    return { status: ok ? "PASS" : "FAIL", evidence: observations.join(" ") };
  } finally {
    await fs5.promises.rm(tempRoot, { recursive: true, force: true });
  }
};

// src/host/assertions/quality.ts
var checkQ2 = makeReplayCheck("Q2");
var checkQ3 = makeReplayCheck("Q3");
var checkQ5 = makeReplayCheck("Q5");
var checkQ6 = makeReplayCheck("Q6");
var checkQ7 = makeReplayCheck("Q7");
var checkQ8 = makeReplayCheck("Q8");
var checkQ9 = makeReplayCheck("Q9");

// src/host/assertions/index.ts
var ASSERTIONS = {
  A1: checkA1,
  A2: checkA2,
  A3: checkA3,
  A4: checkA4,
  A5: checkA5,
  B1: checkB1,
  B2: checkB2,
  B3: checkB3,
  B4: checkB4,
  B5: checkB5,
  B6: checkB6,
  B7: checkB7,
  M1: checkM1,
  M2: checkM2,
  M3: checkM3,
  M4: checkM4,
  M5: checkM5,
  M6: checkM6,
  M8: checkM8,
  M9: checkM9,
  Q2: checkQ2,
  Q3: checkQ3,
  Q5: checkQ5,
  Q6: checkQ6,
  Q7: checkQ7,
  Q8: checkQ8,
  Q9: checkQ9,
  Q10: checkQ10
};

// src/host/checks.ts
import fs6 from "node:fs";
import path5 from "node:path";
import { fileURLToPath } from "node:url";
function checksFilePath() {
  return path5.resolve(path5.dirname(fileURLToPath(import.meta.url)), "..", "checks", "impl-gate.checks.json");
}
function loadChecks() {
  const file = checksFilePath();
  let parsed;
  try {
    parsed = JSON.parse(fs6.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
  const items = parsed?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`${file} has no items array`);
  }
  return items;
}

// src/host/compose/draft.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value, fallback = "\uFF08\u5F85\u586B\uFF09") {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}
function stringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.length > 0) : [];
}
function moduleSlot(module, field) {
  const value = module[field];
  const empty = value === void 0 || typeof value === "string" && value.trim().length === 0 || Array.isArray(value) && value.length === 0;
  if (empty) return `<!-- TODO: ${field} -->`;
  if (Array.isArray(value)) return `\uFF08\u5F53\u524D ${value.length} \u6761\uFF0Cmaterialize \u65F6\u5C55\u5F00\uFF09`;
  return `\uFF08\u5DF2\u586B\uFF0Cmaterialize \u65F6\u5C55\u5F00\uFF09`;
}
function renderDraft(input) {
  const plan = isRecord(input.plan) ? input.plan : {};
  const modules = Array.isArray(plan.modules) ? plan.modules.filter(isRecord) : [];
  const lines = [];
  lines.push(`# ${text(plan.title, text(plan.name, "\u672A\u547D\u540D\u7CFB\u7EDF"))} \xB7 SPEC\uFF08\u8349\u7A3F\uFF09`);
  lines.push("");
  lines.push(`> \u9700\u6C42\uFF1A${text(input.requirement, "\uFF08\u672A\u63D0\u4F9B\uFF09")}`);
  lines.push("> \u672C\u6587\u4EF6\u7531 impl_gate_compose \u751F\u6210\uFF1B\u8BF7\u8865\u9F50 compose-plan.json \u540E\u91CD\u65B0 materialize\u3002");
  lines.push(">");
  lines.push("> \u8FD9\u4E00\u4EFD\u53EA\u662F\u9AA8\u67B6\uFF1A\u6BCF\u8282\u6CE8\u660E\u6570\u636E\u6765\u81EA plan \u7684\u54EA\u4E2A\u5B57\u6BB5\uFF0C\u6A21\u5757\u5C0F\u8282\u91CC\u7684 `<!-- TODO: \u2026 -->` \u662F\u8FD8\u6CA1\u586B\u7684\u69FD\u4F4D\u3002");
  lines.push("");
  lines.push("## 1 \u76EE\u6807\u4E0E\u975E\u76EE\u6807");
  lines.push("> \u6570\u636E\u6765\u6E90\uFF1A`summary` + `goals` + `nonGoals`\u3002");
  lines.push("");
  lines.push(text(plan.summary, "<!-- TODO: summary -->"));
  lines.push("");
  lines.push(`- \u76EE\u6807\uFF1A${stringList(plan.goals).length > 0 ? `\uFF08\u5F53\u524D ${stringList(plan.goals).length} \u6761\uFF09` : "<!-- TODO: goals -->"}`);
  lines.push(
    `- \u975E\u76EE\u6807\uFF1A${stringList(plan.nonGoals).length > 0 ? `\uFF08\u5F53\u524D ${stringList(plan.nonGoals).length} \u6761\uFF09` : "<!-- TODO: nonGoals -->"}`
  );
  lines.push("");
  lines.push("## 2 \u7CFB\u7EDF\u8FB9\u754C");
  lines.push("> \u6570\u636E\u6765\u6E90\uFF1A`boundaries`\uFF1B\u8868\u683C\u56DB\u5217\u4E3A\u4F9D\u8D56 / \u7528\u9014 / \u7248\u672C / \u4E0D\u53EF\u7528\u65F6\u600E\u4E48\u529E\u3002");
  lines.push("");
  lines.push(Array.isArray(plan.boundaries) && plan.boundaries.length > 0 ? "\uFF08\u5DF2\u586B\uFF0Cmaterialize \u65F6\u5C55\u5F00\u4E3A\u8868\u683C\uFF09" : "<!-- TODO: boundaries -->");
  lines.push("");
  lines.push("## 3 \u6A21\u5757\u6E05\u5355");
  lines.push("> \u6570\u636E\u6765\u6E90\uFF1A`modules`\uFF1B\u6BCF\u4E2A\u6A21\u5757\u4E00\u4E2A `### M<id>` \u5C0F\u8282\u3002");
  lines.push("");
  if (modules.length === 0) {
    lines.push("<!-- TODO: modules -->");
    lines.push("");
  }
  for (const module of modules) {
    const id = text(module.id, "M?");
    lines.push(`### ${id} ${text(module.title, "\uFF08\u6807\u9898\u5F85\u586B\uFF09")}`);
    lines.push(`- \u76EE\u5F55\uFF1A${text(module.dir, "<!-- TODO: dir -->")}`);
    lines.push(`- \u804C\u8D23\uFF1A${text(module.responsibility, "<!-- TODO: responsibility -->")}`);
    lines.push(`- \u63D0\u4F9B\uFF08exposes\uFF09\uFF1A${moduleSlot(module, "exposes")}`);
    lines.push(`- \u9700\u8981\uFF08requires\uFF09\uFF1A${moduleSlot(module, "requires")}`);
    lines.push(`- \u7EA6\u675F\uFF08constraints\uFF09\uFF1A${moduleSlot(module, "constraints")}`);
    lines.push(`- \u6587\u4EF6\uFF08files\uFF09\uFF1A${moduleSlot(module, "files")}`);
    lines.push(`- \u9A8C\u6536\uFF08acceptance\uFF09\uFF1A${moduleSlot(module, "acceptance")}`);
    lines.push("");
  }
  lines.push("## 4 \u6570\u636E\u7ED3\u6784");
  lines.push("> \u6570\u636E\u6765\u6E90\uFF1A`data`\uFF1B\u6BCF\u5F20\u8868\u5217\u51FA\u5B57\u6BB5\u4E0E\u7C7B\u578B\uFF0C\u5E76\u9644\u4E0A `indexes`\u3001`notes`\u3002");
  lines.push("");
  lines.push(Array.isArray(plan.data) && plan.data.length > 0 ? "\uFF08\u5DF2\u586B\uFF0Cmaterialize \u65F6\u5C55\u5F00\uFF09" : "<!-- TODO: data -->");
  lines.push("");
  lines.push("## 5 \u6A21\u5757\u8FDE\u7EBF");
  lines.push("> \u6570\u636E\u6765\u6E90\uFF1A`requires` \u2192 `graph.toml` \u7684 link\uFF1B\u8868\u683C\u5217\u4E3A\u8C01\u8C03\u8C01 / \u4F20\u4EC0\u4E48 / \u5931\u8D25\u5904\u7406\u3002");
  lines.push("");
  lines.push("\uFF08materialize \u65F6\u7531 link \u5173\u7CFB\u751F\u6210\uFF09");
  lines.push("");
  lines.push("## 6 \u9A8C\u6536\u6807\u51C6");
  lines.push("> \u6570\u636E\u6765\u6E90\uFF1A\u6BCF\u4E2A\u6A21\u5757\u7684 `acceptance`\uFF1B\u8868\u683C\u5217\u4E3A\u7F16\u53F7 / \u65AD\u8A00 / \u6700\u4F4E\u6D4B\u8BD5\u3002");
  lines.push("");
  lines.push("\uFF08materialize \u65F6\u7531 acceptance \u751F\u6210\uFF09");
  lines.push("");
  lines.push("## 7 \u5B9E\u65BD\u6CE2\u6B21");
  lines.push("> \u6570\u636E\u6765\u6E90\uFF1A\u7531 link \u7684\u6700\u957F\u8DEF\u5F84\u8BA1\u7B97\uFF08\u4E0E impl_gate_init \u5171\u7528\u540C\u4E00\u51FD\u6570\uFF09\u3002");
  lines.push("");
  lines.push("\uFF08materialize \u65F6\u751F\u6210\uFF09");
  lines.push("");
  lines.push("## 8 \u5168\u5C40\u7EA6\u5B9A");
  lines.push("> \u6570\u636E\u6765\u6E90\uFF1A`globals` + `stack` + `envKeys`\u3002");
  lines.push("");
  const globals = isRecord(plan.globals) ? plan.globals : {};
  lines.push(`- \u6280\u672F\u6808\uFF1A${text(plan.stack, "<!-- TODO: stack -->")}`);
  lines.push(`- \u7EA6\u5B9A\uFF1A${stringList(globals.conventions).length > 0 ? `\uFF08\u5F53\u524D ${stringList(globals.conventions).length} \u6761\uFF09` : "<!-- TODO: conventions -->"}`);
  lines.push(`- \u7981\u6B62\uFF1A${stringList(globals.forbidden).length > 0 ? `\uFF08\u5F53\u524D ${stringList(globals.forbidden).length} \u6761\uFF09` : "<!-- TODO: forbidden -->"}`);
  lines.push(`- \u73AF\u5883\u53D8\u91CF\uFF1A${stringList(globals.envKeys).length > 0 ? "\uFF08\u5DF2\u586B\uFF09" : "<!-- TODO: envKeys\uFF08\u53EF\u9009\uFF09 -->"}`);
  lines.push("");
  lines.push("## 9 \u4EA4\u4ED8\u6E05\u5355");
  lines.push("> \u6570\u636E\u6765\u6E90\uFF1A`deliverables.tree` + `deliverables.files`\uFF1B\u8868\u683C\u5217\u4E3A\u8DEF\u5F84 / \u7528\u9014\u3002");
  lines.push("");
  const deliverables = isRecord(plan.deliverables) ? plan.deliverables : {};
  lines.push(`- \u76EE\u5F55\u6811\uFF1A${text(deliverables.tree, "<!-- TODO: deliverables.tree -->")}`);
  lines.push(
    `- \u6587\u4EF6\uFF1A${Array.isArray(deliverables.files) && deliverables.files.length > 0 ? `\uFF08\u5F53\u524D ${deliverables.files.length} \u6761\uFF09` : "<!-- TODO: deliverables.files -->"}`
  );
  lines.push("");
  lines.push("---");
  lines.push('\u8865\u9F50 compose-plan.json \u540E\uFF0C\u7528 `impl_gate_compose(mode: "materialize")` \u751F\u6210\u6B63\u5F0F SPEC.md\u3002');
  lines.push("");
  return lines.join("\n");
}

// src/host/compose/materialize.ts
import fs9 from "node:fs";
import os from "node:os";
import path8 from "node:path";
import { createHash as createHash3 } from "node:crypto";

// src/host/compose/plan.ts
var NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
var MODULE_ID_RE = /^M[0-9]{1,2}$/;
var EXPOSE_KINDS = /* @__PURE__ */ new Set(["http", "fn", "ui"]);
var ROOT_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "name",
  "title",
  "summary",
  "stack",
  "goals",
  "nonGoals",
  "boundaries",
  "globals",
  "data",
  "modules",
  "types",
  "errors",
  "http",
  "runtime",
  "flows",
  "ui",
  "openQuestions",
  "deliverables"
]);
var MODULE_KEYS = /* @__PURE__ */ new Set([
  "id",
  "dir",
  "title",
  "responsibility",
  "exposes",
  "requires",
  "constraints",
  "files",
  "acceptance",
  "wave"
]);
var EXPOSE_KEYS = /* @__PURE__ */ new Set(["kind", "signature", "note"]);
var REQUIRE_KEYS = /* @__PURE__ */ new Set(["module", "item", "why"]);
var BOUNDARY_KEYS = /* @__PURE__ */ new Set(["dependency", "purpose", "version", "fallback"]);
var COLUMN_KEYS = /* @__PURE__ */ new Set(["name", "type", "constraints"]);
var DATA_KEYS = /* @__PURE__ */ new Set(["table", "owner", "rowWriters", "columns", "indexes", "notes"]);
var GLOBALS_KEYS = /* @__PURE__ */ new Set(["conventions", "forbidden", "envKeys", "fieldCase", "listEnvelope", "errorShape", "nfr"]);
var DELIVERABLE_KEYS = /* @__PURE__ */ new Set(["tree", "files"]);
var FILE_KEYS = /* @__PURE__ */ new Set(["path", "purpose"]);
var ACCEPTANCE_KEYS = /* @__PURE__ */ new Set(["id", "assertion", "test", "covers"]);
var TYPE_KEYS = /* @__PURE__ */ new Set(["name", "kind", "fields", "values", "source", "note", "owner"]);
var TYPE_FIELD_KEYS = /* @__PURE__ */ new Set(["name", "type", "note", "unit"]);
var ERROR_KEYS = /* @__PURE__ */ new Set(["code", "status", "when", "shape", "by"]);
var HTTP_KEYS = /* @__PURE__ */ new Set(["method", "path", "module", "handler", "req", "res", "auth", "reqExample", "resExample", "status", "resHeaders", "query"]);
var HTTP_QUERY_KEYS = /* @__PURE__ */ new Set(["name", "type", "required", "note"]);
var FLOW_KEYS = /* @__PURE__ */ new Set(["id", "name", "trigger", "steps", "success", "failure"]);
var RUNTIME_KEYS = /* @__PURE__ */ new Set(["port", "start", "health", "migrate", "rollback"]);
var FLOW_STEP_KEYS = /* @__PURE__ */ new Set(["module", "action", "note"]);
var AUTH_MODES = /* @__PURE__ */ new Set(["public", "session", "admin"]);
var TYPE_KINDS = /* @__PURE__ */ new Set(["object", "enum", "union", "external"]);
var HTTP_METHODS = /* @__PURE__ */ new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
var BUILTIN_TYPES = /* @__PURE__ */ new Set([
  "Promise",
  "Array",
  "ReadonlyArray",
  "Record",
  "Partial",
  "Pick",
  "Omit",
  "Exclude",
  "NonNullable",
  "Date",
  "Error",
  "Map",
  "Set",
  "Uint8Array",
  "Buffer"
]);
var TYPE_NAME_RE = /^[A-Z][A-Za-z0-9_]*$/;
var TYPE_REF_RE = /\b[A-Z][A-Za-z0-9_]*\b/g;
var TYPE_SLOT_REF_RE = /(?::|<|\||,)\s*([A-Z][A-Za-z0-9_]*)/g;
var HTTP_METHOD_PREFIX = /^(?:GET|POST|PUT|PATCH|DELETE)\s+/;
var ROUTE_REF_RE = /\b(GET|POST|PUT|PATCH|DELETE)[ \t]+[“"「『《]?(\/[A-Za-z0-9._~:/?#%&=-]*)/g;
var ROUTE_TRAILING_PUNCT = /[,.;:)）;、」』”’》】"'。]+$/u;
function normalizeRouteRef(rawPath) {
  const cut = rawPath.search(/[?#]/);
  const path12 = (cut === -1 ? rawPath : rawPath.slice(0, cut)).replace(ROUTE_TRAILING_PUNCT, "");
  if (path12.length === 0 || /\s/.test(path12)) return void 0;
  return path12;
}
function declaredRouteHint(declared, method) {
  const paths = [...declared].filter((route) => route.startsWith(`${method} `)).map((route) => route.slice(method.length + 1)).sort();
  if (paths.length === 0) return "";
  const shown = paths.slice(0, 3);
  return `\uFF08\u5DF2\u58F0\u660E\uFF1A${shown.join("\u3001")}${paths.length > shown.length ? " \u7B49" : ""}\uFF09`;
}
var ERROR_CODE_RE = /^E_[A-Z0-9_]+$/;
var ERROR_REF_RE = /\bE_[A-Z0-9_]+/g;
var HANDLER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;
function stripMeta(value) {
  if (Array.isArray(value)) return value.map((entry) => stripMeta(entry));
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.startsWith("_")) continue;
    out[key] = stripMeta(entry);
  }
  return out;
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function pointer(base, key) {
  const token = String(key).replace(/~/g, "~0").replace(/\//g, "~1");
  return `${base}/${token}`;
}
function problem(problems, path12, message) {
  problems.push({ code: "PLAN_INVALID", path: path12, message });
}
function checkKnownKeys(value, allowed, base, problems) {
  for (const key of Object.keys(value)) {
    if (key.startsWith("_")) continue;
    if (!allowed.has(key)) {
      problem(problems, pointer(base, key), `unknown field "${key}" (plan schema v1 is fixed)`);
    }
  }
}
function readString(value, base, problems) {
  if (typeof value !== "string" || value.trim().length === 0) {
    problem(problems, base, "must be a non-empty string");
    return "";
  }
  return value;
}
function readStringArray(value, base, problems) {
  if (!Array.isArray(value)) {
    problem(problems, base, "must be an array of strings");
    return [];
  }
  const out = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      problem(problems, pointer(base, index), "must be a non-empty string");
      return;
    }
    out.push(entry);
  });
  return out;
}
function readNonEmptyArray(value, base, problems, what) {
  if (!Array.isArray(value) || value.length === 0) {
    problem(problems, base, `must be a non-empty array (${what})`);
    return [];
  }
  return value;
}
function isUnsafeRelative(file) {
  if (file.trim().length === 0) return "must be a non-empty path";
  if (/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith("/") || file.startsWith("\\")) {
    return "must be a relative path";
  }
  const segments = file.split(/[\\/]+/);
  if (segments.includes("..")) return 'must not contain ".."';
  return null;
}
function validateExposes(raw, base, problems) {
  const list = readNonEmptyArray(raw, base, problems, "at least one exposed item");
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  list.forEach((entry, index) => {
    const at = pointer(base, index);
    if (!isRecord2(entry)) {
      problem(problems, at, "must be an object");
      return;
    }
    checkKnownKeys(entry, EXPOSE_KEYS, at, problems);
    const kind = entry.kind;
    if (typeof kind !== "string" || !EXPOSE_KINDS.has(kind)) {
      problem(problems, pointer(at, "kind"), 'must be one of "http", "fn", "ui"');
    }
    const signature = readString(entry.signature, pointer(at, "signature"), problems);
    if (entry.note !== void 0 && (typeof entry.note !== "string" || entry.note.trim().length === 0)) {
      problem(problems, pointer(at, "note"), "must be a non-empty string when present");
    }
    if (signature.length > 0) {
      if (seen.has(signature)) problem(problems, pointer(at, "signature"), `duplicate signature "${signature}" in this module`);
      seen.add(signature);
    }
    out.push({ signature, note: typeof entry.note === "string" ? entry.note : void 0 });
  });
  return out;
}
function validateRequires(raw, base, problems) {
  if (raw === void 0) return [];
  if (!Array.isArray(raw)) {
    problem(problems, base, "must be an array");
    return [];
  }
  const out = [];
  raw.forEach((entry, index) => {
    const at = pointer(base, index);
    if (!isRecord2(entry)) {
      problem(problems, at, "must be an object");
      return;
    }
    checkKnownKeys(entry, REQUIRE_KEYS, at, problems);
    const module = readString(entry.module, pointer(at, "module"), problems);
    const item = readString(entry.item, pointer(at, "item"), problems);
    if (entry.why !== void 0 && typeof entry.why !== "string") {
      problem(problems, pointer(at, "why"), "must be a string when present");
    }
    out.push({ module, item });
  });
  return out;
}
function validateModules(raw, problems, goalsCount) {
  const list = readNonEmptyArray(raw, "/modules", problems, "at least one module");
  const out = [];
  const ids = /* @__PURE__ */ new Set();
  const dirs = /* @__PURE__ */ new Set();
  const acceptanceIds = /* @__PURE__ */ new Map();
  list.forEach((entry, index) => {
    const at = pointer("/modules", index);
    if (!isRecord2(entry)) {
      problem(problems, at, "must be an object");
      return;
    }
    checkKnownKeys(entry, MODULE_KEYS, at, problems);
    const id = readString(entry.id, pointer(at, "id"), problems);
    if (id.length > 0 && !MODULE_ID_RE.test(id)) problem(problems, pointer(at, "id"), "must match ^M[0-9]{1,2}$");
    if (id.length > 0) {
      if (ids.has(id)) problem(problems, pointer(at, "id"), `duplicate module id "${id}"`);
      ids.add(id);
    }
    const dir = readString(entry.dir, pointer(at, "dir"), problems);
    if (dir.length > 0) {
      const unsafe = isUnsafeRelative(dir);
      if (unsafe !== null) problem(problems, pointer(at, "dir"), unsafe);
      if (dirs.has(dir)) problem(problems, pointer(at, "dir"), `duplicate module dir "${dir}"`);
      dirs.add(dir);
    }
    if (entry.wave !== void 0) {
      const wave = entry.wave;
      if (typeof wave !== "number" || !Number.isInteger(wave) || wave < 1) {
        problem(problems, pointer(at, "wave"), "must be a positive integer (wave number) when given");
      }
    }
    readString(entry.title, pointer(at, "title"), problems);
    readString(entry.responsibility, pointer(at, "responsibility"), problems);
    const exposes = validateExposes(entry.exposes, pointer(at, "exposes"), problems);
    const requires = validateRequires(entry.requires, pointer(at, "requires"), problems);
    readNonEmptyArray(entry.constraints, pointer(at, "constraints"), problems, "at least one constraint");
    readStringArray(entry.constraints, pointer(at, "constraints"), problems);
    const files = readNonEmptyArray(entry.files, pointer(at, "files"), problems, "at least one file");
    const seenFiles = /* @__PURE__ */ new Set();
    readStringArray(entry.files, pointer(at, "files"), problems).forEach((file, fileIndex) => {
      const unsafe = isUnsafeRelative(file);
      if (unsafe !== null) problem(problems, pointer(pointer(at, "files"), fileIndex), unsafe);
      if (seenFiles.has(file)) {
        problem(problems, pointer(pointer(at, "files"), fileIndex), `duplicate file "${file}" in this module`);
      }
      seenFiles.add(file);
    });
    if (files.length === 0) {
    }
    const acceptanceList = readNonEmptyArray(entry.acceptance, pointer(at, "acceptance"), problems, "at least one acceptance item");
    acceptanceList.forEach((item, itemIndex) => {
      const itemAt = pointer(pointer(at, "acceptance"), itemIndex);
      if (!isRecord2(item)) {
        problem(problems, itemAt, "must be an object");
        return;
      }
      checkKnownKeys(item, ACCEPTANCE_KEYS, itemAt, problems);
      const acceptanceId = readString(item.id, pointer(itemAt, "id"), problems);
      readString(item.assertion, pointer(itemAt, "assertion"), problems);
      readString(item.test, pointer(itemAt, "test"), problems);
      if (item.covers !== void 0) {
        const covers = item.covers;
        const match = typeof covers === "string" ? /^G([1-9][0-9]*)$/.exec(covers) : null;
        if (match === null) {
          problem(problems, pointer(itemAt, "covers"), "must be G<n> with n starting at 1");
        } else if (Number(match[1]) > goalsCount) {
          problem(problems, pointer(itemAt, "covers"), `covers "${covers}" is outside goals 1..${goalsCount || 1}`);
        }
      }
      if (acceptanceId.length > 0) {
        const previous = acceptanceIds.get(acceptanceId);
        if (previous !== void 0) {
          problem(problems, pointer(itemAt, "id"), `duplicate acceptance id "${acceptanceId}" (already used in ${previous})`);
        } else {
          acceptanceIds.set(acceptanceId, at);
        }
      }
    });
    out.push({ id, exposes, requires });
  });
  list.forEach((entry, index) => {
    if (!isRecord2(entry) || !Array.isArray(entry.requires)) return;
    entry.requires.forEach((need, needIndex) => {
      if (!isRecord2(need)) return;
      const targetId = typeof need.module === "string" ? need.module : "";
      const item = typeof need.item === "string" ? need.item : "";
      if (targetId.length === 0 || item.length === 0) return;
      const targetIndex = list.findIndex(
        (candidate) => isRecord2(candidate) && typeof candidate.id === "string" && candidate.id === targetId
      );
      if (targetIndex < 0) {
        problem(
          problems,
          pointer(pointer(pointer("/modules", index), "requires"), needIndex) + "/module",
          `requires.module "${targetId}" does not exist`
        );
        return;
      }
      const target = list[targetIndex];
      const exposes = isRecord2(target) && Array.isArray(target.exposes) ? target.exposes : [];
      const matches = exposes.some(
        (candidate) => isRecord2(candidate) && (typeof candidate.signature === "string" && candidate.signature === item || typeof candidate.note === "string" && candidate.note === item)
      );
      if (!matches) {
        problem(
          problems,
          pointer(pointer(pointer("/modules", index), "requires"), needIndex) + "/item",
          `requires.item "${item}" does not match any exposes signature/note of ${targetId}`
        );
      }
    });
  });
  const cycle = findCycle(out);
  if (cycle !== null) {
    problem(problems, "/modules", `dependency cycle: ${cycle.join(" \u2192 ")}`);
  }
  return out;
}
function findCycle(modules) {
  const adjacency = /* @__PURE__ */ new Map();
  for (const module of modules) {
    if (module.id.length === 0) continue;
    adjacency.set(
      module.id,
      module.requires.map((need) => need.module).filter((id) => id.length > 0 && id !== module.id)
    );
  }
  const state = /* @__PURE__ */ new Map();
  const stack = [];
  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!adjacency.has(next)) continue;
      const seen = state.get(next) ?? 0;
      if (seen === 1) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (seen === 0) {
        const found = visit(next);
        if (found !== null) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of adjacency.keys()) {
    if ((state.get(id) ?? 0) === 0) {
      const found = visit(id);
      if (found !== null) return found;
    }
  }
  return null;
}
function validateTypes(raw, problems) {
  if (raw === void 0) return [];
  if (!Array.isArray(raw)) {
    problem(problems, "/types", "must be an array");
    return [];
  }
  const names = [];
  const seen = /* @__PURE__ */ new Set();
  raw.forEach((entry, index) => {
    const at = pointer("/types", index);
    if (!isRecord2(entry)) {
      problem(problems, at, "must be an object");
      return;
    }
    checkKnownKeys(entry, TYPE_KEYS, at, problems);
    const name2 = readString(entry.name, pointer(at, "name"), problems);
    if (name2.length > 0) {
      if (!TYPE_NAME_RE.test(name2)) problem(problems, pointer(at, "name"), "must be PascalCase (^[A-Z][A-Za-z0-9_]*$)");
      if (seen.has(name2)) problem(problems, pointer(at, "name"), `duplicate type name "${name2}"`);
      seen.add(name2);
      names.push(name2);
    }
    const kind = entry.kind;
    if (typeof kind !== "string" || !TYPE_KINDS.has(kind)) {
      problem(problems, pointer(at, "kind"), 'must be one of "object", "enum", "union", "external"');
      return;
    }
    if (entry.note !== void 0 && typeof entry.note !== "string") {
      problem(problems, pointer(at, "note"), "must be a string when present");
    }
    if (entry.owner !== void 0 && (typeof entry.owner !== "string" || !/^M[0-9]+$/.test(entry.owner))) {
      problem(problems, pointer(at, "owner"), 'must be a module id like "M1"');
    }
    if (kind === "object") {
      if (entry.values !== void 0) problem(problems, pointer(at, "values"), "is only allowed for enum/union");
      if (entry.source !== void 0) problem(problems, pointer(at, "source"), "is only allowed for external");
      const fields = readNonEmptyArray(entry.fields, pointer(at, "fields"), problems, "object types need at least one field");
      fields.forEach((field, fieldIndex) => {
        const fieldAt = pointer(pointer(at, "fields"), fieldIndex);
        if (!isRecord2(field)) {
          problem(problems, fieldAt, "must be an object");
          return;
        }
        checkKnownKeys(field, TYPE_FIELD_KEYS, fieldAt, problems);
        readString(field.name, pointer(fieldAt, "name"), problems);
        readString(field.type, pointer(fieldAt, "type"), problems);
        if (field.note !== void 0 && typeof field.note !== "string") {
          problem(problems, pointer(fieldAt, "note"), "must be a string when present");
        }
        if (field.unit !== void 0) {
          if (typeof field.unit !== "string" || field.unit.trim().length === 0) {
            problem(problems, pointer(fieldAt, "unit"), "must be a non-empty string when present");
          }
        }
      });
      return;
    }
    if (entry.fields !== void 0) problem(problems, pointer(at, "fields"), "is only allowed for object");
    if (kind === "external") {
      if (entry.values !== void 0) problem(problems, pointer(at, "values"), "is only allowed for enum/union");
      readString(entry.source, pointer(at, "source"), problems);
      return;
    }
    if (entry.source !== void 0) problem(problems, pointer(at, "source"), "is only allowed for external");
    const values = readNonEmptyArray(entry.values, pointer(at, "values"), problems, "enum/union need at least one value");
    readStringArray(values, pointer(at, "values"), problems);
  });
  return names;
}
function validateErrors(raw, modulesRaw, problems, defaultShape) {
  if (raw === void 0) return [];
  if (!Array.isArray(raw)) {
    problem(problems, "/errors", "must be an array");
    return [];
  }
  const moduleIds = new Set(
    (Array.isArray(modulesRaw) ? modulesRaw : []).map((candidate) => isRecord2(candidate) && typeof candidate.id === "string" ? candidate.id : "").filter((id) => id.length > 0)
  );
  const codes = [];
  const seen = /* @__PURE__ */ new Set();
  raw.forEach((entry, index) => {
    const at = pointer("/errors", index);
    if (!isRecord2(entry)) {
      problem(problems, at, "must be an object");
      return;
    }
    checkKnownKeys(entry, ERROR_KEYS, at, problems);
    const code = readString(entry.code, pointer(at, "code"), problems);
    if (code.length > 0) {
      if (!ERROR_CODE_RE.test(code)) problem(problems, pointer(at, "code"), "must match ^E_[A-Z0-9_]+$");
      if (seen.has(code)) problem(problems, pointer(at, "code"), `duplicate error code "${code}"`);
      seen.add(code);
      codes.push(code);
    }
    if (typeof entry.status !== "number" || !Number.isInteger(entry.status) || entry.status < 100 || entry.status > 599) {
      problem(problems, pointer(at, "status"), "must be an integer HTTP status between 100 and 599");
    }
    readString(entry.when, pointer(at, "when"), problems);
    if (entry.shape !== void 0) {
      if (typeof entry.shape !== "string" || entry.shape.trim().length === 0) {
        problem(problems, pointer(at, "shape"), "must be a non-empty string");
      }
    } else if (defaultShape === void 0) {
      problem(problems, pointer(at, "shape"), "must be a non-empty string");
    }
    if (entry.by !== void 0) {
      const by = readString(entry.by, pointer(at, "by"), problems);
      if (by.length > 0) {
        if (!MODULE_ID_RE.test(by)) problem(problems, pointer(at, "by"), 'must look like "M1"');
        else if (!moduleIds.has(by)) problem(problems, pointer(at, "by"), `module "${by}" does not exist`);
      }
    }
  });
  return codes;
}
function validateTypeOwners(raw, modulesRaw, problems) {
  if (!Array.isArray(raw) || !Array.isArray(modulesRaw)) return;
  const ids = new Set(
    modulesRaw.filter((entry) => isRecord2(entry) && typeof entry.id === "string").map((entry) => String(entry.id))
  );
  raw.forEach((entry, index) => {
    if (!isRecord2(entry) || typeof entry.owner !== "string" || entry.owner.length === 0) return;
    if (!ids.has(entry.owner)) {
      problem(problems, pointer(pointer("/types", index), "owner"), `module "${entry.owner}" does not exist`);
    }
  });
}
function validateHttp(raw, modulesRaw, typeNames, problems) {
  if (raw === void 0) return;
  if (!Array.isArray(raw)) {
    problem(problems, "/http", "must be an array");
    return;
  }
  const moduleList = Array.isArray(modulesRaw) ? modulesRaw : [];
  const seen = /* @__PURE__ */ new Set();
  raw.forEach((entry, index) => {
    const at = pointer("/http", index);
    if (!isRecord2(entry)) {
      problem(problems, at, "must be an object");
      return;
    }
    checkKnownKeys(entry, HTTP_KEYS, at, problems);
    const method = entry.method;
    if (typeof method !== "string" || !HTTP_METHODS.has(method)) {
      problem(problems, pointer(at, "method"), "must be one of GET, POST, PUT, PATCH, DELETE");
    }
    const routePath = readString(entry.path, pointer(at, "path"), problems);
    if (routePath.length > 0 && !routePath.startsWith("/")) {
      problem(problems, pointer(at, "path"), 'must start with "/"');
    }
    const moduleId = readString(entry.module, pointer(at, "module"), problems);
    const handler = readString(entry.handler, pointer(at, "handler"), problems);
    if (entry.auth !== void 0) {
      if (typeof entry.auth !== "string" || !AUTH_MODES.has(entry.auth)) {
        problem(problems, pointer(at, "auth"), "must be one of public, session, admin");
      }
    }
    if (moduleId.length > 0) {
      const target = moduleList.find(
        (candidate) => isRecord2(candidate) && candidate.id === moduleId
      );
      if (target === void 0) {
        problem(problems, pointer(at, "module"), `module "${moduleId}" does not exist`);
      } else {
        const exposes = Array.isArray(target.exposes) ? target.exposes : [];
        const httpExposes = exposes.filter((expose) => isRecord2(expose) && expose.kind === "http");
        if (httpExposes.length === 0) {
          problem(problems, pointer(at, "module"), `module "${moduleId}" has no kind:"http" expose`);
        } else if (handler.length > 0) {
          const matches = httpExposes.some((expose) => {
            const signature = isRecord2(expose) && typeof expose.signature === "string" ? expose.signature : "";
            const leading = HANDLER_RE.exec(signature.trim())?.[0] ?? "";
            return leading === handler;
          });
          if (!matches) {
            problem(
              problems,
              pointer(at, "handler"),
              `handler "${handler}" does not match the leading identifier of any kind:"http" signature of ${moduleId}`
            );
          }
        }
      }
    }
    if (method !== void 0 && typeof method === "string" && routePath.length > 0) {
      const key = `${method} ${routePath}`;
      if (seen.has(key)) problem(problems, pointer(at, "path"), `duplicate route "${key}"`);
      seen.add(key);
    }
    for (const field of ["req", "res"]) {
      const value = entry[field];
      if (value !== void 0 && (typeof value !== "string" || value.trim().length === 0)) {
        problem(problems, pointer(at, field), "must be a non-empty type name");
      } else if (typeof value === "string" && BUILTIN_TYPES.has(value) && !typeNames.has(value)) {
        problem(problems, pointer(at, field), `${field} type "${value}" must be declared in types`);
      }
    }
    readString(entry.res, pointer(at, "res"), problems);
    const status = entry.status;
    if (status !== void 0) {
      if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
        problem(problems, pointer(at, "status"), "must be an integer between 100 and 599");
      } else if (typeof entry.res === "string") {
        if (entry.res.trim() === "void" && status !== 204) {
          problem(problems, pointer(at, "status"), "a void response must use status 204");
        } else if (entry.res.trim() !== "void" && status === 204) {
          problem(problems, pointer(at, "status"), 'status 204 needs res "void"');
        }
      }
    }
    if (entry.resHeaders !== void 0) {
      const headers = entry.resHeaders;
      if (!isRecord2(headers)) {
        problem(problems, pointer(at, "resHeaders"), "must be an object of header name to value");
      } else {
        for (const [name2, value] of Object.entries(headers)) {
          if (name2.trim().length === 0) problem(problems, pointer(at, "resHeaders"), "header name must not be empty");
          if (typeof value !== "string" || value.trim().length === 0) {
            problem(problems, pointer(at, "resHeaders"), `header "${name2}" must be a non-empty string`);
          }
        }
      }
    }
    if (entry.query !== void 0) {
      const params = entry.query;
      if (!Array.isArray(params)) {
        problem(problems, pointer(at, "query"), "must be an array of {name, type, required?}");
      } else {
        params.forEach((param, paramIndex) => {
          const paramAt = pointer(pointer(at, "query"), paramIndex);
          if (!isRecord2(param)) {
            problem(problems, paramAt, "must be an object");
            return;
          }
          checkKnownKeys(param, HTTP_QUERY_KEYS, paramAt, problems);
          const name2 = readString(param.name, pointer(paramAt, "name"), problems);
          if (name2.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name2)) {
            problem(problems, pointer(paramAt, "name"), "must be a plain identifier");
          }
          const paramType = readString(param.type, pointer(paramAt, "type"), problems);
          if (paramType.length > 0 && /^[A-Z]/.test(paramType) && !typeNames.has(paramType)) {
            problem(problems, pointer(paramAt, "type"), `unknown type "${paramType}"`);
          }
          if (param.required !== void 0 && typeof param.required !== "boolean") {
            problem(problems, pointer(paramAt, "required"), "must be a boolean");
          }
          if (param.note !== void 0 && typeof param.note !== "string") {
            problem(problems, pointer(paramAt, "note"), "must be a string when present");
          }
        });
      }
    }
    for (const field of ["reqExample", "resExample"]) {
      const value = entry[field];
      if (value === void 0) continue;
      if (typeof value !== "string" || value.trim().length === 0) {
        problem(problems, pointer(at, field), "must be a non-empty JSON string");
        continue;
      }
      try {
        JSON.parse(value);
      } catch {
        problem(problems, pointer(at, field), "must be valid JSON text (quote keys and strings)");
      }
    }
  });
}
function normalizeRoute(text2) {
  const match = /^([A-Za-z]+)\s+(.+)$/.exec(text2.trim().replace(/\s+/g, " "));
  if (match === null) return text2.trim();
  return `${(match[1] ?? "").toUpperCase()} ${match[2] ?? ""}`;
}
function validateUi(raw, modulesRaw, httpRaw, problems) {
  if (raw === void 0) return;
  if (!Array.isArray(raw)) {
    problems.push({ code: "UI_PAGE_INVALID", path: "/ui", message: "must be an array" });
    return;
  }
  const modules = new Set(
    Array.isArray(modulesRaw) ? modulesRaw.map((entry) => typeof entry === "object" && entry !== null ? String(entry.id ?? "") : "") : []
  );
  const routes = /* @__PURE__ */ new Set();
  if (Array.isArray(httpRaw)) {
    for (const entry of httpRaw) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry;
      routes.add(normalizeRoute(`${String(record.method ?? "")} ${String(record.path ?? "")}`));
    }
  }
  const seen = /* @__PURE__ */ new Set();
  raw.forEach((entry, index) => {
    const at = `/ui/${index}`;
    if (typeof entry !== "object" || entry === null) {
      problems.push({ code: "UI_PAGE_INVALID", path: at, message: "must be an object" });
      return;
    }
    const page = entry;
    const id = typeof page.id === "string" ? page.id.trim() : "";
    if (!/^P[0-9]{1,2}$/.test(id)) problems.push({ code: "UI_PAGE_INVALID", path: `${at}/id`, message: 'must look like "P1"' });
    else if (seen.has(id)) problems.push({ code: "UI_PAGE_INVALID", path: `${at}/id`, message: `duplicate page id "${id}"` });
    else seen.add(id);
    if (typeof page.title !== "string" || page.title.trim() === "") {
      problems.push({ code: "UI_PAGE_INVALID", path: `${at}/title`, message: "must be a non-empty string" });
    }
    const route = typeof page.route === "string" ? page.route.trim() : "";
    if (!route.startsWith("/")) problems.push({ code: "UI_PAGE_INVALID", path: `${at}/route`, message: 'must start with "/"' });
    const owner = typeof page.module === "string" ? page.module.trim() : "";
    if (!modules.has(owner)) problems.push({ code: "UI_PAGE_INVALID", path: `${at}/module`, message: `module "${owner}" does not exist` });
    if (!Array.isArray(page.shows) || page.shows.length === 0) {
      problems.push({ code: "UI_PAGE_INVALID", path: `${at}/shows`, message: "must be a non-empty array of strings" });
    }
    if (!Array.isArray(page.calls)) {
      problems.push({ code: "UI_PAGE_INVALID", path: `${at}/calls`, message: "must be an array (use [] for a page with no backend call)" });
    } else {
      page.calls.forEach((call, callIndex) => {
        const text2 = typeof call === "string" ? call.trim().replace(/\s+/g, " ") : "";
        if (!routes.has(normalizeRoute(text2))) {
          problems.push({
            code: "UI_PAGE_INVALID",
            path: `${at}/calls/${callIndex}`,
            message: `page calls undeclared route "${String(call)}"; declare it in http[] first`
          });
        }
      });
    }
  });
}
function validateFlows(raw, modulesRaw, errorCodes, problems) {
  if (raw === void 0) return;
  if (!Array.isArray(raw)) {
    problem(problems, "/flows", "must be an array when present");
    return;
  }
  const modules = Array.isArray(modulesRaw) ? modulesRaw : [];
  const seen = /* @__PURE__ */ new Set();
  raw.forEach((entry, index) => {
    const at = pointer("/flows", index);
    if (!isRecord2(entry)) {
      problem(problems, at, "must be an object");
      return;
    }
    checkKnownKeys(entry, FLOW_KEYS, at, problems);
    const id = readString(entry.id, pointer(at, "id"), problems);
    if (id.length > 0) {
      if (!/^F[0-9]{1,2}$/.test(id)) problem(problems, pointer(at, "id"), "must match ^F[0-9]{1,2}$");
      if (seen.has(id)) problem(problems, pointer(at, "id"), `duplicate flow id "${id}"`);
      seen.add(id);
    }
    readString(entry.name, pointer(at, "name"), problems);
    readString(entry.trigger, pointer(at, "trigger"), problems);
    readString(entry.success, pointer(at, "success"), problems);
    const steps = readNonEmptyArray(entry.steps, pointer(at, "steps"), problems, "at least one step");
    steps.forEach((step, stepIndex) => {
      const stepAt = `${pointer(at, "steps")}/${stepIndex}`;
      if (!isRecord2(step)) {
        problem(problems, stepAt, "must be an object");
        return;
      }
      checkKnownKeys(step, FLOW_STEP_KEYS, stepAt, problems);
      const moduleId = readString(step.module, `${stepAt}/module`, problems);
      const action = readString(step.action, `${stepAt}/action`, problems);
      if (moduleId.length === 0) return;
      const target = modules.find((candidate) => isRecord2(candidate) && candidate.id === moduleId);
      if (target === void 0) {
        problem(problems, `${stepAt}/module`, `module "${moduleId}" does not exist`);
        return;
      }
      if (action.length === 0) return;
      const exposes = Array.isArray(target.exposes) ? target.exposes : [];
      const matches = exposes.some((expose) => {
        const signature = isRecord2(expose) && typeof expose.signature === "string" ? expose.signature : "";
        return (HANDLER_RE.exec(signature.trim())?.[0] ?? "") === action;
      });
      if (!matches) {
        problem(
          problems,
          `${stepAt}/action`,
          `action "${action}" does not match the leading identifier of any signature of ${moduleId}`
        );
      }
    });
    if (entry.failure !== void 0) {
      const codes = readStringArray(entry.failure, `${at}/failure`, problems);
      codes.forEach((code, codeIndex) => {
        if (!errorCodes.has(code)) {
          problem(problems, `${at}/failure/${codeIndex}`, `error code "${code}" is not declared in errors`);
        }
      });
    }
  });
}
function validateTypeClosure(raw, typeNames, problems) {
  const refs = [];
  const modules = Array.isArray(raw.modules) ? raw.modules : [];
  modules.forEach((module, moduleIndex) => {
    if (!isRecord2(module) || !Array.isArray(module.exposes)) return;
    module.exposes.forEach((expose, exposeIndex) => {
      if (!isRecord2(expose) || typeof expose.signature !== "string") return;
      refs.push({
        text: expose.signature.replace(HTTP_METHOD_PREFIX, ""),
        path: `${pointer(pointer("/modules", moduleIndex), "exposes")}/${exposeIndex}/signature`,
        mode: "signature"
      });
    });
  });
  const http = Array.isArray(raw.http) ? raw.http : [];
  http.forEach((entry, index) => {
    if (!isRecord2(entry)) return;
    for (const field of ["req", "res"]) {
      if (typeof entry[field] === "string") {
        refs.push({ text: entry[field], path: `${pointer("/http", index)}/${field}`, mode: "plain" });
      }
    }
  });
  const types = Array.isArray(raw.types) ? raw.types : [];
  types.forEach((type, typeIndex) => {
    if (!isRecord2(type) || !Array.isArray(type.fields)) return;
    type.fields.forEach((field, fieldIndex) => {
      if (!isRecord2(field) || typeof field.type !== "string") return;
      refs.push({
        text: field.type,
        path: `${pointer(pointer("/types", typeIndex), "fields")}/${fieldIndex}/type`,
        mode: "plain"
      });
    });
  });
  const reported = /* @__PURE__ */ new Set();
  for (const ref of refs) {
    const pattern = ref.mode === "signature" ? TYPE_SLOT_REF_RE : TYPE_REF_RE;
    const declared = /* @__PURE__ */ new Set();
    if (ref.mode === "signature") {
      for (const generic of ref.text.matchAll(/<\s*([A-Z][0-9]?(?:\s*,\s*[A-Z][0-9]?)*)\s*>/g)) {
        const captured = generic[1];
        if (captured === void 0) continue;
        for (const name2 of captured.split(",")) declared.add(name2.trim());
      }
    }
    for (const match of ref.text.matchAll(pattern)) {
      const name2 = ref.mode === "signature" ? match[1] : match[0];
      if (name2 === void 0) continue;
      if (declared.has(name2)) continue;
      if (typeNames.has(name2) || BUILTIN_TYPES.has(name2) || reported.has(name2)) continue;
      reported.add(name2);
      problem(problems, ref.path, `undefined type reference "${name2}" at ${ref.path}`);
    }
  }
}
function validateErrorRefs(modulesRaw, errorCodes, problems) {
  const modules = Array.isArray(modulesRaw) ? modulesRaw : [];
  modules.forEach((module, moduleIndex) => {
    if (!isRecord2(module)) return;
    const at = pointer("/modules", moduleIndex);
    if (Array.isArray(module.constraints)) {
      module.constraints.forEach((constraint, index) => {
        if (typeof constraint !== "string") return;
        for (const match of constraint.matchAll(ERROR_REF_RE)) {
          if (!errorCodes.has(match[0])) {
            const path12 = `${pointer(at, "constraints")}/${index}`;
            problem(problems, path12, `undefined error code "${match[0]}" at ${path12}`);
          }
        }
      });
    }
    if (Array.isArray(module.acceptance)) {
      module.acceptance.forEach((item, index) => {
        if (!isRecord2(item) || typeof item.assertion !== "string") return;
        for (const match of item.assertion.matchAll(ERROR_REF_RE)) {
          if (!errorCodes.has(match[0])) {
            const path12 = `${pointer(pointer(at, "acceptance"), index)}/assertion`;
            problem(problems, path12, `undefined error code "${match[0]}" at ${path12}`);
          }
        }
      });
    }
  });
}
function validateTableOwners(dataRaw, modulesRaw, problems) {
  const moduleIds = moduleIdsOf(modulesRaw);
  const data = Array.isArray(dataRaw) ? dataRaw : [];
  data.forEach((entry, index) => {
    if (!isRecord2(entry)) return;
    const at = pointer("/data", index);
    const owner = readString(entry.owner, pointer(at, "owner"), problems);
    if (owner.length > 0 && !moduleIds.has(owner)) {
      problem(problems, pointer(at, "owner"), `owner "${owner}" is not a module id`);
    }
  });
}
function validateMigrationFiles(dataRaw, modulesRaw, problems) {
  const filesById = /* @__PURE__ */ new Map();
  if (Array.isArray(modulesRaw)) {
    for (const module of modulesRaw) {
      if (!isRecord2(module) || typeof module.id !== "string" || module.id.length === 0) continue;
      const files = Array.isArray(module.files) ? module.files.filter((file) => typeof file === "string") : [];
      filesById.set(module.id, files);
    }
  }
  const data = Array.isArray(dataRaw) ? dataRaw : [];
  data.forEach((entry, index) => {
    if (!isRecord2(entry)) return;
    const owner = typeof entry.owner === "string" ? entry.owner : "";
    if (owner.length === 0 || !filesById.has(owner)) return;
    const files = filesById.get(owner) ?? [];
    const hasMigration = files.some((file) => /(^|\/)migrations?\/[^/]+\.sql$/i.test(file));
    if (hasMigration) return;
    const table3 = typeof entry.table === "string" ? entry.table : "";
    const at = pointer(pointer("/data", index), "owner");
    problem(
      problems,
      at,
      `owner module "${owner}" of table "${table3}" has no migration file; add a "migrations/*.sql" path to its files`
    );
  });
}
function moduleIdsOf(modulesRaw) {
  const ids = /* @__PURE__ */ new Set();
  if (!Array.isArray(modulesRaw)) return ids;
  for (const module of modulesRaw) {
    if (isRecord2(module) && typeof module.id === "string" && module.id.length > 0) ids.add(module.id);
  }
  return ids;
}
function validateRowWriters(dataRaw, modulesRaw, problems) {
  const moduleIds = moduleIdsOf(modulesRaw);
  const data = Array.isArray(dataRaw) ? dataRaw : [];
  data.forEach((entry, index) => {
    if (!isRecord2(entry)) return;
    const at = pointer("/data", index);
    const table3 = typeof entry.table === "string" ? entry.table : "";
    const writers = entry.rowWriters;
    if (!Array.isArray(writers) || writers.length === 0) {
      problem(problems, pointer(at, "rowWriters"), "must list at least one module id");
      return;
    }
    writers.forEach((writer, writerIndex) => {
      const writerAt = pointer(pointer(at, "rowWriters"), writerIndex);
      if (typeof writer !== "string" || writer.trim().length === 0) {
        problem(problems, writerAt, "must be a non-empty module id");
        return;
      }
      if (!moduleIds.has(writer)) {
        problem(problems, writerAt, `unknown module "${writer}" in rowWriters of table "${table3}" at ${writerAt}`);
      }
    });
  });
}
var NOT_NULL_EXEMPT_COLUMNS = /* @__PURE__ */ new Set(["id", "created_at", "updated_at", "deleted_at"]);
function toCamelCase(name2) {
  return name2.replace(/_+([A-Za-z0-9])/g, (_match, char) => char.toUpperCase());
}
function parameterListOf(signature) {
  const open = signature.indexOf("(");
  if (open < 0) return void 0;
  let depth = 0;
  for (let index = open; index < signature.length; index += 1) {
    const char = signature[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return signature.slice(open + 1, index);
    }
  }
  return void 0;
}
function splitTopLevel(input) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of input) {
    if (char === "<" || char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ">" || char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}
function parseSignatureParams(signature) {
  const body = parameterListOf(signature.replace(HTTP_METHOD_PREFIX, "").trim());
  if (body === void 0) return [];
  const params = [];
  for (const chunk of splitTopLevel(body)) {
    const text2 = chunk.trim();
    if (text2.length === 0) continue;
    const colon = text2.indexOf(":");
    const name2 = (colon === -1 ? text2 : text2.slice(0, colon)).replace(/[?\s]+$/u, "").trim();
    if (name2.length === 0) continue;
    params.push({ name: name2, type: colon === -1 ? "" : text2.slice(colon + 1).trim() });
  }
  return params;
}
function elementTypeName(type) {
  let text2 = type.trim();
  const parts = text2.split("|").map((part) => part.trim());
  if (parts.length === 2) {
    const nonNull = parts.filter((part) => part !== "null" && part !== "undefined");
    const only = nonNull.length === 1 ? nonNull[0] : void 0;
    if (only !== void 0) text2 = only;
  }
  const generic = /^Array<(.+)>$/u.exec(text2);
  if (generic !== null && generic[1] !== void 0) {
    const inner = generic[1].trim();
    if (inner.endsWith("[]")) return inner;
    text2 = inner;
  }
  if (!text2.endsWith("[]")) return text2;
  return text2.slice(0, -2).trim();
}
function objectTypeFields(typesRaw) {
  const fields = /* @__PURE__ */ new Map();
  if (!Array.isArray(typesRaw)) return fields;
  for (const type of typesRaw) {
    if (!isRecord2(type) || typeof type.name !== "string" || type.kind !== "object") continue;
    const names = /* @__PURE__ */ new Set();
    if (Array.isArray(type.fields)) {
      for (const field of type.fields) {
        if (isRecord2(field) && typeof field.name === "string" && field.name.length > 0) names.add(field.name);
      }
    }
    fields.set(type.name, names);
  }
  return fields;
}
function writeFieldNames(modules, writerIds, objectFields) {
  const names = /* @__PURE__ */ new Set();
  const writers = new Set(writerIds);
  for (const module of modules) {
    if (!isRecord2(module) || typeof module.id !== "string" || !writers.has(module.id)) continue;
    const exposes = Array.isArray(module.exposes) ? module.exposes : [];
    for (const expose of exposes) {
      if (!isRecord2(expose) || typeof expose.signature !== "string") continue;
      for (const param of parseSignatureParams(expose.signature)) {
        names.add(param.name);
        const declared = objectFields.get(elementTypeName(param.type));
        if (declared !== void 0) for (const field of declared) names.add(field);
      }
    }
  }
  return names;
}
function validateNotNullColumns(dataRaw, modulesRaw, typesRaw, problems) {
  const data = Array.isArray(dataRaw) ? dataRaw : [];
  const modules = Array.isArray(modulesRaw) ? modulesRaw : [];
  const objectFields = objectTypeFields(typesRaw);
  data.forEach((entry, dataIndex) => {
    if (!isRecord2(entry)) return;
    const at = pointer("/data", dataIndex);
    const writers = Array.isArray(entry.rowWriters) ? entry.rowWriters.filter(
      (writer) => typeof writer === "string" && writer.trim().length > 0
    ) : [];
    const writeFields = writeFieldNames(modules, writers, objectFields);
    const columns = Array.isArray(entry.columns) ? entry.columns : [];
    columns.forEach((column, columnIndex) => {
      if (!isRecord2(column) || typeof column.name !== "string") return;
      const name2 = column.name;
      if (name2.length === 0 || NOT_NULL_EXEMPT_COLUMNS.has(name2.toLowerCase())) return;
      const constraints = Array.isArray(column.constraints) ? column.constraints.filter((constraint) => typeof constraint === "string") : [];
      const text2 = constraints.join(" ").toLowerCase();
      if (!text2.includes("not null") || text2.includes("default")) return;
      const field = toCamelCase(name2);
      if (writeFields.has(field)) return;
      const writerList = writers.length > 0 ? writers.join(", ") : "none";
      problem(
        problems,
        pointer(pointer(at, "columns"), columnIndex),
        `not-null column "${name2}" has no input field "${field}" in write signatures of rowWriters (${writerList})`
      );
    });
  });
}
function validateAcceptanceRoutes(modulesRaw, httpRaw, problems) {
  const declared = /* @__PURE__ */ new Set();
  if (Array.isArray(httpRaw)) {
    for (const route of httpRaw) {
      if (!isRecord2(route)) continue;
      if (typeof route.method === "string" && typeof route.path === "string") {
        declared.add(`${route.method} ${route.path}`);
      }
    }
  }
  const modules = Array.isArray(modulesRaw) ? modulesRaw : [];
  modules.forEach((module, moduleIndex) => {
    if (!isRecord2(module) || !Array.isArray(module.acceptance)) return;
    const at = pointer(pointer("/modules", moduleIndex), "acceptance");
    module.acceptance.forEach((item, itemIndex) => {
      if (!isRecord2(item) || typeof item.assertion !== "string") return;
      const itemAt = pointer(at, itemIndex);
      const reported = /* @__PURE__ */ new Set();
      for (const match of item.assertion.matchAll(ROUTE_REF_RE)) {
        const method = match[1];
        const rawPath = match[2];
        if (method === void 0 || rawPath === void 0) continue;
        const path12 = normalizeRouteRef(rawPath);
        if (path12 === void 0) continue;
        const route = `${method} ${path12}`;
        if (declared.has(route) || reported.has(route)) continue;
        reported.add(route);
        problem(
          problems,
          pointer(itemAt, "assertion"),
          `acceptance references undeclared route "${route}" at ${itemAt}${declaredRouteHint(declared, method)}`
        );
      }
    });
  });
}
function validatePlan(rawInput) {
  const problems = [];
  const raw = stripMeta(rawInput);
  if (!isRecord2(raw)) {
    return { plan: null, problems: [{ code: "PLAN_INVALID", path: "", message: "plan must be a JSON object" }] };
  }
  checkKnownKeys(raw, ROOT_KEYS, "", problems);
  if (raw.schemaVersion !== 1) problem(problems, "/schemaVersion", "must be 1");
  const name2 = readString(raw.name, "/name", problems);
  if (name2.length > 0 && !NAME_RE.test(name2)) {
    problem(problems, "/name", "must match ^[a-z][a-z0-9-]{1,40}$ (used as the output directory name)");
  }
  readString(raw.title, "/title", problems);
  readString(raw.summary, "/summary", problems);
  readString(raw.stack, "/stack", problems);
  const goals = readStringArray(readNonEmptyArray(raw.goals, "/goals", problems, "at least one goal"), "/goals", problems);
  const nonGoals = readStringArray(
    readNonEmptyArray(raw.nonGoals, "/nonGoals", problems, "at least one non-goal"),
    "/nonGoals",
    problems
  );
  const boundaryList = readNonEmptyArray(raw.boundaries, "/boundaries", problems, "at least one boundary");
  boundaryList.forEach((entry, index) => {
    const at = pointer("/boundaries", index);
    if (!isRecord2(entry)) {
      problem(problems, at, "must be an object");
      return;
    }
    checkKnownKeys(entry, BOUNDARY_KEYS, at, problems);
    readString(entry.dependency, pointer(at, "dependency"), problems);
    readString(entry.purpose, pointer(at, "purpose"), problems);
    readString(entry.fallback, pointer(at, "fallback"), problems);
    if (entry.version !== void 0 && typeof entry.version !== "string") {
      problem(problems, pointer(at, "version"), "must be a string when present");
    }
  });
  if (raw.runtime !== void 0) {
    if (!isRecord2(raw.runtime)) {
      problem(problems, "/runtime", "must be an object when present");
    } else {
      checkKnownKeys(raw.runtime, RUNTIME_KEYS, "/runtime", problems);
      const port = raw.runtime.port;
      if (port !== void 0) {
        if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
          problem(problems, "/runtime/port", "must be an integer between 0 and 65535");
        }
      }
      for (const field of ["start", "health", "migrate", "rollback"]) {
        const value = raw.runtime[field];
        if (value !== void 0 && (typeof value !== "string" || value.trim().length === 0)) {
          problem(problems, pointer("/runtime", field), "must be a non-empty string when present");
        }
      }
    }
  }
  let defaultErrorShape;
  if (!isRecord2(raw.globals)) {
    problem(problems, "/globals", "must be an object");
  } else {
    checkKnownKeys(raw.globals, GLOBALS_KEYS, "/globals", problems);
    readStringArray(raw.globals.conventions, "/globals/conventions", problems);
    readStringArray(raw.globals.forbidden, "/globals/forbidden", problems);
    if (raw.globals.nfr !== void 0) readStringArray(raw.globals.nfr, "/globals/nfr", problems);
    if (raw.globals.envKeys !== void 0) readStringArray(raw.globals.envKeys, "/globals/envKeys", problems);
    if (raw.globals.fieldCase !== void 0 && raw.globals.fieldCase !== "camel" && raw.globals.fieldCase !== "snake") {
      problem(problems, "/globals/fieldCase", 'must be "camel" or "snake"');
    }
    if (raw.globals.listEnvelope !== void 0 && typeof raw.globals.listEnvelope !== "boolean") {
      problem(problems, "/globals/listEnvelope", "must be a boolean");
    }
    if (raw.globals.errorShape !== void 0) {
      if (typeof raw.globals.errorShape !== "string" || raw.globals.errorShape.trim().length === 0) {
        problem(problems, "/globals/errorShape", "must be a non-empty string when present");
      } else {
        defaultErrorShape = raw.globals.errorShape;
      }
    }
  }
  const dataList = readNonEmptyArray(raw.data, "/data", problems, "at least one table");
  const tables = /* @__PURE__ */ new Set();
  dataList.forEach((entry, index) => {
    const at = pointer("/data", index);
    if (!isRecord2(entry)) {
      problem(problems, at, "must be an object");
      return;
    }
    checkKnownKeys(entry, DATA_KEYS, at, problems);
    const table3 = readString(entry.table, pointer(at, "table"), problems);
    if (table3.length > 0) {
      if (tables.has(table3)) problem(problems, pointer(at, "table"), `duplicate table "${table3}"`);
      tables.add(table3);
    }
    const columns = readNonEmptyArray(entry.columns, pointer(at, "columns"), problems, "at least one column");
    columns.forEach((column, columnIndex) => {
      const columnAt = pointer(pointer(at, "columns"), columnIndex);
      if (!isRecord2(column)) {
        problem(problems, columnAt, "must be an object");
        return;
      }
      checkKnownKeys(column, COLUMN_KEYS, columnAt, problems);
      readString(column.name, pointer(columnAt, "name"), problems);
      readString(column.type, pointer(columnAt, "type"), problems);
      if (column.constraints !== void 0) readStringArray(column.constraints, pointer(columnAt, "constraints"), problems);
    });
    if (entry.indexes !== void 0) readStringArray(entry.indexes, pointer(at, "indexes"), problems);
    if (entry.notes !== void 0 && typeof entry.notes !== "string") {
      problem(problems, pointer(at, "notes"), "must be a string when present");
    }
  });
  validateModules(raw.modules, problems, goals.length);
  const typeNames = validateTypes(raw.types, problems);
  const errorCodes = validateErrors(raw.errors, raw.modules, problems, defaultErrorShape);
  validateTableOwners(raw.data, raw.modules, problems);
  validateRowWriters(raw.data, raw.modules, problems);
  validateMigrationFiles(raw.data, raw.modules, problems);
  validateNotNullColumns(raw.data, raw.modules, raw.types, problems);
  validateHttp(raw.http, raw.modules, new Set(typeNames), problems);
  validateTypeOwners(raw.types, raw.modules, problems);
  validateFlows(raw.flows, raw.modules, new Set(errorCodes), problems);
  validateUi(raw.ui, raw.modules, raw.http, problems);
  validateAcceptanceRoutes(raw.modules, raw.http, problems);
  validateTypeClosure(raw, new Set(typeNames), problems);
  validateErrorRefs(raw.modules, new Set(errorCodes), problems);
  if (raw.openQuestions !== void 0) readStringArray(raw.openQuestions, "/openQuestions", problems);
  if (!isRecord2(raw.deliverables)) {
    problem(problems, "/deliverables", "must be an object");
  } else {
    checkKnownKeys(raw.deliverables, DELIVERABLE_KEYS, "/deliverables", problems);
    readString(raw.deliverables.tree, "/deliverables/tree", problems);
    const files = readNonEmptyArray(raw.deliverables.files, "/deliverables/files", problems, "at least one deliverable file");
    const seen = /* @__PURE__ */ new Set();
    files.forEach((entry, index) => {
      const at = pointer("/deliverables/files", index);
      if (!isRecord2(entry)) {
        problem(problems, at, "must be an object");
        return;
      }
      checkKnownKeys(entry, FILE_KEYS, at, problems);
      const filePath = readString(entry.path, pointer(at, "path"), problems);
      readString(entry.purpose, pointer(at, "purpose"), problems);
      if (filePath.length > 0) {
        const unsafe = isUnsafeRelative(filePath);
        if (unsafe !== null) problem(problems, pointer(at, "path"), unsafe);
        if (seen.has(filePath)) problem(problems, pointer(at, "path"), `duplicate deliverable path "${filePath}"`);
        seen.add(filePath);
      }
    });
  }
  if (goals.length === 0 && raw.goals !== void 0) {
  }
  return { plan: problems.length === 0 ? raw : null, problems };
}
function emptyPlan(input) {
  const name2 = input.name !== void 0 && NAME_RE.test(input.name) ? input.name : "my-app";
  return {
    schemaVersion: 1,
    _hint: '\u7531 impl_gate_compose \u751F\u6210\u7684\u7A7A\u69FD\u6A21\u677F\u3002\u8865\u5168 modules/data/boundaries/deliverables \u540E\u8C03\u7528 mode:"materialize"\u3002',
    name: name2,
    title: "",
    summary: "",
    stack: input.stack ?? "",
    goals: [],
    nonGoals: [],
    boundaries: [],
    globals: { conventions: [], forbidden: [], envKeys: [], fieldCase: "camel", listEnvelope: false },
    data: [],
    types: [],
    errors: [],
    http: [],
    openQuestions: [],
    modules: [
      {
        id: "M1",
        dir: "",
        title: "",
        responsibility: "",
        exposes: [],
        requires: [],
        constraints: [],
        files: [],
        acceptance: [],
        _hint: "\u81F3\u5C11\u4FDD\u7559\u4E00\u4E2A\u6A21\u5757\uFF1Bid \u5F62\u5982 M1\uFF0Cdir \u662F outDir/<name>/ \u4E0B\u7684\u76F8\u5BF9\u76EE\u5F55\u3002"
      }
    ],
    deliverables: { tree: "", files: [] }
  };
}
function missingSlots(rawInput) {
  const raw = stripMeta(rawInput);
  const out = [];
  const rec = isRecord2(raw) ? raw : {};
  const planMissing = [];
  if (typeof rec.title !== "string" || rec.title.trim().length === 0) planMissing.push("title");
  if (typeof rec.summary !== "string" || rec.summary.trim().length === 0) planMissing.push("summary");
  if (typeof rec.stack !== "string" || rec.stack.trim().length === 0) planMissing.push("stack");
  if (!Array.isArray(rec.goals) || rec.goals.length === 0) planMissing.push("goals");
  if (!Array.isArray(rec.data) || rec.data.length === 0) planMissing.push("data");
  const deliverables = isRecord2(rec.deliverables) ? rec.deliverables : {};
  const tree = typeof deliverables.tree === "string" ? deliverables.tree.trim() : "";
  const files = Array.isArray(deliverables.files) ? deliverables.files : [];
  if (tree.length === 0 || files.length === 0) planMissing.push("deliverables");
  if (planMissing.length > 0) out.push(`plan: ${planMissing.join(", ")}`);
  const modules = Array.isArray(rec.modules) ? rec.modules : [];
  if (modules.length === 0) {
    out.push("plan: modules\uFF08\u81F3\u5C11 1 \u4E2A\uFF09");
    return out;
  }
  modules.forEach((module, index) => {
    const id = isRecord2(module) && typeof module.id === "string" && module.id.length > 0 ? module.id : `#${index}`;
    const missing = [];
    if (!isRecord2(module)) {
      out.push(`${id}: dir, responsibility, exposes, constraints, files, acceptance`);
      return;
    }
    if (typeof module.dir !== "string" || module.dir.length === 0) missing.push("dir");
    if (typeof module.responsibility !== "string" || module.responsibility.length === 0) missing.push("responsibility");
    if (!Array.isArray(module.exposes) || module.exposes.length === 0) missing.push("exposes");
    if (!Array.isArray(module.constraints) || module.constraints.length === 0) missing.push("constraints");
    if (!Array.isArray(module.files) || module.files.length === 0) missing.push("files");
    if (!Array.isArray(module.acceptance) || module.acceptance.length === 0) missing.push("acceptance");
    if (missing.length > 0) out.push(`${id}: ${missing.join(", ")}`);
  });
  return out;
}

// src/host/compose/graph.ts
function oneLine(text2) {
  return text2.replace(/\s+/g, " ").trim();
}
function exposeId(index) {
  return `E${index + 1}`;
}
function needId(index) {
  return `N${index + 1}`;
}
function constraintId(index) {
  return `C${index + 1}`;
}
function findExposeIndex(provider, item) {
  return provider.exposes.findIndex((expose) => expose.signature === item);
}
function renderModuleSpec(plan, module) {
  const byId = new Map(plan.modules.map((entry) => [entry.id, entry]));
  const lines = [
    "---",
    `name: ${module.dir}`,
    "kind: module",
    "---",
    "",
    "## \u63D0\u4F9B",
    ""
  ];
  module.exposes.forEach((expose, index) => {
    lines.push(`### ${exposeId(index)} ${oneLine(expose.signature)}`);
    lines.push(`- \u540D\u79F0\uFF1A${oneLine(expose.signature)}`);
    if (expose.note !== void 0) lines.push(`- \u8BED\u4E49\uFF1A${oneLine(expose.note)}`);
    lines.push("");
  });
  lines.push("## \u9700\u8981", "");
  if (module.requires.length === 0) {
    lines.push("\uFF08\u65E0\u3002\uFF09", "");
  } else {
    module.requires.forEach((need, index) => {
      const provider = byId.get(need.module);
      const exposeIndex = provider === void 0 ? -1 : findExposeIndex(provider, need.item);
      lines.push(`### ${needId(index)} ${oneLine(need.item)}`);
      lines.push(`- \u540D\u79F0\uFF1A${oneLine(need.item)}`);
      if (need.why !== void 0) lines.push(`- \u8BED\u4E49\uFF1A${oneLine(need.why)}`);
      lines.push(`- \u6EE1\u8DB3\u4E8E\uFF1A[[${provider?.dir ?? need.module}#\u63D0\u4F9B/${exposeId(exposeIndex < 0 ? 0 : exposeIndex)}]]`);
      lines.push("");
    });
  }
  lines.push("## \u7EA6\u675F", "");
  module.constraints.forEach((constraint, index) => {
    lines.push(`### ${constraintId(index)} ${oneLine(constraint)}`);
    lines.push(`- \u89C4\u5219\uFF1A${oneLine(constraint)}`);
    lines.push("");
  });
  return `${lines.join("\n").trimEnd()}
`;
}
function renderGraphToml(plan) {
  const byId = new Map(plan.modules.map((entry) => [entry.id, entry]));
  const groups = /* @__PURE__ */ new Map();
  for (const module of plan.modules) {
    module.requires.forEach((need, index) => {
      const provider = byId.get(need.module);
      if (provider === void 0) return;
      const exposeIndex = findExposeIndex(provider, need.item);
      if (exposeIndex < 0) return;
      const key = `${module.dir}\0${provider.dir}`;
      const group = groups.get(key) ?? { from: module.dir, to: provider.dir, satisfies: [] };
      group.satisfies.push({ need: needId(index), expose: exposeId(exposeIndex) });
      groups.set(key, group);
    });
  }
  const lines = ["# \u7531 dsh-impl-gate \u4ECE compose-plan.json \u751F\u6210\uFF1B\u6539\u5951\u7EA6\u8BF7\u6539 plan \u540E\u91CD\u8DD1 materialize\u3002"];
  for (const group of groups.values()) {
    lines.push("", "[[link]]", `from = "${group.from}"`, `to = "${group.to}"`, "satisfies = [");
    for (const entry of group.satisfies) {
      lines.push(`  { need = "${entry.need}", expose = "${entry.expose}" },`);
    }
    lines.push("]");
  }
  return `${lines.join("\n")}
`;
}

// src/host/compose/type-doc.ts
function cell(text2) {
  return text2.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}
function table(headers, rows) {
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.map((value) => cell(value)).join(" | ")} |`);
  return lines;
}
function renderTypeBlock(type) {
  const lines = [`#### ${type.name}\uFF08${type.kind}\uFF09`, ""];
  if (type.kind === "object") {
    const fields = type.fields ?? [];
    const hasUnit = fields.some((field) => field.unit !== void 0);
    if (hasUnit) {
      lines.push(...table(["\u5B57\u6BB5", "\u7C7B\u578B", "\u5355\u4F4D", "\u8BF4\u660E"], fields.map((field) => [field.name, field.type, field.unit ?? "\u2014", field.note ?? "\u2014"])));
    } else {
      lines.push(...table(["\u5B57\u6BB5", "\u7C7B\u578B", "\u8BF4\u660E"], fields.map((field) => [field.name, field.type, field.note ?? "\u2014"])));
    }
  } else if (type.kind === "external") {
    lines.push(`\u6765\u6E90\uFF1A${type.source ?? "\uFF08\u672A\u5199\u660E\uFF09"}`);
  } else {
    const values = (type.values ?? []).map((value) => `\`${value}\``).join("\u3001");
    lines.push(`\u53D6\u503C\uFF1A${values.length > 0 ? values : "\uFF08\u65E0\uFF09"}`);
  }
  if (type.note !== void 0 && type.note.trim().length > 0) lines.push("", `\u8BF4\u660E\uFF1A${type.note}`);
  if (type.owner !== void 0) {
    lines.push("", type.kind === "external" ? `\u7EF4\u62A4\uFF1A${type.owner}\uFF08\u5916\u90E8\u7C7B\u578B\uFF0C\u53EA\u5728\u6B64\u767B\u8BB0\u6765\u6E90\uFF0C\u4E0D\u8981\u6C42\u672C\u6A21\u5757\u5B9A\u4E49\uFF09` : `\u5F52\u5C5E\uFF1A${type.owner}\uFF08\u7531\u8BE5\u6A21\u5757\u7684\u67D0\u4E2A\u6587\u4EF6\u5B9A\u4E49\u5E76\u5BFC\u51FA\uFF09`);
  }
  return lines;
}
function typesUsedBy(types, texts) {
  const haystack = texts.join("\n");
  return types.filter((type) => new RegExp(`\\b${type.name}\\b`).test(haystack));
}

// src/host/compose/spec-doc.ts
function cell2(text2) {
  return text2.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}
function listOrNone(items) {
  return items.length === 0 ? ["\uFF08\u65E0\uFF09"] : items.map((item) => `- ${cell2(item)}`);
}
function table2(headers, rows) {
  if (rows.length === 0) return ["\uFF08\u65E0\uFF09"];
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.map((value) => cell2(value)).join(" | ")} |`);
  return lines;
}
var FK_RE = /^references:\s*([A-Za-z0-9_]+)\(id\)$/;
function referencedByOwners(plan) {
  const owners = /* @__PURE__ */ new Map();
  for (const entry of plan.data) {
    for (const column of entry.columns ?? []) {
      for (const constraint of column.constraints ?? []) {
        const match = FK_RE.exec(constraint.trim());
        const target = match?.[1];
        if (target === void 0 || target === entry.table) continue;
        const set = owners.get(target) ?? /* @__PURE__ */ new Set();
        set.add(entry.owner);
        owners.set(target, set);
      }
    }
  }
  return owners;
}
function renderSpecDoc(input) {
  const { plan, waves } = input;
  const byId = new Map(plan.modules.map((module) => [module.id, module]));
  const lines = [`# ${plan.title}`, "", `> ${plan.summary}`, ""];
  const goalLines = plan.goals.length === 0 ? ["\uFF08\u65E0\uFF09"] : plan.goals.map((goal, index) => `- **G${index + 1}** ${goal}`);
  lines.push("## 1 \u76EE\u6807\u4E0E\u975E\u76EE\u6807", "", "### \u76EE\u6807", ...goalLines, "", "### \u975E\u76EE\u6807", ...listOrNone(plan.nonGoals), "");
  lines.push("## 2 \u7CFB\u7EDF\u8FB9\u754C", "");
  lines.push(...table2(
    ["\u4F9D\u8D56", "\u7528\u9014", "\u7248\u672C", "\u964D\u7EA7"],
    plan.boundaries.map((boundary) => [boundary.dependency, boundary.purpose, boundary.version ?? "\u2014", boundary.fallback])
  ));
  lines.push("", `\u6280\u672F\u6808\uFF1A${plan.stack.length > 0 ? cell2(plan.stack) : "\uFF08\u65E0\uFF09"}`, "");
  lines.push("## 3 \u6A21\u5757\u6E05\u5355", "");
  lines.push(...table2(
    ["\u6A21\u5757", "\u76EE\u5F55", "\u804C\u8D23", "\u63D0\u4F9B\uFF08\u7B7E\u540D\uFF09", "\u9700\u8981", "\u6587\u4EF6\u767D\u540D\u5355"],
    plan.modules.map((module) => [
      module.id,
      module.dir,
      module.responsibility,
      module.exposes.map((expose) => expose.signature).join("<br>"),
      module.requires.map((need) => need.item).join("<br>") || "\uFF08\u65E0\uFF09",
      module.files.join("<br>")
    ])
  ));
  lines.push("");
  lines.push("### 3.1 \u6A21\u5757\u7EA6\u675F", "");
  lines.push(...table2(
    ["\u6A21\u5757", "\u7EA6\u675F"],
    plan.modules.map((module) => [module.id, (module.constraints ?? []).join("<br>") || "\uFF08\u65E0\uFF09"])
  ));
  lines.push("");
  lines.push("## 4 \u6570\u636E\u7ED3\u6784", "", "### 4.1 \u8868", "");
  if (plan.data.length === 0) {
    lines.push("\uFF08\u65E0\uFF09", "");
  } else {
    const referencedBy = referencedByOwners(plan);
    for (const entry of plan.data) {
      lines.push(`#### ${entry.table}`);
      const writers = Array.isArray(entry.rowWriters) ? entry.rowWriters : [];
      lines.push(...table2(
        ["\u5B57\u6BB5", "\u7C7B\u578B", "\u7EA6\u675F", "\u5EFA\u8868\u6A21\u5757", "\u8FD0\u884C\u65F6\u5199\u5165\u65B9"],
        entry.columns.map((column) => [
          column.name,
          column.type,
          (column.constraints ?? []).join("<br>") || "\u2014",
          entry.owner,
          writers.length > 0 ? writers.join(", ") : "\uFF08\u65E0\uFF09"
        ])
      ));
      const referencingOwners = referencedBy.get(entry.table);
      if (writers.length > 0 && referencingOwners !== void 0 && (writers.length !== referencingOwners.size || writers.some((moduleId) => !referencingOwners.has(moduleId)))) {
        lines.push("", `\u5199\u5165\u65B9\uFF1A${writers.join(", ")}`);
      }
      if (entry.indexes !== void 0 && entry.indexes.length > 0) lines.push("", `\u7D22\u5F15\uFF1A${entry.indexes.join("<br>")}`);
      if (entry.notes !== void 0) lines.push("", `\u8BF4\u660E\uFF1A${entry.notes}`);
      lines.push("");
    }
  }
  lines.push("### 4.2 \u7C7B\u578B", "");
  const types = plan.types ?? [];
  if (types.length === 0) {
    lines.push("\uFF08\u65E0\uFF09", "");
  } else {
    for (const type of types) {
      lines.push(...renderTypeBlock(type), "");
    }
  }
  lines.push("### 4.3 \u9519\u8BEF\u7801", "");
  const errors = plan.errors ?? [];
  if (errors.length === 0) {
    lines.push("\uFF08\u65E0\uFF09", "");
  } else {
    lines.push(...table2(
      ["\u7801", "\u72B6\u6001\u7801", "\u5F52\u5C5E\u6A21\u5757", "\u89E6\u53D1\u6761\u4EF6", "\u54CD\u5E94\u4F53"],
      errors.map((error) => [
        error.code,
        String(error.status),
        error.by ?? "\uFF08\u672A\u6307\u5B9A\uFF09",
        error.when,
        error.shape ?? plan.globals.errorShape ?? "\u2014"
      ])
    ), "");
  }
  lines.push("### 4.4 \u63A5\u53E3\u9762", "");
  const http = plan.http ?? [];
  if (http.length === 0) {
    lines.push("\uFF08\u65E0\uFF09", "");
  } else {
    lines.push(...table2(
      ["\u65B9\u6CD5", "\u8DEF\u5F84", "\u5904\u7406\u6A21\u5757", "\u5904\u7406\u51FD\u6570", "\u9274\u6743", "\u72B6\u6001\u7801", "\u8BF7\u6C42", "\u54CD\u5E94"],
      http.map((route) => [
        route.method,
        route.path,
        route.module,
        `${route.handler}()`,
        route.auth ?? "public",
        String(route.status ?? (route.res.trim() === "void" ? 204 : 200)),
        route.req ?? "\uFF08\u65E0\uFF09",
        route.res.trim() === "void" ? "204\uFF08\u65E0\u54CD\u5E94\u4F53\uFF09" : route.res
      ])
    ), "");
    const withHeaders = http.filter((route) => route.resHeaders !== void 0);
    if (withHeaders.length > 0) {
      lines.push("\u54CD\u5E94\u5934\uFF08\u5951\u7EA6\u7684\u4E00\u90E8\u5206\uFF09\uFF1A", "");
      for (const route of withHeaders) {
        const pairs = Object.entries(route.resHeaders ?? {}).map(([name2, value]) => `${name2}: ${value}`);
        lines.push(`- ${route.method} ${route.path} \u2014 ${pairs.join("\uFF1B")}`);
      }
      lines.push("");
    }
    const withQuery = http.filter((route) => (route.query ?? []).length > 0);
    if (withQuery.length > 0) {
      lines.push("\u67E5\u8BE2\u53C2\u6570\uFF08\u5951\u7EA6\u7684\u4E00\u90E8\u5206\uFF09\uFF1A", "");
      for (const route of withQuery) {
        const params = (route.query ?? []).map(
          (param) => `${param.name}\uFF08${param.type}\uFF0C${param.required === true ? "\u5FC5\u586B" : "\u53EF\u9009"}\uFF09${param.note !== void 0 ? ` \u2014 ${param.note}` : ""}`
        );
        lines.push(`- ${route.method} ${route.path} \u2014 ${params.join("\u3001")}`);
      }
      lines.push("");
    }
    const documented = http.filter((route) => route.reqExample !== void 0 || route.resExample !== void 0);
    for (const route of documented) {
      lines.push(`#### ${route.method} ${route.path} \u793A\u4F8B`, "");
      const bodyless = route.method === "GET" || route.method === "DELETE";
      if (route.reqExample !== void 0) {
        lines.push(bodyless ? "\u67E5\u8BE2\u53C2\u6570\u793A\u4F8B\uFF1A" : "\u8BF7\u6C42\u4F53\uFF1A", "", "```json", route.reqExample.trim(), "```", "");
      }
      if (route.resExample !== void 0) {
        lines.push("\u54CD\u5E94\u4F53\uFF1A", "", "```json", route.resExample.trim(), "```", "");
      }
    }
  }
  lines.push("## 5 \u6A21\u5757\u8FDE\u7EBF", "");
  const links = [];
  for (const module of plan.modules) {
    module.requires.forEach((need) => {
      const provider = byId.get(need.module);
      if (provider === void 0) return;
      const exposeIndex = findExposeIndex(provider, need.item);
      const provided = exposeIndex < 0 ? need.item : provider.exposes[exposeIndex]?.signature ?? need.item;
      links.push([module.dir, provider.dir, need.item, provided]);
    });
  }
  if (links.length === 0) {
    lines.push("\uFF08\u65E0\u8DE8\u6A21\u5757\u4F9D\u8D56\uFF09", "");
  } else {
    lines.push(...table2(["\u4ECE", "\u5230", "\u9700\u8981\u6761\u76EE\uFF08\u539F\u6587\uFF09", "\u63D0\u4F9B\u6761\u76EE\uFF08\u539F\u6587\uFF09"], links), "");
  }
  const flows = plan.flows ?? [];
  if (flows.length > 0) {
    lines.push("### 5.1 \u5173\u952E\u6D41\u7A0B\uFF08\u65F6\u5E8F\uFF09", "");
    lines.push("\u6BCF\u4E00\u6B65\u90FD\u53EA\u80FD\u901A\u8FC7\u76EE\u6807\u6A21\u5757 `## 3` \u91CC\u5217\u51FA\u7684\u7B7E\u540D\u8C03\u7528\uFF1B\u987A\u5E8F\u5373\u8C03\u7528\u987A\u5E8F\u3002", "");
    for (const flow of flows) {
      lines.push(`#### ${flow.id} ${flow.name}`, "");
      lines.push(`- \u89E6\u53D1\uFF1A${flow.trigger}`);
      lines.push(`- \u6210\u529F\u7ED3\u679C\uFF1A${flow.success}`);
      if (flow.failure !== void 0 && flow.failure.length > 0) {
        lines.push(`- \u5931\u8D25\u53EF\u80FD\uFF1A${flow.failure.join("\u3001")}`);
      }
      lines.push("");
      flow.steps.forEach((step, index) => {
        const owner = byId.get(step.module);
        const dir = owner === void 0 ? step.module : owner.dir;
        const note = step.note === void 0 || step.note.length === 0 ? "" : `\u3000\u2014 ${step.note}`;
        lines.push(`${index + 1}. \`${dir}\`\uFF1A${step.action}${note}`);
      });
      lines.push("");
    }
  }
  lines.push("## 6 \u9A8C\u6536\u6807\u51C6", "");
  const acceptance = [];
  for (const module of plan.modules) {
    module.acceptance.forEach((item, index) => {
      acceptance.push([`AC-${module.id}-${index + 1}`, module.id, item.assertion, item.test, item.covers ?? "\u2014"]);
    });
  }
  lines.push(...table2(["\u7F16\u53F7", "\u6A21\u5757", "\u65AD\u8A00", "\u8BC1\u636E", "\u8986\u76D6\u76EE\u6807"], acceptance), "");
  const covered = /* @__PURE__ */ new Set();
  for (const module of plan.modules) {
    for (const item of module.acceptance) {
      const match = item.covers === void 0 ? null : /^G([1-9][0-9]*)$/.exec(item.covers);
      if (match !== null) covered.add(Number(match[1]));
    }
  }
  const uncovered = plan.goals.map((_, index) => index + 1).filter((goal) => !covered.has(goal));
  if (plan.goals.length > 0 && uncovered.length > 0) {
    lines.push(`\u8986\u76D6\u7F3A\u53E3\uFF1A${uncovered.map((goal) => `G${goal}`).join("\u3001")} \u6CA1\u6709\u9A8C\u6536\u65AD\u8A00\u5BF9\u5E94\u7684 \`covers\`\uFF0C\u5F00\u5DE5\u4F1A\u4E0A\u9700\u8865\u3002`, "");
  }
  lines.push("## 7 \u5B9E\u65BD\u6CE2\u6B21", "");
  const waveRows = [];
  for (const wave of waves.waves) {
    for (const moduleId of wave.modules) {
      waveRows.push([`\u7B2C ${wave.index} \u6CE2`, moduleId, "\u662F", wave.dependsOn.length === 0 ? "\uFF08\u65E0\uFF09" : wave.dependsOn.join("<br>")]);
    }
  }
  lines.push(...table2(["\u6CE2\u6B21", "\u6A21\u5757", "\u53EF\u5E76\u884C", "\u524D\u7F6E"], waveRows), "");
  lines.push("## 8 \u5168\u5C40\u7EA6\u5B9A", "", "### \u7EA6\u5B9A", ...listOrNone(plan.globals.conventions), "");
  lines.push("### \u7981\u6B62", ...listOrNone(plan.globals.forbidden), "");
  lines.push("### \u73AF\u5883\u53D8\u91CF", ...listOrNone(plan.globals.envKeys ?? []), "");
  const fieldCase = plan.globals.fieldCase ?? "camel";
  const envelope = plan.globals.listEnvelope === true ? "\u662F" : "\u5426";
  const errorShape = plan.globals.errorShape ?? plan.errors?.[0]?.shape ?? "\uFF08\u65E0\uFF09";
  lines.push(
    "### \u63A5\u53E3\u7EA6\u5B9A",
    "",
    `- \u5B57\u6BB5\u547D\u540D\uFF1A${fieldCase}`,
    `- \u5217\u8868\u5305\u88F9\uFF1A${envelope}`,
    `- \u9519\u8BEF\u4F53\u5F62\u72B6\uFF1A${cell2(errorShape)}`,
    "- \u9519\u8BEF\u5BF9\u8C61\uFF1A\u629B\u51FA\u7684\u503C\u5FC5\u987B\u662F `instanceof Error`\uFF0C\u5E26 `code: string`\uFF08\u53D6\u81EA \xA74.3\uFF09\u4E0E\u53EF\u9009 `details: unknown`\uFF1B\u4E0D\u8981\u53E6\u9020\u88F8\u5BF9\u8C61",
    ""
  );
  const runtime = plan.runtime ?? {};
  const runtimeRows = [];
  if (runtime.port !== void 0) runtimeRows.push(["\u7AEF\u53E3", String(runtime.port)]);
  if (runtime.start !== void 0) runtimeRows.push(["\u542F\u52A8", runtime.start]);
  if (runtime.health !== void 0) runtimeRows.push(["\u5065\u5EB7\u68C0\u67E5", runtime.health]);
  if (runtime.migrate !== void 0) runtimeRows.push(["\u8FC1\u79FB", runtime.migrate]);
  if (runtime.rollback !== void 0) runtimeRows.push(["\u56DE\u6EDA", runtime.rollback]);
  lines.push("### 8.1 \u8FD0\u884C\u4E0E\u90E8\u7F72", "");
  if (runtimeRows.length === 0) {
    lines.push("\uFF08\u672A\u58F0\u660E\uFF1B\u5B9E\u73B0\u8005\u9700\u5728\u5F00\u5DE5\u4F1A\u4E0A\u786E\u8BA4\u7AEF\u53E3\u3001\u542F\u52A8\u547D\u4EE4\u3001\u5065\u5EB7\u68C0\u67E5\u4E0E\u8FC1\u79FB\u65B9\u5F0F\uFF09", "");
  } else {
    lines.push(...table2(["\u9879", "\u5185\u5BB9"], runtimeRows), "");
  }
  const nfr = plan.globals.nfr ?? [];
  lines.push("### 8.2 \u975E\u529F\u80FD\u8981\u6C42", "");
  lines.push(...listOrNone(nfr), "");
  lines.push("## 9 \u4EA4\u4ED8\u6E05\u5355", "");
  const tree = plan.deliverables.tree.trim();
  lines.push("```text", tree.length > 0 ? plan.deliverables.tree.trimEnd() : "\uFF08\u65E0\uFF09", "```", "");
  lines.push(...table2(["\u6587\u4EF6", "\u7528\u9014"], plan.deliverables.files.map((file) => [file.path, file.purpose])), "");
  const pages = plan.ui ?? [];
  lines.push("## 10 \u754C\u9762\uFF08\u9875\u9762\u7EA7\uFF09", "");
  if (pages.length === 0) {
    lines.push("\uFF08\u672A\u58F0\u660E\uFF1B\u9700\u8981\u754C\u9762\u65F6\u5728 plan \u91CC\u52A0 ui[]\uFF0C\u5199\u660E\u6BCF\u9875\u5C55\u793A\u4EC0\u4E48\u3001\u8C03\u7528\u54EA\u6761\u5DF2\u58F0\u660E\u8DEF\u7531\uFF09", "");
  } else {
    lines.push(
      ...table2(
        ["\u9875\u9762", "\u8DEF\u7531", "\u5F52\u5C5E\u6A21\u5757", "\u8C03\u7528"],
        pages.map((page) => [`${page.id} ${page.title}`, page.route, page.module, page.calls.length === 0 ? "\uFF08\u65E0\uFF09" : page.calls.join("\uFF1B")])
      ),
      ""
    );
    for (const page of pages) {
      const details = [];
      details.push(`\u5C55\u793A\uFF1A${page.shows.join("\uFF1B")}`);
      if (page.states?.empty !== void 0) details.push(`\u7A7A\u6001\uFF1A${page.states.empty}`);
      if (page.states?.error !== void 0) details.push(`\u9519\u8BEF\u6001\uFF1A${page.states.error}`);
      if (page.notes !== void 0) details.push(`\u5907\u6CE8\uFF1A${page.notes}`);
      lines.push(`- **${page.id} ${page.title}**\uFF08${page.route}\uFF09\uFF1A${details.join("\u3000")}`);
    }
    lines.push("");
  }
  lines.push("## \u9644\u5F55 A \u672A\u51B3\u95EE\u9898", "");
  lines.push(...listOrNone(plan.openQuestions ?? []), "");
  lines.push("> \u672C\u6587\u7531 dsh-impl-gate \u4ECE compose-plan.json \u751F\u6210\uFF0C\u6539\u5951\u7EA6\u8BF7\u6539 plan \u540E\u91CD\u8DD1 materialize\u3002");
  return `${lines.join("\n")}
`;
}

// src/host/init/waves.ts
function edgesOf(plan) {
  const ids = new Set(plan.modules.map((module) => module.id));
  const edges = [];
  for (const module of plan.modules) {
    for (const need of module.requires) {
      if (!ids.has(need.module) || need.module === module.id) continue;
      edges.push({ from: module.id, to: need.module });
    }
  }
  return edges;
}
function findCycle2(plan) {
  const adjacency = /* @__PURE__ */ new Map();
  for (const module of plan.modules) {
    adjacency.set(
      module.id,
      module.requires.map((need) => need.module).filter((id) => id !== module.id)
    );
  }
  const state = /* @__PURE__ */ new Map();
  const stack = [];
  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!adjacency.has(next)) continue;
      const seen = state.get(next) ?? 0;
      if (seen === 1) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (seen === 0) {
        const found = visit(next);
        if (found !== null) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of adjacency.keys()) {
    if ((state.get(id) ?? 0) === 0) {
      const found = visit(id);
      if (found !== null) return found;
    }
  }
  return null;
}
function computeWaves(plan) {
  const cycle = findCycle2(plan);
  if (cycle !== null) {
    return { ok: false, code: "PLAN_INVALID", message: `dependency cycle: ${cycle.join(" \u2192 ")}` };
  }
  const edges = edgesOf(plan);
  const ids = plan.modules.map((module) => module.id).sort();
  const prerequisites = /* @__PURE__ */ new Map();
  for (const id of ids) prerequisites.set(id, /* @__PURE__ */ new Set());
  for (const edge of edges) prerequisites.get(edge.from)?.add(edge.to);
  const placed = /* @__PURE__ */ new Set();
  const waves = [];
  let index = 1;
  while (placed.size < ids.length) {
    const ready = ids.filter((id) => {
      if (placed.has(id)) return false;
      const needs = prerequisites.get(id) ?? /* @__PURE__ */ new Set();
      for (const need of needs) if (!placed.has(need)) return false;
      return true;
    });
    if (ready.length === 0) {
      return { ok: false, code: "PLAN_INVALID", message: "dependency cycle: cannot place remaining modules" };
    }
    const dependsOn = /* @__PURE__ */ new Set();
    for (const id of ready) for (const need of prerequisites.get(id) ?? []) dependsOn.add(need);
    waves.push({ index, modules: ready, dependsOn: [...dependsOn].sort() });
    for (const id of ready) placed.add(id);
    index += 1;
  }
  const baseLayer = /* @__PURE__ */ new Map();
  waves.forEach((wave) => {
    for (const id of wave.modules) baseLayer.set(id, wave.index);
  });
  const pinned = /* @__PURE__ */ new Map();
  for (const module of plan.modules) {
    const pin = module.wave;
    if (pin === void 0) continue;
    const base = baseLayer.get(module.id) ?? 1;
    if (pin < base) {
      return {
        ok: false,
        code: "PLAN_INVALID",
        message: `module "${module.id}" is pinned to wave ${pin} but its dependencies place it in wave ${base} or later`
      };
    }
    pinned.set(module.id, pin);
  }
  if (pinned.size > 0) {
    const layered = /* @__PURE__ */ new Map();
    for (const module of plan.modules) {
      const layer = Math.max(baseLayer.get(module.id) ?? 1, pinned.get(module.id) ?? 1);
      const bucket = layered.get(layer) ?? [];
      bucket.push(module.id);
      layered.set(layer, bucket);
    }
    const rebuilt = [];
    for (const layer of [...layered.keys()].sort((a, b) => a - b)) {
      const ids2 = (layered.get(layer) ?? []).sort();
      const dependsOn = /* @__PURE__ */ new Set();
      for (const id of ids2) {
        const module = plan.modules.find((entry) => entry.id === id);
        for (const need of module?.requires ?? []) {
          if (!ids2.includes(need.module)) dependsOn.add(need.module);
        }
      }
      rebuilt.push({ index: rebuilt.length + 1, modules: ids2, dependsOn: [...dependsOn].sort() });
    }
    waves.length = 0;
    waves.push(...rebuilt);
  }
  const filesById = /* @__PURE__ */ new Map();
  for (const module of plan.modules) filesById.set(module.id, new Set(module.files));
  const overlaps = [];
  for (const wave of waves) {
    for (let i = 0; i < wave.modules.length; i += 1) {
      for (let j = i + 1; j < wave.modules.length; j += 1) {
        const a = wave.modules[i];
        const b = wave.modules[j];
        const left = filesById.get(a) ?? /* @__PURE__ */ new Set();
        const right = filesById.get(b) ?? /* @__PURE__ */ new Set();
        const shared = [...left].filter((file) => right.has(file)).sort();
        if (shared.length > 0) overlaps.push({ a, b, files: shared });
      }
    }
  }
  return { ok: true, result: { waves, overlaps } };
}

// src/host/compose/checklist-template.ts
var CHECKLIST_REL = ".impl-gate/checklist.md";
var SECTION_BY_GROUP = { A: "## 3", B: "## 6", M: "## 4", Q: "## 8" };
function specLineFor(id, specText) {
  const heading = SECTION_BY_GROUP[id.charAt(0).toUpperCase()];
  if (heading === void 0) return 1;
  const lines = specText.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(heading));
  return index < 0 ? 1 : index + 1;
}
function renderChecklistTemplate(items, name2, evidence) {
  const lines = [];
  lines.push("# \u9A8C\u6536\u52FE\u9009\u8868");
  lines.push("");
  lines.push(`- \u9879\u76EE\uFF1A${name2}`);
  lines.push(`- \u751F\u6210\uFF1A\u7531 impl_gate_compose \u7684 materialize \u6B65\u9AA4\u6309 checks/impl-gate.checks.json \u751F\u6210\uFF0C\u5171 ${items.length} \u6761`);
  lines.push("- \u6539 plan \u540E\u91CD\u65B0 materialize \u53EA\u66FF\u6362 NOT-RUN \u884C\uFF1B\u5DF2\u586B PASS/FAIL \u7684\u8BC1\u636E\u4F1A\u539F\u6837\u4FDD\u7559");
  lines.push("- \u53EA\u5141\u8BB8\u4E09\u6001\uFF1APASS / FAIL / NOT-RUN\uFF1BPASS \u4E0E FAIL \u7684 evidence \u5FC5\u987B\u4EE5 `command:` \u6216 `file:` \u5F00\u5934");
  lines.push("");
  lines.push("| id | status | evidence | reason |");
  lines.push("|----|--------|----------|--------|");
  for (const item of items) {
    lines.push(`| ${item.id} | NOT-RUN | ${evidence === void 0 ? "file:SPEC.md:1" : evidence(item.id)} | NOT_IMPLEMENTED |`);
  }
  lines.push("");
  lines.push("## \u672A\u8986\u76D6");
  lines.push("");
  lines.push("\u4EE5\u4E0B\u6761\u76EE\u5F53\u524D\u6CA1\u6709\u7ED3\u8BBA\uFF0C\u5FC5\u987B\u9010\u6761\u8865\u8BC1\u636E\u6216\u5199\u660E\u539F\u56E0\uFF1A");
  lines.push("");
  lines.push(items.map((item) => item.id).join("\u3001"));
  lines.push("");
  return lines.join("\n");
}
function mergeChecklist(previous, items, name2, evidence) {
  if (previous === void 0 || previous.trim() === "") {
    return { body: renderChecklistTemplate(items, name2, evidence), preserved: [] };
  }
  const parsed = parseChecklist(previous, CHECKLIST_REL);
  const kept = /* @__PURE__ */ new Map();
  const preserved = [];
  for (const [id, row] of parsed.rows) {
    if (row.status === "PASS" || row.status === "FAIL") {
      kept.set(id, `| ${id} | ${row.status} | ${row.evidence} | ${row.reason} |`);
      preserved.push(id);
    }
  }
  const lines = [];
  lines.push("# \u9A8C\u6536\u52FE\u9009\u8868");
  lines.push("");
  lines.push(`- \u9879\u76EE\uFF1A${name2}`);
  lines.push(`- \u751F\u6210\uFF1A\u7531 impl_gate_compose \u7684 materialize \u6B65\u9AA4\u6309 checks/impl-gate.checks.json \u751F\u6210\uFF0C\u5171 ${items.length} \u6761`);
  lines.push("- \u6539 plan \u540E\u91CD\u65B0 materialize \u53EA\u66FF\u6362 NOT-RUN \u884C\uFF1B\u5DF2\u586B PASS/FAIL \u7684\u8BC1\u636E\u4F1A\u539F\u6837\u4FDD\u7559");
  lines.push("- \u53EA\u5141\u8BB8\u4E09\u6001\uFF1APASS / FAIL / NOT-RUN\uFF1BPASS \u4E0E FAIL \u7684 evidence \u5FC5\u987B\u4EE5 `command:` \u6216 `file:` \u5F00\u5934");
  lines.push("");
  lines.push("| id | status | evidence | reason |");
  lines.push("|----|--------|----------|--------|");
  const uncovered = [];
  for (const item of items) {
    const carried = kept.get(item.id);
    if (carried !== void 0) {
      lines.push(carried);
    } else {
      lines.push(`| ${item.id} | NOT-RUN | ${evidence === void 0 ? "file:SPEC.md:1" : evidence(item.id)} | NOT_IMPLEMENTED |`);
      uncovered.push(item.id);
    }
  }
  lines.push("");
  lines.push("## \u672A\u8986\u76D6");
  lines.push("");
  lines.push("\u4EE5\u4E0B\u6761\u76EE\u5F53\u524D\u6CA1\u6709\u7ED3\u8BBA\uFF0C\u5FC5\u987B\u9010\u6761\u8865\u8BC1\u636E\u6216\u5199\u660E\u539F\u56E0\uFF1A");
  lines.push("");
  lines.push(uncovered.length === 0 ? "\uFF08\u65E0\uFF09" : uncovered.join("\u3001"));
  lines.push("");
  return { body: lines.join("\n"), preserved: preserved.filter((id) => items.some((item) => item.id === id)) };
}

// src/host/compose/mapping-template.ts
var MAPPING_REL = ".impl-gate/mapping.md";
function renderMappingTemplate(plan) {
  const lines = [];
  lines.push("# \u9700\u6C42 \u2192 \u6A21\u5757 \u6620\u5C04\u8868");
  lines.push("");
  lines.push(`- \u9879\u76EE\uFF1A${plan.name}`);
  lines.push("- \u7531 impl_gate_compose \u7684 materialize \u6B65\u9AA4\u6309 plan \u7684 requires \u751F\u6210\uFF1B\u6539 plan \u540E\u91CD\u65B0 materialize \u4F1A\u8986\u76D6");
  lines.push("- \u9700\u6C42 ID \u4E0E\u5404\u6A21\u5757 `spec.md` \u7684 `## \u9700\u8981` \u5C0F\u8282\u4E00\u4E00\u5BF9\u5E94\uFF08\u6BCF\u4E2A\u6A21\u5757\u5185\u90E8\u4ECE N1 \u8D77\uFF09");
  lines.push("");
  lines.push("| \u9700\u6C42ID | \u6A21\u5757 | \u6761\u76EE |");
  lines.push("|--------|------|------|");
  for (const module of plan.modules) {
    module.requires.forEach((need, index) => {
      lines.push(`| N${index + 1} | ${module.dir} | ${oneLine2(need.item)} |`);
    });
  }
  lines.push("");
  return lines.join("\n");
}
function oneLine2(text2) {
  return text2.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

// src/host/init/init.ts
import fs7 from "node:fs";
import path6 from "node:path";

// src/host/init/cards.ts
var NONE = "\uFF08\u65E0\uFF09";
function oneLine3(text2) {
  return text2.replace(/\s+/g, " ").trim();
}
function cardPathOf(module, wave) {
  const flat = module.dir.split(/[\\/]+/).filter(Boolean).join("-");
  return `wave-${wave}/${module.id}-${flat}.md`;
}
function withPrefix(file, implRoot) {
  const root = (implRoot ?? "").trim().replace(/[\\/]+$/, "");
  return root.length === 0 ? file : `${root}/${file}`;
}
function rootText(options) {
  const implRoot = (options.implRoot ?? "").trim().replace(/[\\/]+$/, "");
  if (implRoot.length > 0) return implRoot;
  const outDir = (options.outDir ?? "").trim().replace(/[\\/]+$/, "");
  return outDir.length > 0 ? `\u672C\u4EFB\u52A1\u5305\u6240\u5728\u76EE\u5F55 ${outDir}` : "\u672C\u4EFB\u52A1\u5305\u6240\u5728\u76EE\u5F55";
}
function exposeText(provider, item) {
  if (provider === void 0) return item;
  const found = provider.exposes.find((expose) => expose.signature === item || expose.note === item);
  return found?.signature ?? item;
}
function renderTaskCard(plan, module, wave, options = {}) {
  const byId = new Map(plan.modules.map((entry) => [entry.id, entry]));
  const lines = [
    `# ${module.title}\uFF08${module.id} \xB7 ${module.dir}\uFF09`,
    `> \u6CE2\u6B21 ${wave.index}\uFF1B\u524D\u7F6E\uFF1A${wave.dependsOn.length > 0 ? wave.dependsOn.join("\u3001") : "\u65E0"}\uFF1B\u5361\u7247\u7531 dsh-impl-gate \u4ECE compose-plan.json \u751F\u6210\uFF0C\u6539\u9700\u6C42\u8BF7\u6539 plan \u91CD\u8DD1\uFF0C\u4E0D\u8981\u624B\u6539\u672C\u5361\u3002`,
    "",
    "## 1 \u4F60\u8D1F\u8D23\u4EC0\u4E48",
    "",
    module.responsibility,
    "",
    "## 2 \u6587\u4EF6\u767D\u540D\u5355",
    "",
    "\u53EA\u5141\u8BB8\u65B0\u5EFA\u6216\u4FEE\u6539\u4EE5\u4E0B\u6587\u4EF6\uFF0C\u8D8A\u754C\u5373\u5931\u8D25\uFF1A",
    "",
    `\u4EE5\u4E0B\u8DEF\u5F84\u76F8\u5BF9 ${rootText(options)}\u3002\u5F80 graphRoot \u91CC\u5199\u6587\u4EF6\u89C6\u4E3A\u5931\u8D25\uFF1A\u5951\u7EA6\u76EE\u5F55\u53EA\u8BFB\uFF0C\u5B9E\u73B0\u4EA7\u7269\u53EA\u653E ${rootText(options)}\u3002`,
    ""
  ];
  if (module.files.length === 0) {
    lines.push(`- ${NONE}`);
  } else {
    for (const file of module.files) lines.push(`- ${withPrefix(file, options.implRoot)}`);
  }
  lines.push("", "## 3 \u4F60\u8981\u63D0\u4F9B\u7684\u5951\u7EA6", "");
  if (module.exposes.length === 0) {
    lines.push(NONE, "", "\u672C\u6A21\u5757\u4E0D\u5BF9\u5916\u63D0\u4F9B\u5951\u7EA6\u3002");
  } else {
    lines.push("\u6BCF\u6761\u4E00\u884C\uFF0C\u7B7E\u540D\u5FC5\u987B\u4E0E\u6587\u672C\u5B8C\u5168\u4E00\u81F4\uFF08\u4E0B\u6E38\u6309\u6B64\u8C03\u7528\uFF09\uFF1A", "");
    for (const expose of module.exposes) lines.push(`- \`${expose.signature}\``);
  }
  const relatedTypes = typesUsedBy(plan.types ?? [], module.exposes.map((expose) => expose.signature));
  lines.push("", "### 3.1 \u76F8\u5173\u7C7B\u578B", "");
  if (relatedTypes.length === 0) {
    lines.push(NONE);
  } else {
    for (const type of relatedTypes) lines.push(...renderTypeBlock(type), "");
  }
  lines.push("", "## 4 \u4F60\u4F9D\u8D56\u7684\u5951\u7EA6", "");
  if (module.requires.length === 0) {
    lines.push(NONE, "", "\u672C\u6A21\u5757\u53EF\u72EC\u7ACB\u5F00\u5DE5\u3002");
  } else {
    lines.push("| \u6765\u81EA | \u6761\u76EE | \u5B83\u7684\u7B7E\u540D | \u600E\u4E48\u7528 |", "|---|---|---|---|");
    for (const need of module.requires) {
      const provider = byId.get(need.module);
      const from = provider === void 0 ? need.module : `${provider.id}/${provider.dir}`;
      lines.push(`| ${from} | ${need.item} | ${exposeText(provider, need.item)} | \u6309\u7B7E\u540D\u8C03\u7528\uFF0C\u4E0D\u8981\u590D\u5236\u5176\u5B9E\u73B0 |`);
    }
  }
  const errorCodes = [...new Set(module.constraints.join("\n").match(/\bE_[A-Z0-9_]+/g) ?? [])];
  lines.push("", "### 4.1 \u9519\u8BEF\u7801", "");
  if (errorCodes.length === 0) {
    lines.push(NONE);
  } else {
    lines.push("\u672C\u6A21\u5757\u7684\u7EA6\u675F\u4F1A\u89E6\u53D1\u4EE5\u4E0B\u9519\u8BEF\u7801\uFF1A", "");
    for (const code of errorCodes) lines.push(`- \`${code}\``);
  }
  const myFlows = (plan.flows ?? []).map((flow) => {
    const positions = flow.steps.map((step, index) => step.module === module.id ? index + 1 : 0).filter((position) => position > 0);
    return { flow, positions };
  }).filter((entry) => entry.positions.length > 0);
  if (myFlows.length > 0) {
    lines.push("", "### 4.2 \u4F60\u5728\u6D41\u7A0B\u4E2D\u7684\u4F4D\u7F6E", "");
    for (const { flow, positions } of myFlows) {
      const total = flow.steps.length;
      lines.push(`- \`${flow.id}\` ${flow.name}\uFF1A\u7B2C ${positions.join("\u3001")}/${total} \u6B65\uFF08\u89E6\u53D1\uFF1A${flow.trigger}\uFF09`);
    }
  }
  const myPages = (plan.ui ?? []).filter((page) => page.module === module.id);
  if (myPages.length > 0) {
    lines.push("", "### 4.3 \u4F60\u8D1F\u8D23\u7684\u9875\u9762", "");
    for (const page of myPages) {
      lines.push(`- \`${page.id}\` ${page.title}\uFF08${page.route}\uFF09\u8C03\u7528 ${page.calls.length === 0 ? "\uFF08\u65E0\u540E\u7AEF\u8C03\u7528\uFF09" : page.calls.join("\uFF1B")}`);
    }
  }
  lines.push("", "### 4.4 \u4E0A\u4E0B\u6E38\u4E00\u89C8", "");
  const upstream = /* @__PURE__ */ new Map();
  for (const need of module.requires) {
    const list = upstream.get(need.module) ?? [];
    list.push(need.item);
    upstream.set(need.module, list);
  }
  if (upstream.size === 0) {
    lines.push(`- \u4E0A\u6E38\uFF1A${NONE}\uFF08\u53EF\u72EC\u7ACB\u5F00\u5DE5\uFF09`);
  } else {
    lines.push("- \u4E0A\u6E38\uFF08\u4F60\u6309\u7B7E\u540D\u8C03\u7528\u5B83\u4EEC\uFF09\uFF1A");
    for (const [id, items] of upstream) {
      const provider = byId.get(id);
      const label = provider === void 0 ? id : `${id}/${provider.dir}`;
      lines.push(`  - ${label} \u2014\u2014 ${items.length} \u6761\uFF1A${items.join("\u3001")}`);
    }
  }
  const downstream = [];
  for (const other of plan.modules) {
    if (other.id === module.id) continue;
    const items = other.requires.filter((need) => need.module === module.id).map((need) => need.item);
    if (items.length > 0) downstream.push({ id: other.id, dir: other.dir, items });
  }
  if (downstream.length === 0) {
    lines.push("- \u4E0B\u6E38\uFF1A\u6CA1\u6709\u6A21\u5757\u4F9D\u8D56\u4F60\u7684\u66B4\u9732\u7B7E\u540D");
  } else {
    lines.push("- \u4E0B\u6E38\uFF08\u5B83\u4EEC\u4F9D\u8D56\u4F60\uFF0C\u6539\u7B7E\u540D\u524D\u5148\u901A\u77E5\uFF09\uFF1A");
    for (const entry of downstream) {
      lines.push(`  - ${entry.id}/${entry.dir} \u2014\u2014 \u9700\u8981 ${entry.items.length} \u6761\uFF1A${entry.items.join("\u3001")}`);
    }
  }
  lines.push("", "## 5 \u7EA6\u675F", "");
  if (module.constraints.length === 0) {
    lines.push(`- ${NONE}`);
  } else {
    for (const constraint of module.constraints) lines.push(`- ${constraint}`);
  }
  lines.push("", "## 6 \u9A8C\u6536\u65AD\u8A00", "");
  const globalAcceptance = plan.acceptance ?? [];
  if (module.acceptance.length === 0 && globalAcceptance.length === 0) {
    lines.push(NONE);
  } else {
    lines.push("| \u7F16\u53F7 | \u65AD\u8A00 | \u9A8C\u6536\u547D\u4EE4 |", "|---|---|---|");
    module.acceptance.forEach((entry, index) => {
      const id = entry.id === void 0 || entry.id === "" ? `AC-${module.id}-${index + 1}` : entry.id;
      const command = entry.test === void 0 || entry.test === "" ? "\uFF08\u672A\u58F0\u660E\uFF09" : `\`${entry.test}\``;
      lines.push(`| ${id} | ${entry.assertion} | ${command} |`);
    });
    globalAcceptance.forEach((entry, index) => {
      lines.push(`| AC-G-${index + 1} | ${entry.assertion ?? ""} | \uFF08\u5168\u5C40\uFF09 |`);
    });
  }
  lines.push(
    "",
    "## 7 \u5B8C\u6210\u6807\u51C6",
    "",
    "- \u4E0A\u9762\u7684\u65AD\u8A00\u5168\u90E8\u80FD\u7528\u547D\u4EE4\u884C\u6216\u811A\u672C\u590D\u73B0\uFF1B",
    "- \u81F3\u5C11\u4E00\u6761\u8BC1\u636E\u662F\u201C\u5B9E\u9645\u6267\u884C\u7684\u547D\u4EE4 + \u8F93\u51FA\u201D\uFF0C\u4E0D\u5141\u8BB8\u53EA\u5199\u201C\u5DF2\u5B9E\u73B0\u201D\uFF1B",
    "- \u4F60\u5199\u7684\u6587\u4EF6\u5168\u90E8\u843D\u5728\u7B2C 2 \u8282\u767D\u540D\u5355\u5185\u3002",
    "",
    "## 8 \u56DE\u62A5\u683C\u5F0F",
    "",
    "\u6309\u4E94\u6BB5\u5199\uFF1A\u505A\u4E86\u4EC0\u4E48 / \u8BC1\u636E\uFF08\u547D\u4EE4+\u8F93\u51FA\uFF09 / \u7ED3\u8BBA / \u672A\u51B3\u95EE\u9898 / \u4E0B\u4E00\u6B65\u3002",
    "",
    "## 9 \u7981\u6B62",
    "",
    "- \u4E0D\u4FEE\u6539\u5176\u4ED6\u6A21\u5757\u7684\u6587\u4EF6\u3001\u4E0D\u4FEE\u6539 graphRoot \u4E0B\u7684\u5951\u7EA6\u6587\u4EF6\uFF1B",
    "- \u4E0D\u65B0\u589E\u767D\u540D\u5355\u5916\u7684\u6587\u4EF6\uFF08\u542B\u4E34\u65F6\u811A\u672C\uFF0C\u9700\u653E /tmp \u6216\u4ED3\u5E93\u6839 _probe\uFF09\uFF1B",
    "- \u4E0D\u5F80 graphRoot \u6216 tasks/ \u76EE\u5F55\u91CC\u5199\u5B9E\u73B0\u4EE3\u7801\u3002",
    "- \u4E0D\u628A\u9A8C\u6536\u65AD\u8A00\u6539\u6210\u66F4\u5BB9\u6613\u901A\u8FC7\u7684\u5F62\u5F0F\uFF1B\u65AD\u8A00\u5199\u9519\u4E86\uFF0C\u56DE\u62A5\u91CC\u63D0\u51FA\uFF0C\u4E0D\u8981\u79C1\u81EA\u6539\u3002",
    ""
  );
  return lines.join("\n");
}
function bulletList(values) {
  if (values.length === 0) return [`- ${NONE}`];
  return values.map((value) => `- ${value}`);
}
function renderTasksDoc(plan, waves, overlaps, cards) {
  const byId = new Map(plan.modules.map((entry) => [entry.id, entry]));
  const cardByModule = new Map(cards.map((card) => [card.moduleId, card.cardPath]));
  const lines = [
    `# ${plan.title} \xB7 \u4EFB\u52A1\u5361`,
    "",
    "## 0 \u600E\u4E48\u7528",
    "",
    "\u6309\u6CE2\u6B21\u63A8\u8FDB\uFF1B\u540C\u6CE2\u6B21\u53EF\u5E76\u884C\uFF1B\u6BCF\u6CE2\u5168\u90E8 PASS \u518D\u8FDB\u4E0B\u4E00\u6CE2\u3002",
    "",
    "## 1 \u6CE2\u6B21\u8868",
    "",
    "| \u6CE2\u6B21 | \u53EF\u5E76\u884C\u6A21\u5757 | \u5361\u7247 | \u524D\u7F6E\u6CE2\u6B21 |",
    "|---|---|---|---|"
  ];
  for (const wave of waves) {
    const links = wave.modules.map((id) => {
      const cardPath = cardByModule.get(id) ?? "";
      return `[${cardPath.split("/").pop() ?? id}](${cardPath})`;
    }).join("<br>");
    lines.push(`| ${wave.index} | ${wave.modules.join("<br>")} | ${links} | ${wave.dependsOn.length > 0 ? wave.dependsOn.join("\u3001") : "\u65E0"} |`);
  }
  lines.push("", "## 2 \u5E76\u884C\u5206\u7EC4", "");
  for (const wave of waves) {
    const mode = wave.modules.length === 1 ? "\uFF08\u72EC\u7ACB\uFF09" : "\uFF08\u53EF\u5E76\u884C\uFF09";
    lines.push(`- \u6CE2\u6B21 ${wave.index}\uFF1A${wave.modules.join("\u3001")}${mode}`);
  }
  if (overlaps.length > 0) {
    lines.push("");
    for (const overlap of overlaps) {
      for (const file of overlap.files) {
        lines.push(`${overlap.a} \u4E0E ${overlap.b} \u90FD\u5199 ${file} \u2014\u2014 \u5FC5\u987B\u4E32\u884C\u6216\u62C6\u5206\u6587\u4EF6`);
      }
    }
  }
  lines.push("", "## 3 \u5168\u5C40\u7EA6\u5B9A", "", "### conventions", "");
  lines.push(...bulletList(plan.globals.conventions));
  lines.push("", "### forbidden", "");
  lines.push(...bulletList(plan.globals.forbidden));
  lines.push("", "### envKeys", "");
  lines.push(...bulletList(plan.globals.envKeys ?? []));
  lines.push("", "## 4 \u9A8C\u6536\u6C47\u603B", "", "| \u6A21\u5757 | \u65AD\u8A00\u6570 | \u5361\u7247 |", "|---|---|---|");
  for (const module of plan.modules) {
    const cardPath = cardByModule.get(module.id) ?? "";
    lines.push(`| ${module.id} ${oneLine3(module.title)} | ${module.acceptance.length} | [${cardPath.split("/").pop() ?? module.id}](${cardPath}) |`);
  }
  lines.push("", "## 5 \u751F\u6210\u8BF4\u660E", "", "> \u7531 compose-plan.json \u751F\u6210\uFF1B\u91CD\u8DD1\u4F1A\u8986\u76D6\u672C\u76EE\u5F55\u3002", "");
  for (const card of cards) {
    if (!byId.has(card.moduleId)) throw new Error(`card for unknown module ${card.moduleId}`);
  }
  return lines.join("\n");
}
function buildCardsJson(plan, waves, overlaps, cards) {
  const byId = new Map(plan.modules.map((entry) => [entry.id, entry]));
  const cardByModule = new Map(cards.map((card) => [card.moduleId, card.cardPath]));
  return {
    schemaVersion: 1,
    planName: plan.name,
    waves: waves.map((wave) => ({
      index: wave.index,
      modules: wave.modules.map((id) => {
        const module = byId.get(id);
        if (module === void 0) throw new Error(`wave references unknown module ${id}`);
        return {
          id: module.id,
          dir: module.dir,
          title: module.title,
          cardPath: cardByModule.get(id) ?? "",
          files: [...module.files]
        };
      })
    })),
    overlaps
  };
}

// src/host/init/init.ts
function failure(code, message) {
  return { ok: false, error: { code, message } };
}
function relativePosix(root, target) {
  return path6.relative(root, target).split(path6.sep).join("/");
}
function listFiles(dir) {
  if (!fs7.existsSync(dir)) return [];
  return fs7.readdirSync(dir, { recursive: true }).map((entry) => String(entry)).filter((entry) => {
    try {
      return fs7.statSync(path6.join(dir, entry)).isFile();
    } catch {
      return false;
    }
  }).sort();
}
function readPlan(outDir) {
  const planPath = path6.join(outDir, "compose-plan.json");
  let text2;
  try {
    text2 = fs7.readFileSync(planPath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return failure("PLAN_MISSING", `compose-plan.json not found in ${outDir}`);
  }
  let raw;
  try {
    raw = JSON.parse(text2);
  } catch (error) {
    return failure("PLAN_INVALID", `compose-plan.json is not valid JSON: ${error.message}`);
  }
  const validation = validatePlan(raw);
  if (validation.plan === null) {
    const cycle = validation.problems.find((problem2) => problem2.message.startsWith("dependency cycle:"));
    if (cycle !== void 0) return failure("PLAN_HAS_CYCLE", cycle.message);
    const first = validation.problems[0];
    return failure(
      "PLAN_INVALID",
      first === void 0 ? "compose-plan.json failed validation" : `${first.path} ${first.message}`
    );
  }
  return validation.plan;
}
function initTasks(outDirRaw, options = {}) {
  const outDir = path6.resolve(outDirRaw);
  const plan = readPlan(outDir);
  if ("ok" in plan) return plan;
  const outcome = computeWaves(plan);
  if (!outcome.ok) {
    return failure("PLAN_HAS_CYCLE", outcome.message);
  }
  const { waves, overlaps } = outcome.result;
  const tasksDir = path6.join(outDir, "tasks");
  const waveByModule = /* @__PURE__ */ new Map();
  for (const wave of waves) for (const id of wave.modules) waveByModule.set(id, wave.index);
  const cards = [];
  const rendered = /* @__PURE__ */ new Map();
  for (const module of plan.modules) {
    const waveIndex = waveByModule.get(module.id);
    if (waveIndex === void 0) return failure("PLAN_INVALID", `module ${module.id} is missing from the wave plan`);
    const wave = waves.find((entry) => entry.index === waveIndex);
    if (wave === void 0) return failure("PLAN_INVALID", `wave ${waveIndex} is missing`);
    const cardPath = cardPathOf(module, wave.index);
    cards.push({ moduleId: module.id, wave: wave.index, cardPath });
    rendered.set(cardPath, renderTaskCard(plan, module, wave, { implRoot: options.implRoot, outDir }));
  }
  cards.sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  rendered.set("TASKS.md", renderTasksDoc(plan, waves, overlaps, cards));
  rendered.set("cards.json", `${JSON.stringify(buildCardsJson(plan, waves, overlaps, cards), null, 2)}
`);
  const expected = new Set([...rendered.keys()].map((entry) => entry.split("/").join(path6.sep)));
  const ours = /* @__PURE__ */ new Set(["EVIDENCE.md"]);
  const existing = listFiles(tasksDir);
  const unknown = existing.filter((entry) => !expected.has(entry) && !ours.has(entry));
  if (unknown.length > 0) {
    return failure(
      "EXPORT_REFUSED",
      `tasks/ already contains files this tool did not generate: ${unknown.map((entry) => `tasks/${entry}`).join(", ")}`
    );
  }
  if (options.overwrite !== true) {
    const clash = [...expected].filter((entry) => fs7.existsSync(path6.join(tasksDir, entry))).sort();
    if (clash.length > 0) {
      return failure(
        "EXPORT_REFUSED",
        `tasks/ files already exist (pass overwrite=true to replace): ${clash.map((entry) => `tasks/${entry}`).join(", ")}`
      );
    }
  }
  const filesWritten = [];
  for (const relative of [...rendered.keys()].sort()) {
    const target = path6.join(tasksDir, ...relative.split("/"));
    fs7.mkdirSync(path6.dirname(target), { recursive: true });
    fs7.writeFileSync(target, rendered.get(relative) ?? "");
    filesWritten.push(relativePosix(outDir, target));
  }
  return {
    ok: true,
    tasksDir,
    cards,
    waves,
    overlaps,
    filesWritten: filesWritten.sort()
  };
}

// src/host/record/record.ts
import { spawnSync } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import fs8 from "node:fs";
import path7 from "node:path";
var AC_EVIDENCE_REL = ".impl-gate/ac-evidence.json";
var TASKS_EVIDENCE_REL = "tasks/EVIDENCE.md";
var ALLOWED_RUNNERS = /* @__PURE__ */ new Set([
  "pnpm",
  "npm",
  "npx",
  "yarn",
  "bun",
  "deno",
  "node",
  "python",
  "python3",
  "py",
  "git",
  "bash",
  "sh",
  "cargo",
  "go",
  "dotnet",
  "java",
  "mvn",
  "gradle",
  "make"
]);
var DEFAULT_TIMEOUT_MS = 12e4;
var DEFAULT_TAIL_LINES = 20;
var MAX_TAIL_CHARS = 1200;
function failure2(code, message, detail) {
  const out = { ok: false, error: { code, message } };
  if (detail !== void 0) out.error.detail = detail;
  return out;
}
function hashFile(file) {
  return createHash2("sha256").update(fs8.readFileSync(file)).digest("hex");
}
var ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
function tailOf(stdout, stderr, lines) {
  const text2 = `${stdout?.toString() ?? ""}
${stderr?.toString() ?? ""}`.replace(ANSI, "").trim();
  if (text2 === "") return "";
  const rows = text2.split(/\r?\n/).filter((row) => row.trim() !== "");
  const tail = rows.slice(-lines).join("\n");
  return tail.length > MAX_TAIL_CHARS ? `${tail.slice(0, MAX_TAIL_CHARS)}\u2026` : tail;
}
function runnerOf(command) {
  const first = command.trim().split(/\s+/)[0] ?? "";
  if (first === "") return null;
  return first.replace(/\\/g, "/").split("/").pop()?.replace(/\.(cmd|exe|bat)$/i, "") ?? null;
}
function firstProblem(problem2) {
  return problem2.path === void 0 ? problem2.message : `${problem2.path}: ${problem2.message}`;
}
function recordAcceptance(outDirRaw, options = {}) {
  if (typeof outDirRaw !== "string" || outDirRaw.trim() === "") {
    return failure2("E_ROOT_MISSING", "outDir is required");
  }
  const outDir = path7.resolve(outDirRaw);
  if (!fs8.existsSync(outDir) || !fs8.statSync(outDir).isDirectory()) {
    return failure2("E_ROOT_MISSING", `outDir does not exist: ${outDir}`);
  }
  const planFile = path7.join(outDir, "compose-plan.json");
  if (!fs8.existsSync(planFile)) {
    return failure2("PLAN_MISSING", `no compose-plan.json under ${outDir}; run impl_gate_compose mode:"plan" first`);
  }
  let plan;
  try {
    plan = JSON.parse(fs8.readFileSync(planFile, "utf8"));
  } catch (error) {
    return failure2("PLAN_INVALID", `compose-plan.json is not valid JSON: ${error.message}`);
  }
  const { problems } = validatePlan(plan);
  if (problems.length > 0) {
    return failure2("PLAN_INVALID", `${problems.length} problem(s) in compose-plan.json`, firstProblem(problems[0]));
  }
  const wanted = options.modules === void 0 ? null : new Set(options.modules);
  if (wanted !== null) {
    for (const id of wanted) {
      if (!plan.modules.some((module) => module.id === id)) {
        return failure2("PLAN_INVALID", `unknown module "${id}" in modules filter`);
      }
    }
  }
  const implRoot = path7.resolve(options.implRoot ?? outDir);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTailLines = options.maxTailLines ?? DEFAULT_TAIL_LINES;
  const items = [];
  const recordedModules = [];
  for (const module of plan.modules) {
    if (wanted !== null && !wanted.has(module.id)) continue;
    recordedModules.push(module.id);
    for (const acceptance of module.acceptance ?? []) {
      const command = (acceptance.test ?? "").trim();
      if (command === "") {
        items.push({ id: acceptance.id, module: module.id, command: "", status: "SKIPPED", exitCode: null, durationMs: 0, tail: "", reason: "NO_COMMAND" });
        continue;
      }
      const runner = runnerOf(command);
      if (runner === null || !ALLOWED_RUNNERS.has(runner)) {
        items.push({ id: acceptance.id, module: module.id, command, status: "SKIPPED", exitCode: null, durationMs: 0, tail: "", reason: `RUNNER_NOT_ALLOWED (${runner ?? "unknown"})` });
        continue;
      }
      if (options.dryRun === true) {
        items.push({ id: acceptance.id, module: module.id, command, status: "SKIPPED", exitCode: null, durationMs: 0, tail: "", reason: "DRY_RUN" });
        continue;
      }
      const startedAt = Date.now();
      const result = spawnSync(command, {
        cwd: implRoot,
        shell: true,
        timeout: timeoutMs,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      });
      const durationMs = Date.now() - startedAt;
      const exitCode = typeof result.status === "number" ? result.status : null;
      const timedOut = result.error !== void 0 && result.error.code === "ETIMEDOUT";
      const tail = tailOf(result.stdout, result.stderr, maxTailLines);
      if (timedOut) {
        items.push({ id: acceptance.id, module: module.id, command, status: "FAIL", exitCode, durationMs, tail, reason: `TIMEOUT after ${timeoutMs}ms` });
        continue;
      }
      items.push({
        id: acceptance.id,
        module: module.id,
        command,
        status: exitCode === 0 ? "PASS" : "FAIL",
        exitCode,
        durationMs,
        tail,
        ...exitCode === 0 ? {} : { reason: `exit:${exitCode ?? "null"}` }
      });
    }
  }
  const planSha256 = hashFile(planFile);
  const evidencePath = path7.join(outDir, AC_EVIDENCE_REL);
  let merged = items;
  try {
    const prev = JSON.parse(fs8.readFileSync(evidencePath, "utf8"));
    if (prev.planSha256 === planSha256 && Array.isArray(prev.items)) {
      const recorded = new Set(recordedModules);
      const kept = prev.items.filter((item) => !recorded.has(item.module));
      merged = [...kept, ...items].sort((a, b) => a.id.localeCompare(b.id));
    }
  } catch {
    merged = items;
  }
  const summary = {
    pass: merged.filter((item) => item.status === "PASS").length,
    fail: merged.filter((item) => item.status === "FAIL").length,
    skipped: merged.filter((item) => item.status === "SKIPPED").length,
    total: merged.length
  };
  const moduleOrder = new Map(plan.modules.map((module, index) => [module.id, index]));
  const acceptanceOrder = /* @__PURE__ */ new Map();
  for (const module of plan.modules) {
    ;
    (module.acceptance ?? []).forEach((entry, index) => {
      acceptanceOrder.set(`${module.id}\0${entry.id}`, index);
    });
  }
  merged.sort((a, b) => {
    const orderA = moduleOrder.get(a.module) ?? Number.MAX_SAFE_INTEGER;
    const orderB = moduleOrder.get(b.module) ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    const acA = acceptanceOrder.get(`${a.module}\0${a.id}`) ?? Number.MAX_SAFE_INTEGER;
    const acB = acceptanceOrder.get(`${b.module}\0${b.id}`) ?? Number.MAX_SAFE_INTEGER;
    return acA === acB ? a.id.localeCompare(b.id) : acA - acB;
  });
  const refCounters = /* @__PURE__ */ new Map();
  for (const item of merged) {
    const n = (refCounters.get(item.module) ?? 0) + 1;
    refCounters.set(item.module, n);
    item.ref = `AC-${item.module}-${n}`;
  }
  try {
    fs8.mkdirSync(path7.dirname(evidencePath), { recursive: true });
    fs8.writeFileSync(
      evidencePath,
      `${JSON.stringify({ schemaVersion: 1, generatedAt: (/* @__PURE__ */ new Date()).toISOString(), planSha256, summary, items: merged }, null, 2)}
`,
      "utf8"
    );
    const tasksDir = path7.join(outDir, "tasks");
    if (fs8.existsSync(tasksDir)) {
      fs8.writeFileSync(path7.join(outDir, TASKS_EVIDENCE_REL), renderEvidenceDoc({ planSha256, summary, items: merged, plan, dryRun: options.dryRun === true }), "utf8");
    }
  } catch (error) {
    return failure2("RECORD_WRITE_FAILED", `cannot write ${evidencePath}: ${error.message}`);
  }
  return { ok: true, evidencePath: path7.relative(outDir, evidencePath).split(path7.sep).join("/"), summary, items: merged, planSha256 };
}
function renderEvidenceDoc(input) {
  const title = input.plan.title ?? input.plan.name;
  const lines = [];
  lines.push(`# \u9A8C\u6536\u8BC1\u636E\uFF1A${title}`);
  lines.push("");
  lines.push("> \u7531 `impl_gate_record` \u751F\u6210\uFF1A\u6BCF\u6761 AC \u7684\u547D\u4EE4\u88AB\u6267\u884C\u4E00\u6B21\uFF0C\u4E0B\u9762\u662F\u9000\u51FA\u7801\u4E0E\u65E5\u5FD7\u5C3E\u90E8\u3002");
  lines.push("> \u8FD9\u662F\u300C\u5B9E\u73B0\u8BC1\u636E\u300D\uFF0C\u4E0D\u662F\u300C\u6587\u6863\u81EA\u6D3D\u300D\u2014\u2014\u6587\u6863\u5C42\u9762\u8BF7\u7528 `impl_gate_review`\u3002");
  lines.push("");
  lines.push(`- plan sha256: \`${input.planSha256.slice(0, 16)}\``);
  lines.push(`- \u7ED3\u679C\uFF1APASS ${input.summary.pass} / FAIL ${input.summary.fail} / SKIPPED ${input.summary.skipped}\uFF08\u5171 ${input.summary.total} \u6761\uFF09`);
  if (input.dryRun) lines.push("- \u672C\u6B21\u662F dryRun\uFF0C\u6CA1\u6709\u771F\u6B63\u6267\u884C\u4EFB\u4F55\u547D\u4EE4\u3002");
  lines.push("");
  lines.push("| AC | \u6A21\u5757 | \u72B6\u6001 | \u9000\u51FA\u7801 | \u8017\u65F6 | \u547D\u4EE4 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const item of input.items) {
    const label = item.ref === void 0 || item.id === item.ref ? item.id : `${item.ref} (${item.id})`;
    const cells = [label, item.module, item.status, item.exitCode === null ? "\u2014" : String(item.exitCode), `${item.durationMs}ms`, item.command === "" ? "\uFF08\u672A\u58F0\u660E\u547D\u4EE4\uFF09" : `\`${item.command}\``];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  const failed = input.items.filter((item) => item.status === "FAIL");
  if (failed.length > 0) {
    lines.push("");
    lines.push("## \u5931\u8D25\u4E0E\u8DF3\u8FC7\u660E\u7EC6");
    for (const item of failed) {
      lines.push("");
      lines.push(`### ${item.id}\uFF08${item.module}\uFF09\u2014 ${item.reason ?? "FAIL"}`);
      lines.push("");
      lines.push("```");
      lines.push(item.tail === "" ? "\uFF08\u6CA1\u6709\u8F93\u51FA\uFF09" : item.tail);
      lines.push("```");
    }
  }
  const skipped = input.items.filter((item) => item.status === "SKIPPED");
  if (skipped.length > 0) {
    lines.push("");
    lines.push("## \u672A\u6267\u884C");
    for (const item of skipped) lines.push(`- ${item.id}\uFF08${item.module}\uFF09\uFF1A${item.reason ?? "SKIPPED"}`);
  }
  lines.push("");
  return lines.join("\n");
}

// src/host/compose/materialize.ts
var OWNERSHIP = ".impl-gate/ownership.json";
var RUN_RECORD_RE = /(^|\/)\.impl-gate\/runs\/run-[a-z0-9]+-[a-z0-9]+\.json$/;
function isRunRecord(file) {
  return RUN_RECORD_RE.test(file);
}
async function listFiles2(root) {
  const out = [];
  const walk2 = async (dir, depth) => {
    if (depth > 12) return;
    let entries;
    try {
      entries = await fs9.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path8.join(dir, entry.name);
      if (entry.isDirectory()) await walk2(full, depth + 1);
      else if (entry.isFile()) out.push(full);
    }
  };
  await walk2(root, 0);
  return out;
}
async function readOwnershipRecord(outDir) {
  try {
    const raw = await fs9.promises.readFile(path8.join(outDir, OWNERSHIP), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.generated)) return void 0;
    return {
      generated: parsed.generated.filter((entry) => typeof entry === "string"),
      managedBy: typeof parsed.managedBy === "string" ? parsed.managedBy : "",
      plan_sha256: typeof parsed.plan_sha256 === "string" ? parsed.plan_sha256 : "",
      generated_at: typeof parsed.generated_at === "string" ? parsed.generated_at : ""
    };
  } catch {
    return void 0;
  }
}
async function writeOwnership(outDir, generated, planSha256) {
  const file = path8.join(outDir, OWNERSHIP);
  await fs9.promises.mkdir(path8.dirname(file), { recursive: true });
  const body = {
    generated: [...generated].sort(),
    managedBy: `dsh-impl-gate@${"0.4.27"}`,
    plan_sha256: planSha256,
    generated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  await fs9.promises.writeFile(file, `${JSON.stringify(body, null, 2)}
`, "utf8");
}
function hashFile2(file) {
  return createHash3("sha256").update(fs9.readFileSync(file)).digest("hex");
}
var FILE_PATH_RE = /(?:^|[\s（(，,、])(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|sql|html|css|json|md|yml|yaml)\b/;
function collectWarnings(plan) {
  const out = [];
  const garbled = [];
  const walk2 = (value, path12) => {
    if (typeof value === "string") {
      if (/\?{3,}|\uFFFD/.test(value)) garbled.push(`${path12 || "/"}: ${value.slice(0, 60)}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk2(item, `${path12}/${index}`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) walk2(item, `${path12}/${key}`);
    }
  };
  walk2(plan, "");
  if (garbled.length > 0) {
    out.push({ code: "PLAN_TEXT_MOJIBAKE", count: garbled.length, items: garbled.slice(0, 10) });
  }
  const covered = /* @__PURE__ */ new Set();
  for (const module of plan.modules) {
    for (const item of module.acceptance ?? []) {
      if (typeof item.covers === "string" && item.covers !== "") covered.add(item.covers);
    }
  }
  const gap = (plan.goals ?? []).filter((goal, index) => !covered.has(`G${index + 1}`));
  if (gap.length > 0) {
    out.push({ code: "COVERAGE_GAP", count: gap.length, items: gap.map((_, i) => `G${i + 1}`) });
  }
  const noOwner = (plan.errors ?? []).filter((entry) => entry.by === void 0 || entry.by === "").map((entry) => entry.code);
  if (noOwner.length > 0) out.push({ code: "ERROR_OWNER_MISSING", count: noOwner.length, items: noOwner });
  const magnitude = /(duration|weight|height|length|width|depth|distance|volume|amount|price|cost|dose|quantity|capacity|temperature|speed|pace|mass)/i;
  const unitSuffix = /(?:Kg|G|Mg|Ml|L|Km|Cm|Mm|M|S|Ms|Us|Min|Sec|Hour|Day|Pct|Bps|Bytes|Kb|Mb|Gb|Usd|Cny|Cent)$/;
  const unitless = [];
  for (const type of plan.types ?? []) {
    for (const field of type.fields ?? []) {
      if (!/\bnumber\b/i.test(field.type)) continue;
      if (!magnitude.test(field.name)) continue;
      if (unitSuffix.test(field.name)) continue;
      if (field.unit !== void 0 && field.unit.trim().length > 0) continue;
      unitless.push(`${type.name}.${field.name}`);
    }
  }
  if (unitless.length > 0) out.push({ code: "UNIT_MISSING", count: unitless.length, items: unitless.slice(0, 10) });
  const unitByName = /* @__PURE__ */ new Map();
  for (const type of plan.types ?? []) {
    for (const field of type.fields ?? []) {
      if (!/\bnumber\b/i.test(field.type)) continue;
      const entry = unitByName.get(field.name) ?? [];
      entry.push({ unit: field.unit ?? "", where: type.name });
      unitByName.set(field.name, entry);
    }
  }
  const inconsistent = [];
  for (const [name2, entries] of unitByName) {
    if (entries.length < 2) continue;
    const units = new Set(entries.map((entry) => entry.unit));
    if (units.size < 2) continue;
    const shown = entries.map((entry) => `${entry.where}:${entry.unit === "" ? "\uFF08\u65E0\uFF09" : entry.unit}`).join(", ");
    inconsistent.push(`${name2} (${shown})`);
  }
  if (inconsistent.length > 0) {
    out.push({ code: "UNIT_INCONSISTENT", count: inconsistent.length, items: inconsistent.slice(0, 10) });
  }
  const declaredEnv = new Set(plan.globals?.envKeys ?? []);
  const undeclaredEnv = /* @__PURE__ */ new Set();
  const runtime = plan.runtime ?? {};
  for (const command of [runtime.start, runtime.health, runtime.migrate, runtime.rollback]) {
    if (!command) continue;
    for (const match of command.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*=/g)) {
      const name2 = match[1];
      if (!name2) continue;
      if (!declaredEnv.has(name2)) undeclaredEnv.add(name2);
    }
  }
  if (undeclaredEnv.size > 0) {
    out.push({ code: "ENV_KEY_UNDECLARED", count: undeclaredEnv.size, items: [...undeclaredEnv].slice(0, 10) });
  }
  const referenced = /* @__PURE__ */ new Set();
  for (const module of plan.modules) {
    for (const text2 of module.constraints ?? []) {
      for (const match of text2.matchAll(/\bE_[A-Z0-9_]+\b/g)) referenced.add(match[0]);
    }
    for (const item of module.acceptance ?? []) {
      for (const match of item.assertion.matchAll(/\bE_[A-Z0-9_]+\b/g)) referenced.add(match[0]);
    }
  }
  for (const flow of plan.flows ?? []) {
    for (const code of flow.failure ?? []) referenced.add(code);
  }
  const unused = (plan.errors ?? []).map((entry) => entry.code).filter((code) => !referenced.has(code));
  if (unused.length > 0) out.push({ code: "ERROR_UNUSED", count: unused.length, items: unused });
  const noAuth = (plan.http ?? []).filter((entry) => entry.auth === void 0).map((entry) => `${entry.method} ${entry.path}`);
  if (noAuth.length > 0) out.push({ code: "AUTH_UNSPECIFIED", count: noAuth.length, items: noAuth });
  const MUTATING = /* @__PURE__ */ new Set(["POST", "PATCH", "PUT", "DELETE"]);
  const defaulted = (plan.http ?? []).filter((entry) => MUTATING.has(entry.method) && entry.status === void 0).map((entry) => `${entry.method} ${entry.path}`);
  if (defaulted.length > 0) out.push({ code: "STATUS_DEFAULTED", count: defaulted.length, items: defaulted });
  const collection = (name2) => {
    if (name2 === void 0 || name2 === "void" || name2 === "") return false;
    if (name2.endsWith("[]")) return true;
    if (/(List|Page|Collection)$/.test(name2)) return true;
    const declared = (plan.types ?? []).find((type) => type.name === name2);
    const fields = declared?.fields ?? [];
    const arrays = fields.filter((field) => field.type.includes("[]") || field.type.startsWith("Array<"));
    if (arrays.length === 0) return false;
    return arrays.length === fields.length || arrays.some((field) => /^(items|rows|list|results|data|entries)$/i.test(field.name));
  };
  const orderWords = (text2) => /排序|升序|降序|order\s*by|sort(ed)?\s*by|orderBy|sortBy/i.test(text2);
  const hasOrderNote = (routeModule, res) => {
    const name2 = res ?? "";
    return (plan.modules ?? []).some((module) => {
      if (!(module.constraints ?? []).some(orderWords)) return false;
      if (module.id === routeModule) return true;
      return (module.exposes ?? []).some((expose) => name2 !== "" && expose.signature.includes(`: ${name2}`));
    });
  };
  const unordered = (plan.http ?? []).filter((entry) => collection(entry.res)).filter((entry) => !(entry.query ?? []).some((param) => /^(sort|order|orderBy|sortBy)$/i.test(param.name))).filter((entry) => !hasOrderNote(entry.module, entry.res)).map((entry) => `${entry.method} ${entry.path} \u2192 ${entry.res ?? ""}`);
  if (unordered.length > 0) out.push({ code: "LIST_ORDER_UNDEFINED", count: unordered.length, items: unordered });
  const PAGE_FIELDS = /^(total|totalCount|hasMore|nextCursor|pageSize)$/i;
  const PAGE_PARAMS = /^(page|pageSize|perPage|limit|offset|cursor|after|before)$/i;
  const unpaginated = (plan.http ?? []).filter((entry) => {
    const declared = (plan.types ?? []).find((type) => type.name === entry.res);
    if (declared === void 0 || declared.kind !== "object") return false;
    const fields = declared.fields ?? [];
    if (!fields.some((field) => PAGE_FIELDS.test(field.name))) return false;
    return !(entry.query ?? []).some((param) => PAGE_PARAMS.test(param.name));
  }).map((entry) => `${entry.method} ${entry.path} returns ${entry.res ?? ""} with pagination fields but declares no page/limit/cursor query`);
  if (unpaginated.length > 0) out.push({ code: "LIST_PAGINATION_UNDECLARED", count: unpaginated.length, items: unpaginated });
  const OFFSET_PARAMS = /^(page|pageSize|perPage|offset|limit)$/i;
  const CURSOR_PARAMS = /^(cursor|after|before)$/i;
  const mixedPaging = (plan.http ?? []).filter((entry) => {
    const names = (entry.query ?? []).map((param) => param.name);
    return names.some((name2) => OFFSET_PARAMS.test(name2)) && names.some((name2) => CURSOR_PARAMS.test(name2));
  }).map((entry) => {
    const names = (entry.query ?? []).map((param) => param.name).join(", ");
    return `${entry.method} ${entry.path} mixes offset and cursor pagination (${names})`;
  });
  if (mixedPaging.length > 0) out.push({ code: "PAGINATION_MODE_CONFLICT", count: mixedPaging.length, items: mixedPaging });
  const typeIndex = new Map((plan.types ?? []).map((type) => [type.name, type]));
  const paramTypes = (signature) => {
    const open = signature.indexOf("(");
    const close = signature.lastIndexOf(")");
    if (open < 0 || close <= open) return [];
    return [...signature.slice(open + 1, close).matchAll(/:\s*([A-Z][A-Za-z0-9_]*)/g)].map((match) => match[1] ?? "");
  };
  const unmapped = [];
  for (const entry of plan.http ?? []) {
    const names = (entry.query ?? []).map((param) => param.name);
    const handler = (entry.handler ?? "").trim();
    if (names.length === 0 || handler === "") continue;
    const signatures = (plan.modules ?? []).flatMap((module) => (module.exposes ?? []).map((expose) => expose.signature.trim())).filter((signature) => signature.startsWith(`${handler}(`));
    const carriers = [...new Set(signatures.flatMap(paramTypes))].filter((name2) => typeIndex.get(name2)?.kind === "object");
    if (carriers.length === 0) continue;
    const known = new Set(carriers.flatMap((name2) => (typeIndex.get(name2)?.fields ?? []).map((field) => field.name)));
    const missing = names.filter((name2) => !known.has(name2));
    if (missing.length > 0) {
      unmapped.push(`${entry.method} ${entry.path} declares ${missing.join(", ")} but ${carriers.join("/")} has no such field`);
    }
  }
  if (unmapped.length > 0) out.push({ code: "QUERY_PARAM_UNMAPPED", count: unmapped.length, items: unmapped });
  const defaultWords = /缺省|默认|default|上限|最多|最少|从 ?1 ?开始/;
  const conventionText = (plan.globals?.conventions ?? []).join("\n");
  const unstatedDefaults = [];
  for (const entry of plan.http ?? []) {
    const params = (entry.query ?? []).filter((param) => param.required !== true);
    if (params.length === 0) continue;
    const owner = (plan.modules ?? []).find((module) => module.id === entry.module);
    const text2 = `${(owner?.constraints ?? []).join("\n")}
${conventionText}`;
    for (const param of params) {
      if (typeof param.note === "string" && param.note.trim() !== "") continue;
      const named = text2.split(/\n/).some((line) => line.includes(param.name) && defaultWords.test(line));
      if (!named) unstatedDefaults.push(`${entry.method} ${entry.path} \u2192 ${param.name} has no default stated`);
    }
  }
  if (unstatedDefaults.length > 0) out.push({ code: "QUERY_DEFAULT_UNSTATED", count: unstatedDefaults.length, items: unstatedDefaults });
  const patchTypes = /* @__PURE__ */ new Set();
  for (const entry of plan.http ?? []) {
    if (entry.method === "PATCH" && entry.req !== void 0 && entry.req !== "") patchTypes.add(entry.req);
  }
  const ambiguousPatch = [...patchTypes].filter((name2) => {
    const declared = (plan.types ?? []).find((type) => type.name === name2);
    const fields = declared?.fields ?? [];
    if (fields.length === 0) return false;
    return fields.every((field) => /null/.test(field.type) || field.note === "\u53EF\u9009");
  });
  if (ambiguousPatch.length > 0) out.push({ code: "PATCH_NULLABLE_AMBIGUOUS", count: ambiguousPatch.length, items: ambiguousPatch });
  const typeUsers = /* @__PURE__ */ new Map();
  for (const type of plan.types ?? []) {
    for (const module of plan.modules) {
      const texts = [
        ...(module.exposes ?? []).map((expose) => expose.signature),
        ...module.constraints ?? [],
        ...(module.acceptance ?? []).map((item) => item.assertion)
      ];
      if (texts.some((text2) => new RegExp(`\\b${type.name}\\b`).test(text2))) {
        const set = typeUsers.get(type.name) ?? /* @__PURE__ */ new Set();
        set.add(module.id);
        typeUsers.set(type.name, set);
      }
    }
    for (const route of plan.http ?? []) {
      if (route.req === type.name || route.res === type.name) {
        const set = typeUsers.get(type.name) ?? /* @__PURE__ */ new Set();
        set.add(route.module);
        typeUsers.set(type.name, set);
      }
    }
  }
  const ownerless = (plan.types ?? []).filter((type) => type.owner === void 0 || type.owner === "").filter((type) => (typeUsers.get(type.name)?.size ?? 0) > 1).map((type) => type.name);
  if (ownerless.length > 0) {
    out.push({ code: "TYPE_OWNER_MISSING", count: ownerless.length, items: ownerless });
  }
  const typeCorpus = [
    ...plan.modules.flatMap((module) => [
      ...(module.exposes ?? []).map((expose) => expose.signature),
      ...module.constraints ?? [],
      ...(module.acceptance ?? []).map((item) => item.assertion)
    ]),
    ...(plan.http ?? []).flatMap((route) => [
      route.req ?? "",
      route.res ?? "",
      route.handler ?? "",
      ...(route.query ?? []).map((param) => param.type)
    ]),
    ...(plan.types ?? []).flatMap((type) => (type.fields ?? []).map((field) => field.type))
  ].join("\n");
  const unusedTypes = (plan.types ?? []).filter((type) => type.kind !== "external").filter((type) => !new RegExp(`\\b${type.name}\\b`).test(typeCorpus)).map((type) => type.name);
  if (unusedTypes.length > 0) {
    out.push({ code: "TYPE_UNUSED", count: unusedTypes.length, items: unusedTypes });
  }
  const corpus = [
    plan.stack ?? "",
    ...plan.goals ?? [],
    ...plan.nonGoals ?? [],
    ...plan.globals?.conventions ?? [],
    ...plan.globals?.forbidden ?? [],
    ...plan.globals?.nfr ?? [],
    ...(plan.deliverables?.files ?? []).map((file) => `${file.path} ${file.purpose}`),
    ...plan.modules.flatMap((module) => [module.title, module.responsibility ?? "", ...module.constraints ?? [], ...module.files ?? []])
  ].join("\n").toLowerCase();
  const RUNTIME_LIKE = /^(node(\.?js)?|deno|bun|python|java|go|rust|\.net|jdk|运行时|runtime|浏览器|browser|现代浏览器|fetch|文件系统|本地文件系统|os|stdin|stdout)$/i;
  const unusedBoundary = (plan.boundaries ?? []).map((boundary) => boundary.dependency).filter((dependency) => typeof dependency === "string" && dependency !== "").filter((dependency) => !RUNTIME_LIKE.test(dependency.trim()) && !/浏览器|文件系统|fetch/i.test(dependency)).filter((dependency) => !/(目录|环境|离线|本机|单机|时区|本地数据|用户数据)/.test(dependency)).filter((dependency) => !corpus.includes(dependency.toLowerCase()));
  if (unusedBoundary.length > 0) {
    out.push({ code: "BOUNDARY_UNUSED", count: unusedBoundary.length, items: unusedBoundary });
  }
  const anyValidation = (plan.errors ?? []).some((error) => error.status === 400 || error.status === 422);
  const noValidation = anyValidation ? [] : (plan.http ?? []).filter((entry) => ["POST", "PATCH", "PUT"].includes(entry.method)).filter((entry) => entry.req !== void 0 && entry.req !== "" && entry.req !== "void").map((entry) => `${entry.method} ${entry.path} \u2192 ${entry.req ?? ""}`);
  if (noValidation.length > 0) {
    out.push({ code: "WRITE_NO_VALIDATION_ERROR", count: noValidation.length, items: noValidation });
  }
  const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|rs|cs|kt|swift|php|rb)$/i;
  const noSource = (plan.types ?? []).filter((type) => type.owner !== void 0 && type.owner !== "").filter((type) => {
    const owner = plan.modules.find((module) => module.id === type.owner);
    if (owner === void 0) return false;
    const files = owner.files ?? [];
    return files.length > 0 && !files.some((file) => SOURCE_FILE.test(file));
  }).map((type) => `${type.name} \u2192 ${type.owner}`);
  if (noSource.length > 0) {
    out.push({ code: "TYPE_OWNER_NO_SOURCE", count: noSource.length, items: noSource });
  }
  const fieldsOf = new Map((plan.types ?? []).map((type) => [type.name, new Set((type.fields ?? []).map((f) => f.name))]));
  const unknownFields = [];
  const seenField = /* @__PURE__ */ new Set();
  for (const module of plan.modules) {
    const texts = [...module.constraints ?? [], ...(module.acceptance ?? []).map((item) => item.assertion)];
    for (const text2 of texts) {
      for (const match of text2.matchAll(/\b([A-Z][A-Za-z0-9]*)\.([a-z][A-Za-z0-9]*)\b/g)) {
        const type = match[1] ?? "";
        const field = match[2] ?? "";
        const fields = fieldsOf.get(type);
        if (fields === void 0 || fields.has(field)) continue;
        const line = `${module.id}: ${type}.${field}`;
        if (seenField.has(line)) continue;
        seenField.add(line);
        unknownFields.push(line);
      }
    }
  }
  if (unknownFields.length > 0) {
    out.push({ code: "CONSTRAINT_FIELD_UNKNOWN", count: unknownFields.length, items: unknownFields });
  }
  const IN_MEMORY = /内存|进程内|in-?memory|new Map\(/i;
  const implicit = (plan.data ?? []).flatMap(
    (table3) => (table3.rowWriters ?? []).flatMap((writer) => {
      const module = plan.modules.find((entry) => entry.id === writer);
      if (module === void 0) return [];
      const texts = [module.title, module.responsibility ?? "", ...module.constraints ?? []];
      return texts.some((text2) => IN_MEMORY.test(text2)) ? [`${table3.table} \u2190 ${writer}`] : [];
    })
  );
  if (implicit.length > 0) {
    out.push({ code: "IN_MEMORY_VS_TABLE", count: implicit.length, items: implicit });
  }
  const owners = /* @__PURE__ */ new Map();
  for (const module of plan.modules) {
    for (const file of module.files ?? []) {
      const key = file.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
      const set = owners.get(key) ?? /* @__PURE__ */ new Set();
      set.add(module.id);
      owners.set(key, set);
    }
  }
  const clashes = [...owners.entries()].filter(([, modules]) => modules.size > 1).map(([file, modules]) => `${file} \u2190 ${[...modules].sort().join(", ")}`);
  if (clashes.length > 0) out.push({ code: "FILE_OWNERSHIP_OVERLAP", count: clashes.length, items: clashes });
  const pathish = [];
  for (const module of plan.modules) {
    for (const text2 of module.constraints ?? []) {
      if (FILE_PATH_RE.test(text2)) pathish.push(module.id + ": " + text2.slice(0, 80));
    }
  }
  if (pathish.length > 0) out.push({ code: "CONSTRAINT_HAS_PATH", count: pathish.length, items: pathish });
  const routes = plan.http ?? [];
  const asserted = /* @__PURE__ */ new Set();
  const unstated = [];
  const seen = /* @__PURE__ */ new Set();
  const routePath = (raw) => {
    const cut = raw.split("?")[0] ?? raw;
    return cut.replace(/[.,;:!?。，；：、」』”’"'）)]+$/u, "");
  };
  for (const module of plan.modules) {
    for (const item of module.acceptance ?? []) {
      for (const match of item.assertion.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s,，、；;）」』"']*)/g)) {
        const rawPath = match[2];
        if (rawPath === void 0) continue;
        const path12 = routePath(rawPath);
        const key = `${match[1]} ${path12}`;
        asserted.add(key);
        const route = routes.find((entry) => entry.method === match[1] && entry.path === path12);
        if (route !== void 0 && (route.auth ?? "public") !== "public" && !/Origin|401/i.test(item.assertion)) {
          const line = `${module.id}: ${key} needs ${route.auth}`;
          if (!seen.has(line)) {
            seen.add(line);
            unstated.push(line);
          }
        }
      }
    }
  }
  if (unstated.length > 0) out.push({ code: "AC_AUTH_UNSTATED", count: unstated.length, items: unstated });
  const contradictions = [];
  const statusSeen = /* @__PURE__ */ new Set();
  for (const module of plan.modules) {
    for (const item of module.acceptance ?? []) {
      const mentions = [];
      for (const match of item.assertion.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s，,。）)]*)/g)) {
        const rawPath = match[2];
        if (rawPath === void 0 || match.index === void 0) continue;
        mentions.push({ index: match.index, key: `${match[1]} ${rawPath}`, path: routePath(rawPath) });
      }
      if (mentions.length === 0) continue;
      for (const statusMatch of item.assertion.matchAll(/(?:返回|状态码|status)\D{0,6}([1-5][0-9]{2})/gi)) {
        if (statusMatch.index === void 0) continue;
        const assertedStatus = Number(statusMatch[1]);
        if (assertedStatus < 200 || assertedStatus > 299) continue;
        const before = mentions.filter((mention) => mention.index <= statusMatch.index);
        const nearest = before[before.length - 1];
        if (nearest === void 0) continue;
        if (statusMatch.index - nearest.index > 24) continue;
        const method = nearest.key.split(" ")[0] ?? "";
        const route = routes.find((entry) => entry.method === method && entry.path === nearest.path);
        if (route === void 0) continue;
        const declared = route.status ?? (route.res === "void" ? 204 : 200);
        if (declared === assertedStatus) continue;
        const line = `${module.id}: ${item.id} asserts ${assertedStatus} for ${method} ${nearest.path}; http[] declares ${declared}`;
        if (statusSeen.has(line)) continue;
        statusSeen.add(line);
        contradictions.push(line);
      }
    }
  }
  if (contradictions.length > 0) {
    out.push({ code: "AC_STATUS_CONTRADICTION", count: contradictions.length, items: contradictions });
  }
  const fieldHits = [];
  const fieldSeen = /* @__PURE__ */ new Set();
  for (const module of plan.modules) {
    for (const item of module.acceptance ?? []) {
      const keys = /* @__PURE__ */ new Set();
      for (const match of item.assertion.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s，,。）)]*)/g)) {
        const rawPath = match[2];
        if (rawPath === void 0) continue;
        keys.add(`${match[1]} ${routePath(rawPath)}`);
      }
      if (keys.size !== 1) continue;
      const key = [...keys][0] ?? "";
      const method = key.split(" ")[0] ?? "";
      const routePathOnly = key.slice(method.length + 1);
      const route = routes.find((entry) => entry.method === method && entry.path === routePathOnly);
      if (route === void 0 || route.res === void 0 || route.res === "" || route.res === "void") continue;
      const declared = typeIndex.get(route.res);
      if (declared === void 0 || declared.kind !== "object") continue;
      const known = new Set((declared.fields ?? []).map((field) => field.name));
      const errorCase = /\bE_[A-Z0-9_]+\b|\b4[0-9]{2}\b/.test(item.assertion);
      const envelope = /* @__PURE__ */ new Set(["error", "message", "code", "details"]);
      for (const read of item.assertion.matchAll(/\bbody\.([A-Za-z0-9_]+)/g)) {
        const field = read[1];
        if (field === void 0 || known.has(field)) continue;
        if (errorCase && envelope.has(field)) continue;
        const line = `${module.id}: ${item.id} reads body.${field} but ${route.res} has no such field`;
        if (fieldSeen.has(line)) continue;
        fieldSeen.add(line);
        fieldHits.push(line);
      }
    }
  }
  if (fieldHits.length > 0) out.push({ code: "AC_FIELD_UNKNOWN", count: fieldHits.length, items: fieldHits });
  const routeKey = (text2) => {
    const parts = text2.trim().replace(/\s+/g, " ").split(" ");
    if (parts.length < 2) return text2.trim();
    return `${parts[0]?.toUpperCase() ?? ""} ${parts.slice(1).join(" ")}`;
  };
  const touched = /* @__PURE__ */ new Set();
  for (const flow of plan.flows ?? []) {
    for (const step of flow.steps ?? []) {
      const route = (plan.http ?? []).find((entry) => entry.module === step.module && entry.handler === step.action);
      if (route !== void 0) touched.add(`${route.method} ${route.path}`);
    }
  }
  for (const page of plan.ui ?? []) {
    for (const call of page.calls ?? []) touched.add(routeKey(call));
  }
  const isStaticAsset = (routePath2) => /\.(?:js|mjs|css|html|png|svg|ico|woff2?|ttf|map)$/i.test(routePath2);
  const uncovered = routes.filter((route) => !isStaticAsset(route.path)).filter((route) => !asserted.has(`${route.method} ${route.path}`)).filter((route) => !touched.has(`${route.method} ${route.path}`)).map((route) => `${route.method} ${route.path}`);
  if (uncovered.length > 0) out.push({ code: "HTTP_ROUTE_UNCOVERED", count: uncovered.length, items: uncovered });
  const HOST_ENTRY = /\b(listen|startServer|buildServer|createApp)\s*\(/;
  const hasHost = plan.modules.some(
    (module) => (module.exposes ?? []).some((entry) => HOST_ENTRY.test(entry.signature))
  );
  if (routes.length > 0 && !hasHost) {
    out.push({
      code: "HTTP_NO_HOST",
      count: routes.length,
      items: routes.slice(0, 10).map((route) => `${route.method} ${route.path}`)
    });
  }
  const simpleType = /^([A-Za-z_][A-Za-z0-9_]*)(\[\])?$/;
  const resMismatch = [];
  const norm = (value) => value.replace(/\s+/g, "");
  for (const route of plan.http ?? []) {
    const res = (route.res ?? "").trim();
    if (res === "void" || res === "") continue;
    if (/^register/i.test(route.handler)) continue;
    const module = plan.modules.find((entry) => entry.id === route.module);
    const expose = (module?.exposes ?? []).find((entry) => entry.signature.trim().startsWith(`${route.handler}(`));
    if (!expose) continue;
    const afterParams = expose.signature.slice(expose.signature.indexOf("):") + 2).trim();
    const unwrapped = afterParams.replace(/^Promise<(.+)>$/, "$1").trim();
    if (!simpleType.test(res) || !simpleType.test(unwrapped)) continue;
    const norm2 = (value) => value.replace(/\s+/g, "");
    if (norm2(res) !== norm2(unwrapped)) {
      resMismatch.push(`${route.method} ${route.path} declares ${res}, handler ${route.handler} returns ${unwrapped}`);
    }
  }
  if (resMismatch.length > 0) {
    out.push({ code: "HTTP_RES_MISMATCH", count: resMismatch.length, items: resMismatch.slice(0, 10) });
  }
  const reqMismatch = [];
  for (const route of plan.http ?? []) {
    const req = (route.req ?? "").trim();
    if (req === "" || req === "\uFF08\u65E0\uFF09" || /^register/i.test(route.handler)) continue;
    if (!["POST", "PUT", "PATCH"].includes(route.method.toUpperCase())) continue;
    const module = plan.modules.find((entry) => entry.id === route.module);
    const expose = (module?.exposes ?? []).find((entry) => entry.signature.trim().startsWith(`${route.handler}(`));
    if (!expose) continue;
    const inside = expose.signature.slice(expose.signature.indexOf("(") + 1, expose.signature.indexOf("):"));
    const params = inside.split(",").map((part) => part.trim()).filter(Boolean);
    if (params.length !== 1) continue;
    const typeOfParam = params[0]?.slice(params[0].indexOf(":") + 1).trim() ?? "";
    if (!simpleType.test(req) || !simpleType.test(typeOfParam)) continue;
    if (norm(req) !== norm(typeOfParam)) {
      reqMismatch.push(`${route.method} ${route.path} declares req ${req}, handler ${route.handler} takes ${typeOfParam}`);
    }
  }
  if (reqMismatch.length > 0) {
    out.push({ code: "HTTP_REQ_MISMATCH", count: reqMismatch.length, items: reqMismatch.slice(0, 10) });
  }
  const outside = [];
  for (const module of plan.modules) {
    const owns = routes.some((route) => route.module === module.id);
    if (owns) continue;
    for (const item of module.acceptance ?? []) {
      if (/\b(GET|POST|PUT|PATCH|DELETE)\s+\//.test(item.assertion)) outside.push(`${module.id}: ${item.id}`);
    }
  }
  if (outside.length > 0) out.push({ code: "AC_HTTP_OUTSIDE_SHELL", count: outside.length, items: outside });
  let waves = null;
  try {
    waves = computeWaves(plan);
  } catch {
    waves = null;
  }
  const shell = plan.modules.find((module) => (module.exposes ?? []).some((entry) => /\bbuildServer\s*\(/.test(entry.signature ?? "")));
  if (waves !== null && waves.ok && shell !== void 0) {
    const waveOf = (id) => waves.result.waves.find((wave) => wave.modules.includes(id))?.index ?? 0;
    const shellWave = waveOf(shell.id);
    const early = [];
    for (const module of plan.modules) {
      if (module.id === shell.id || waveOf(module.id) === 0 || waveOf(module.id) >= shellWave) continue;
      const ownRoutes = new Set(
        routes.filter((route) => route.module === module.id).map((route) => `${route.method} ${route.path}`)
      );
      for (const item of module.acceptance ?? []) {
        const mentions = [...item.assertion.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s，,。）)]*)/g)].map(
          (match) => `${match[1] ?? ""} ${match[2] ?? ""}`
        );
        if (mentions.length === 0) continue;
        if (mentions.every((mention) => ownRoutes.has(mention))) continue;
        early.push(`${module.id}: ${item.id} runs in wave ${waveOf(module.id)}, shell ${shell.id} is wave ${shellWave}`);
      }
    }
    if (early.length > 0) out.push({ code: "AC_SHELL_LATER", count: early.length, items: early });
  }
  const manifests = ["package.json", "pyproject.toml", "go.mod", "cargo.toml", "pom.xml", "build.gradle"];
  const hasCommands = plan.modules.some((module) => (module.acceptance ?? []).some((item) => (item.test ?? "").trim() !== ""));
  const ownsManifest = plan.modules.some(
    (module) => (module.files ?? []).some((file) => manifests.includes(file.split("/").pop()?.toLowerCase() ?? ""))
  );
  if (hasCommands && !ownsManifest) {
    out.push({
      code: "TOOLING_UNOWNED",
      count: 1,
      items: ["no module owns package.json (or another workspace manifest); acceptance commands cannot run in a clean checkout"]
    });
  }
  const questions = plan.openQuestions ?? [];
  if (questions.length > 0) {
    out.push({
      code: "OPEN_QUESTIONS_PENDING",
      count: questions.length,
      items: questions.map((entry, index) => `${index + 1}. ${entry.slice(0, 70)}`)
    });
  }
  const unrun = [];
  for (const module of plan.modules) {
    for (const item of module.acceptance ?? []) {
      const command = (item.test ?? "").trim();
      if (command === "") {
        unrun.push(`${module.id}: ${item.id} has no command`);
        continue;
      }
      const runner = runnerOf(command);
      if (runner === null || !ALLOWED_RUNNERS.has(runner)) {
        unrun.push(`${module.id}: ${item.id} starts with "${command.split(/\s+/)[0] ?? ""}"`);
      }
    }
  }
  if (unrun.length > 0) out.push({ code: "AC_TEST_UNRUNNABLE", count: unrun.length, items: unrun });
  const selectorPattern = /(?:-t|--test-name-pattern|--grep)\s+"([^"]+)"/;
  const filePattern = /\brun\s+([^\s-][^\s]*)/;
  const byFile = /* @__PURE__ */ new Map();
  for (const module of plan.modules) {
    for (const item of module.acceptance ?? []) {
      const command = (item.test ?? "").trim();
      const selector = selectorPattern.exec(command)?.[1];
      if (selector === void 0 || selector === "") continue;
      const file = filePattern.exec(command)?.[1] ?? command;
      const key = file.replace(/\\/g, "/");
      const list = byFile.get(key) ?? [];
      list.push({ id: `${module.id}: ${item.id}`, selector });
      byFile.set(key, list);
    }
  }
  const overlaps = [];
  for (const [file, entries] of byFile) {
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = 0; j < entries.length; j += 1) {
        if (i === j) continue;
        const a = entries[i];
        const b = entries[j];
        if (a === void 0 || b === void 0) continue;
        if (a.selector !== b.selector && !b.selector.startsWith(a.selector)) continue;
        overlaps.push(`${a.id} selector "${a.selector}" also matches ${b.id} "${b.selector}" (${file})`);
      }
    }
  }
  if (overlaps.length > 0) {
    out.push({ code: "AC_TEST_SELECTOR_OVERLAP", count: overlaps.length, items: overlaps.slice(0, 10) });
  }
  return out;
}
function failure3(code, message, detail) {
  const out = { ok: false, code, message };
  if (detail !== void 0) out.detail = detail;
  return out;
}
function fromError(error) {
  if (error instanceof SpecgraphError) return failure3(error.code, error.message, error.detail);
  return failure3("E_INTERNAL", error.message);
}
function buildEnv(config, outDir) {
  return resolveSpecgraphEnv({
    command: config.specgraphCommand,
    pythonPath: config.pythonPath,
    home: config.specgraphCwd,
    startDirs: [config.implRoot ?? "", outDir]
  });
}
function parseJson(text2) {
  const start = text2.indexOf("{");
  if (start < 0) return void 0;
  try {
    return JSON.parse(text2.slice(start));
  } catch {
    return void 0;
  }
}
async function runExport(environment, timeoutMs, graphRoot, moduleDir) {
  const tmp = await fs9.promises.mkdtemp(path8.join(os.tmpdir(), "impl-gate-export-"));
  try {
    const output = await runProcess([...environment.argv, "export", moduleDir, "--root", graphRoot, "--out", tmp], {
      cwd: environment.cwd,
      env: environment.env,
      timeoutMs
    });
    if (output.exitCode !== 0) {
      const parsed = parseJson(output.stdout);
      if (parsed !== void 0 && Array.isArray(parsed.issues)) {
        throw new SpecgraphError(
          "GRAPH_INVALID",
          `specgraph export failed for "${moduleDir}" (exit ${output.exitCode})`,
          output.stderr.slice(-4096) || output.stdout.slice(-4096)
        );
      }
      throw new SpecgraphError(
        "PYTHON_ENV_MISSING",
        `python could not run specgraph export for "${moduleDir}" (exit ${output.exitCode}); check PYTHONPATH or specgraphCwd`,
        output.stderr.slice(-4096) || output.stdout.slice(-4096)
      );
    }
    const files = (await listFiles2(tmp)).sort();
    const mdFile = files.find((file) => file.endsWith(".md"));
    const jsonFile = files.find((file) => file.endsWith(".json"));
    if (mdFile === void 0 || jsonFile === void 0) {
      throw new SpecgraphError("E_BAD_JSON", `specgraph export wrote no package for "${moduleDir}"`);
    }
    const md = await fs9.promises.readFile(mdFile, "utf8");
    const manifest = JSON.parse(await fs9.promises.readFile(jsonFile, "utf8"));
    return { md, manifest };
  } finally {
    await fs9.promises.rm(tmp, { recursive: true, force: true }).catch(() => void 0);
  }
}
async function materializePlan(outDirRaw, config) {
  const outDir = path8.resolve(outDirRaw);
  const planPath = path8.join(outDir, "compose-plan.json");
  let raw;
  try {
    raw = await fs9.promises.readFile(planPath, "utf8");
  } catch {
    return failure3("E_PLAN_MISSING", `compose-plan.json not found in ${outDir}`);
  }
  let parsedPlan;
  try {
    parsedPlan = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    return failure3("E_BAD_JSON", `compose-plan.json is not valid JSON: ${error.message}`);
  }
  const validation = validatePlan(parsedPlan);
  if (validation.plan === null) {
    const first = validation.problems[0];
    const message = first === void 0 ? "plan is invalid" : `${first.path || "/"} ${first.message}`;
    return { ...failure3("PLAN_INVALID", message), problems: validation.problems };
  }
  const plan = validation.plan;
  const waves = computeWaves(plan);
  if (!waves.ok) return failure3("PLAN_INVALID", waves.message);
  const target = path8.join(outDir, plan.name);
  const exportDir = path8.join(outDir, "export");
  const specFile = path8.join(outDir, "SPEC.md");
  const planFile = path8.join(outDir, "compose-plan.json");
  const planSha256 = hashFile2(planFile);
  const previousOwnership = await readOwnershipRecord(outDir);
  const registered = new Set(previousOwnership?.generated ?? []);
  const files = /* @__PURE__ */ new Map();
  files.set(`${plan.name}/graph.toml`, renderGraphToml(plan));
  for (const module of plan.modules) {
    files.set(`${plan.name}/${module.dir}/spec.md`, renderModuleSpec(plan, module));
  }
  const specText = renderSpecDoc({ plan, waves: waves.result });
  files.set("SPEC.md", specText);
  const generated = [...files.keys()];
  const conflicts = [];
  for (const rel of generated) {
    const full = path8.join(outDir, rel);
    const exists = await fs9.promises.stat(full).then((stat2) => stat2.isFile()).catch(() => false);
    if (exists && !registered.has(rel) && !isRunRecord(rel)) conflicts.push(rel);
  }
  if (conflicts.length > 0) {
    return failure3(
      "EXPORT_REFUSED",
      `refusing to overwrite files impl-gate does not own: ${conflicts.sort().join(", ")}`,
      `move them away and retry; owned from the previous run: ${[...registered].sort().join(", ") || "(none)"}`
    );
  }
  const environment = buildEnv(config, outDir);
  try {
    await preflightSpecgraph(environment, config.timeoutMs);
  } catch (error) {
    return fromError(error);
  }
  for (const [rel, body] of files) {
    const full = path8.join(outDir, rel);
    await fs9.promises.mkdir(path8.dirname(full), { recursive: true });
    await fs9.promises.writeFile(full, body, "utf8");
  }
  const ownedBefore = previousOwnership?.generated ?? [];
  await writeOwnership(outDir, [.../* @__PURE__ */ new Set([...ownedBefore, ...generated])], planSha256);
  const runner = { argv: environment.argv, cwd: environment.cwd, env: environment.env, timeoutMs: config.timeoutMs };
  let checkOutput;
  try {
    checkOutput = await runProcess([...runner.argv, "check", target, "--json"], runner);
  } catch (error) {
    return fromError(error);
  }
  const checkJson = parseJson(checkOutput.stdout);
  if (checkOutput.exitCode !== 0 || checkJson?.ok !== true) {
    const issues = Array.isArray(checkJson?.issues) ? checkJson.issues : [];
    if (checkOutput.exitCode !== 0 && (checkJson === void 0 || !Array.isArray(checkJson.issues))) {
      return failure3(
        "PYTHON_ENV_MISSING",
        `python could not run specgraph check (exit ${checkOutput.exitCode}); check PYTHONPATH or specgraphCwd`,
        `${checkOutput.stderr}
${checkOutput.stdout}`.trim().slice(-4096) || void 0
      );
    }
    const hints = collectWarnings(plan).map((entry) => `warning ${entry.code} (${entry.count}): ${entry.items.slice(0, 3).join("; ")}`).join("\n");
    const detail = [checkOutput.stderr.slice(-2048), hints].filter((part) => part !== "").join("\n");
    return {
      ...failure3(
        "GRAPH_INVALID",
        `specgraph check rejected ${target} (exit ${checkOutput.exitCode})`,
        detail === "" ? void 0 : detail
      ),
      issues,
      graphExitCode: checkOutput.exitCode
    };
  }
  const exports = [];
  for (const module of plan.modules) {
    try {
      const result = await runExport(environment, config.timeoutMs, target, module.dir);
      exports.push({ dir: module.dir, ...result });
    } catch (error) {
      return fromError(error);
    }
  }
  const bundlePreface = [
    "> \u672C\u5305\u7531 impl-gate \u751F\u6210\u3002\u6280\u672F\u6808\u4EE5 plan.stack \u4E3A\u51C6\uFF0C\u76EE\u5F55\u4E0E\u6587\u4EF6\u767D\u540D\u5355\u4EE5 `tasks/` \u4E0B\u7684\u4EFB\u52A1\u5361\u4E3A\u51C6\uFF1B",
    "> \u53EA\u6709\u4EFB\u52A1\u5361\u672A\u63D0\u5230\u7684\u5185\u90E8\u5B9E\u73B0\u7EC6\u8282\u624D\u7531\u5B9E\u73B0\u8005\u81EA\u9009\u3002",
    ""
  ].join("\n");
  files.set("export/export.md", `${bundlePreface}
${exports.map((entry) => entry.md.trimEnd()).join("\n\n---\n\n")}
`);
  files.set(
    "export/manifest.json",
    `${JSON.stringify({ schemaVersion: 1, modules: exports.map((entry) => ({ dir: entry.dir, manifest: entry.manifest })) }, null, 2)}
`
  );
  const checklistPath = path8.join(outDir, CHECKLIST_REL);
  const previousChecklist = await fs9.promises.readFile(checklistPath, "utf8").catch(() => void 0);
  const merged = mergeChecklist(previousChecklist, loadChecks(), plan.name, (id) => `file:SPEC.md:${specLineFor(id, specText)}`);
  let checklistBackupPath;
  if (previousChecklist !== void 0 && merged.preserved.length > 0) {
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
    checklistBackupPath = `${checklistPath}.bak-${stamp}`;
    await fs9.promises.writeFile(checklistBackupPath, previousChecklist, "utf8");
  }
  files.set(CHECKLIST_REL, merged.body);
  files.set(MAPPING_REL, renderMappingTemplate(plan));
  for (const [rel, body] of files) {
    if (generated.includes(rel)) continue;
    const full = path8.join(outDir, rel);
    await fs9.promises.mkdir(path8.dirname(full), { recursive: true });
    await fs9.promises.writeFile(full, body, "utf8");
  }
  const all = [...files.keys()].sort();
  await writeOwnership(outDir, all, planSha256);
  let tasksRefreshed = [];
  if (fs9.existsSync(path8.join(outDir, "tasks"))) {
    try {
      const refreshed = initTasks(outDir, { overwrite: true });
      if ("ok" in refreshed && refreshed.ok) tasksRefreshed = refreshed.filesWritten ?? [];
    } catch {
      tasksRefreshed = [];
    }
  }
  return {
    ok: true,
    mode: "materialize",
    graphRoot: target,
    specMd: specFile,
    packageMd: path8.join(exportDir, "export.md"),
    manifestPath: path8.join(exportDir, "manifest.json"),
    files: all,
    waves: waves.result.waves,
    overlaps: waves.result.overlaps,
    planSha256,
    checklistPreserved: merged.preserved,
    ...checklistBackupPath === void 0 ? {} : { checklistBackupPath },
    ...tasksRefreshed.length === 0 ? {} : { tasksRefreshed },
    warnings: collectWarnings(plan)
  };
}

// src/host/review/review.ts
import crypto from "node:crypto";
import fs10 from "node:fs";
import path9 from "node:path";
var REVIEW_REL = path9.join(".impl-gate", "review.json");
function failure4(code, message, detail) {
  const out = { ok: false, error: { code, message } };
  if (detail !== void 0) out.error.detail = detail;
  return out;
}
function readPlan2(outDir) {
  const planPath = path9.join(outDir, "compose-plan.json");
  let text2;
  try {
    text2 = fs10.readFileSync(planPath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return failure4("PLAN_MISSING", `compose-plan.json not found in ${outDir}`);
  }
  let raw;
  try {
    raw = JSON.parse(text2);
  } catch (error) {
    return failure4("PLAN_INVALID", `compose-plan.json is not valid JSON: ${error.message}`);
  }
  const validation = validatePlan(raw);
  if (validation.plan === null) {
    const first = validation.problems[0];
    return failure4("PLAN_INVALID", first === void 0 ? "compose-plan.json failed validation" : `${first.path} ${first.message}`);
  }
  return validation.plan;
}
function readStored(reviewPath) {
  try {
    const text2 = fs10.readFileSync(reviewPath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(text2);
    if (Array.isArray(parsed.rounds)) return { schemaVersion: 1, rounds: parsed.rounds };
  } catch {
  }
  return { schemaVersion: 1, rounds: [] };
}
var STATUSES = /* @__PURE__ */ new Set(["ready", "clarify", "blocked"]);
var EVIDENCE_RE = /^SPEC\.md:[1-9][0-9]*$/;
function hashOf(file) {
  try {
    return crypto.createHash("sha256").update(fs10.readFileSync(file)).digest("hex");
  } catch {
    return void 0;
  }
}
function recordReview(outDirRaw, input) {
  const outDir = path9.resolve(outDirRaw);
  if (!fs10.existsSync(outDir) || !fs10.statSync(outDir).isDirectory()) {
    return failure4("E_ROOT_MISSING", `outDir does not exist: ${outDir}`);
  }
  const plan = readPlan2(outDir);
  if ("ok" in plan) return plan;
  const reviewer = (input.reviewer ?? "").trim();
  if (reviewer === "") return failure4("REVIEW_INVALID", "reviewer must be a non-empty string");
  const verdicts = input.verdicts ?? [];
  if (!Array.isArray(verdicts) || verdicts.length === 0) {
    return failure4("REVIEW_INVALID", "verdicts must list at least one module");
  }
  const known = new Set(plan.modules.map((module) => module.id));
  const seen = /* @__PURE__ */ new Set();
  for (const [index, verdict] of verdicts.entries()) {
    const module = typeof verdict.module === "string" ? verdict.module.trim() : "";
    if (!known.has(module)) {
      return failure4("REVIEW_MODULE_UNKNOWN", `verdict ${index} names module "${module}", which is not in compose-plan.json`);
    }
    if (seen.has(module)) return failure4("REVIEW_INVALID", `module "${module}" appears twice in one round`);
    seen.add(module);
    if (!STATUSES.has(verdict.status)) {
      return failure4("REVIEW_INVALID", `verdict ${index} status must be ready, clarify or blocked`);
    }
    if (verdict.evidence !== void 0 && !EVIDENCE_RE.test(verdict.evidence.trim())) {
      return failure4(
        "REVIEW_INVALID",
        `verdict ${index} evidence must look like "SPEC.md:<line>" (got "${verdict.evidence}")`
      );
    }
  }
  const reviewPath = path9.join(outDir, REVIEW_REL);
  const stored = readStored(reviewPath);
  const planSha256 = hashOf(path9.join(outDir, "compose-plan.json")) ?? "";
  if (planSha256 === "") return failure4("PLAN_INVALID", "compose-plan.json could not be read for hashing");
  const specSha256 = hashOf(path9.join(outDir, "SPEC.md"));
  const nextRound = input.round ?? stored.rounds.length + 1;
  if (stored.rounds.some((entry) => entry.round === nextRound)) {
    return failure4("REVIEW_ROUND_EXISTS", `round ${nextRound} already recorded; pass a new round number`);
  }
  const summary = {
    ready: verdicts.filter((entry) => entry.status === "ready").length,
    clarify: verdicts.filter((entry) => entry.status === "clarify").length,
    blocked: verdicts.filter((entry) => entry.status === "blocked").length,
    blocking: verdicts.reduce((sum, entry) => sum + (entry.blocking?.length ?? 0), 0)
  };
  stored.rounds.push({
    round: nextRound,
    reviewer,
    at: (/* @__PURE__ */ new Date()).toISOString(),
    planSha256,
    ...specSha256 === void 0 ? {} : { specSha256 },
    verdicts: verdicts.map((entry) => ({
      module: entry.module.trim(),
      status: entry.status,
      ...entry.note === void 0 ? {} : { note: entry.note },
      ...entry.blocking === void 0 ? {} : { blocking: entry.blocking },
      ...entry.evidence === void 0 ? {} : { evidence: entry.evidence.trim() }
    })),
    summary
  });
  stored.rounds.sort((a, b) => a.round - b.round);
  try {
    fs10.mkdirSync(path9.dirname(reviewPath), { recursive: true });
    fs10.writeFileSync(reviewPath, `${JSON.stringify(stored, null, 2)}
`, "utf8");
  } catch (error) {
    return failure4("REVIEW_WRITE_FAILED", `could not write ${reviewPath}: ${error.message}`);
  }
  const previous = stored.rounds.filter((entry) => entry.round < nextRound).at(-1);
  const previousBlocking = previous?.summary.blocking;
  return {
    ok: true,
    reviewPath,
    round: nextRound,
    total: plan.modules.length,
    planSha256,
    ...specSha256 === void 0 ? {} : { specSha256 },
    ...previousBlocking === void 0 ? {} : { blockingDelta: previousBlocking - summary.blocking },
    ...summary
  };
}

// src/host/graph-hash.ts
import { createHash as createHash4 } from "node:crypto";
import fs11 from "node:fs";
import path10 from "node:path";
var TARGET_NAMES = /* @__PURE__ */ new Set(["spec.md", "graph.toml"]);
var SKIP_DIRS = /* @__PURE__ */ new Set([".git", "node_modules", ".dsh-dev", ".impl-gate"]);
async function walk(dir, depth, out) {
  if (depth > 12) return;
  let entries;
  try {
    entries = await fs11.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const full = path10.join(dir, entry.name);
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
      const digest = createHash4("sha256").update(await fs11.promises.readFile(file)).digest("hex");
      hashes[path10.relative(root, file).split(path10.sep).join("/")] = digest.slice(0, 16);
    } catch {
      hashes[path10.relative(root, file).split(path10.sep).join("/")] = "unreadable";
    }
  }
  return hashes;
}

// src/host/tools.ts
var MAX_EVIDENCE = 2048;
var RUN_TTL_MS = 10 * 60 * 1e3;
var RUN_FILE_TTL_MS = 24 * 60 * 60 * 1e3;
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
var runs = /* @__PURE__ */ new Map();
function normalizeRoot(root) {
  const resolved = path11.resolve(root);
  const unquoted = resolved.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? unquoted.toLowerCase() : unquoted;
}
function runsDir(graphRoot) {
  return path11.join(graphRoot, ".impl-gate", "runs");
}
function persistRun(runId, record) {
  try {
    const dir = runsDir(record.graphRoot);
    fs12.mkdirSync(dir, { recursive: true });
    fs12.writeFileSync(path11.join(dir, `${runId}.json`), JSON.stringify({ runId, ...record }), "utf8");
  } catch {
  }
}
function readRunFile(root, runId) {
  if (!/^run-[a-z0-9]+-[a-z0-9]+$/.test(runId)) return null;
  try {
    const raw = JSON.parse(fs12.readFileSync(path11.join(runsDir(root), `${runId}.json`), "utf8"));
    if (raw === null || typeof raw.finishedAt !== "number") return null;
    if (Date.now() - raw.finishedAt > RUN_FILE_TTL_MS) return null;
    return { payload: raw.payload, reasons: raw.reasons, graphRoot: raw.graphRoot, finishedAt: raw.finishedAt };
  } catch {
    return null;
  }
}
function readLatestRunFile(root) {
  let entries;
  try {
    entries = fs12.readdirSync(runsDir(root)).filter((name2) => name2.endsWith(".json"));
  } catch {
    return null;
  }
  let best = null;
  const wanted = normalizeRoot(root);
  for (const name2 of entries) {
    const record = readRunFile(root, name2.slice(0, -".json".length));
    if (record === null) continue;
    if (record.graphRoot !== wanted) continue;
    if (best === null || record.finishedAt > best.finishedAt) best = record;
  }
  return best;
}
function rememberRun(runId, payload, reasons, graphRoot) {
  const record = {
    payload,
    reasons,
    graphRoot: normalizeRoot(graphRoot),
    finishedAt: Date.now()
  };
  runs.set(runId, record);
  persistRun(runId, record);
  for (const [key, entry] of runs) {
    if (Date.now() - entry.finishedAt > RUN_TTL_MS) runs.delete(key);
  }
}
function lookupRun(runId, root) {
  const record = runs.get(runId);
  if (record === void 0) {
    const fromDisk = root === void 0 ? null : readRunFile(root, runId);
    if (fromDisk === null) return { kind: "missing" };
    return { kind: "ok", record: fromDisk };
  }
  if (Date.now() - record.finishedAt > RUN_TTL_MS) {
    runs.delete(runId);
    const fromDisk = root === void 0 ? null : readRunFile(root, runId);
    if (fromDisk === null) return { kind: "expired" };
    return { kind: "ok", record: fromDisk };
  }
  return { kind: "ok", record };
}
function latestRunFor(root) {
  const wanted = normalizeRoot(root);
  let best;
  let bestId = "";
  for (const [runId, record] of runs) {
    if (record.graphRoot !== wanted) continue;
    if (Date.now() - record.finishedAt > RUN_TTL_MS) {
      runs.delete(runId);
      continue;
    }
    if (best === void 0 || record.finishedAt > best.finishedAt) {
      best = record;
      bestId = runId;
    }
  }
  if (best === void 0) {
    const fromDisk = readLatestRunFile(root);
    return fromDisk === null ? { kind: "missing" } : { kind: "ok", record: fromDisk };
  }
  return { kind: "ok", record: { ...best, payload: { ...best.payload, runId: best.payload.runId || bestId } } };
}
function fail(code, message, detail) {
  return detail === void 0 ? { error: { code, message } } : { error: { code, message, detail } };
}
function failureFrom(error) {
  if (error instanceof SpecgraphError) return fail(error.code, error.message, error.detail);
  const message = error instanceof Error ? error.message : String(error);
  return fail("E_INTERNAL_INCONSISTENT", message);
}
function truncate(text2) {
  return text2.length <= MAX_EVIDENCE ? text2 : `${text2.slice(0, MAX_EVIDENCE)}\u2026`;
}
function notRunReason(item, slow, implemented) {
  if (item.mode === "notrun") return item.notRunReason;
  if (item.mode === "manual") return "MANUAL_REVIEW_REQUIRED";
  if (item.runtime === "slow" && !slow) return "SLOW_CHECK_DISABLED";
  if (!implemented) return "NOT_IMPLEMENTED";
  return item.notRunReason;
}
function designStaleness(implRoot) {
  const planFile = path11.join(implRoot, "compose-plan.json");
  const ownershipFile = path11.join(implRoot, ".impl-gate", "ownership.json");
  try {
    if (!fs12.existsSync(planFile) || !fs12.existsSync(ownershipFile)) return void 0;
    const record = JSON.parse(fs12.readFileSync(ownershipFile, "utf8"));
    const expected = typeof record.plan_sha256 === "string" ? record.plan_sha256 : "";
    if (expected === "") return void 0;
    const actual = createHash5("sha256").update(fs12.readFileSync(planFile)).digest("hex");
    if (actual === expected) return void 0;
    return `compose-plan.json changed after the last materialize (plan sha256 ${actual.slice(0, 12)}\u2026 vs ${expected.slice(0, 12)}\u2026); SPEC.md / checklist / tasks are stale \u2014 run impl_gate_compose mode:"materialize" then impl_gate_init again`;
  } catch {
    return void 0;
  }
}
function implementationEvidence(implRoot) {
  const evidenceFile = path11.join(implRoot, ".impl-gate", "ac-evidence.json");
  try {
    if (!fs12.existsSync(evidenceFile)) return void 0;
    const stored = JSON.parse(fs12.readFileSync(evidenceFile, "utf8"));
    const summary = stored.summary ?? {};
    const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
    const planFile = path11.join(implRoot, "compose-plan.json");
    const current = fs12.existsSync(planFile) ? createHash5("sha256").update(fs12.readFileSync(planFile)).digest("hex") : "";
    let coverage = { declared: 0, recorded: 0, missing: [] };
    if (fs12.existsSync(planFile)) {
      const plan = JSON.parse(fs12.readFileSync(planFile, "utf8"));
      const got = /* @__PURE__ */ new Set();
      for (const item of stored.items ?? []) {
        if (typeof item.id === "string") got.add(item.id);
        if (typeof item.ref === "string") got.add(item.ref);
      }
      const missing = [];
      let declared = 0;
      for (const module of plan.modules ?? []) {
        const moduleId = typeof module.id === "string" ? module.id : "";
        const items = module.acceptance ?? [];
        for (let index = 0; index < items.length; index += 1) {
          const id = items[index]?.id;
          if (typeof id !== "string" || id.length === 0) continue;
          declared += 1;
          const ref = moduleId.length > 0 ? `AC-${moduleId}-${index + 1}` : "";
          if (!got.has(id) && !(ref.length > 0 && got.has(ref))) missing.push(id);
        }
      }
      coverage = { declared, recorded: declared - missing.length, missing };
    }
    return {
      pass: num(summary.pass),
      fail: num(summary.fail),
      skipped: num(summary.skipped),
      total: num(summary.total),
      generatedAt: typeof stored.generatedAt === "string" ? stored.generatedAt : "",
      stale: current !== "" && typeof stored.planSha256 === "string" && stored.planSha256 !== "" && stored.planSha256 !== current,
      coverage
    };
  } catch {
    return void 0;
  }
}
async function runCheck(rawArgs, deps) {
  const startedAt = /* @__PURE__ */ new Date();
  const startedMs = Date.now();
  const args = rawArgs ?? {};
  const graphRootRaw = typeof args.graphRoot === "string" ? args.graphRoot : "";
  if (graphRootRaw.length === 0) return fail("E_ROOT_MISSING", "graphRoot is required");
  const graphRoot = path11.resolve(graphRootRaw);
  try {
    const stat2 = await fs12.promises.stat(graphRoot);
    if (!stat2.isDirectory()) return fail("E_ROOT_MISSING", `graphRoot is not a directory: ${graphRoot}`);
  } catch {
    return fail("E_ROOT_MISSING", `graphRoot does not exist: ${graphRoot}`);
  }
  const config = deps.config;
  const implRootArg = typeof args.implRoot === "string" && args.implRoot.length > 0 ? args.implRoot : "";
  const implRoot = path11.resolve(implRootArg.length > 0 ? implRootArg : config.implRoot.length > 0 ? config.implRoot : graphRoot);
  const slow = args.slow === true || config.slow;
  let checks;
  try {
    checks = loadChecks();
  } catch (error) {
    return fail("E_INTERNAL_INCONSISTENT", error.message);
  }
  const environment = resolveSpecgraphEnv({
    command: config.specgraphCommand,
    pythonPath: config.pythonPath,
    home: config.specgraphCwd,
    startDirs: [graphRoot]
  });
  const runner = {
    argv: environment.argv,
    cwd: environment.cwd,
    env: environment.env,
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
    rememberRun(runId, payload2, reasons2, graphRoot);
    return payload2;
  }
  const checklistArg = typeof args.checklistPath === "string" && args.checklistPath.length > 0 ? args.checklistPath : "";
  const checklistPath = path11.resolve(
    checklistArg.length > 0 ? checklistArg : path11.join(implRoot, ".impl-gate", "checklist.md")
  );
  const checklist = loadChecklist(checklistPath);
  const preGraphHashes = await hashContractFiles(graphRoot);
  const mapPython = (argv) => {
    const mapped = [...argv];
    const head = mapped[0];
    if (head !== void 0 && config.pythonPath.length > 0 && /^python(\d+(?:\.\d+)*)?(\.exe)?$/i.test(path11.basename(head))) {
      mapped[0] = config.pythonPath;
    }
    return mapped;
  };
  const runArgvMapped = (argv, opts) => runProcess(mapPython(argv), { cwd: opts.cwd, env: runner.env, timeoutMs: opts.timeoutMs });
  const runArgv = (argv) => runArgvMapped(argv, { cwd: runner.cwd, timeoutMs: config.timeoutMs });
  const runImpl = (argv) => runArgvMapped(argv, { cwd: implRoot, timeoutMs: 12e4 });
  const ctx = {
    graphRoot,
    implRoot,
    slow,
    timeoutMs: config.timeoutMs,
    checks,
    checklist,
    preGraphHashes,
    specgraphHome: environment.home ?? "",
    allowCommandReplay: config.allowCommandReplay,
    replayBudget: { remaining: 5 },
    run: (specArgs) => runSpecgraph({ argv: runner.argv, cwd: runner.cwd, env: runner.env, timeoutMs: config.timeoutMs }, specArgs),
    runArgv,
    runImpl,
    hashGraph: () => hashContractFiles(graphRoot),
    newTempDir: (prefix) => fs12.promises.mkdtemp(path11.join(os2.tmpdir(), prefix))
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
  const staleDesign = designStaleness(implRoot);
  const implementation = implementationEvidence(implRoot);
  const review2 = reviewSummary(implRoot);
  const consistency = compareReviewAndEvidence(review2, implementation);
  const payload = {
    ...base,
    passed,
    failed,
    notRun,
    evidence,
    durationMs: Date.now() - startedMs,
    ...staleDesign === void 0 ? {} : { designStale: staleDesign },
    ...implementation === void 0 ? {} : { implementation },
    ...review2 === void 0 ? {} : { review: review2 },
    ...consistency === void 0 ? {} : { consistency }
  };
  payload.readiness = distributionReadiness(payload);
  rememberRun(runId, payload, reasons, graphRoot);
  return payload;
}
function compareReviewAndEvidence(review2, implementation) {
  if (review2 === void 0 && implementation === void 0) return void 0;
  const reasons = [];
  if (review2 !== void 0) {
    if (review2.blocked > 0 || review2.blocking > 0) {
      reasons.push(`review round ${review2.round} has ${review2.blocked} blocked module(s), ${review2.blocking} blocking item(s)`);
    }
    if (review2.stale) {
      reasons.push(`review round ${review2.round} was recorded against an older ${review2.staleField === "spec" ? "SPEC.md" : "compose-plan.json"}`);
    }
  }
  if (implementation !== void 0) {
    if (implementation.fail > 0) {
      reasons.push(`implementation evidence has ${implementation.fail} FAIL row(s)`);
    }
    if (implementation.stale) {
      reasons.push("implementation evidence was recorded against an older compose-plan.json");
    }
  }
  if (implementation === void 0 && review2 !== void 0 && review2.blocked === 0 && review2.blocking === 0) {
    reasons.push("review passed but no implementation evidence has been recorded yet");
  }
  return { ok: reasons.length === 0, reasons };
}
function reviewSummary(implRoot) {
  const reviewFile = path11.join(implRoot, ".impl-gate", "review.json");
  try {
    if (!fs12.existsSync(reviewFile)) return void 0;
    const stored = JSON.parse(fs12.readFileSync(reviewFile, "utf8"));
    const rounds = Array.isArray(stored.rounds) ? stored.rounds : [];
    if (rounds.length === 0) return void 0;
    const latest = [...rounds].sort((a, b) => Number(a.round ?? 0) - Number(b.round ?? 0)).at(-1);
    if (latest === void 0) return void 0;
    const summary = latest.summary ?? {};
    const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
    const planFile = path11.join(implRoot, "compose-plan.json");
    const specFile = path11.join(implRoot, "SPEC.md");
    const hashOf2 = (file) => fs12.existsSync(file) ? createHash5("sha256").update(fs12.readFileSync(file)).digest("hex") : "";
    const current = hashOf2(planFile);
    const currentSpec = hashOf2(specFile);
    const storedPlan = typeof latest.planSha256 === "string" ? latest.planSha256 : "";
    const storedSpec = typeof latest.specSha256 === "string" ? latest.specSha256 : "";
    const staleField = current !== "" && storedPlan !== "" && storedPlan !== current ? "plan" : currentSpec !== "" && storedSpec !== "" && storedSpec !== currentSpec ? "spec" : "";
    return {
      round: num(latest.round),
      reviewer: typeof latest.reviewer === "string" ? latest.reviewer : "",
      ready: num(summary.ready),
      clarify: num(summary.clarify),
      blocked: num(summary.blocked),
      blocking: num(summary.blocking),
      stale: staleField !== "",
      staleField
    };
  } catch {
    return void 0;
  }
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
  if (notRun.length > 0) {
    lines.push(`NOT-RUN: ${notRun.join(", ")}`);
    const codeSide = notRun.filter((id) => /^[MQ]\d+$/.test(id)).length;
    if (codeSide > 0) {
      lines.push(`  (${codeSide} of them are implementation-side gate assertions \u2014 this tool does not parse source code, so they stay NOT-RUN by design)`);
    }
  }
  if (payload.graphExitCode !== void 0 && payload.graphExitCode !== 0) {
    lines.push(`graphExitCode=${payload.graphExitCode}, ${(payload.graphIssues ?? []).length} issue(s)`);
  }
  if (payload.designStale !== void 0) lines.push(`stale design: ${payload.designStale}`);
  if (payload.implementation !== void 0) {
    const impl = payload.implementation;
    lines.push(`implementation evidence: PASS ${impl.pass} / FAIL ${impl.fail} / SKIPPED ${impl.skipped} (${impl.total} AC) \u2014 recorded ${impl.generatedAt === "" ? "unknown time" : impl.generatedAt}`);
    const coverage = impl.coverage;
    if (coverage !== void 0 && coverage.declared > 0) {
      const missing = coverage.missing;
      const shown = missing.slice(0, 6).join(", ");
      const tail = missing.length > 6 ? `, +${missing.length - 6} more` : "";
      lines.push(
        `implementation coverage: ${coverage.recorded}/${coverage.declared} AC recorded${missing.length > 0 ? ` \u2014 missing ${shown}${tail}` : ""}`
      );
    }
    if (impl.stale) lines.push("these AC results were produced against an older compose-plan.json; re-run impl_gate_record");
  }
  if (payload.review !== void 0) {
    const review2 = payload.review;
    const reviewer = review2.reviewer === "" ? "(unknown)" : review2.reviewer;
    lines.push(
      `review: round ${review2.round} by ${reviewer} \u2014 ready ${review2.ready} / clarify ${review2.clarify} / blocked ${review2.blocked} (blocking ${review2.blocking})`
    );
    if (review2.stale) {
      const what = review2.staleField === "spec" ? "SPEC.md" : "compose-plan.json";
      lines.push(`this review was recorded against an older ${what}; run impl_gate_review again`);
    }
  }
  if (payload.consistency !== void 0) {
    const { ok, reasons } = payload.consistency;
    if (ok) {
      lines.push("consistency: review and implementation evidence agree");
    } else {
      lines.push(`consistency: ${reasons.length} note(s)`);
      for (const reason of reasons) lines.push(`  - ${reason}`);
    }
  }
  if (payload.readiness !== void 0) {
    const { ok, reasons } = payload.readiness;
    lines.push(ok ? "readiness: ready to hand over" : `readiness: not ready \u2014 ${reasons.length} reason(s)`);
    for (const reason of ok ? [] : reasons) lines.push(`  - ${reason}`);
  }
  return [{ type: "text", text: lines.join("\n") }];
}
function selectRun(rawRoot, rawRunId) {
  const rootArg = typeof rawRoot === "string" ? rawRoot.trim() : "";
  if (rootArg.length === 0) return fail("E_ROOT_MISSING", "root is required");
  const root = path11.resolve(rootArg);
  const runId = typeof rawRunId === "string" && rawRunId.length > 0 ? rawRunId : "";
  if (runId.length > 0) {
    const found = lookupRun(runId, root);
    if (found.kind === "missing") {
      return fail("E_NO_PRIOR_RUN", `no cached run for runId ${runId}`, "Run impl_gate_check first; runs are cached in memory for 10 minutes and under <graphRoot>/.impl-gate/runs for a day.");
    }
    if (found.kind === "expired") {
      return fail("E_RUN_EXPIRED", `run ${runId} is older than the 10 minute TTL`, "Run impl_gate_check again.");
    }
    if (found.record.graphRoot !== normalizeRoot(root)) {
      return fail(
        "E_NO_PRIOR_RUN",
        `run ${runId} was produced for a different root`,
        `cached root: ${found.record.graphRoot}; requested root: ${normalizeRoot(root)}`
      );
    }
    return { record: found.record };
  }
  const latest = latestRunFor(root);
  if (latest.kind === "missing") {
    return fail("E_NO_PRIOR_RUN", `no cached run for root ${root}`, "Run impl_gate_check first; the cache is in-memory and is lost on plugin reload.");
  }
  if (latest.kind === "expired") return fail("E_RUN_EXPIRED", "the cached run is older than the 10 minute TTL");
  return { record: latest.record };
}
var A_IDS = ["A1", "A2", "A3", "A4", "A5"];
function evidenceFor(payload, id) {
  return payload.evidence.find((entry) => entry.id === id)?.text ?? "";
}
function distributionReadiness(payload) {
  const reasons = [];
  if (payload.review === void 0) reasons.push("no review round has been recorded");
  if (payload.implementation === void 0) reasons.push("no implementation evidence has been recorded");
  const coverage = payload.implementation?.coverage;
  if (coverage !== void 0 && coverage.missing.length > 0) {
    const shown = coverage.missing.slice(0, 4).join(", ");
    const tail = coverage.missing.length > 4 ? `, +${coverage.missing.length - 4} more` : "";
    reasons.push(`implementation coverage ${coverage.recorded}/${coverage.declared} \u2014 missing ${shown}${tail}`);
  }
  if (payload.consistency !== void 0) {
    for (const reason of payload.consistency.reasons) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
function buildReport(rawArgs) {
  const args = rawArgs ?? {};
  const selected = selectRun(args.root, args.runId);
  if ("error" in selected) return selected;
  const { payload, reasons } = selected.record;
  let order;
  try {
    order = loadChecks().map((item) => item.id);
  } catch {
    order = [...payload.passed, ...payload.failed, ...payload.notRun];
  }
  const passed = new Set(payload.passed);
  const failed = new Set(payload.failed);
  const notRun = new Set(payload.notRun);
  const checklist = order.map((id) => {
    const status = passed.has(id) ? "PASS" : failed.has(id) ? "FAIL" : "NOT-RUN";
    const reason = status === "NOT-RUN" ? reasons[id] ?? "NOT_IMPLEMENTED" : void 0;
    const row = {
      id,
      status,
      evidence: evidenceFor(payload, id)
    };
    if (reason !== void 0) row.reason = reason;
    return row;
  });
  const uncovered = [...notRun];
  const uncoveredMatches = uncovered.length === notRun.size && uncovered.every((id) => notRun.has(id)) && checklist.length === 32;
  if (!uncoveredMatches) {
    return fail(
      "E_INTERNAL_INCONSISTENT",
      "\u672A\u8986\u76D6\u96C6\u5408\u4E0E NOT-RUN \u96C6\u5408\u4E0D\u76F8\u7B49",
      `uncovered=${uncovered.length}; notRun=${notRun.size}; rows=${checklist.length}`
    );
  }
  return {
    summary: `PASS ${payload.passed.length} / FAIL ${payload.failed.length} / NOT-RUN ${payload.notRun.length} (32)`,
    checklist,
    uncovered,
    readiness: distributionReadiness(payload)
  };
}
function coverageStatement(rows, uncovered) {
  const notRun = rows.filter((row) => row.status === "NOT-RUN").map((row) => row.id);
  const enough = rows.length === 32;
  const equal = enough && notRun.length === uncovered.length && notRun.every((id) => uncovered.includes(id)) && uncovered.every((id) => notRun.includes(id));
  return `\u672A\u8986\u76D6\u96C6\u5408 \u2261 NOT-RUN \u96C6\u5408\uFF08${equal ? "\u76F8\u7B49" : "\u4E0D\u7B49"}\uFF09`;
}
function buildVerifyContract(rawArgs) {
  const args = rawArgs ?? {};
  const selected = selectRun(args.root, args.runId);
  if ("error" in selected) return selected;
  const { payload, reasons } = selected.record;
  const membership = /* @__PURE__ */ new Map();
  for (const id of [...payload.passed, ...payload.failed, ...payload.notRun]) {
    membership.set(id, (membership.get(id) ?? 0) + 1);
  }
  for (const id of A_IDS) {
    if (membership.get(id) !== 1) {
      return fail("E_INTERNAL_INCONSISTENT", `${id} does not appear exactly once in the cached run`);
    }
  }
  const details = A_IDS.map((id) => {
    const status = payload.passed.includes(id) ? "PASS" : payload.failed.includes(id) ? "FAIL" : "NOT-RUN";
    const evidence = evidenceFor(payload, id);
    const reason = status === "NOT-RUN" ? ` reason=${reasons[id] ?? "NOT_IMPLEMENTED"}` : "";
    return `${id} ${status}${reason} \u2014 ${evidence || "(no evidence)"}`;
  });
  const ok = A_IDS.every((id) => payload.passed.includes(id));
  const deliveryIds = ["B1", "B2", "B5", "B7"];
  const deliveryStatus = (id) => payload.passed.includes(id) ? "PASS" : payload.failed.includes(id) ? "FAIL" : "NOT-RUN";
  const delivery = {
    ok: deliveryIds.every((id) => payload.passed.includes(id)),
    checks: deliveryIds.map((id) => ({ id, status: deliveryStatus(id) }))
  };
  return { ok, details, delivery };
}
function renderReport(_args, value) {
  const payload = value;
  if (payload.error !== void 0) {
    return [{ type: "text", text: `impl_gate_report failed: ${payload.error.code} \u2014 ${payload.error.message}` }];
  }
  const lines = [
    payload.summary ?? "",
    coverageStatement(payload.checklist ?? [], payload.uncovered ?? [])
  ];
  const failed = (payload.checklist ?? []).filter((row) => row.status === "FAIL").map((row) => row.id);
  if (failed.length > 0) lines.push(`FAIL: ${failed.join(", ")}`);
  const readiness = payload.readiness;
  if (readiness !== void 0) {
    if (readiness.ok) {
      lines.push("readiness: ready to hand over \u2014 review passed, evidence recorded, no contradiction");
    } else {
      lines.push(`readiness: not ready \u2014 ${readiness.reasons.length} reason(s)`);
      for (const reason of readiness.reasons) lines.push(`- ${reason}`);
    }
  }
  return [{ type: "text", text: lines.filter((line) => line.length > 0).join("\n") }];
}
var REVIEW_RUBRIC = ["\u53EF\u5F00\u5DE5", "\u9700\u6F84\u6E05", "\u4E0D\u53EF\u5F00\u5DE5"];
function composeReview(outDir) {
  const root = path11.resolve(outDir);
  const specPath = path11.join(root, "SPEC.md");
  const prompt = [
    `\u4F60\u662F\u8FD9\u4EFD\u8BBE\u8BA1\u6587\u6863\u7684\u72EC\u7ACB\u8BC4\u5BA1\u8005\u3002\u53EA\u8BFB ${specPath}\uFF0C\u4E0D\u8981\u8BFB compose-plan.json\u3001tasks/ \u6216\u4EFB\u4F55\u5B9E\u73B0\u4EE3\u7801\u2014\u2014\u90A3\u4E9B\u4F1A\u66FF\u6587\u6863\u56DE\u7B54\u5B83\u6CA1\u5199\u7684\u4E1C\u897F\u3002`,
    "\u5BF9\u6BCF\u4E00\u4E2A\u6A21\u5757\u7ED9\u4E09\u6001\u5224\u5B9A\uFF1A\u53EF\u5F00\u5DE5 / \u9700\u6F84\u6E05 / \u4E0D\u53EF\u5F00\u5DE5\u3002\u5224\u5B9A\u6807\u51C6\uFF1A\u53EF\u5F00\u5DE5 = \u5B9E\u65BD\u8005\u4E0D\u7528\u518D\u95EE\u4EFB\u4F55\u4EBA\u5C31\u80FD\u52A8\u624B\uFF1B\u9700\u6F84\u6E05 = \u5F00\u5DE5\u4F1A\u4E0A\u95EE\u4E00\u53E5\u5373\u53EF\uFF1B\u4E0D\u53EF\u5F00\u5DE5 = \u7167\u6587\u6863\u5199\u4E0D\u51FA\u6765\u3002",
    "\u300C\u9700\u6F84\u6E05\u300D\u300C\u4E0D\u53EF\u5F00\u5DE5\u300D\u5FC5\u987B\u5199\u6E05\u7F3A\u4EC0\u4E48\uFF1B\u8BC1\u636E\u4E00\u5F8B\u5199\u6210 SPEC.md:<\u884C\u53F7>\uFF0C\u4E0D\u8981\u5199\u300C\u7B2C 3 \u8282\u300D\u8FD9\u7C7B\u6A21\u7CCA\u4F4D\u7F6E\u3002",
    "\u91CD\u70B9\u67E5\u81EA\u76F8\u77DB\u76FE\u4E0E\u7559\u767D\uFF1A\u540C\u4E00\u6982\u5FF5\u662F\u5426\u53EA\u6709\u4E00\u4E2A\u540D\u5B57\uFF1B\u58F0\u660E\u5FC5\u586B\u7684\u5B57\u6BB5\u5728 AC \u91CC\u662F\u5426\u771F\u4F20\uFF1B\u6210\u529F\u72B6\u6001\u7801\u3001\u6392\u5E8F\u3001\u7F3A\u7701\u503C\u3001\u65F6\u533A\u662F\u5426\u5199\u6B7B\uFF1B\u6563\u6587\u4E0E\u7C7B\u578B\u8868\u3001http \u8868\u662F\u5426\u5BF9\u5F97\u4E0A\u3002",
    "\u518D\u9010\u6761\u8FC7\u4E00\u904D\u300C\u6C89\u9ED8\u6E05\u5355\u300D\u2014\u2014\u8FD9\u4E9B\u673A\u5668\u67E5\u4E0D\u51FA\u3001\u53EA\u80FD\u9760\u4F60\u8BFB\u51FA\u6765\uFF0C\u547D\u4E2D\u5C31\u5199\u8FDB\u300C\u9700\u6F84\u6E05\u300D\u5E76\u7ED9\u884C\u53F7\uFF1A",
    "1. \u6BCF\u4E2A\u6570\u503C\u5B57\u6BB5\u6709\u5355\u4F4D\u5417\uFF1F\u540C\u4E00\u4E2A\u5B57\u6BB5\u540D\u5728\u4E0D\u540C\u7C7B\u578B\u91CC\u5355\u4F4D\u4E00\u81F4\u5417\uFF1F\uFF08\u5982\u5E93\u5B58\u300C\u7247\u300Dvs\u300C\u76D2\u300D\uFF09",
    "2. \u6BCF\u4E2A\u53EF\u9009\u53C2\u6570/\u5B57\u6BB5\u5199\u4E86\u7F3A\u7701\u503C\u3001\u4E0A\u9650\u3001\u8D8A\u754C\u884C\u4E3A\u5417\uFF1F",
    "3. \u6BCF\u4E2A\u5217\u8868\u63A5\u53E3\u5199\u4E86\u6392\u5E8F\u5417\uFF1F\u5206\u9875\u7684 total \u662F\u622A\u65AD\u524D\u8FD8\u662F\u622A\u65AD\u540E\uFF1Fpage \u4ECE 0 \u8FD8\u662F 1 \u5F00\u59CB\uFF1F",
    "4. \u6BCF\u4E2A\u6210\u529F\u54CD\u5E94\u5199\u4E86\u72B6\u6001\u7801\u5417\uFF1F\u975E 2xx \u7684\u9519\u8BEF\u4F53\u662F\u540C\u4E00\u5F62\u72B6\u5417\uFF08code/message/details\uFF09\uFF1F",
    "5. \u65F6\u95F4\u5199\u6B7B\u5728\u54EA\u4E00\u5C42\uFF1F\u65E5\u671F\u5B57\u7B26\u4E32\u662F\u672C\u5730\u65F6\u95F4\u8FD8\u662F UTC\uFF1F\u8DE8\u65F6\u533A/\u8DE8\u590F\u4EE4\u65F6\u600E\u4E48\u7B97\uFF1F",
    "6. \u300C\u4E0D\u5B58\u5728\u300D\u300C\u5DF2\u8F6F\u5220\u300D\u300C\u5DF2\u88AB\u6539\u8FC7\u300D\u5206\u522B\u8FD4\u56DE\u54EA\u4E2A\u7801\uFF1F\u5224\u65AD\u987A\u5E8F\u662F\u4EC0\u4E48\uFF1F",
    "7. \u4E00\u6B21\u8BF7\u6C42\u91CC\u591A\u5904\u5199\u5E93\u65F6\uFF0C\u4E8B\u52A1\u8FB9\u754C\u5728\u54EA\uFF1F\u8C01\u5F00\u3001\u8C01\u63D0\u4EA4\u3001\u5931\u8D25\u600E\u4E48\u56DE\u6EDA\uFF1F",
    "8. \u91CD\u590D\u63D0\u4EA4\u540C\u4E00\u8BF7\u6C42\u4F1A\u600E\u6837\uFF08\u5E42\u7B49\u952E\u662F\u4EC0\u4E48\uFF09\uFF1F\u5E76\u53D1\u540C\u4E00\u8D44\u6E90\u65F6\u8C01\u8D62\uFF1F",
    "9. \u81EA\u7531\u6587\u672C\u5B57\u6BB5\u7684\u957F\u5EA6\u4E0A\u9650\u662F\u591A\u5C11\uFF1F\u8D85\u8FC7\u65F6\u62A5\u54EA\u4E2A\u7801\uFF1F",
    "10. \u8DE8\u6A21\u5757\u8C03\u7528\u662F\u5355\u6761\u8FD8\u662F\u6279\u91CF\uFF1F\u6279\u91CF\u90E8\u5206\u5931\u8D25\u65F6\u8FD4\u56DE\u4EC0\u4E48\uFF1F",
    "11. \u6BCF\u4E2A\u9875\u9762/\u89C6\u56FE\u7684\u6570\u636E\u4ECE\u54EA\u4E2A\u63A5\u53E3\u6765\uFF1F\u7A7A\u6001\u4E0E\u9519\u8BEF\u6001\u663E\u793A\u4EC0\u4E48\uFF1F",
    "12. \u6846\u67B6/\u8FD0\u884C\u65F6\u7248\u672C\u3001\u6D4B\u8BD5\u547D\u4EE4\u4E0E\u8FD0\u884C\u65B9\u5F0F\uFF08vitest / node:test\uFF09\u843D\u5B57\u4E86\u5417\uFF1F",
    "\u901A\u8FC7\u7EBF\u662F blocked = 0 \u4E14 blocking = 0\uFF08\u4E0D\u8981\u6C42 100% \u53EF\u5F00\u5DE5\uFF09\uFF1B\u6BCF\u8F6E\u53EA\u6838\u4E0A\u4E00\u8F6E\u7684 blocking \u662F\u5426\u6E05\u96F6\uFF0C\u5916\u52A0\u6709\u6CA1\u6709\u65B0\u5F15\u5165\u7684\u77DB\u76FE\u3002",
    `\u628A\u5224\u5B9A\u5199\u56DE\uFF1A\u8C03\u7528 impl_gate_review\uFF0CoutDir = ${root}\uFF0Creviewer \u5199\u4F60\u7684\u6807\u8BC6\u5E76\u6CE8\u660E\u300C\u53EA\u8BFB SPEC.md\u300D\u3002`
  ].join("\n");
  return {
    playbook: path11.resolve(path11.dirname(fileURLToPath2(import.meta.url)), "..", "playbooks", "review.md"),
    specPath,
    rubric: [...REVIEW_RUBRIC],
    prompt
  };
}
async function buildCompose(rawArgs, config) {
  const args = rawArgs ?? {};
  const outDirRaw = typeof args.outDir === "string" ? args.outDir.trim() : "";
  if (outDirRaw.length === 0) return fail("E_OUT_DIR_REQUIRED", "outDir is required");
  const mode = args.mode === "materialize" ? "materialize" : args.mode === "draft" ? "draft" : "plan";
  if (mode === "materialize") {
    const toolHome = typeof args.specgraphCwd === "string" ? args.specgraphCwd.trim() : "";
    const materializeConfig = toolHome.length > 0 ? { ...config, specgraphCwd: toolHome } : config;
    const outcome = await materializePlan(outDirRaw, materializeConfig);
    if (outcome.ok) {
      return {
        ok: true,
        mode: "materialize",
        planPath: path11.join(path11.resolve(outDirRaw), "compose-plan.json"),
        draftPath: "",
        missingSlots: [],
        problems: [],
        review: composeReview(outDirRaw),
        graphRoot: outcome.graphRoot,
        specMd: outcome.specMd,
        packageMd: outcome.packageMd,
        manifestPath: outcome.manifestPath,
        files: outcome.files,
        waves: outcome.waves,
        overlaps: outcome.overlaps,
        planSha256: outcome.planSha256,
        checklistPreserved: outcome.checklistPreserved,
        ...outcome.checklistBackupPath === void 0 ? {} : { checklistBackupPath: outcome.checklistBackupPath },
        ...outcome.tasksRefreshed === void 0 ? {} : { tasksRefreshed: outcome.tasksRefreshed },
        warnings: outcome.warnings
      };
    }
    const failure5 = {
      error: {
        code: outcome.code,
        message: outcome.message,
        ...outcome.detail === void 0 ? {} : { detail: outcome.detail }
      }
    };
    if (outcome.problems !== void 0) failure5.problems = outcome.problems;
    if (outcome.issues !== void 0) failure5.issues = outcome.issues;
    if (outcome.graphExitCode !== void 0) failure5.graphExitCode = outcome.graphExitCode;
    return failure5;
  }
  const outDir = path11.resolve(outDirRaw);
  const planPath = path11.join(outDir, "compose-plan.json");
  const draftPath = path11.join(outDir, "SPEC-DRAFT.md");
  const requirement = typeof args.requirement === "string" ? args.requirement : void 0;
  let existingPlan;
  try {
    existingPlan = JSON.parse(await fs12.promises.readFile(planPath, "utf8"));
  } catch (error) {
    const code = error.code;
    if (code !== "ENOENT") return failureFrom(error);
  }
  await fs12.promises.mkdir(outDir, { recursive: true });
  if (mode === "draft") {
    const source = existingPlan ?? emptyPlan({
      name: typeof args.name === "string" ? args.name : void 0,
      stack: typeof args.stack === "string" ? args.stack : void 0
    });
    await fs12.promises.writeFile(draftPath, renderDraft({ plan: source, requirement }), "utf8");
    return {
      ok: true,
      mode: "draft",
      planPath: existingPlan === void 0 ? "" : planPath,
      draftPath,
      missingSlots: missingSlots(source),
      problems: [],
      review: composeReview(outDir)
    };
  }
  if (existingPlan !== void 0 && args.overwrite !== true) {
    return fail(
      "E_PLAN_EXISTS",
      `compose-plan.json already exists: ${planPath}`,
      'use mode:"draft" to refresh SPEC-DRAFT.md without touching the plan, or overwrite:true to reset the plan (a timestamped backup is written first)'
    );
  }
  const template = emptyPlan({
    name: typeof args.name === "string" ? args.name : void 0,
    stack: typeof args.stack === "string" ? args.stack : void 0
  });
  let backupPath = "";
  if (existingPlan !== void 0) {
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
    backupPath = path11.join(outDir, `compose-plan.backup-${stamp}.json`);
    await fs12.promises.rename(planPath, backupPath);
  }
  await fs12.promises.writeFile(planPath, `${JSON.stringify(template, null, 2)}
`, "utf8");
  await fs12.promises.writeFile(draftPath, renderDraft({ plan: template, requirement }), "utf8");
  return {
    ok: true,
    mode: "plan",
    planPath,
    draftPath,
    missingSlots: missingSlots(template),
    problems: [],
    review: composeReview(outDir),
    ...backupPath === "" ? {} : { backupPath }
  };
}
function buildInit(rawArgs) {
  const args = rawArgs ?? {};
  const outDir = typeof args.outDir === "string" ? args.outDir.trim() : "";
  if (outDir.length === 0) {
    return { ok: false, error: { code: "E_ROOT_MISSING", message: "outDir is required" } };
  }
  const implRoot = typeof args.implRoot === "string" ? args.implRoot : "";
  const overwrite = args.overwrite === true;
  return initTasks(outDir, { implRoot, overwrite });
}
function renderInit(_args, value) {
  const payload = value;
  if (payload.ok !== true) {
    const error = payload.error;
    return [{ type: "text", text: `impl_gate_init failed: ${error?.code ?? ""} \u2014 ${error?.message ?? ""}` }];
  }
  const lines = [
    `impl_gate_init: ${payload.tasksDir ?? ""}`,
    `cards (${payload.cards?.length ?? 0}): ${(payload.cards ?? []).map((card) => `${card.moduleId} ${card.cardPath}`).join(", ")}`,
    `files (${payload.filesWritten?.length ?? 0})`
  ];
  for (const wave of payload.waves ?? []) {
    lines.push(`wave ${wave.index}: ${wave.modules.join(", ")}${wave.dependsOn.length > 0 ? ` (after ${wave.dependsOn.join(", ")})` : ""}`);
  }
  if ((payload.overlaps ?? []).length > 0) {
    lines.push(`overlaps: ${(payload.overlaps ?? []).map((entry) => `${entry.a}/${entry.b}: ${entry.files.join(", ")}`).join(" | ")}`);
  }
  return [{ type: "text", text: lines.join("\n") }];
}
function reviewLine(review2) {
  if (review2 === void 0) return "review: not available";
  return `review: ${review2.playbook} | spec: ${review2.specPath} | rubric: ${review2.rubric.join("/")}`;
}
function renderCompose(_args, value) {
  const payload = value;
  if (payload.error !== void 0) {
    const lines2 = [`impl_gate_compose failed: ${payload.error.code} \u2014 ${payload.error.message}`];
    if (payload.problems !== void 0 && payload.problems.length > 0) {
      lines2.push(`problems (${payload.problems.length}):`);
      for (const entry of payload.problems) lines2.push(`- ${entry.path || "/"}: ${entry.message}`);
    }
    if (payload.issues !== void 0 && payload.issues.length > 0) {
      lines2.push(`graph issues (${payload.issues.length}, unchanged from specgraph):`);
      for (const issue of payload.issues) lines2.push(`- ${JSON.stringify(issue)}`);
    }
    if (payload.error.detail !== void 0) lines2.push(payload.error.detail);
    return [{ type: "text", text: lines2.join("\n") }];
  }
  if (payload.mode === "materialize") {
    const waves = (payload.waves ?? []).map((wave) => `wave ${wave.index}: ${wave.modules.join(", ")}`).join(" | ");
    const overlaps = payload.overlaps ?? [];
    const lines2 = [
      `impl_gate_compose materialize: ${payload.graphRoot ?? ""}`,
      `spec: ${payload.specMd ?? ""}`,
      `package: ${payload.packageMd ?? ""}`,
      `manifest: ${payload.manifestPath ?? ""}`,
      `files (${payload.files?.length ?? 0}): ${(payload.files ?? []).join(", ")}`,
      waves.length > 0 ? waves : "waves: none",
      reviewLine(payload.review)
    ];
    if (overlaps.length > 0) {
      lines2.push(`overlaps (${overlaps.length}): ${overlaps.map((entry) => `${entry.a}/${entry.b}: ${entry.files.join(", ")}`).join(" | ")}`);
    }
    if ((payload.tasksRefreshed ?? []).length > 0) {
      lines2.push(`tasks: refreshed ${payload.tasksRefreshed?.length ?? 0} card file(s) from the same plan`);
    }
    if ((payload.checklistPreserved ?? []).length > 0) {
      const backup = payload.checklistBackupPath === void 0 ? "" : `; previous checklist at ${payload.checklistBackupPath}`;
      lines2.push(`checklist: preserved ${payload.checklistPreserved?.length ?? 0} filled row(s)${backup}`);
    }
    for (const warning of payload.warnings ?? []) {
      lines2.push(`warning ${warning.code} (${warning.count}): ${warning.items.join(", ")}`);
    }
    const prompt = payload.review?.prompt ?? "";
    if (prompt.length > 0) {
      lines2.push("review prompt (paste to the reviewer as-is):");
      for (const line of prompt.split("\n")) lines2.push(`  ${line}`);
    }
    return [{ type: "text", text: lines2.join("\n") }];
  }
  const slots = payload.missingSlots ?? [];
  const lines = payload.mode === "draft" ? [`impl_gate_compose draft: ${payload.draftPath ?? ""}`] : [`impl_gate_compose ${payload.mode ?? ""}: ${payload.planPath ?? ""}`, `draft: ${payload.draftPath ?? ""}`];
  if (payload.mode === "draft") {
    lines.push(
      payload.planPath === "" ? "note: no compose-plan.json yet; draft rendered from an empty template" : "note: SPEC-DRAFT.md refreshed from the existing plan; the plan was not touched"
    );
  }
  if (payload.backupPath !== void 0) lines.push(`previous plan moved to: ${payload.backupPath}`);
  lines.push(slots.length === 0 ? "missingSlots: none" : `missingSlots (${slots.length}): ${slots.join(" | ")}`);
  lines.push(reviewLine(payload.review));
  return [{ type: "text", text: lines.join("\n") }];
}
function renderVerify(_args, value) {
  const payload = value;
  if (payload.error !== void 0) {
    return [{ type: "text", text: `impl_gate_verify_contract failed: ${payload.error.code} \u2014 ${payload.error.message}` }];
  }
  const lines = [`ok=${payload.ok === true}`];
  for (const detail of payload.details ?? []) lines.push(detail);
  const delivery = payload.delivery;
  if (delivery !== void 0) {
    const parts = delivery.checks.map((check) => `${check.id} ${check.status}`).join(" / ");
    lines.push(`delivery contract: ${parts}`);
    lines.push(delivery.ok ? "delivery: ok" : "delivery: not ok \u2014 the list above names what is missing");
  }
  return [{ type: "text", text: lines.join("\n") }];
}
var reportOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    checklist: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          evidence: { type: "string" },
          reason: { type: "string" }
        },
        required: ["id", "status", "evidence"],
        additionalProperties: false
      }
    },
    uncovered: { type: "array", items: { type: "string" } },
    readiness: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
        reasons: { type: "array", items: { type: "string" } }
      },
      required: ["ok", "reasons"]
    },
    error: errorSchema
  }
};
var verifyOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    details: { type: "array", items: { type: "string" } },
    delivery: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
        checks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { id: { type: "string" }, status: { type: "string" } },
            required: ["id", "status"]
          }
        }
      },
      required: ["ok", "checks"]
    },
    error: errorSchema
  }
};
var runSelectorParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    root: { type: "string", description: "\u68C0\u67E5\u6839\uFF08graphRoot\uFF09\u7684\u7EDD\u5BF9\u8DEF\u5F84\u3002\u5FC5\u586B\u3002" },
    runId: { type: "string", description: "\u524D\u6B21 impl_gate_check \u7684 runId\uFF1B\u7F3A\u7701\u53D6\u8BE5\u6839\u6700\u8FD1\u4E00\u6B21\u8FD0\u884C\u3002" }
  },
  required: ["root"]
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
    designStale: { type: "string" },
    implementation: {
      type: "object",
      additionalProperties: false,
      properties: {
        pass: { type: "number" },
        fail: { type: "number" },
        skipped: { type: "number" },
        total: { type: "number" },
        generatedAt: { type: "string" },
        stale: { type: "boolean" },
        coverage: {
          type: "object",
          additionalProperties: false,
          properties: {
            declared: { type: "number" },
            recorded: { type: "number" },
            missing: { type: "array", items: { type: "string" } }
          },
          required: ["declared", "recorded", "missing"]
        }
      },
      required: ["pass", "fail", "skipped", "total", "generatedAt", "stale"]
    },
    review: {
      type: "object",
      additionalProperties: false,
      properties: {
        round: { type: "number" },
        reviewer: { type: "string" },
        ready: { type: "number" },
        clarify: { type: "number" },
        blocked: { type: "number" },
        blocking: { type: "number" },
        stale: { type: "boolean" },
        staleField: { type: "string" }
      },
      required: ["round", "reviewer", "ready", "clarify", "blocked", "blocking", "stale", "staleField"]
    },
    consistency: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
        reasons: { type: "array", items: { type: "string" } }
      },
      required: ["ok", "reasons"]
    },
    readiness: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
        reasons: { type: "array", items: { type: "string" } }
      },
      required: ["ok", "reasons"]
    },
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
var composeParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    outDir: { type: "string", description: "\u8F93\u51FA\u76EE\u5F55\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF09\u3002plan \u6A21\u5F0F\u53EA\u4F1A\u5199\u5165 compose-plan.json \u4E0E SPEC-DRAFT.md\u3002" },
    requirement: { type: "string", description: "\u9700\u6C42\u539F\u6587\uFF0C\u5199\u8FDB SPEC-DRAFT.md \u6587\u9996\uFF0C\u4F9B\u6A21\u578B\u8865\u69FD\u65F6\u5BF9\u7167\u3002" },
    name: { type: "string", description: "\u8F93\u51FA\u76EE\u5F55\u540D/\u9879\u76EE\u540D\uFF0C\u9700\u5339\u914D ^[a-z][a-z0-9-]{1,40}$\uFF1B\u7F3A\u7701 my-app\u3002" },
    stack: { type: "string", description: '\u6280\u672F\u6808\u63CF\u8FF0\uFF0C\u4F8B\u5982 "node22+fastify+react+pg"\u3002' },
    mode: {
      type: "string",
      enum: ["plan", "draft", "materialize"],
      description: "plan=\u9996\u6B21\u5199\u7A7A\u69FD\u6A21\u677F\u4E0E\u8349\u7A3F\uFF08\u5DF2\u6709 plan \u65F6\u62D2\u7EDD\uFF0C\u9664\u975E overwrite:true\uFF09\uFF1Bdraft=\u53EA\u6309\u73B0\u6709 plan \u5237\u65B0 SPEC-DRAFT.md\uFF0C\u7EDD\u4E0D\u6539 plan\uFF1Bmaterialize=\u7269\u5316\u56FE\u8C31\u4E0E\u4E5D\u8282 SPEC.md\u3002"
    },
    overwrite: {
      type: "boolean",
      description: "plan \u6A21\u5F0F\uFF1A\u5DF2\u6709 compose-plan.json \u65F6\u5141\u8BB8\u91CD\u7F6E\uFF08\u5148\u5199\u65F6\u95F4\u6233\u5907\u4EFD\uFF09\u3002materialize \u4E0D\u53D7\u5F71\u54CD\u3002\u9ED8\u8BA4 false\u3002"
    },
    specgraphCwd: {
      type: "string",
      description: "\u672C\u6B21\u8C03\u7528\u8986\u76D6\u914D\u7F6E\u91CC\u7684 specgraphCwd\uFF08spec-graph \u6E90\u7801\u76EE\u5F55\uFF09\uFF1B\u7F3A\u7701\u6309\u914D\u7F6E\u3001\u5411\u4E0A\u67E5\u627E\u3001SPECGRAPH_HOME \u4F9D\u6B21\u89E3\u6790\u3002"
    }
  },
  required: ["outDir", "mode"]
};
var composeOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    mode: { type: "string" },
    planPath: { type: "string" },
    draftPath: { type: "string" },
    missingSlots: { type: "array", items: { type: "string" } },
    problems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string" },
          path: { type: "string" },
          message: { type: "string" }
        },
        required: ["code", "path", "message"],
        additionalProperties: false
      }
    },
    graphRoot: { type: "string" },
    specMd: { type: "string" },
    review: {
      type: "object",
      additionalProperties: false,
      properties: {
        playbook: { type: "string" },
        specPath: { type: "string" },
        rubric: { type: "array", items: { type: "string" } },
        prompt: { type: "string" }
      },
      required: ["playbook", "specPath", "rubric", "prompt"]
    },
    packageMd: { type: "string" },
    manifestPath: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    backupPath: { type: "string" },
    planSha256: { type: "string" },
    checklistPreserved: { type: "array", items: { type: "string" } },
    checklistBackupPath: { type: "string" },
    tasksRefreshed: { type: "array", items: { type: "string" } },
    warnings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string" },
          count: { type: "number" },
          items: { type: "array", items: { type: "string" } }
        },
        required: ["code", "count", "items"],
        additionalProperties: false
      }
    },
    waves: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number" },
          modules: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "string" } }
        },
        required: ["index", "modules", "dependsOn"],
        additionalProperties: false
      }
    },
    overlaps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "string" },
          files: { type: "array", items: { type: "string" } }
        },
        required: ["a", "b", "files"],
        additionalProperties: false
      }
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          level: { type: "string" },
          code: { type: "string" },
          node: { type: "string" },
          section: { type: "string" },
          item: { type: "string" },
          message: { type: "string" },
          fix: { type: "string" },
          file: { type: "string" },
          line: { type: "number" }
        },
        additionalProperties: false
      }
    },
    graphExitCode: { type: "number" },
    error: errorSchema
  }
};
var reviewParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    outDir: { type: "string", description: "\u542B compose-plan.json \u4E0E SPEC.md \u7684\u9879\u76EE\u76EE\u5F55\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF09\u3002" },
    reviewer: { type: "string", description: "\u8BC4\u5BA1\u8005\u6807\u8BC6\uFF08\u4EBA\u6216\u8005\u5B50\u667A\u80FD\u4F53 id\uFF09\uFF0C\u5199\u8FDB review.json \u4F5C\u4E3A\u8BC1\u636E\u3002" },
    round: { type: "number", description: "\u8F6E\u6B21\uFF1B\u7F3A\u7701 = \u5DF2\u6709\u8F6E\u6B21 + 1\u3002\u540C\u4E00\u8F6E\u91CD\u590D\u63D0\u4EA4\u4F1A\u88AB\u62D2\u7EDD\u3002" },
    verdicts: {
      type: "array",
      description: "\u6BCF\u4E2A\u6A21\u5757\u4E00\u6761\uFF1Aready=\u80FD\u76F4\u63A5\u5F00\u5DE5\uFF0Cclarify=\u5F00\u5DE5\u4F1A\u4E0A\u95EE\u4E00\u53E5\u5C31\u80FD\u5F00\u5DE5\uFF0Cblocked=\u7167\u6587\u6863\u5199\u4E0D\u51FA\u6765\u3002",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          module: { type: "string", description: "\u6A21\u5757 id\uFF0C\u5FC5\u987B\u5B58\u5728\u4E8E plan\u3002" },
          status: { type: "string", enum: ["ready", "clarify", "blocked"] },
          note: { type: "string", description: "\u4E00\u53E5\u8BDD\u7406\u7531\u3002" },
          blocking: { type: "array", items: { type: "string" }, description: "blocked \u65F6\u5FC5\u987B\u7ED9\u51FA\u5177\u4F53\u7F3A\u53E3\u3002" },
          evidence: { type: "string", description: '\u7406\u7531\u5728 SPEC.md \u7684\u4F4D\u7F6E\uFF0C\u5F62\u5982 "SPEC.md:412"\u3002' }
        },
        required: ["module", "status"]
      }
    }
  },
  required: ["outDir", "reviewer", "verdicts"]
};
var reviewOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    reviewPath: { type: "string" },
    round: { type: "number" },
    ready: { type: "number" },
    clarify: { type: "number" },
    blocked: { type: "number" },
    blocking: { type: "number" },
    total: { type: "number" },
    planSha256: { type: "string" },
    specSha256: { type: "string" },
    blockingDelta: { type: "number" },
    error: {
      type: "object",
      additionalProperties: false,
      properties: { code: { type: "string" }, message: { type: "string" }, detail: { type: "string" } },
      required: ["code", "message"]
    }
  },
  required: ["ok"]
};
function renderReview(_args, value) {
  const payload = value;
  if (payload.error !== void 0 && payload.ok !== true) {
    return [{ type: "text", text: `impl_gate_review failed: ${payload.error.code} \u2014 ${payload.error.message}` }];
  }
  const lines = [
    `impl_gate_review: round ${payload.round ?? 0} recorded at ${payload.reviewPath ?? ""}`,
    `verdicts: ready ${payload.ready ?? 0} / clarify ${payload.clarify ?? 0} / blocked ${payload.blocked ?? 0} (of ${payload.total ?? 0} modules)`,
    `blocking items: ${payload.blocking ?? 0}`
  ];
  const planSha = (payload.planSha256 ?? "").slice(0, 12);
  const specSha = (payload.specSha256 ?? "").slice(0, 12);
  if (planSha !== "") {
    lines.push(`plan sha256: ${planSha}${specSha === "" ? "\uFF08SPEC.md \u5C1A\u672A\u7269\u5316\uFF09" : ` / spec sha256: ${specSha}`}`);
  }
  if (payload.blockingDelta !== void 0) {
    const verb = payload.blockingDelta > 0 ? "\u51CF\u5C11" : payload.blockingDelta < 0 ? "\u589E\u52A0" : "\u4E0D\u53D8";
    lines.push(`blocking vs \u4E0A\u4E00\u8F6E: ${verb} ${Math.abs(payload.blockingDelta)}`);
  }
  if ((payload.blocked ?? 0) > 0 || (payload.blocking ?? 0) > 0) {
    lines.push("\u8FD9\u6761\u8BC4\u5BA1\u672A\u8FC7\u7EBF\uFF1Ablocked \u6216 blocking>0 \u65F6\u5148\u6539 plan \u518D\u91CD\u8DD1 materialize\uFF0C\u4E0D\u8981\u5F00\u59CB\u5B9E\u73B0\u3002");
  } else {
    lines.push("\u8BC4\u5BA1\u8FC7\u7EBF\uFF1A\u53EF\u4EE5\u8FDB\u5165 impl_gate_init \u5206\u53D1\u3002");
  }
  return [{ type: "text", text: lines.join("\n") }];
}
var review = {
  name: "impl_gate_review",
  description: 'Record one review round of a generated SPEC.md into <outDir>/.impl-gate/review.json. A reviewer (human or another agent) marks every module ready / clarify / blocked with reasons, optionally citing where the reason can be read ("SPEC.md:<line>"). Each round also records the sha256 of compose-plan.json and SPEC.md, so later rounds can be proven to judge the same document, and reports how blocking moved versus the previous round. It appends rounds and never edits the plan, SPEC.md or the graph; use it before impl_gate_init so the "can we start?" judgement is evidence instead of chat history. The pass line is blocking = 0.',
  parameters: reviewParameters,
  output: { schema: reviewOutputSchema, render: renderReview },
  async execute(args) {
    const input = args ?? {};
    if (typeof input.outDir !== "string" || input.outDir.trim() === "") {
      return { ok: false, error: { code: "E_ROOT_MISSING", message: "outDir is required" } };
    }
    if (typeof input.reviewer !== "string") {
      return { ok: false, error: { code: "REVIEW_INVALID", message: "reviewer is required" } };
    }
    return await recordReview(input.outDir, {
      reviewer: input.reviewer,
      ...input.round === void 0 ? {} : { round: input.round },
      verdicts: Array.isArray(input.verdicts) ? input.verdicts : []
    });
  }
};
var recordParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    outDir: { type: "string", description: "\u542B compose-plan.json \u7684\u9879\u76EE\u76EE\u5F55\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF09\u3002" },
    implRoot: { type: "string", description: "\u547D\u4EE4\u7684\u6267\u884C\u76EE\u5F55\uFF0C\u7F3A\u7701\u7B49\u4E8E outDir\u3002" },
    modules: { type: "array", items: { type: "string" }, description: "\u53EA\u8DD1\u8FD9\u4E9B\u6A21\u5757\u7684\u9A8C\u6536\uFF1B\u7F3A\u7701=\u5168\u90E8\u3002" },
    timeoutMs: { type: "number", description: "\u5355\u6761\u547D\u4EE4\u8D85\u65F6\u6BEB\u79D2\uFF0C\u7F3A\u7701 120000\u3002" },
    dryRun: { type: "boolean", description: "true=\u53EA\u767B\u8BB0\u5C06\u8981\u6267\u884C\u7684\u547D\u4EE4\uFF0C\u4E0D\u771F\u6B63\u6267\u884C\u3002" }
  },
  required: ["outDir"]
};
var recordOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    evidencePath: { type: "string" },
    planSha256: { type: "string" },
    summary: {
      type: "object",
      additionalProperties: false,
      properties: {
        pass: { type: "number" },
        fail: { type: "number" },
        skipped: { type: "number" },
        total: { type: "number" }
      },
      required: ["pass", "fail", "skipped", "total"]
    },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          module: { type: "string" },
          command: { type: "string" },
          status: { type: "string" },
          exitCode: { type: "number" },
          durationMs: { type: "number" },
          tail: { type: "string" },
          reason: { type: "string" }
        },
        required: ["id", "module", "command", "status", "exitCode", "durationMs", "tail"]
      }
    },
    error: errorSchema
  },
  required: ["ok"]
};
function renderRecord(_args, value) {
  const payload = value;
  if (payload.error !== void 0 && payload.ok !== true) {
    return [{ type: "text", text: `impl_gate_record failed: ${payload.error.code} \u2014 ${payload.error.message}` }];
  }
  const summary = payload.summary;
  const items = payload.items ?? [];
  const failed = items.filter((item) => item.status === "FAIL");
  const lines = [
    `impl_gate_record: PASS ${summary?.pass ?? 0} / FAIL ${summary?.fail ?? 0} / SKIPPED ${summary?.skipped ?? 0} (total ${summary?.total ?? 0})`,
    `evidence: ${payload.evidencePath ?? ""}`,
    `plan sha256: ${(payload.planSha256 ?? "").slice(0, 12)}`
  ];
  if (failed.length > 0) {
    lines.push(`failed (${failed.length}):`);
    for (const item of failed.slice(0, 5)) {
      const firstLine = item.tail === "" ? "" : ` :: ${item.tail.split(/\r?\n/)[0]}`;
      lines.push(`- ${item.id} (${item.module}) exit ${item.exitCode}${firstLine}`);
    }
    lines.push("\u5931\u8D25\u7684\u65AD\u8A00\u8981\u4FEE\u5B9E\u73B0\u6216\u4FEE\u6587\u6863\uFF1B\u628A\u5B83\u8D34\u56DE plan \u7684 acceptance \u91CC\uFF0C\u4E0D\u8981\u53EA\u7559\u5728\u804A\u5929\u91CC\u3002");
  } else if ((summary?.skipped ?? 0) > 0) {
    lines.push("\u6CA1\u6709\u5931\u8D25\uFF0C\u4F46\u6709\u672A\u6267\u884C\u7684\u65AD\u8A00\uFF1AdryRun\u3001\u7F3A\u547D\u4EE4\uFF0C\u6216\u547D\u4EE4\u9996\u8BCD\u4E0D\u5728\u5141\u8BB8\u5217\u8868\u91CC\u3002");
  } else if ((summary?.total ?? 0) > 0) {
    lines.push("\u5168\u90E8\u901A\u8FC7\uFF1A\u8FD9\u4E9B\u9000\u51FA\u7801\u5C31\u662F\u5B9E\u73B0\u7684\u300C\u8BC1\u636E\u300D\uFF0C\u628A\u5B83\u4EEC\u8FDE\u540C evidence \u6587\u4EF6\u4E00\u8D77\u4EA4\u4ED8\u3002");
  }
  return [{ type: "text", text: lines.join("\n") }];
}
var initParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    outDir: { type: "string", description: "\u542B compose-plan.json \u7684\u76EE\u5F55\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF09\uFF1B\u5361\u7247\u5199\u5230 <outDir>/tasks/\u3002" },
    implRoot: { type: "string", description: "\u53EF\u9009\uFF1B\u53EA\u5F71\u54CD\u5361\u7247\u6587\u4EF6\u767D\u540D\u5355\u7684\u524D\u7F00\u5C55\u793A\uFF0C\u4E0D\u53C2\u4E0E\u6821\u9A8C\u3002" },
    overwrite: { type: "boolean", description: "\u662F\u5426\u8986\u76D6 tasks/ \u4E0B\u672C\u6B21\u8981\u5199\u7684\u6587\u4EF6\uFF0C\u9ED8\u8BA4 false\u3002" }
  },
  required: ["outDir"]
};
var initOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    tasksDir: { type: "string" },
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          moduleId: { type: "string" },
          wave: { type: "number" },
          cardPath: { type: "string" }
        },
        required: ["moduleId", "wave", "cardPath"],
        additionalProperties: false
      }
    },
    waves: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number" },
          modules: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "string" } }
        },
        required: ["index", "modules", "dependsOn"],
        additionalProperties: false
      }
    },
    overlaps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "string" },
          files: { type: "array", items: { type: "string" } }
        },
        required: ["a", "b", "files"],
        additionalProperties: false
      }
    },
    filesWritten: { type: "array", items: { type: "string" } },
    error: errorSchema
  }
};
function buildTools(deps) {
  const check = {
    name: "impl_gate_check",
    description: "Run the 32 IMPL-GATE assertions against a spec-graph root. Calls `python -m specgraph check --json` first; an invalid graph makes every assertion NOT-RUN with D4_GRAPH_INVALID. Does not do GUI checks, does not render a canvas, and never writes into the inspected project. Use it once before delivery, when you need the full verdict table.",
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
  const report = {
    name: "impl_gate_report",
    description: "Summarise a previous impl_gate_check run as PASS/FAIL/NOT-RUN per assertion, reusing that run's cached results. Does not re-run checks, does not do GUI checks and does not render a canvas. Use it right after check to read the summary and uncovered set.",
    parameters: runSelectorParameters,
    output: { schema: reportOutputSchema, render: renderReport },
    async execute(args) {
      try {
        return buildReport(args);
      } catch (error) {
        return failureFrom(error);
      }
    }
  };
  const verify = {
    name: "impl_gate_verify_contract",
    description: "Check that A1\u2013A5 passed in one previous impl_gate_check run, reusing that run's cached results. Does not re-run checks, does not do GUI checks and does not render a canvas. Use it when only the contract deliverables need a yes/no.",
    parameters: runSelectorParameters,
    output: { schema: verifyOutputSchema, render: renderVerify },
    async execute(args) {
      try {
        return buildVerifyContract(args);
      } catch (error) {
        return failureFrom(error);
      }
    }
  };
  const compose = {
    name: "impl_gate_compose",
    description: 'Turn a requirement into a\u65BD\u5DE5\u6587\u6863 chain. \u52A8\u624B\u524D\u5148\u8BFB\u5305\u5185 playbooks/compose.md\uFF08\u76F8\u5BF9\u672C\u5305\u6839\u76EE\u5F55\uFF09\uFF1B\u5B83\u89C4\u5B9A\u4E86 plan \u5404\u5B57\u6BB5\u7684\u5199\u6CD5\u3002 mode "plan" writes compose-plan.json (the only place content lives) and SPEC-DRAFT.md with explicit TODO slots. mode "materialize" writes <outDir>/<name>/graph.toml + per-module spec.md, a nine-section SPEC.md beside <name>/, and export/export.md + export/manifest.json, then validates the graph with `python -m specgraph check`; an invalid graph returns GRAPH_INVALID with specgraph issues unchanged. It never invents content and never does GUI/canvas work.',
    parameters: composeParameters,
    output: { schema: composeOutputSchema, render: renderCompose },
    async execute(args) {
      try {
        return await buildCompose(args, deps.config);
      } catch (error) {
        return failureFrom(error);
      }
    }
  };
  const init = {
    name: "impl_gate_init",
    description: "Generate per-module task cards from <outDir>/compose-plan.json into <outDir>/tasks/ (TASKS.md, cards.json, wave-N/<id>-<dir>.md). Waves and overlaps come from the same planner as materialize; output is deterministic. It never edits the graph root, SPEC.md or export/, and never invents requirements or assertions. Use it after materialize, before splitting implementation across several agents.",
    parameters: initParameters,
    output: { schema: initOutputSchema, render: renderInit },
    async execute(args) {
      try {
        return buildInit(args);
      } catch (error) {
        return failureFrom(error);
      }
    }
  };
  const record = {
    name: "impl_gate_record",
    description: "Run the acceptance commands written in <outDir>/compose-plan.json and store the result as evidence (<outDir>/.impl-gate/ac-evidence.json, plus tasks/EVIDENCE.md when tasks/ exists). Each row records PASS/FAIL with the real exit code, duration and the log tail. Commands run in implRoot (default outDir) through the shell, and only commands whose first word is a known runner (pnpm/npm/node/python/git/...) are executed; anything else is SKIPPED with RUNNER_NOT_ALLOWED. Use dryRun first to see what would run. This is the implementation-side counterpart of impl_gate_review: review judges the document, record judges the code against the document.",
    parameters: recordParameters,
    output: { schema: recordOutputSchema, render: renderRecord },
    async execute(args) {
      const input = args ?? {};
      if (typeof input.outDir !== "string" || input.outDir.trim() === "") {
        return { ok: false, error: { code: "E_ROOT_MISSING", message: "outDir is required" } };
      }
      try {
        const outcome = recordAcceptance(input.outDir, {
          ...typeof input.implRoot === "string" && input.implRoot !== "" ? { implRoot: input.implRoot } : {},
          ...Array.isArray(input.modules) ? { modules: input.modules } : {},
          ...typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {},
          ...input.dryRun === true ? { dryRun: true } : {}
        });
        if (!outcome.ok) return outcome;
        return {
          ok: true,
          evidencePath: outcome.evidencePath,
          planSha256: outcome.planSha256,
          summary: outcome.summary,
          items: outcome.items.map((item) => ({
            id: item.id,
            module: item.module,
            command: item.command,
            status: item.status,
            exitCode: item.exitCode === null ? -1 : item.exitCode,
            durationMs: item.durationMs,
            tail: item.tail.length > 600 ? `${item.tail.slice(0, 600)}\u2026` : item.tail,
            ...item.reason === void 0 ? {} : { reason: item.reason }
          }))
        };
      } catch (error) {
        return failureFrom(error);
      }
    }
  };
  return [check, report, verify, compose, init, review, record];
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
  slow: z.boolean().default(false).description("\u9ED8\u8BA4\u662F\u5426\u8FD0\u884C slow \u65AD\u8A00\u3002"),
  allowCommandReplay: z.boolean().default(false).description("\u662F\u5426\u5141\u8BB8\u6309\u8BC1\u636E\u547D\u4EE4\u91CD\u653E M/Q \u65AD\u8A00\uFF08Step 5\uFF0C\u9ED8\u8BA4\u5173\u95ED\uFF09\u3002")
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
      slow: config.slow,
      allowCommandReplay: config.allowCommandReplay
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
  AC_EVIDENCE_REL,
  CHECKLIST_REL,
  Config,
  MAPPING_REL,
  TASKS_EVIDENCE_REL,
  apply,
  auditChecklist,
  buildCardsJson,
  buildCompose,
  buildInit,
  buildReport,
  buildTools,
  buildVerifyContract,
  cardPathOf,
  checkA2,
  checkA3,
  checkB5,
  checkQ10,
  checksFilePath,
  collectWarnings,
  compareReviewAndEvidence,
  composeReview,
  computeWaves,
  coverageStatement,
  distributionReadiness,
  emptyPlan,
  findExposeIndex,
  findSpecgraphHome,
  implementationEvidence,
  initTasks,
  inject,
  isRunRecord,
  loadChecks,
  makeReplayCheck,
  materializePlan,
  mergeChecklist,
  missingSlots,
  name,
  parseChecklist,
  parseReplayEvidence,
  preflightSpecgraph,
  recordAcceptance,
  recordReview,
  rememberRun,
  renderChecklistTemplate,
  renderDraft,
  renderEvidenceDoc,
  renderGraphToml,
  renderMappingTemplate,
  renderModuleSpec,
  renderSpecDoc,
  renderTaskCard,
  renderTasksDoc,
  resolveSpecgraphEnv,
  reviewSummary,
  runCheck,
  runnerOf,
  stripMeta,
  validatePlan
};
