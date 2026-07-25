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
  const targetBuildDir = path.join(dir, "build");

  fs.mkdirSync(binDir);
  fs.mkdirSync(projectDir);
  fs.mkdirSync(path.join(targetBuildDir, `${projectName}.app`), { recursive: true });
  if (options.configContent) {
    fs.writeFileSync(path.join(dir, ".xcdev.env"), options.configContent);
  }
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
case " $* " in
  *" -showBuildSettings "*)
    echo "    TARGET_BUILD_DIR = $XCODEBUILD_TARGET_BUILD_DIR"
    echo "    WRAPPER_NAME = ${projectName}.app"
    echo "    PRODUCT_BUNDLE_IDENTIFIER = com.example.fixture"
    exit 0
    ;;
  *" -showdestinations "*)
    echo "Available destinations for the \\"${projectName}\\" scheme:"
    echo "    { platform:iOS, arch:arm64, id:REAL-DEVICE-UDID, name:Fixture iPhone }"
    exit 0
    ;;
esac
if [ -n "$XCODEBUILD_FAILURE_OUTPUT" ]; then
  printf '%s\\n' "$XCODEBUILD_FAILURE_OUTPUT" >&2
  exit "\${XCODEBUILD_FAILURE_STATUS:-65}"
fi
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(binDir, "xcrun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  return { dir, binDir, logPath, listPath, targetBuildDir };
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
    XCODEBUILD_TARGET_BUILD_DIR: fixture.targetBuildDir,
    XCODEBUILD_FAILURE_OUTPUT: ""
  };
  delete env.IOS_SKIP_MACRO_VALIDATION;
  delete env.XCDEV_SKIP_MACRO_VALIDATION_OVERRIDE;
  Object.assign(env, options.env || {});

  if (cleanBuild !== undefined) {
    env.IOS_CLEAN_BUILD = cleanBuild;
  } else {
    delete env.IOS_CLEAN_BUILD;
  }

  const result = spawnSync(
    "/bin/bash",
    [
      path.join(__dirname, "../lib/xcdev.sh"),
      options.mode || "sim",
      options.action || "build"
    ],
    {
      env,
      encoding: "utf8"
    }
  );
  const args = fs.existsSync(fixture.logPath)
    ? fs.readFileSync(fixture.logPath, "utf8").trim().split("\n")
    : [];

  fs.rmSync(fixture.dir, { recursive: true, force: true });
  return { result, args };
}

function runCliWithFakeCore(args, configContent = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xcdev-cli-test-"));
  const binDir = path.join(dir, "bin");
  const envLogPath = path.join(dir, "core-env.log");

  fs.mkdirSync(binDir);
  fs.mkdirSync(path.join(dir, "Fixture.xcodeproj"));
  if (configContent) {
    fs.writeFileSync(path.join(dir, ".xcdev.env"), configContent);
  }
  fs.writeFileSync(
    path.join(binDir, "bash"),
    `#!/bin/sh
printf '%s\\n' "$IOS_SKIP_MACRO_VALIDATION" "$XCDEV_SKIP_MACRO_VALIDATION_OVERRIDE" > "$XCDEV_CORE_ENV_LOG"
`,
    { mode: 0o755 }
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    XCDEV_CORE_ENV_LOG: envLogPath
  };
  delete env.IOS_SKIP_MACRO_VALIDATION;
  delete env.XCDEV_SKIP_MACRO_VALIDATION_OVERRIDE;

  const result = spawnSync(process.execPath, [path.join(__dirname, "../bin/xcdev.js"), ...args], {
    cwd: dir,
    env,
    encoding: "utf8"
  });
  const envValues = fs.existsSync(envLogPath)
    ? fs.readFileSync(envLogPath, "utf8").trim().split("\n")
    : [];

  fs.rmSync(dir, { recursive: true, force: true });
  return { result, envValues };
}

test("parseBuildRunOptions reads simulator version flags", () => {
  assert.deepEqual(
    xcdev.parseBuildRunOptions(["--no-open-simulator", "--version", "18.2", "sim"]),
    {
      positional: ["sim"],
      openSimulator: false,
      simVersion: "18.2",
      scheme: "",
      skipMacroValidation: false
    }
  );

  assert.deepEqual(
    xcdev.parseBuildRunOptions(["--version=18.3", "qa"]),
    {
      positional: ["qa"],
      openSimulator: true,
      simVersion: "18.3",
      scheme: "",
      skipMacroValidation: false
    }
  );
});

test("parseBuildRunOptions reads explicit scheme flags", () => {
  assert.deepEqual(xcdev.parseBuildRunOptions(["--scheme", "Rote", "sim"]), {
    positional: ["sim"],
    openSimulator: true,
    simVersion: "",
    scheme: "Rote",
    skipMacroValidation: false
  });

  assert.deepEqual(xcdev.parseBuildRunOptions(["real", "--scheme=Rote Beta"]), {
    positional: ["real"],
    openSimulator: true,
    simVersion: "",
    scheme: "Rote Beta",
    skipMacroValidation: false
  });
});

