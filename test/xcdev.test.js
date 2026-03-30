const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const xcdev = require("../bin/xcdev.js");

test("parseBuildRunOptions reads simulator version flags", () => {
  assert.deepEqual(
    xcdev.parseBuildRunOptions(["--no-open-simulator", "--version", "18.2", "sim"]),
    {
      positional: ["sim"],
      openSimulator: false,
      simVersion: "18.2"
    }
  );

  assert.deepEqual(
    xcdev.parseBuildRunOptions(["--version=18.3", "qa"]),
    {
      positional: ["qa"],
      openSimulator: true,
      simVersion: "18.3"
    }
  );
});

test("resolveProfile falls back to simulator defaults and version", () => {
  const config = {
    IOS_SIM_NAME: "iPhone 16",
    IOS_SIM_VERSION: "18.2"
  };

  assert.deepEqual(xcdev.resolveProfile(config, "sim"), {
    mode: "sim",
    target: "iPhone 16",
    version: "18.2"
  });
});

test("setTarget writes simulator target and version into config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xcdev-test-"));
  const configPath = path.join(dir, ".xcdev.env");
  const originalLog = console.log;
  console.log = () => {};

  try {
    xcdev.setTarget("sim", "iPhone Air", configPath, configPath, { simVersion: "18.2" });
    const config = fs.readFileSync(configPath, "utf8");

    assert.match(config, /IOS_SIM_NAME="iPhone Air"/);
    assert.match(config, /IOS_SIM_VERSION="18\.2"/);
    assert.match(config, /IOS_PROFILE_SIM_TARGET="iPhone Air"/);
    assert.match(config, /IOS_PROFILE_SIM_VERSION="18\.2"/);
  } finally {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseSimulatorsJsonOutput extracts runtime metadata from simctl JSON", () => {
  const rows = xcdev.parseSimulatorsJsonOutput(
    JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
          {
            name: "iPhone 16",
            udid: "UDID-1",
            state: "Shutdown",
            isAvailable: true
          }
        ]
      }
    })
  );

  assert.deepEqual(rows, [
    {
      name: "iPhone 16",
      udid: "UDID-1",
      state: "Shutdown",
      runtime: "iOS 18.2",
      version: "18.2",
      runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2"
    }
  ]);
});

test("selectSimulator prefers exact version and booted device", () => {
  const selected = xcdev.selectSimulator(
    [
      { name: "iPhone 16", udid: "A", state: "Shutdown", runtime: "iOS 18.2", version: "18.2" },
      { name: "iPhone 16", udid: "B", state: "Booted", runtime: "iOS 18.1", version: "18.1" },
      { name: "iPhone 16", udid: "C", state: "Shutdown", runtime: "iOS 17.5", version: "17.5" }
    ],
    "iPhone 16",
    "18.2"
  );

  assert.equal(selected && selected.udid, "A");
});

test("selectSimulator picks latest matching runtime when version is omitted", () => {
  const selected = xcdev.selectSimulator(
    [
      { name: "iPhone 16", udid: "A", state: "Shutdown", runtime: "iOS 17.5", version: "17.5" },
      { name: "iPhone 16", udid: "B", state: "Shutdown", runtime: "iOS 18.2", version: "18.2" },
      { name: "iPhone 16 Pro", udid: "C", state: "Booted", runtime: "iOS 18.1", version: "18.1" }
    ],
    "iPhone 16",
    ""
  );

  assert.equal(selected && selected.udid, "B");
});
