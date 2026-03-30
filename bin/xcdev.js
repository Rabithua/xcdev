#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PRIMARY_CONFIG_NAME = ".xcdev.env";
const RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.";

function usage() {
  console.log(`xcdev

Usage:
  xcdev list devices [all|sim|real]
  xcdev list profiles
  xcdev set sim [--version <ios-version>] <simulator-name>
  xcdev set real <device-name-pattern>
  xcdev build [--version <ios-version>] [profile] [target]
  xcdev run [--no-open-simulator] [--version <ios-version>] [profile] [target]

Examples:
  xcdev list devices
  xcdev list devices sim
  xcdev set sim --version 18.2 "iPhone Air"
  xcdev set real "Huawei Air"
  xcdev build --version 18.2 sim
  xcdev run --version 18.2 sim
  xcdev run --no-open-simulator sim
  xcdev run real
  xcdev run real "Huawei Air"
  xcdev run "Huawei Air"

Config:
  Reads .xcdev.env from current working directory by default.
`);
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf8");
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quoteEnvValue(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function ensureConfigHeader(lines) {
  const marker = "# xcdev config";
  if (lines.some((line) => line.trim() === marker)) return lines;
  const header = [
    marker,
    "# Purpose: local project defaults for xcdev device/profile selection.",
    "# Created/updated by `xcdev set`.",
    ""
  ];
  return [...header, ...lines];
}

function upsertEnvEntries(filePath, entries) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  let lines = existing ? existing.split(/\r?\n/) : [];
  if (lines.length === 1 && lines[0] === "") lines.length = 0;
  lines = ensureConfigHeader(lines);

  for (const [key, rawValue] of Object.entries(entries)) {
    const value = quoteEnvValue(rawValue);
    const nextLine = `${key}=${value}`;
    const keyRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
    const idx = lines.findIndex((line) => !line.trim().startsWith("#") && keyRe.test(line));
    if (idx >= 0) {
      lines[idx] = nextLine;
    } else {
      lines.push(nextLine);
    }
  }

  const output = `${lines.join("\n").replace(/\n+$/g, "")}\n`;
  fs.writeFileSync(filePath, output, "utf8");
}

function findConfigInDir(dir) {
  const primaryPath = path.join(dir, PRIMARY_CONFIG_NAME);
  if (fs.existsSync(primaryPath)) {
    return { path: primaryPath, name: PRIMARY_CONFIG_NAME };
  }
  return null;
}

function findUp(startDir, checkFn) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (checkFn(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
}

function hasXcodeContainer(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.some(
      (entry) =>
        entry.isDirectory() &&
        (entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace"))
    );
  } catch {
    return false;
  }
}

function discoverContext(startDir) {
  const configDir = findUp(startDir, (dir) => Boolean(findConfigInDir(dir)));
  const projectDir = findUp(startDir, hasXcodeContainer);

  const workDir = projectDir || configDir || path.resolve(startDir);
  const discoveredConfig = configDir ? findConfigInDir(configDir) : null;
  const configBaseDir = configDir || workDir;
  const preferredConfigPath = path.join(configBaseDir, PRIMARY_CONFIG_NAME);
  const configPath = process.env.IOS_DEV_CONFIG || (discoveredConfig ? discoveredConfig.path : preferredConfigPath);

  return { workDir, configPath, preferredConfigPath };
}

function normalizeProfileKey(profile) {
  return profile.toUpperCase().replace(/-/g, "_");
}

function resolveProfile(config, profile) {
  const key = normalizeProfileKey(profile);
  const modeKey = `IOS_PROFILE_${key}_MODE`;
  const targetKey = `IOS_PROFILE_${key}_TARGET`;
  const versionKey = `IOS_PROFILE_${key}_VERSION`;

  let mode = process.env[modeKey] || config[modeKey];
  let target = process.env[targetKey] || config[targetKey];
  let version = process.env[versionKey] || config[versionKey];

  if (!mode || !target) {
    if (profile === "sim") {
      mode = mode || "sim";
      target = target || process.env.IOS_SIM_NAME || config.IOS_SIM_NAME || "iPhone 17";
    } else if (profile === "real") {
      mode = mode || "real";
      target = target || process.env.IOS_DEVICE_NAME_PATTERN || config.IOS_DEVICE_NAME_PATTERN || ".*";
    }
  }

  if ((mode || "").toLowerCase() === "sim") {
    version = version || process.env.IOS_SIM_VERSION || config.IOS_SIM_VERSION || "";
  }

  return { mode, target, version };
}

function runCapture(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.status !== 0) {
    const stderr = (res.stderr || "").trim();
    const stdout = (res.stdout || "").trim();
    const msg = stderr || stdout || `${cmd} failed`;
    throw new Error(msg);
  }
  return res.stdout || "";
}

function normalizeVersion(value) {
  return String(value || "")
    .trim()
    .replace(/^ios\s*/i, "")
    .replace(/^v/i, "")
    .replace(/_/g, ".")
    .replace(/\s+/g, "")
    .replace(/[^\d.]/g, "");
}

function versionParts(value) {
  const normalized = normalizeVersion(value);
  if (!normalized) return [];
  return normalized
    .split(".")
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function runtimeIdentifierToMeta(runtimeIdentifier) {
  const raw = String(runtimeIdentifier || "");
  const short = raw.startsWith(RUNTIME_PREFIX) ? raw.slice(RUNTIME_PREFIX.length) : raw;
  const match = short.match(/^([A-Za-z]+)-(.+)$/);
  const platformToken = match ? match[1] : short;
  const versionToken = match ? match[2] : "";
  const knownPlatforms = new Map([
    ["ios", "iOS"],
    ["tvos", "tvOS"],
    ["watchos", "watchOS"],
    ["visionos", "visionOS"],
    ["macos", "macOS"]
  ]);
  const platform =
    knownPlatforms.get(platformToken.toLowerCase()) ||
    platformToken.replace(/([a-z])([A-Z])/g, "$1 $2");
  const version = versionToken ? versionToken.replace(/-/g, ".") : "";
  return {
    runtimeIdentifier: raw,
    runtime: version ? `${platform} ${version}` : platform,
    version
  };
}

function parseSimulatorsTextOutput(output) {
  const rows = [];
  let runtime = "";
  for (const rawLine of output.split(/\r?\n/)) {
    const header = rawLine.match(/^\s*--\s*(.+?)\s*--\s*$/);
    if (header) {
      runtime = header[1];
      continue;
    }
    const m = rawLine.match(/^\s*([^()]+?)\s+\(([0-9A-Fa-f-]{8,})\)\s+\(([^)]+)\)\s*$/);
    if (!m) continue;
    const versionMatch = runtime.match(/(\d+(?:\.\d+)*)/);
    rows.push({
      name: m[1].trim(),
      udid: m[2],
      state: m[3].trim(),
      runtime,
      version: versionMatch ? versionMatch[1] : ""
    });
  }
  return rows;
}

function parseSimulatorsJsonOutput(output) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch (error) {
    throw new Error(`Failed to parse simctl JSON output: ${error.message}`);
  }

  const devices = payload && typeof payload === "object" ? payload.devices : null;
  if (!devices || typeof devices !== "object") {
    throw new Error("Invalid simctl JSON output: missing devices");
  }

  const rows = [];
  for (const [runtimeIdentifier, deviceRows] of Object.entries(devices)) {
    const { runtime, version } = runtimeIdentifierToMeta(runtimeIdentifier);
    for (const device of Array.isArray(deviceRows) ? deviceRows : []) {
      if (!device || device.isAvailable === false) continue;
      rows.push({
        name: String(device.name || "").trim(),
        udid: String(device.udid || "").trim(),
        state: String(device.state || "Shutdown").trim(),
        runtime,
        version,
        runtimeIdentifier
      });
    }
  }
  return rows;
}

