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
  return line.split("|").slice(1, -1).map((cell) => cell.trim());
}
async function readMapping(path7) {
  let text2;
  try {
    text2 = await readFile(path7, "utf8");
  } catch {
    return void 0;
  }
  const lines = text2.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.includes("|") && /需求\s*ID/i.test(line) && line.includes("\u6A21\u5757"));
  if (headerIndex < 0) return [];
  const headerLine = lines[headerIndex];
  if (headerLine === void 0) return [];
  const header = tableCells(headerLine);
  const needIndex = header.findIndex((cell) => /需求\s*ID/i.test(cell));
  const moduleIndex = header.findIndex((cell) => cell.includes("\u6A21\u5757"));
  const itemIndex = header.findIndex((cell) => cell.includes("\u6761\u76EE"));
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
  return cells.map((cell) => cell.trim());
}
function isSeparator(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
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
var DATA_KEYS = /* @__PURE__ */ new Set(["table", "columns", "indexes", "notes"]);
var GLOBALS_KEYS = /* @__PURE__ */ new Set(["conventions", "forbidden", "envKeys"]);
var DELIVERABLE_KEYS = /* @__PURE__ */ new Set(["tree", "files"]);
var FILE_KEYS = /* @__PURE__ */ new Set(["path", "purpose"]);
var ACCEPTANCE_KEYS = /* @__PURE__ */ new Set(["id", "assertion", "test"]);
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function pointer(base, key) {
  const token = String(key).replace(/~/g, "~0").replace(/\//g, "~1");
  return `${base}/${token}`;
}
function problem(problems, path7, message) {
  problems.push({ code: "PLAN_INVALID", path: path7, message });
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
function validateModules(raw, problems) {
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
function validatePlan(raw) {
  const problems = [];
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
  if (!isRecord2(raw.globals)) {
    problem(problems, "/globals", "must be an object");
  } else {
    checkKnownKeys(raw.globals, GLOBALS_KEYS, "/globals", problems);
    readStringArray(raw.globals.conventions, "/globals/conventions", problems);
    readStringArray(raw.globals.forbidden, "/globals/forbidden", problems);
    if (raw.globals.envKeys !== void 0) readStringArray(raw.globals.envKeys, "/globals/envKeys", problems);
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
    const table = readString(entry.table, pointer(at, "table"), problems);
    if (table.length > 0) {
      if (tables.has(table)) problem(problems, pointer(at, "table"), `duplicate table "${table}"`);
      tables.add(table);
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
  validateModules(raw.modules, problems);
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
    globals: { conventions: [], forbidden: [], envKeys: [] },
    data: [],
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
function missingSlots(raw) {
  const modules = isRecord2(raw) && Array.isArray(raw.modules) ? raw.modules : [];
  const out = [];
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
  const resolved = path6.resolve(root);
  const unquoted = resolved.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? unquoted.toLowerCase() : unquoted;
}
function rememberRun(runId, payload, reasons, graphRoot) {
  runs.set(runId, { payload, reasons, graphRoot: normalizeRoot(graphRoot), finishedAt: Date.now() });
  for (const [key, record] of runs) {
    if (Date.now() - record.finishedAt > RUN_TTL_MS) runs.delete(key);
  }
}
function lookupRun(runId) {
  const record = runs.get(runId);
  if (record === void 0) return { kind: "missing" };
  if (Date.now() - record.finishedAt > RUN_TTL_MS) {
    runs.delete(runId);
    return { kind: "expired" };
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
  if (best === void 0) return { kind: "missing" };
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
  const graphRoot = path6.resolve(graphRootRaw);
  try {
    const stat2 = await fs7.promises.stat(graphRoot);
    if (!stat2.isDirectory()) return fail("E_ROOT_MISSING", `graphRoot is not a directory: ${graphRoot}`);
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
    rememberRun(runId, payload2, reasons2, graphRoot);
    return payload2;
  }
  const checklistArg = typeof args.checklistPath === "string" && args.checklistPath.length > 0 ? args.checklistPath : "";
  const checklistPath = path6.resolve(
    checklistArg.length > 0 ? checklistArg : path6.join(implRoot, ".impl-gate", "checklist.md")
  );
  const checklist = loadChecklist(checklistPath);
  const preGraphHashes = await hashContractFiles(graphRoot);
  const mapPython = (argv) => {
    const mapped = [...argv];
    const head = mapped[0];
    if (head !== void 0 && config.pythonPath.length > 0 && /^python(\d+(?:\.\d+)*)?(\.exe)?$/i.test(path6.basename(head))) {
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
    specgraphHome: sourceHome ?? "",
    allowCommandReplay: config.allowCommandReplay,
    replayBudget: { remaining: 5 },
    run: (specArgs) => runSpecgraph({ argv: runner.argv, cwd: runner.cwd, env: runner.env, timeoutMs: config.timeoutMs }, specArgs),
    runArgv,
    runImpl,
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
  const root = path6.resolve(rootArg);
  const runId = typeof rawRunId === "string" && rawRunId.length > 0 ? rawRunId : "";
  if (runId.length > 0) {
    const found = lookupRun(runId);
    if (found.kind === "missing") {
      return fail("E_NO_PRIOR_RUN", `no cached run for runId ${runId}`, "Run impl_gate_check first; the cache is in-memory and is lost on plugin reload.");
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
async function buildCompose(rawArgs) {
  const args = rawArgs ?? {};
  const outDirRaw = typeof args.outDir === "string" ? args.outDir.trim() : "";
  if (outDirRaw.length === 0) return fail("E_OUT_DIR_REQUIRED", "outDir is required");
  const mode = args.mode === "materialize" ? "materialize" : "plan";
  if (mode === "materialize") {
    return fail("E_NOT_IMPLEMENTED", 'materialize is not part of G1; only mode "plan" exists yet');
  }
  const outDir = path6.resolve(outDirRaw);
  try {
    const stat2 = await fs7.promises.stat(outDir);
    if (!stat2.isDirectory()) {
      return fail("E_OUT_DIR_NOT_EMPTY", `outDir exists and is not a directory: ${outDir}`);
    }
    const entries = await fs7.promises.readdir(outDir);
    if (entries.length > 0 && args.overwrite !== true) {
      return fail(
        "E_OUT_DIR_NOT_EMPTY",
        `outDir is not empty: ${outDir}`,
        `${entries.length} entr${entries.length === 1 ? "y" : "ies"}; pass overwrite:true to replace compose-plan.json and SPEC-DRAFT.md`
      );
    }
  } catch (error) {
    const code = error.code;
    if (code !== "ENOENT") return failureFrom(error);
  }
  await fs7.promises.mkdir(outDir, { recursive: true });
  const planPath = path6.join(outDir, "compose-plan.json");
  const draftPath = path6.join(outDir, "SPEC-DRAFT.md");
  const template = emptyPlan({
    name: typeof args.name === "string" ? args.name : void 0,
    stack: typeof args.stack === "string" ? args.stack : void 0
  });
  const requirement = typeof args.requirement === "string" ? args.requirement : void 0;
  await fs7.promises.writeFile(planPath, `${JSON.stringify(template, null, 2)}
`, "utf8");
  await fs7.promises.writeFile(draftPath, renderDraft({ plan: template, requirement }), "utf8");
  return {
    ok: true,
    mode: "plan",
    planPath,
    draftPath,
    missingSlots: missingSlots(template),
    problems: []
  };
}
function renderCompose(_args, value) {
  const payload = value;
  if (payload.error !== void 0) {
    return [{ type: "text", text: `impl_gate_compose failed: ${payload.error.code} \u2014 ${payload.error.message}` }];
  }
  const slots = payload.missingSlots ?? [];
  const lines = [`impl_gate_compose ${payload.mode ?? ""}: ${payload.planPath ?? ""}`, `draft: ${payload.draftPath ?? ""}`];
  lines.push(slots.length === 0 ? "missingSlots: none" : `missingSlots (${slots.length}): ${slots.join(" | ")}`);
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
      enum: ["plan", "materialize"],
      description: "plan=\u5199\u7A7A\u69FD\u6A21\u677F\u4E0E\u8349\u7A3F\uFF1Bmaterialize=\u7269\u5316\u56FE\u8C31\u4E0E\u4E5D\u8282 SPEC.md\uFF080.2.0-G2 \u8D77\u53EF\u7528\uFF09\u3002"
    },
    overwrite: { type: "boolean", description: "outDir \u975E\u7A7A\u65F6\u662F\u5426\u8986\u76D6 compose-plan.json \u4E0E SPEC-DRAFT.md\uFF0C\u9ED8\u8BA4 false\u3002" }
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
    error: errorSchema
  }
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
  const report = {
    name: "impl_gate_report",
    description: "Summarise a previous impl_gate_check run as PASS/FAIL/NOT-RUN per assertion, reusing that run's cached results. Does not re-run checks, does not do GUI checks and does not render a canvas.",
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
    description: "Check that A1\u2013A5 passed in one previous impl_gate_check run, reusing that run's cached results. Does not re-run checks, does not do GUI checks and does not render a canvas.",
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
    description: 'Turn a requirement into a\u65BD\u5DE5\u6587\u6863 scaffold. mode "plan" writes compose-plan.json (the only place content lives) and SPEC-DRAFT.md with explicit TODO slots. It never invents content, never calls specgraph and never writes spec.md/graph.toml; materialize is not available in this card.',
    parameters: composeParameters,
    output: { schema: composeOutputSchema, render: renderCompose },
    async execute(args) {
      try {
        return await buildCompose(args);
      } catch (error) {
        return failureFrom(error);
      }
    }
  };
  return [check, report, verify, compose];
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
  Config,
  apply,
  auditChecklist,
  buildCompose,
  buildReport,
  buildTools,
  buildVerifyContract,
  checkA2,
  checkA3,
  coverageStatement,
  emptyPlan,
  inject,
  makeReplayCheck,
  missingSlots,
  name,
  parseChecklist,
  parseReplayEvidence,
  rememberRun,
  renderDraft,
  runCheck,
  validatePlan
};
