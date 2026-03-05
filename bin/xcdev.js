#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function usage() {
  console.log(`xcdev

Usage:
  xcdev list devices [all|sim|real]
  xcdev list profiles
  xcdev build [profile]
  xcdev run [profile]

Examples:
  xcdev list devices
  xcdev list devices sim
  xcdev build sim
  xcdev run real

Config:
  Reads .ios-dev.env from current working directory by default.
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
  const configDir = findUp(startDir, (dir) => fs.existsSync(path.join(dir, ".ios-dev.env")));
  const projectDir = findUp(startDir, hasXcodeContainer);

  const workDir = projectDir || configDir || path.resolve(startDir);
  const configPath =
    process.env.IOS_DEV_CONFIG || (configDir ? path.join(configDir, ".ios-dev.env") : path.join(workDir, ".ios-dev.env"));

  return { workDir, configPath };
}

function normalizeProfileKey(profile) {
  return profile.toUpperCase().replace(/-/g, "_");
}

function resolveProfile(config, profile) {
  const key = normalizeProfileKey(profile);
  const modeKey = `IOS_PROFILE_${key}_MODE`;
  const targetKey = `IOS_PROFILE_${key}_TARGET`;

  let mode = process.env[modeKey] || config[modeKey];
  let target = process.env[targetKey] || config[targetKey];

  if (!mode || !target) {
    if (profile === "sim") {
      mode = mode || "sim";
      target = target || process.env.IOS_SIM_NAME || config.IOS_SIM_NAME || "iPhone 17";
    } else if (profile === "real") {
      mode = mode || "real";
      target = target || process.env.IOS_DEVICE_NAME_PATTERN || config.IOS_DEVICE_NAME_PATTERN || "iPhone";
    }
  }

  return { mode, target };
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

function parseSimulators() {
  const output = runCapture("xcrun", ["simctl", "list", "devices", "available"]);
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
    rows.push({
      name: m[1].trim(),
      udid: m[2],
      state: m[3].trim(),
      runtime
    });
  }
  return rows;
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
    profiles.push({
      profile: nameKey.toLowerCase(),
      mode: config[modeKey] || "",
      target: config[targetKey] || ""
    });
  }
  if (profiles.length === 0) {
    profiles.push({ profile: "sim", mode: "sim", target: "iPhone" });
    profiles.push({ profile: "real", mode: "real", target: "iPhone" });
  }
  profiles.sort((a, b) => a.profile.localeCompare(b.profile));
  console.log(`default: ${(config.IOS_PROFILE_DEFAULT || "sim").toLowerCase()}`);
  printTable(["profile", "mode", "target"], profiles);
}

function runBuildOrRun(action, profile, workDir, configPath, config) {
  const resolvedProfile =
    profile || process.env.IOS_PROFILE_DEFAULT || config.IOS_PROFILE_DEFAULT || "sim";
  const { mode, target } = resolveProfile(config, resolvedProfile.toLowerCase());
  if (!mode || !target) {
    throw new Error(`Profile '${resolvedProfile}' is not configured in ${configPath}`);
  }

  const scriptPath = path.resolve(__dirname, "../lib/xcdev.sh");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Core script not found: ${scriptPath}`);
  }

  const env = {
    ...process.env,
    IOS_WORKDIR: workDir,
    IOS_DEV_CONFIG: configPath
  };
  const res = spawnSync("bash", [scriptPath, mode, action, target], {
    stdio: "inherit",
    cwd: workDir,
    env
  });
  process.exit(res.status == null ? 1 : res.status);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help") || argv[0] === "help") {
    usage();
    process.exit(0);
  }

  const cwd = process.cwd();
  const { workDir, configPath } = discoverContext(cwd);
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

  if (cmd === "build" || cmd === "run") {
    runBuildOrRun(cmd, argv[1], workDir, configPath, config);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

try {
  main();
} catch (err) {
  console.error(`xcdev: ${err.message}`);
  process.exit(1);
}