function parseSimulators() {
  try {
    const jsonOutput = runCapture("xcrun", ["simctl", "list", "devices", "available", "--json"]);
    return parseSimulatorsJsonOutput(jsonOutput);
  } catch {
    const textOutput = runCapture("xcrun", ["simctl", "list", "devices", "available"]);
    return parseSimulatorsTextOutput(textOutput);
  }
}

function scoreSimulatorName(name, target) {
  const left = String(name || "").trim().toLowerCase();
  const right = String(target || "").trim().toLowerCase();
  if (!left || !right) return 0;
  if (left === right) return 400;
  if (left.startsWith(right)) return 300;
  if (left.includes(right)) return 200;

  try {
    const re = new RegExp(target, "i");
    if (re.test(name)) return 100;
  } catch {
    // Ignore invalid regex patterns and keep plain-string matching only.
  }

  return 0;
}

function scoreSimulatorVersion(candidateVersion, requestedVersion) {
  const requested = normalizeVersion(requestedVersion);
  if (!requested) return 0;

  const candidate = normalizeVersion(candidateVersion);
  if (!candidate) return -1;
  if (candidate === requested) return 200;
  if (candidate.startsWith(`${requested}.`)) return 100;
  return -1;
}

function selectSimulator(simulators, target, requestedVersion) {
  const matches = [];

  for (const simulator of simulators) {
    const nameScore = scoreSimulatorName(simulator.name, target);
    if (nameScore === 0) continue;

    const versionScore = scoreSimulatorVersion(simulator.version, requestedVersion);
    if (versionScore < 0) continue;

    matches.push({
      simulator,
      nameScore,
      versionScore
    });
  }

  matches.sort((left, right) => {
    if (left.versionScore !== right.versionScore) return right.versionScore - left.versionScore;
    if (left.nameScore !== right.nameScore) return right.nameScore - left.nameScore;

    const leftBooted = left.simulator.state === "Booted" ? 1 : 0;
    const rightBooted = right.simulator.state === "Booted" ? 1 : 0;
    if (leftBooted !== rightBooted) return rightBooted - leftBooted;

    const versionCompare = compareVersions(right.simulator.version, left.simulator.version);
    if (versionCompare !== 0) return versionCompare;

    return left.simulator.name.localeCompare(right.simulator.name);
  });

  return matches[0] ? matches[0].simulator : null;
}

