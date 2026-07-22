const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const xcdev = require("../bin/xcdev.js");

function createFakeXcodeEnvironment(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xcdev-xcode-test-"));
  const binDir = path.join(dir, "bin");
  const projectName = options.projectName || "Fixture";
  const containerExtension = options.containerKind === "workspace" ? "xcworkspace" : "xcodeproj";
  const projectDir = path.join(dir, `${projectName}.${containerExtension}`);
  const logPath = path.join(dir, "xcodebuild.log");
  const listPath = path.join(dir, "xcodebuild-list.txt");

  fs.mkdirSync(binDir);
  fs.mkdirSync(projectDir);
  if (options.localSchemes) {
    const schemesDir = path.join(projectDir, "xcshareddata", "xcschemes");
    fs.mkdirSync(schemesDir, { recursive: true });
    for (const scheme of options.localSchemes) {
      fs.writeFileSync(path.join(schemesDir, `${scheme}.xcscheme`), "");
    }
  }
  fs.writeFileSync(
    listPath,
    options.listOutput || `Information about project "${projectName}":\n    Schemes:\n        ${projectName}\n`
  );
  fs.writeFileSync(
    path.join(binDir, "xcodebuild"),
    `#!/bin/sh
if [ "$1" = "-version" ]; then
  echo "Xcode 99.0"
  exit 0
fi
case " $* " in
  *" -list "*)
    /bin/cat "$XCODEBUILD_LIST"
    exit 0
    ;;
esac
printf '%s\\n' "$@" >> "$XCODEBUILD_LOG"
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(binDir, "xcrun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  return { dir, binDir, logPath, listPath };
}

function runShellBuild(cleanBuild, options = {}) {
  const fixture = createFakeXcodeEnvironment(options);
  const env = {
    ...process.env,
    PATH: `${fixture.binDir}:${process.env.PATH}`,
    IOS_WORKDIR: fixture.dir,
    IOS_SIM_UDID: "SIMULATOR-UDID",
    XCODEBUILD_LOG: fixture.logPath,
    XCODEBUILD_LIST: fixture.listPath,
    ...(options.env || {})
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
      simVersion: "18.2",
      scheme: ""
    }
  );

  assert.deepEqual(
    xcdev.parseBuildRunOptions(["--version=18.3", "qa"]),
    {
      positional: ["qa"],
      openSimulator: true,
      simVersion: "18.3",
      scheme: ""
    }
  );
});

test("parseBuildRunOptions reads explicit scheme flags", () => {
  assert.deepEqual(xcdev.parseBuildRunOptions(["--scheme", "Rote", "sim"]), {
    positional: ["sim"],
    openSimulator: true,
    simVersion: "",
    scheme: "Rote"
  });

  assert.deepEqual(xcdev.parseBuildRunOptions(["real", "--scheme=Rote Beta"]), {
    positional: ["real"],
    openSimulator: true,
    simVersion: "",
    scheme: "Rote Beta"
  });
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

test("scheme discovery prefers the scheme matching the project name", () => {
  const build = runShellBuild(undefined, {
    projectName: "Rote",
    listOutput: `Information about project "Rote":
    Targets:
        Rote
        RoteSyncTests
    Build Configurations:
        Debug
    Schemes:
        HighlightSwift
        Rote
        RoteSyncTests
`
  });

  assert.equal(build.result.status, 0, build.result.stderr);
  const schemeIndex = build.args.indexOf("-scheme");
  assert.equal(build.args[schemeIndex + 1], "Rote");
});

test("scheme discovery excludes schemes matching resolved package identities", () => {
  const build = runShellBuild(undefined, {
    projectName: "Container",
    localSchemes: ["MainApp"],
    listOutput: `Resolved source packages:
        HighlightSwift: https://example.com/highlightswift @ 1.0.0

Information about project "Container":
    Schemes:
        HighlightSwift
        MainApp
`
  });

  assert.equal(build.result.status, 0, build.result.stderr);
  const schemeIndex = build.args.indexOf("-scheme");
  assert.equal(build.args[schemeIndex + 1], "MainApp");
});

test("scheme discovery fails when multiple project schemes remain", () => {
  const build = runShellBuild(undefined, {
    projectName: "Container",
    localSchemes: ["MainApp", "MainAppTests"],
    listOutput: `Resolved source packages:
        HighlightSwift: https://example.com/highlightswift @ 1.0.0

Information about project "Container":
    Schemes:
        HighlightSwift
        MainApp
        MainAppTests
`
  });

  assert.equal(build.result.status, 1);
  assert.match(build.result.stderr, /Unable to choose a scheme automatically/);
  assert.match(build.result.stderr, /MainApp/);
  assert.doesNotMatch(build.result.stderr, /HighlightSwift/);
});

test("scheme discovery preserves custom local schemes as ambiguous candidates", () => {
  const build = runShellBuild(undefined, {
    projectName: "Container",
    localSchemes: ["MainApp", "Staging"],
    listOutput: `Resolved source packages:
        HighlightSwift: https://example.com/highlightswift @ 1.0.0

Information about project "Container":
    Targets:
        MainApp
    Schemes:
        HighlightSwift
        MainApp
        Staging
`
  });

  assert.equal(build.result.status, 1);
  assert.match(build.result.stderr, /MainApp/);
  assert.match(build.result.stderr, /Staging/);
  assert.doesNotMatch(build.result.stderr, /HighlightSwift/);
});

test("scheme discovery selects a custom local scheme when packages are the only alternatives", () => {
  const build = runShellBuild(undefined, {
    projectName: "Container",
    localSchemes: ["Staging"],
    listOutput: `Resolved source packages:
        HighlightSwift: https://example.com/highlightswift @ 1.0.0

Information about project "Container":
    Targets:
        MainApp
    Schemes:
        HighlightSwift
        Staging
`
  });

  assert.equal(build.result.status, 0, build.result.stderr);
  const schemeIndex = build.args.indexOf("-scheme");
  assert.equal(build.args[schemeIndex + 1], "Staging");
});

test("local scheme metadata wins over a same-named package identity", () => {
  const build = runShellBuild(undefined, {
    projectName: "Container",
    localSchemes: ["Textual"],
    listOutput: `Resolved source packages:
        textual: https://example.com/textual @ 1.0.0

Information about project "Container":
    Schemes:
        Textual
`
  });

  assert.equal(build.result.status, 0, build.result.stderr);
  const schemeIndex = build.args.indexOf("-scheme");
  assert.equal(build.args[schemeIndex + 1], "Textual");
});

test("scheme discovery reads workspace-local scheme metadata", () => {
  const build = runShellBuild(undefined, {
    projectName: "Container",
    containerKind: "workspace",
    localSchemes: ["Staging"],
    listOutput: `Resolved source packages:
        HighlightSwift: https://example.com/highlightswift @ 1.0.0

Information about workspace "Container":
    Schemes:
        HighlightSwift
        Staging
`
  });

  assert.equal(build.result.status, 0, build.result.stderr);
  const schemeIndex = build.args.indexOf("-scheme");
  assert.equal(build.args[schemeIndex + 1], "Staging");
});

test("explicit scheme override bypasses ambiguous discovery", () => {
  const build = runShellBuild(undefined, {
    projectName: "Container",
    env: { XCDEV_SCHEME_OVERRIDE: "MainApp" },
    listOutput: `Information about project "Container":
    Targets:
        MainApp
        MainAppTests
    Schemes:
        MainApp
        MainAppTests
`
  });

  assert.equal(build.result.status, 0, build.result.stderr);
  const schemeIndex = build.args.indexOf("-scheme");
  assert.equal(build.args[schemeIndex + 1], "MainApp");
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

test("setTarget writes an explicit scheme into config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xcdev-test-"));
  const configPath = path.join(dir, ".xcdev.env");
  const originalLog = console.log;
  console.log = () => {};

  try {
    xcdev.setTarget("scheme", "Rote", configPath, configPath);
    const config = fs.readFileSync(configPath, "utf8");

    assert.match(config, /IOS_SCHEME="Rote"/);
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
