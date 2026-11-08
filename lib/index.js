// src/host/index.ts
import z from "@deepseek-ai/schemastery";

// src/host/tools.ts
import { randomUUID } from "node:crypto";
import fs9 from "node:fs";
import os2 from "node:os";
import path8 from "node:path";
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
async function readMapping(path9) {
  let text2;
  try {
    text2 = await readFile(path9, "utf8");
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
  if (rows.length === 0 || emptyCells.length > 0 || unknown.length > 0) {
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
  return rest.split(COMMAND_SPLIT)[0]?.trim() ?? "";
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
import fs6 from "node:fs";
import os from "node:os";
import path5 from "node:path";

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
  "acceptance"
]);
var EXPOSE_KEYS = /* @__PURE__ */ new Set(["kind", "signature", "note"]);
var REQUIRE_KEYS = /* @__PURE__ */ new Set(["module", "item", "why"]);
var BOUNDARY_KEYS = /* @__PURE__ */ new Set(["dependency", "purpose", "version", "fallback"]);
var COLUMN_KEYS = /* @__PURE__ */ new Set(["name", "type", "constraints"]);
var DATA_KEYS = /* @__PURE__ */ new Set(["table", "owner", "rowWriters", "columns", "indexes", "notes"]);
var GLOBALS_KEYS = /* @__PURE__ */ new Set(["conventions", "forbidden", "envKeys", "fieldCase", "listEnvelope", "errorShape"]);
var DELIVERABLE_KEYS = /* @__PURE__ */ new Set(["tree", "files"]);
var FILE_KEYS = /* @__PURE__ */ new Set(["path", "purpose"]);
var ACCEPTANCE_KEYS = /* @__PURE__ */ new Set(["id", "assertion", "test", "covers"]);
var TYPE_KEYS = /* @__PURE__ */ new Set(["name", "kind", "fields", "values", "source", "note"]);
var TYPE_FIELD_KEYS = /* @__PURE__ */ new Set(["name", "type", "note"]);
var ERROR_KEYS = /* @__PURE__ */ new Set(["code", "status", "when", "shape", "by"]);
var HTTP_KEYS = /* @__PURE__ */ new Set(["method", "path", "module", "handler", "req", "res", "auth"]);
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
  const path9 = (cut === -1 ? rawPath : rawPath.slice(0, cut)).replace(ROUTE_TRAILING_PUNCT, "");
  if (path9.length === 0 || /\s/.test(path9)) return void 0;
  return path9;
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
function problem(problems, path9, message) {
  problems.push({ code: "PLAN_INVALID", path: path9, message });
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
    for (const match of ref.text.matchAll(pattern)) {
      const name2 = ref.mode === "signature" ? match[1] : match[0];
      if (name2 === void 0) continue;
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
            const path9 = `${pointer(at, "constraints")}/${index}`;
            problem(problems, path9, `undefined error code "${match[0]}" at ${path9}`);
          }
        }
      });
    }
    if (Array.isArray(module.acceptance)) {
      module.acceptance.forEach((item, index) => {
        if (!isRecord2(item) || typeof item.assertion !== "string") return;
        for (const match of item.assertion.matchAll(ERROR_REF_RE)) {
          if (!errorCodes.has(match[0])) {
            const path9 = `${pointer(pointer(at, "acceptance"), index)}/assertion`;
            problem(problems, path9, `undefined error code "${match[0]}" at ${path9}`);
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
        const path9 = normalizeRouteRef(rawPath);
        if (path9 === void 0) continue;
        const route = `${method} ${path9}`;
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
  let defaultErrorShape;
  if (!isRecord2(raw.globals)) {
    problem(problems, "/globals", "must be an object");
  } else {
    checkKnownKeys(raw.globals, GLOBALS_KEYS, "/globals", problems);
    readStringArray(raw.globals.conventions, "/globals/conventions", problems);
    readStringArray(raw.globals.forbidden, "/globals/forbidden", problems);
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
    lines.push(...table(["\u5B57\u6BB5", "\u7C7B\u578B", "\u8BF4\u660E"], (type.fields ?? []).map((field) => [field.name, field.type, field.note ?? "\u2014"])));
  } else if (type.kind === "external") {
    lines.push(`\u6765\u6E90\uFF1A${type.source ?? "\uFF08\u672A\u5199\u660E\uFF09"}`);
  } else {
    const values = (type.values ?? []).map((value) => `\`${value}\``).join("\u3001");
    lines.push(`\u53D6\u503C\uFF1A${values.length > 0 ? values : "\uFF08\u65E0\uFF09"}`);
  }
  if (type.note !== void 0 && type.note.trim().length > 0) lines.push("", `\u8BF4\u660E\uFF1A${type.note}`);
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
      ["\u65B9\u6CD5", "\u8DEF\u5F84", "\u5904\u7406\u6A21\u5757", "\u9274\u6743", "\u8BF7\u6C42", "\u54CD\u5E94"],
      http.map((route) => [
        route.method,
        route.path,
        route.module,
        route.auth ?? "public",
        route.req ?? "\uFF08\u65E0\uFF09",
        route.res.trim() === "void" ? "204\uFF08\u65E0\u54CD\u5E94\u4F53\uFF09" : route.res
      ])
    ), "");
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
    ""
  );
  lines.push("## 9 \u4EA4\u4ED8\u6E05\u5355", "");
  const tree = plan.deliverables.tree.trim();
  lines.push("```text", tree.length > 0 ? plan.deliverables.tree.trimEnd() : "\uFF08\u65E0\uFF09", "```", "");
  lines.push(...table2(["\u6587\u4EF6", "\u7528\u9014"], plan.deliverables.files.map((file) => [file.path, file.purpose])), "");
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
function renderChecklistTemplate(items, name2) {
  const lines = [];
  lines.push("# \u9A8C\u6536\u52FE\u9009\u8868");
  lines.push("");
  lines.push(`- \u9879\u76EE\uFF1A${name2}`);
  lines.push(`- \u751F\u6210\uFF1A\u7531 impl_gate_compose \u7684 materialize \u6B65\u9AA4\u6309 checks/impl-gate.checks.json \u751F\u6210\uFF0C\u5171 ${items.length} \u6761`);
  lines.push("- \u6539 plan \u540E\u91CD\u65B0 materialize \u4F1A\u8986\u76D6\u672C\u6587\u4EF6\uFF08\u5B83\u767B\u8BB0\u5728 ownership.json \u91CC\uFF09");
  lines.push("- \u53EA\u5141\u8BB8\u4E09\u6001\uFF1APASS / FAIL / NOT-RUN\uFF1BPASS \u4E0E FAIL \u7684 evidence \u5FC5\u987B\u4EE5 `command:` \u6216 `file:` \u5F00\u5934");
  lines.push("");
  lines.push("| id | status | evidence | reason |");
  lines.push("|----|--------|----------|--------|");
  for (const item of items) {
    lines.push(`| ${item.id} | NOT-RUN | file:SPEC.md:1 | NOT_IMPLEMENTED |`);
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

// src/host/compose/materialize.ts
var OWNERSHIP = ".impl-gate/ownership.json";
function toPosix(file) {
  return file.split(path5.sep).join("/");
}
var RUN_RECORD_RE = /(^|\/)\.impl-gate\/runs\/run-[a-z0-9]+-[a-z0-9]+\.json$/;
function isRunRecord(file) {
  return RUN_RECORD_RE.test(file);
}
async function listFiles(root) {
  const out = [];
  const walk2 = async (dir, depth) => {
    if (depth > 12) return;
    let entries;
    try {
      entries = await fs6.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path5.join(dir, entry.name);
      if (entry.isDirectory()) await walk2(full, depth + 1);
      else if (entry.isFile()) out.push(full);
    }
  };
  await walk2(root, 0);
  return out;
}
async function readOwnership(outDir) {
  try {
    const raw = await fs6.promises.readFile(path5.join(outDir, OWNERSHIP), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.generated)) return /* @__PURE__ */ new Set();
    return new Set(parsed.generated.filter((entry) => typeof entry === "string"));
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
async function writeOwnership(outDir, generated) {
  const file = path5.join(outDir, OWNERSHIP);
  await fs6.promises.mkdir(path5.dirname(file), { recursive: true });
  const body = { generated: [...generated].sort(), managedBy: "dsh-impl-gate@0.2" };
  await fs6.promises.writeFile(file, `${JSON.stringify(body, null, 2)}
`, "utf8");
}
function failure(code, message, detail) {
  const out = { ok: false, code, message };
  if (detail !== void 0) out.detail = detail;
  return out;
}
function fromError(error) {
  if (error instanceof SpecgraphError) return failure(error.code, error.message, error.detail);
  return failure("E_INTERNAL", error.message);
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
  const tmp = await fs6.promises.mkdtemp(path5.join(os.tmpdir(), "impl-gate-export-"));
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
    const files = (await listFiles(tmp)).sort();
    const mdFile = files.find((file) => file.endsWith(".md"));
    const jsonFile = files.find((file) => file.endsWith(".json"));
    if (mdFile === void 0 || jsonFile === void 0) {
      throw new SpecgraphError("E_BAD_JSON", `specgraph export wrote no package for "${moduleDir}"`);
    }
    const md = await fs6.promises.readFile(mdFile, "utf8");
    const manifest = JSON.parse(await fs6.promises.readFile(jsonFile, "utf8"));
    return { md, manifest };
  } finally {
    await fs6.promises.rm(tmp, { recursive: true, force: true }).catch(() => void 0);
  }
}
async function materializePlan(outDirRaw, config) {
  const outDir = path5.resolve(outDirRaw);
  const planPath = path5.join(outDir, "compose-plan.json");
  let raw;
  try {
    raw = await fs6.promises.readFile(planPath, "utf8");
  } catch {
    return failure("E_PLAN_MISSING", `compose-plan.json not found in ${outDir}`);
  }
  let parsedPlan;
  try {
    parsedPlan = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    return failure("E_BAD_JSON", `compose-plan.json is not valid JSON: ${error.message}`);
  }
  const validation = validatePlan(parsedPlan);
  if (validation.plan === null) {
    const first = validation.problems[0];
    const message = first === void 0 ? "plan is invalid" : `${first.path || "/"} ${first.message}`;
    return { ...failure("PLAN_INVALID", message), problems: validation.problems };
  }
  const plan = validation.plan;
  const waves = computeWaves(plan);
  if (!waves.ok) return failure("PLAN_INVALID", waves.message);
  const target = path5.join(outDir, plan.name);
  const exportDir = path5.join(outDir, "export");
  const specFile = path5.join(outDir, "SPEC.md");
  const registered = await readOwnership(outDir);
  const existing = [];
  for (const root of [target, exportDir]) {
    for (const file of await listFiles(root)) existing.push(toPosix(path5.relative(outDir, file)));
  }
  if (await fs6.promises.stat(specFile).then((stat2) => stat2.isFile()).catch(() => false)) {
    existing.push("SPEC.md");
  }
  const conflicts = existing.filter((file) => !registered.has(file) && !isRunRecord(file)).sort();
  if (conflicts.length > 0) {
    return failure(
      "EXPORT_REFUSED",
      `target contains files not written by impl-gate: ${conflicts.join(", ")}`,
      `delete them or move them away; generated: ${[...registered].sort().join(", ") || "(none)"}`
    );
  }
  const environment = buildEnv(config, outDir);
  try {
    await preflightSpecgraph(environment, config.timeoutMs);
  } catch (error) {
    return fromError(error);
  }
  const files = /* @__PURE__ */ new Map();
  files.set(`${plan.name}/graph.toml`, renderGraphToml(plan));
  for (const module of plan.modules) {
    files.set(`${plan.name}/${module.dir}/spec.md`, renderModuleSpec(plan, module));
  }
  files.set("SPEC.md", renderSpecDoc({ plan, waves: waves.result }));
  const generated = [...files.keys()];
  for (const [rel, body] of files) {
    const full = path5.join(outDir, rel);
    await fs6.promises.mkdir(path5.dirname(full), { recursive: true });
    await fs6.promises.writeFile(full, body, "utf8");
  }
  await writeOwnership(outDir, generated);
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
      return failure(
        "PYTHON_ENV_MISSING",
        `python could not run specgraph check (exit ${checkOutput.exitCode}); check PYTHONPATH or specgraphCwd`,
        `${checkOutput.stderr}
${checkOutput.stdout}`.trim().slice(-4096) || void 0
      );
    }
    return {
      ...failure(
        "GRAPH_INVALID",
        `specgraph check rejected ${target} (exit ${checkOutput.exitCode})`,
        checkOutput.stderr.slice(-4096) || void 0
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
  files.set("export/export.md", `${exports.map((entry) => entry.md.trimEnd()).join("\n\n---\n\n")}
`);
  files.set(
    "export/manifest.json",
    `${JSON.stringify({ schemaVersion: 1, modules: exports.map((entry) => ({ dir: entry.dir, manifest: entry.manifest })) }, null, 2)}
`
  );
  files.set(CHECKLIST_REL, renderChecklistTemplate(loadChecks(), plan.name));
  files.set(MAPPING_REL, renderMappingTemplate(plan));
  for (const [rel, body] of files) {
    if (generated.includes(rel)) continue;
    const full = path5.join(outDir, rel);
    await fs6.promises.mkdir(path5.dirname(full), { recursive: true });
    await fs6.promises.writeFile(full, body, "utf8");
  }
  const all = [...files.keys()].sort();
  await writeOwnership(outDir, all);
  return {
    ok: true,
    mode: "materialize",
    graphRoot: target,
    specMd: specFile,
    packageMd: path5.join(exportDir, "export.md"),
    manifestPath: path5.join(exportDir, "manifest.json"),
    files: all,
    waves: waves.result.waves,
    overlaps: waves.result.overlaps
  };
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
    lines.push("| \u7F16\u53F7 | \u65AD\u8A00 |", "|---|---|");
    module.acceptance.forEach((entry, index) => {
      lines.push(`| AC-${module.id}-${index + 1} | ${entry.assertion} |`);
    });
    globalAcceptance.forEach((entry, index) => {
      lines.push(`| AC-G-${index + 1} | ${entry.assertion ?? ""} |`);
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
function failure2(code, message) {
  return { ok: false, error: { code, message } };
}
function relativePosix(root, target) {
  return path6.relative(root, target).split(path6.sep).join("/");
}
function listFiles2(dir) {
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
    return failure2("PLAN_MISSING", `compose-plan.json not found in ${outDir}`);
  }
  let raw;
  try {
    raw = JSON.parse(text2);
  } catch (error) {
    return failure2("PLAN_INVALID", `compose-plan.json is not valid JSON: ${error.message}`);
  }
  const validation = validatePlan(raw);
  if (validation.plan === null) {
    const cycle = validation.problems.find((problem2) => problem2.message.startsWith("dependency cycle:"));
    if (cycle !== void 0) return failure2("PLAN_HAS_CYCLE", cycle.message);
    const first = validation.problems[0];
    return failure2(
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
    return failure2("PLAN_HAS_CYCLE", outcome.message);
  }
  const { waves, overlaps } = outcome.result;
  const tasksDir = path6.join(outDir, "tasks");
  const waveByModule = /* @__PURE__ */ new Map();
  for (const wave of waves) for (const id of wave.modules) waveByModule.set(id, wave.index);
  const cards = [];
  const rendered = /* @__PURE__ */ new Map();
  for (const module of plan.modules) {
    const waveIndex = waveByModule.get(module.id);
    if (waveIndex === void 0) return failure2("PLAN_INVALID", `module ${module.id} is missing from the wave plan`);
    const wave = waves.find((entry) => entry.index === waveIndex);
    if (wave === void 0) return failure2("PLAN_INVALID", `wave ${waveIndex} is missing`);
    const cardPath = cardPathOf(module, wave.index);
    cards.push({ moduleId: module.id, wave: wave.index, cardPath });
    rendered.set(cardPath, renderTaskCard(plan, module, wave, { implRoot: options.implRoot, outDir }));
  }
  cards.sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  rendered.set("TASKS.md", renderTasksDoc(plan, waves, overlaps, cards));
  rendered.set("cards.json", `${JSON.stringify(buildCardsJson(plan, waves, overlaps, cards), null, 2)}
`);
  const expected = new Set([...rendered.keys()].map((entry) => entry.split("/").join(path6.sep)));
  const existing = listFiles2(tasksDir);
  const unknown = existing.filter((entry) => !expected.has(entry));
  if (unknown.length > 0) {
    return failure2(
      "EXPORT_REFUSED",
      `tasks/ already contains files this tool did not generate: ${unknown.map((entry) => `tasks/${entry}`).join(", ")}`
    );
  }
  if (options.overwrite !== true) {
    const clash = [...expected].filter((entry) => fs7.existsSync(path6.join(tasksDir, entry))).sort();
    if (clash.length > 0) {
      return failure2(
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

// src/host/graph-hash.ts
import { createHash as createHash2 } from "node:crypto";
import fs8 from "node:fs";
import path7 from "node:path";
var TARGET_NAMES = /* @__PURE__ */ new Set(["spec.md", "graph.toml"]);
var SKIP_DIRS = /* @__PURE__ */ new Set([".git", "node_modules", ".dsh-dev", ".impl-gate"]);
async function walk(dir, depth, out) {
  if (depth > 12) return;
  let entries;
  try {
    entries = await fs8.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const full = path7.join(dir, entry.name);
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
      const digest = createHash2("sha256").update(await fs8.promises.readFile(file)).digest("hex");
      hashes[path7.relative(root, file).split(path7.sep).join("/")] = digest.slice(0, 16);
    } catch {
      hashes[path7.relative(root, file).split(path7.sep).join("/")] = "unreadable";
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
  const resolved = path8.resolve(root);
  const unquoted = resolved.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? unquoted.toLowerCase() : unquoted;
}
function runsDir(graphRoot) {
  return path8.join(graphRoot, ".impl-gate", "runs");
}
function persistRun(runId, record) {
  try {
    const dir = runsDir(record.graphRoot);
    fs9.mkdirSync(dir, { recursive: true });
    fs9.writeFileSync(path8.join(dir, `${runId}.json`), JSON.stringify({ runId, ...record }), "utf8");
  } catch {
  }
}
function readRunFile(root, runId) {
  if (!/^run-[a-z0-9]+-[a-z0-9]+$/.test(runId)) return null;
  try {
    const raw = JSON.parse(fs9.readFileSync(path8.join(runsDir(root), `${runId}.json`), "utf8"));
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
    entries = fs9.readdirSync(runsDir(root)).filter((name2) => name2.endsWith(".json"));
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
async function runCheck(rawArgs, deps) {
  const startedAt = /* @__PURE__ */ new Date();
  const startedMs = Date.now();
  const args = rawArgs ?? {};
  const graphRootRaw = typeof args.graphRoot === "string" ? args.graphRoot : "";
  if (graphRootRaw.length === 0) return fail("E_ROOT_MISSING", "graphRoot is required");
  const graphRoot = path8.resolve(graphRootRaw);
  try {
    const stat2 = await fs9.promises.stat(graphRoot);
    if (!stat2.isDirectory()) return fail("E_ROOT_MISSING", `graphRoot is not a directory: ${graphRoot}`);
  } catch {
    return fail("E_ROOT_MISSING", `graphRoot does not exist: ${graphRoot}`);
  }
  const config = deps.config;
  const implRootArg = typeof args.implRoot === "string" && args.implRoot.length > 0 ? args.implRoot : "";
  const implRoot = path8.resolve(implRootArg.length > 0 ? implRootArg : config.implRoot.length > 0 ? config.implRoot : graphRoot);
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
  const checklistPath = path8.resolve(
    checklistArg.length > 0 ? checklistArg : path8.join(implRoot, ".impl-gate", "checklist.md")
  );
  const checklist = loadChecklist(checklistPath);
  const preGraphHashes = await hashContractFiles(graphRoot);
  const mapPython = (argv) => {
    const mapped = [...argv];
    const head = mapped[0];
    if (head !== void 0 && config.pythonPath.length > 0 && /^python(\d+(?:\.\d+)*)?(\.exe)?$/i.test(path8.basename(head))) {
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
    newTempDir: (prefix) => fs9.promises.mkdtemp(path8.join(os2.tmpdir(), prefix))
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
  rememberRun(runId, payload, reasons, graphRoot);
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
function selectRun(rawRoot, rawRunId) {
  const rootArg = typeof rawRoot === "string" ? rawRoot.trim() : "";
  if (rootArg.length === 0) return fail("E_ROOT_MISSING", "root is required");
  const root = path8.resolve(rootArg);
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
    uncovered
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
  return { ok, details };
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
  return [{ type: "text", text: lines.filter((line) => line.length > 0).join("\n") }];
}
var REVIEW_RUBRIC = ["\u53EF\u5F00\u5DE5", "\u9700\u6F84\u6E05", "\u4E0D\u53EF\u5F00\u5DE5"];
function composeReview(outDir) {
  return {
    playbook: path8.resolve(path8.dirname(fileURLToPath2(import.meta.url)), "..", "playbooks", "review.md"),
    specPath: path8.join(path8.resolve(outDir), "SPEC.md"),
    rubric: [...REVIEW_RUBRIC]
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
        planPath: path8.join(path8.resolve(outDirRaw), "compose-plan.json"),
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
        overlaps: outcome.overlaps
      };
    }
    const failure3 = {
      error: {
        code: outcome.code,
        message: outcome.message,
        ...outcome.detail === void 0 ? {} : { detail: outcome.detail }
      }
    };
    if (outcome.problems !== void 0) failure3.problems = outcome.problems;
    if (outcome.issues !== void 0) failure3.issues = outcome.issues;
    if (outcome.graphExitCode !== void 0) failure3.graphExitCode = outcome.graphExitCode;
    return failure3;
  }
  const outDir = path8.resolve(outDirRaw);
  const planPath = path8.join(outDir, "compose-plan.json");
  const draftPath = path8.join(outDir, "SPEC-DRAFT.md");
  const requirement = typeof args.requirement === "string" ? args.requirement : void 0;
  let existingPlan;
  try {
    existingPlan = JSON.parse(await fs9.promises.readFile(planPath, "utf8"));
  } catch (error) {
    const code = error.code;
    if (code !== "ENOENT") return failureFrom(error);
  }
  await fs9.promises.mkdir(outDir, { recursive: true });
  if (mode === "draft") {
    const source = existingPlan ?? emptyPlan({
      name: typeof args.name === "string" ? args.name : void 0,
      stack: typeof args.stack === "string" ? args.stack : void 0
    });
    await fs9.promises.writeFile(draftPath, renderDraft({ plan: source, requirement }), "utf8");
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
  const entries = await fs9.promises.readdir(outDir);
  const allowed = /* @__PURE__ */ new Set(["compose-plan.json", "SPEC-DRAFT.md"]);
  const unexpected = entries.filter((entry) => !allowed.has(entry));
  if (unexpected.length > 0 && args.overwrite !== true) {
    return fail(
      "E_OUT_DIR_NOT_EMPTY",
      `outDir is not empty: ${outDir}`,
      `${unexpected.length} entr${unexpected.length === 1 ? "y" : "ies"} other than compose-plan.json/SPEC-DRAFT.md; pass overwrite:true only if you mean to write into it`
    );
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
    backupPath = path8.join(outDir, `compose-plan.backup-${stamp}.json`);
    await fs9.promises.rename(planPath, backupPath);
  }
  await fs9.promises.writeFile(planPath, `${JSON.stringify(template, null, 2)}
`, "utf8");
  await fs9.promises.writeFile(draftPath, renderDraft({ plan: template, requirement }), "utf8");
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
function reviewLine(review) {
  if (review === void 0) return "review: not available";
  return `review: ${review.playbook} | spec: ${review.specPath} | rubric: ${review.rubric.join("/")}`;
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
    error: errorSchema
  }
};
var verifyOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    details: { type: "array", items: { type: "string" } },
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
        rubric: { type: "array", items: { type: "string" } }
      },
      required: ["playbook", "specPath", "rubric"]
    },
    packageMd: { type: "string" },
    manifestPath: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    backupPath: { type: "string" },
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
  return [check, report, verify, compose, init];
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
  CHECKLIST_REL,
  Config,
  MAPPING_REL,
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
  checksFilePath,
  composeReview,
  computeWaves,
  coverageStatement,
  emptyPlan,
  findExposeIndex,
  findSpecgraphHome,
  initTasks,
  inject,
  isRunRecord,
  loadChecks,
  makeReplayCheck,
  materializePlan,
  missingSlots,
  name,
  parseChecklist,
  parseReplayEvidence,
  preflightSpecgraph,
  rememberRun,
  renderChecklistTemplate,
  renderDraft,
  renderGraphToml,
  renderMappingTemplate,
  renderModuleSpec,
  renderSpecDoc,
  renderTaskCard,
  renderTasksDoc,
  resolveSpecgraphEnv,
  runCheck,
  stripMeta,
  validatePlan
};