function resolveSimulator(target, version) {
  const simulators = parseSimulators();
  const selected = selectSimulator(simulators, target, version);
  if (!selected) {
    const versionLabel = normalizeVersion(version);
    const versionSuffix = versionLabel ? ` for iOS ${versionLabel}` : "";
    throw new Error(`No available simulator matching '${target}'${versionSuffix}`);
  }
  return selected;
}

function parseRealDevices() {
  const output = runCapture("xcrun", ["xctrace", "list", "devices"]);
  const rows = [];
  let inOffline = false;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "== Devices Offline ==") {
      inOffline = true;
      continue;
    }
    if (line === "== Simulators ==") {
      break;
    }
    if (line.startsWith("==")) continue;
    if (inOffline) continue;
    if (/Simulator|MacBook|My Mac/i.test(line)) continue;

    const tokens = [...line.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
    const udid = [...tokens].reverse().find((t) => /^[0-9A-Fa-f-]{8,}$/.test(t));
    if (!udid) continue;

    const firstParen = line.indexOf("(");
    const name = firstParen > 0 ? line.slice(0, firstParen).trim() : line;
    const os = tokens.find((t) => t !== udid) || "";
    rows.push({ name, udid, os });
  }
  return rows;
}

function printTable(columns, rows) {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((r) => String(r[col] ?? "").length))
  );
  const header = columns.map((col, i) => col.padEnd(widths[i])).join("  ");
  console.log(header);
  console.log(columns.map((_, i) => "-".repeat(widths[i])).join("  "));
  for (const row of rows) {
    const line = columns
      .map((col, i) => String(row[col] ?? "").padEnd(widths[i]))
      .join("  ");
    console.log(line);
  }
}

function listDevices(kind) {
  if (kind !== "all" && kind !== "sim" && kind !== "real") {
    throw new Error(`Invalid device kind: ${kind}`);
  }

  if (kind === "all" || kind === "sim") {
    const sims = parseSimulators();
    console.log("Simulators");
    printTable(["name", "state", "runtime", "udid"], sims);
    console.log("");
  }

  if (kind === "all" || kind === "real") {
    const reals = parseRealDevices();
    console.log("Real Devices");
    printTable(["name", "os", "udid"], reals);
  }
}