test("parseBuildRunOptions reads the macro validation opt-out flag", () => {
  assert.deepEqual(
    xcdev.parseBuildRunOptions(["real", "--skip-macro-validation"]),
    {
      positional: ["real"],
      openSimulator: true,
      simVersion: "",
      scheme: "",
      skipMacroValidation: true
    }
  );
});

test("help documents the macro validation opt-out", () => {
  const help = spawnSync(process.execPath, [path.join(__dirname, "../bin/xcdev.js"), "--help"], {
    encoding: "utf8"
  });

  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /xcdev build .*--skip-macro-validation/);
  assert.match(help.stdout, /xcdev run .*--skip-macro-validation/);
  assert.match(help.stdout, /IOS_SKIP_MACRO_VALIDATION defaults to NO/);
});

test("CLI passes explicit and configured macro validation settings to the core script", () => {
  const explicit = runCliWithFakeCore(
    ["build", "--skip-macro-validation", "real"],
    'IOS_SKIP_MACRO_VALIDATION="NO"\n'
  );
  assert.equal(explicit.result.status, 0, explicit.result.stderr);
  assert.deepEqual(explicit.envValues, ["YES", "YES"]);

  const configured = runCliWithFakeCore(
    ["run", "real"],
    'IOS_SKIP_MACRO_VALIDATION="YES"\n'
  );
  assert.equal(configured.result.status, 0, configured.result.stderr);
  assert.deepEqual(configured.envValues, ["YES", "YES"]);

  const defaultBuild = runCliWithFakeCore(["build", "real"]);
  assert.equal(defaultBuild.result.status, 0, defaultBuild.result.stderr);
  assert.deepEqual(defaultBuild.envValues, ["NO", "NO"]);
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

test("shell adds -skipMacroValidation only when explicitly configured", () => {
  const defaultBuild = runShellBuild("NO");
  assert.equal(defaultBuild.result.status, 0, defaultBuild.result.stderr);
  assert.equal(defaultBuild.args.includes("-skipMacroValidation"), false);

  const configuredBuild = runShellBuild("NO", {
    configContent: 'IOS_SKIP_MACRO_VALIDATION="YES"\n'
  });
  assert.equal(configuredBuild.result.status, 0, configuredBuild.result.stderr);
  assert.equal(configuredBuild.args.filter((arg) => arg === "-skipMacroValidation").length, 1);

  const explicitRun = runShellBuild("NO", {
    action: "run",
    env: {
      IOS_OPEN_SIMULATOR: "NO",
      XCDEV_SKIP_MACRO_VALIDATION_OVERRIDE: "YES"
    }
  });
  assert.equal(explicitRun.result.status, 0, explicitRun.result.stderr);
  assert.equal(explicitRun.args.filter((arg) => arg === "-skipMacroValidation").length, 2);
  assert.equal(explicitRun.args.filter((arg) => arg === "-showBuildSettings").length, 1);

  const realBuild = runShellBuild("NO", {
    mode: "real",
    env: { XCDEV_SKIP_MACRO_VALIDATION_OVERRIDE: "YES" }
  });
  assert.equal(realBuild.result.status, 0, realBuild.result.stderr);
  assert.equal(realBuild.args.filter((arg) => arg === "-skipMacroValidation").length, 1);
});

test("shell explains how to resolve rejected Swift macros without bypassing validation", () => {
  const macroError =
    "error: Macro “FixtureMacros” from package “FixturePackage” must be enabled before it can be used";
  const rejectedBuild = runShellBuild("NO", {
    env: { XCODEBUILD_FAILURE_OUTPUT: macroError }
  });

  assert.equal(rejectedBuild.result.status, 65);
  assert.doesNotMatch(rejectedBuild.result.stdout, /Macro .*must be enabled before it can be used/);
  assert.match(rejectedBuild.result.stderr, /Macro .*must be enabled before it can be used/);
  assert.match(rejectedBuild.result.stderr, /open the project in Xcode and approve it/i);
  assert.match(rejectedBuild.result.stderr, /--skip-macro-validation/);
  assert.match(rejectedBuild.result.stderr, /IOS_SKIP_MACRO_VALIDATION=YES/);
  assert.equal(rejectedBuild.args.includes("-skipMacroValidation"), false);

  const optedOutBuild = runShellBuild("NO", {
    env: {
      XCODEBUILD_FAILURE_OUTPUT: macroError,
      XCDEV_SKIP_MACRO_VALIDATION_OVERRIDE: "YES"
    }
  });
  assert.equal(optedOutBuild.result.status, 65);
  assert.doesNotMatch(optedOutBuild.result.stderr, /Swift macro validation blocked/);
  assert.equal(optedOutBuild.args.includes("-skipMacroValidation"), true);
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
