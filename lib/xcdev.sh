#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="${IOS_WORKDIR:-$SCRIPT_ROOT}"
CONFIG_FILE="${IOS_DEV_CONFIG:-$ROOT_DIR/.xcdev.env}"

if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

MODE="${1:-sim}"          # sim | real
ACTION="${2:-build}"      # build | run
TARGET_VALUE="${3:-}"     # simulator name or device name pattern

if [[ "$MODE" != "sim" && "$MODE" != "real" ]]; then
  echo "Invalid mode: $MODE"
  exit 1
fi

if [[ "$ACTION" != "build" && "$ACTION" != "run" ]]; then
  echo "Invalid action: $ACTION"
  exit 1
fi

find_default_project() {
  find "$ROOT_DIR" -maxdepth 1 -name "*.xcodeproj" -print | sort | head -n 1
}

find_default_workspace() {
  find "$ROOT_DIR" -maxdepth 1 -name "*.xcworkspace" -print | sort | head -n 1
}

container_args=()

WORKSPACE="${IOS_WORKSPACE:-}"
PROJECT="${IOS_PROJECT:-}"

if [[ -z "${WORKSPACE:-}" && -z "${PROJECT:-}" ]]; then
  WORKSPACE="$(find_default_workspace)"
  PROJECT="$(find_default_project)"
fi