function listProfiles(config) {
  const profiles = [];
  const modeKeys = Object.keys(config).filter((k) => /^IOS_PROFILE_[A-Z0-9_]+_MODE$/.test(k));
  for (const modeKey of modeKeys) {
    const nameKey = modeKey.replace(/^IOS_PROFILE_/, "").replace(/_MODE$/, "");
    const targetKey = `IOS_PROFILE_${nameKey}_TARGET`;
    const versionKey = `IOS_PROFILE_${nameKey}_VERSION`;
    profiles.push({
      profile: nameKey.toLowerCase(),
      mode: config[modeKey] || "",
      target: config[targetKey] || "",
      version: config[versionKey] || ""
    });
  }
  if (profiles.length === 0) {
    profiles.push({
      profile: "sim",
      mode: "sim",
      target: config.IOS_SIM_NAME || "iPhone",
      version: config.IOS_SIM_VERSION || ""
    });
    profiles.push({ profile: "real", mode: "real", target: ".*", version: "" });
  }
  profiles.sort((a, b) => a.profile.localeCompare(b.profile));
  console.log(`default: ${(config.IOS_PROFILE_DEFAULT || "sim").toLowerCase()}`);
  printTable(["profile", "mode", "target", "version"], profiles);
}

function setTarget(kind, value, configPath, preferredConfigPath, options = {}) {
  const target = (value || "").trim();
  if (!target) {
    throw new Error(`Usage: xcdev set ${kind}${kind === "sim" ? ' [--version <ios-version>]' : ""} "<name>"`);
  }

  const writePath = process.env.IOS_DEV_CONFIG ? configPath : preferredConfigPath;

  if (kind === "sim") {
    const entries = {
      IOS_SIM_NAME: target,
      IOS_PROFILE_SIM_MODE: "sim",
      IOS_PROFILE_SIM_TARGET: target
    };
    if (options.simVersion) {
      entries.IOS_SIM_VERSION = options.simVersion;
      entries.IOS_PROFILE_SIM_VERSION = options.simVersion;
    }
    upsertEnvEntries(writePath, entries);
  } else if (kind === "real") {
    if (options.simVersion) {
      throw new Error("--version is only supported with `xcdev set sim`");
    }
    upsertEnvEntries(writePath, {
      IOS_DEVICE_NAME_PATTERN: target,
      IOS_PROFILE_REAL_MODE: "real",
      IOS_PROFILE_REAL_TARGET: target
    });
  } else {
    throw new Error(`Invalid set target: ${kind}`);
  }

  const suffix = kind === "sim" && options.simVersion ? ` (iOS ${options.simVersion})` : "";
  console.log(`Saved ${kind} target '${target}'${suffix} to ${writePath}`);
}

function hasConfiguredProfile(config, profile) {
  const key = normalizeProfileKey(profile);
  return Boolean(config[`IOS_PROFILE_${key}_MODE`] || config[`IOS_PROFILE_${key}_TARGET`]);
}

function parseBuildRunArgs(args, config) {
  if (args.length === 0) return { profile: "", target: "" };
  if (args.length === 1) return { profile: args[0], target: "" };

  const first = (args[0] || "").toLowerCase();
  const rest = args.slice(1).join(" ").trim();
  if (first === "sim" || first === "real" || hasConfiguredProfile(config, first)) {
    return { profile: first, target: rest };
  }

  // Treat unrecognized multi-word args as a real-device name pattern.
  return { profile: "real", target: args.join(" ").trim() };
}

function parseBuildRunOptions(args) {
  const positional = [];
  let openSimulator = true;
  let simVersion = "";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--no-open-simulator") {
      openSimulator = false;
      continue;
    }
    if (arg === "--version") {
      const next = args[i + 1];
      if (!next) {
        throw new Error("Missing value for --version");
      }
      simVersion = next.trim();
      i += 1;
      continue;
    }
    if (arg.startsWith("--version=")) {
      simVersion = arg.slice("--version=".length).trim();
      if (!simVersion) {
        throw new Error("Missing value for --version");
      }
      continue;
    }
    positional.push(arg);
  }

  return { positional, openSimulator, simVersion };
}

