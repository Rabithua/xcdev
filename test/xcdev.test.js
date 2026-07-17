const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const xcdev = require("../bin/xcdev.js");

function createFakeXcodeEnvironment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xcdev-xcode-test-"));
  const binDir = path.join(dir, "bin");
  const projectDir = path.join(dir, "Fixture.xcodeproj");
  const logPath = path.join(dir, "xcodebuild.log");

  fs.mkdirSync(binDir);
  fs.mkdirSync(projectDir);
  fs.writeFileSync(
    path.join(binDir, "xcodebuild"),
    `#!/bin/sh
if [ "$1" = "-version" ]; then
  echo "Xcode 99.0"
  exit 0
fi
case " $* " in
  *" -list "*)
    printf 'Information about project "Fixture":\\n    Schemes:\\n        Fixture\\n'
    exit 0
    ;;
esac
printf '%s\\n' "$@" >> "$XCODEBUILD_LOG"
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(binDir, "xcrun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  return { dir, binDir, logPath };
}

function runShellBuild(cleanBuild) {
  const fixture = createFakeXcodeEnvironment();
  const env = {
    ...process.env,
    PATH: `${fixture.binDir}:${process.env.PATH}`,
    IOS_WORKDIR: fixture.dir,
    IOS_SIM_UDID: "SIMULATOR-UDID",
    XCODEBUILD_LOG: fixture.logPath
  };

  if (cleanBuild !== undefined) {
    env.IOS_CLEAN_BUILD = cleanBuild;
  } else {
    delete env.IOS_CLEAN_BUILD;
  }

  const result = spawnSync("/bin/bash", [path.join(__dirname, "../lib/xcdev.sh"), "sim", "build"], {
    env,
    encoding: "utf8"
  });
  const args = fs.existsSync(fixture.logPath)
    ? fs.readFileSync(fixture.logPath, "utf8").trim().split("\n")
    : [];

  fs.rmSync(fixture.dir, { recursive: true, force: true });
  return { result, args };
}

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

test("shell builds are clean by default and can opt into incremental builds", () => {
  const defaultBuild = runShellBuild(undefined);
  assert.equal(defaultBuild.result.status, 0, defaultBuild.result.stderr);
  assert.deepEqual(defaultBuild.args.slice(-2), ["clean", "build"]);

  const incrementalBuild = runShellBuild("NO");
  assert.equal(incrementalBuild.result.status, 0, incrementalBuild.result.stderr);
  assert.deepEqual(incrementalBuild.args.slice(-1), ["build"]);
  assert.equal(incrementalBuild.args.includes("clean"), false);

  const invalidBuild = runShellBuild("sometimes");
  assert.equal(invalidBuild.result.status, 1);
  assert.match(invalidBuild.result.stdout, /Invalid IOS_CLEAN_BUILD value/);
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

test("parseRealDevicesOutput ignores local Macs without dropping device names containing Mac", () => {
  const rows = xcdev.parseRealDevicesOutput(`
== Devices ==
于长野的Mac mini (8823ED09-9438-5967-A5BE-B22CD463AB55)
Mac's iPhone (18.7.8) (00008101-000A3D9934D0001E)
Huawei Air (26.5) (00008150-00163CCE3E40401C)
== Simulators ==
iPhone 17 (26.5) (351603C8-F89F-45C9-859E-BBC492949E4C)
`);

  assert.deepEqual(rows, [
    {
      name: "Mac's iPhone",
      os: "18.7.8",
      udid: "00008101-000A3D9934D0001E"
    },
    {
      name: "Huawei Air",
      os: "26.5",
      udid: "00008150-00163CCE3E40401C"
    }
  ]);
});

test("parseDevicectlDevicesOutput extracts physical iOS hardware udids", () => {
  const rows = xcdev.parseDevicectlDevicesOutput(`
Name             Hostname                          Identifier                             State
--------------   -------------------------------   ------------------------------------   ------------------
Huawei Air       Huawei-Air.coredevice.local       8FFD5C16-07F3-5E73-818A-9016F7CB0661   available (paired)
{
  "result": {
    "devices": [
      {
        "identifier": "8FFD5C16-07F3-5E73-818A-9016F7CB0661",
        "deviceProperties": {
          "name": "Huawei Air",
          "osVersionNumber": "27.0"
        },
        "connectionProperties": {
          "pairingState": "paired",
          "tunnelState": "disconnected"
        },
        "capabilities": [
          {
            "featureIdentifier": "com.apple.coredevice.feature.connectdevice"
          }
        ],
        "hardwareProperties": {
          "platform": "iOS",
          "reality": "physical",
          "udid": "00008150-00163CCE3E40401C"
        }
      },
      {
        "identifier": "38DDC880-CE28-56ED-B2A0-97B1040998B3",
        "deviceProperties": {
          "name": "卧室",
          "osVersionNumber": "26.5"
        },
        "hardwareProperties": {
          "platform": "audioOS",
          "reality": "physical"
        }
      },
      {
        "identifier": "41BA1C4F-8888-4444-AAAA-111122223333",
        "deviceProperties": {
          "name": "Unavailable iPhone",
          "osVersionNumber": "18.7.8"
        },
        "connectionProperties": {
          "pairingState": "paired",
          "tunnelState": "unavailable"
        },
        "hardwareProperties": {
          "platform": "iOS",
          "reality": "physical",
          "udid": "00008101-000A3D9934D0001E"
        }
      }
    ]
  }
}
`);

  assert.deepEqual(rows, [
    {
      name: "Huawei Air",
      os: "27.0",
      udid: "00008150-00163CCE3E40401C"
    }
  ]);
});