if [[ -n "${WORKSPACE:-}" ]]; then
  if [[ "$WORKSPACE" != /* ]]; then
    WORKSPACE="$ROOT_DIR/$WORKSPACE"
  fi
  if [[ ! -d "$WORKSPACE" ]]; then
    echo "Workspace not found: $WORKSPACE"
    exit 1
  fi
  container_args=(-workspace "$WORKSPACE")
elif [[ -n "${PROJECT:-}" ]]; then
  if [[ "$PROJECT" != /* ]]; then
    PROJECT="$ROOT_DIR/$PROJECT"
  fi
  if [[ ! -d "$PROJECT" ]]; then
    echo "Project not found: $PROJECT"
    exit 1
  fi
  container_args=(-project "$PROJECT")
else
  echo "No .xcworkspace or .xcodeproj found."
  exit 1
fi

find_default_scheme() {
  xcodebuild -list "${container_args[@]}" | awk '
    /^[[:space:]]*Schemes:/ { in_schemes = 1; next }
    in_schemes && NF {
      gsub(/^[[:space:]]+/, "", $0)
      print $0
      exit
    }
  '
}

SCHEME="${IOS_SCHEME:-$(find_default_scheme)}"
if [[ -z "${SCHEME:-}" ]]; then
  echo "No scheme found. Set IOS_SCHEME in .xcdev.env."
  exit 1
fi

CONFIGURATION="${IOS_CONFIGURATION:-Debug}"
ENABLE_DEBUG_DYLIB="${IOS_ENABLE_DEBUG_DYLIB:-NO}"
BUNDLE_ID_OVERRIDE="${IOS_BUNDLE_ID:-}"
SIM_NAME="${IOS_SIM_NAME:-iPhone 17}"
SIM_VERSION="${IOS_SIM_VERSION:-}"
SIM_UDID="${IOS_SIM_UDID:-}"
SIM_RESOLVED_NAME="${IOS_SIM_RESOLVED_NAME:-}"
SIM_RUNTIME="${IOS_SIM_RUNTIME:-}"
DEVICE_NAME_PATTERN="${IOS_DEVICE_NAME_PATTERN:-.*}"
OPEN_SIMULATOR="${IOS_OPEN_SIMULATOR:-YES}"

if [[ -n "$TARGET_VALUE" ]]; then
  if [[ "$MODE" == "sim" ]]; then
    SIM_NAME="$TARGET_VALUE"
  else
    DEVICE_NAME_PATTERN="$TARGET_VALUE"
  fi
fi

if [[ -n "$SIM_RESOLVED_NAME" ]]; then
  SIM_NAME="$SIM_RESOLVED_NAME"
fi

TARGET_BUILD_DIR=""
WRAPPER_NAME=""
PRODUCT_BUNDLE_IDENTIFIER=""

resolve_build_output() {
  local destination="$1"
  local build_settings
  build_settings="$(
    xcodebuild \
      "${container_args[@]}" \
      -scheme "$SCHEME" \
      -configuration "$CONFIGURATION" \
      -destination "$destination" \
      "ENABLE_DEBUG_DYLIB=$ENABLE_DEBUG_DYLIB" \
      -showBuildSettings
  )"

  TARGET_BUILD_DIR="$(printf '%s\n' "$build_settings" | sed -n 's/^[[:space:]]*TARGET_BUILD_DIR = //p' | tail -n 1)"
  WRAPPER_NAME="$(printf '%s\n' "$build_settings" | sed -n 's/^[[:space:]]*WRAPPER_NAME = //p' | tail -n 1)"
  PRODUCT_BUNDLE_IDENTIFIER="$(printf '%s\n' "$build_settings" | sed -n 's/^[[:space:]]*PRODUCT_BUNDLE_IDENTIFIER = //p' | tail -n 1)"
}

resolve_bundle_id_from_plist() {
  local app_path="$1"
  /usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$app_path/Info.plist" 2>/dev/null || true
}

open_simulator_app() {
  local udid="$1"
  open -a Simulator --args -CurrentDeviceUDID "$udid" >/dev/null 2>&1 ||
    open -a Simulator >/dev/null 2>&1 || true
}

run_on_simulator() {
  local udid app_path bundle_id
  udid="$SIM_UDID"
  if [[ -n "${udid:-}" ]]; then
    xcrun simctl boot "$udid" || true
    xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || true
  else
    echo "Simulator UDID is not resolved."
    exit 1
  fi

  if [[ "$ACTION" == "run" && "$OPEN_SIMULATOR" == "YES" ]]; then
    open_simulator_app "$udid"
  fi

  xcodebuild \
    "${container_args[@]}" \
    -scheme "$SCHEME" \
    -configuration "$CONFIGURATION" \
    -destination "id=$udid" \
    "ENABLE_DEBUG_DYLIB=$ENABLE_DEBUG_DYLIB" \
    build

  if [[ "$ACTION" == "build" ]]; then
    if [[ -n "$SIM_VERSION" ]]; then
      echo "Build completed on $SIM_NAME iOS $SIM_VERSION ($udid)."
    elif [[ -n "$SIM_RUNTIME" ]]; then
      echo "Build completed on $SIM_NAME $SIM_RUNTIME ($udid)."
    else
      echo "Build completed on $SIM_NAME ($udid)."
    fi
    exit 0
  fi

  resolve_build_output "id=$udid"
  app_path="$TARGET_BUILD_DIR/$WRAPPER_NAME"
  if [[ -z "${TARGET_BUILD_DIR:-}" || -z "${WRAPPER_NAME:-}" || ! -d "$app_path" ]]; then
    echo "Built app not found in DerivedData."
    exit 1
  fi

  bundle_id="$BUNDLE_ID_OVERRIDE"
  if [[ -z "${bundle_id:-}" ]]; then
    bundle_id="$PRODUCT_BUNDLE_IDENTIFIER"
  fi
  if [[ -z "${bundle_id:-}" ]]; then
    bundle_id="$(resolve_bundle_id_from_plist "$app_path")"
  fi
  if [[ -z "${bundle_id:-}" ]]; then
    echo "Cannot resolve bundle id. Set IOS_BUNDLE_ID or verify app Info.plist."
    exit 1
  fi

  xcrun simctl install "$udid" "$app_path"
  xcrun simctl launch "$udid" "$bundle_id"
  if [[ -n "$SIM_VERSION" ]]; then
    echo "Run completed on $SIM_NAME iOS $SIM_VERSION ($udid)."
  elif [[ -n "$SIM_RUNTIME" ]]; then
    echo "Run completed on $SIM_NAME $SIM_RUNTIME ($udid)."
  else
    echo "Run completed on $SIM_NAME ($udid)."
  fi
}

run_on_real_device() {
  xctrace_devices_output() {
    xcrun xctrace list devices
  }

  find_connected_device_udid() {
    local devices_output
    devices_output="$(xctrace_devices_output)"
    printf '%s\n' "$devices_output" |
      awk -v pattern="$DEVICE_NAME_PATTERN" '
        BEGIN { in_offline = 0 }
        $0 == "== Devices Offline ==" { in_offline = 1; next }
        $0 == "== Simulators ==" { exit }
        in_offline { next }
        $0 ~ /MacBook/ || $0 ~ /Simulator/ { next }
        $0 ~ pattern {
          line = $0
          while (match(line, /\(([A-Fa-f0-9-]{8,})\)/)) {
            udid = substr(line, RSTART + 1, RLENGTH - 2)
            line = substr(line, RSTART + RLENGTH)
          }
          if (udid != "") {
            print udid
            exit
          }
        }
      '
  }

  find_first_connected_device_udid() {
    local devices_output
    devices_output="$(xctrace_devices_output)"
    printf '%s\n' "$devices_output" |
      awk '
        BEGIN { in_offline = 0 }
        $0 == "== Devices Offline ==" { in_offline = 1; next }
        $0 == "== Simulators ==" { exit }
        in_offline { next }
        $0 ~ /MacBook/ || $0 ~ /Simulator/ { next }
        {
          line = $0
          while (match(line, /\(([A-Fa-f0-9-]{8,})\)/)) {
            udid = substr(line, RSTART + 1, RLENGTH - 2)
            line = substr(line, RSTART + RLENGTH)
          }
          if (udid != "") {
            print udid
            exit
          }
        }
      '
  }

  local udid app_path bundle_id
  udid="$(find_connected_device_udid)"
  if [[ -z "${udid:-}" ]]; then
    local fallback_udid
    fallback_udid="$(find_first_connected_device_udid)"
    if [[ -z "${fallback_udid:-}" ]]; then
      echo "No connected real device found."
      exit 1
    fi
    echo "No connected real device matching pattern '$DEVICE_NAME_PATTERN'. Fallback to first connected device ($fallback_udid)."
    udid="$fallback_udid"
  fi

  xcodebuild \
    "${container_args[@]}" \
    -scheme "$SCHEME" \
    -configuration "$CONFIGURATION" \
    -destination "id=$udid" \
    "ENABLE_DEBUG_DYLIB=$ENABLE_DEBUG_DYLIB" \
    build

  if [[ "$ACTION" == "build" ]]; then
    echo "Build completed on real device ($udid)."
    exit 0
  fi

  resolve_build_output "id=$udid"
  app_path="$TARGET_BUILD_DIR/$WRAPPER_NAME"
  if [[ -z "${TARGET_BUILD_DIR:-}" || -z "${WRAPPER_NAME:-}" || ! -d "$app_path" ]]; then
    echo "Built device app not found in DerivedData."
    exit 1
  fi

  bundle_id="$BUNDLE_ID_OVERRIDE"
  if [[ -z "${bundle_id:-}" ]]; then
    bundle_id="$PRODUCT_BUNDLE_IDENTIFIER"
  fi
  if [[ -z "${bundle_id:-}" ]]; then
    bundle_id="$(resolve_bundle_id_from_plist "$app_path")"
  fi
  if [[ -z "${bundle_id:-}" ]]; then
    echo "Cannot resolve bundle id. Set IOS_BUNDLE_ID or verify app Info.plist."
    exit 1
  fi

  xcrun devicectl device install app --device "$udid" "$app_path"
  xcrun devicectl device process launch --device "$udid" "$bundle_id"
  echo "Run completed on real device ($udid)."
}

if [[ "$MODE" == "sim" ]]; then
  run_on_simulator
else
  run_on_real_device
fi