function runBuildOrRun(action, profile, targetOverride, workDir, configPath, config, options = {}) {
  const resolvedProfile =
    profile || process.env.IOS_PROFILE_DEFAULT || config.IOS_PROFILE_DEFAULT || "sim";
  const { mode, target, version } = resolveProfile(config, resolvedProfile.toLowerCase());
  const finalTarget = targetOverride || target;
  const finalVersion = (options.simVersion || version || "").trim();
  if (!mode || !finalTarget) {
    throw new Error(`Profile '${resolvedProfile}' is not configured in ${configPath}`);
  }
  if (mode !== "sim" && finalVersion) {
    throw new Error("--version can only be used with simulator profiles");
  }

  const scriptPath = path.resolve(__dirname, "../lib/xcdev.sh");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Core script not found: ${scriptPath}`);
  }

  const env = {
    ...process.env,
    IOS_WORKDIR: workDir,
    IOS_DEV_CONFIG: configPath,
    IOS_SIM_VERSION: finalVersion,
    IOS_OPEN_SIMULATOR:
      options.openSimulator === false
        ? "NO"
        : process.env.IOS_OPEN_SIMULATOR || config.IOS_OPEN_SIMULATOR || "YES"
  };

  if (mode === "sim") {
    const selectedSimulator = resolveSimulator(finalTarget, finalVersion);
    env.IOS_SIM_UDID = selectedSimulator.udid;
    env.IOS_SIM_RESOLVED_NAME = selectedSimulator.name;
    env.IOS_SIM_RUNTIME = selectedSimulator.runtime;
    env.IOS_SIM_VERSION = selectedSimulator.version || finalVersion;
  }

  const res = spawnSync("bash", [scriptPath, mode, action, finalTarget], {
    stdio: "inherit",
    cwd: workDir,
    env
  });
  process.exit(res.status == null ? 1 : res.status);
}

function parseSetOptions(args) {
  const positional = [];
  let simVersion = "";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--version") {
      const next = args[i + 1];
      if (!next) {
        throw new Error("Missing value for --version");
      }
      simVersion = next.trim();
      i += 1;
      continue;
    }
    if (arg.startsWith("--version=")) {
      simVersion = arg.slice("--version=".length).trim();
      if (!simVersion) {
        throw new Error("Missing value for --version");
      }
      continue;
    }
    positional.push(arg);
  }

  return { positional, simVersion };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help") || argv[0] === "help") {
    usage();
    process.exit(0);
  }

  const cwd = process.cwd();
  const { workDir, configPath, preferredConfigPath } = discoverContext(cwd);
  const config = parseEnvFile(configPath);

  const cmd = argv[0];
  if (cmd === "list") {
    const sub = argv[1] || "devices";
    if (sub === "devices") {
      listDevices((argv[2] || "all").toLowerCase());
      return;
    }
    if (sub === "profiles") {
      listProfiles(config);
      return;
    }
    throw new Error(`Unknown list subcommand: ${sub}`);
  }

  if (cmd === "set") {
    const kind = (argv[1] || "").toLowerCase();
    if (kind !== "sim" && kind !== "real") {
      throw new Error("Usage: xcdev set <sim|real> \"<name>\"");
    }
    const options = parseSetOptions(argv.slice(2));
    const value = options.positional.join(" ");
    setTarget(kind, value, configPath, preferredConfigPath, options);
    return;
  }

  if (cmd === "build" || cmd === "run") {
    const options = parseBuildRunOptions(argv.slice(1));
    const { profile, target } = parseBuildRunArgs(options.positional, config);
    runBuildOrRun(cmd, profile, target, workDir, configPath, config, options);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

module.exports = {
  PRIMARY_CONFIG_NAME,
  compareVersions,
  discoverContext,
  ensureConfigHeader,
  hasConfiguredProfile,
  listDevices,
  listProfiles,
  normalizeProfileKey,
  normalizeVersion,
  parseBuildRunArgs,
  parseBuildRunOptions,
  parseEnvFile,
  parseSetOptions,
  parseSimulators,
  parseSimulatorsJsonOutput,
  parseSimulatorsTextOutput,
  resolveProfile,
  resolveSimulator,
  runtimeIdentifierToMeta,
  scoreSimulatorName,
  scoreSimulatorVersion,
  selectSimulator,
  setTarget,
  upsertEnvEntries
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`xcdev: ${err.message}`);
    process.exit(1);
  }
}
