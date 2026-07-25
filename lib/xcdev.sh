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

if ! xcodebuild -version &>/dev/null; then
  echo "Error: xcode-select is pointing to Command Line Tools, not Xcode."
  echo ""
  echo "Run the following command to fix:"
  echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
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

container_display_name() {
  local container_path
  if [[ -n "${WORKSPACE:-}" ]]; then
    container_path="$WORKSPACE"
  else
    container_path="$PROJECT"
  fi

  container_path="$(basename "$container_path")"
  printf '%s\n' "${container_path%.*}"
}

list_xcodebuild_section() {
  local section="$1"
  awk -v requested_section="$section" '
    /^[[:space:]]*(Targets|Build Configurations|Schemes):[[:space:]]*$/ {
      current_section = $0
      gsub(/^[[:space:]]+|[[:space:]]*:?[[:space:]]*$/, "", current_section)
      next
    }
    current_section == requested_section && NF {
      value = $0
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      print value
    }
  '
}

list_resolved_package_names() {
  awk '
    /^[[:space:]]*Resolved source packages:[[:space:]]*$/ {
      in_packages = 1
      next
    }
    /^[[:space:]]*Information about (project|workspace)/ {
      in_packages = 0
    }
    in_packages && /^[[:space:]]+[^:]+:/ {
      value = $0
      gsub(/^[[:space:]]+/, "", value)
      sub(/:.*/, "", value)
      print value
    }
  '
}

find_local_scheme_files() {
  if [[ -n "${PROJECT:-}" ]]; then
    find "$PROJECT" -type f -name "*.xcscheme" -path "*/xcschemes/*" -print
    return
  fi

  # Workspace schemes can live in the workspace itself or in one of its local
  # projects. Prune conventional dependency/build directories so package and
  # generated schemes are not mistaken for project-owned schemes.
  find "$ROOT_DIR" \
    \( -type d \( \
      -name .git -o \
      -name .build -o \
      -name build -o \
      -name DerivedData -o \
      -name Pods -o \
      -name Carthage -o \
      -name SourcePackages \
    \) -prune \) -o \
    \( -type f -name "*.xcscheme" -path "*/xcschemes/*" -print \)
}

list_local_scheme_names() {
  local scheme_path filename
  while IFS= read -r scheme_path; do
    [[ -z "$scheme_path" ]] && continue
    filename="$(basename "$scheme_path")"
    printf '%s\n' "${filename%.xcscheme}"
  done < <(find_local_scheme_files)
}

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

print_ambiguous_schemes() {
  local container_name="$1"
  shift

  echo "Unable to choose a scheme automatically for '$container_name'." >&2
  echo "Candidate schemes:" >&2
  local scheme
  for scheme in "$@"; do
    echo "  $scheme" >&2
  done
  echo "Set IOS_SCHEME in .xcdev.env, run 'xcdev set scheme <name>', or pass '--scheme <name>'." >&2
}

find_default_scheme() {
  local list_output container_name scheme package_name local_scheme_name
  local scheme_lower package_lower is_local is_package
  local -a schemes=()
  local -a package_names=()
  local -a local_scheme_names=()
  local -a candidates=()

  list_output="$(xcodebuild -list "${container_args[@]}")"
  container_name="$(container_display_name)"

  while IFS= read -r scheme; do
    [[ -n "$scheme" ]] && schemes+=("$scheme")
  done < <(printf '%s\n' "$list_output" | list_xcodebuild_section "Schemes")

  if [[ ${#schemes[@]} -eq 0 ]]; then
    echo "No scheme found for '$container_name'. Set IOS_SCHEME in .xcdev.env." >&2
    return 1
  fi

  while IFS= read -r package_name; do
    [[ -n "$package_name" ]] && package_names+=("$package_name")
  done < <(printf '%s\n' "$list_output" | list_resolved_package_names)

  while IFS= read -r local_scheme_name; do
    [[ -n "$local_scheme_name" ]] && local_scheme_names+=("$local_scheme_name")
  done < <(list_local_scheme_names)

  # Keep all unknown schemes. A scheme is excluded only when its name matches
  # a resolved Swift Package and no local .xcscheme with that name exists.
  for scheme in "${schemes[@]}"; do
    is_local=0
    for local_scheme_name in "${local_scheme_names[@]-}"; do
      [[ -z "$local_scheme_name" ]] && continue
      if [[ "$scheme" == "$local_scheme_name" ]]; then
        is_local=1
        break
      fi
    done

    is_package=0
    if [[ "$is_local" -eq 0 ]]; then
      scheme_lower="$(lowercase "$scheme")"
      for package_name in "${package_names[@]-}"; do
        [[ -z "$package_name" ]] && continue
        package_lower="$(lowercase "$package_name")"
        if [[ "$scheme_lower" == "$package_lower" ]]; then
          is_package=1
          break
        fi
      done
    fi

    if [[ "$is_package" -eq 0 ]]; then
      candidates+=("$scheme")
    fi
  done

  if [[ ${#candidates[@]} -eq 0 ]]; then
    echo "No non-package scheme found for '$container_name'. Set IOS_SCHEME in .xcdev.env." >&2
    return 1
  fi

  # The container's own non-package scheme is the strongest automatic signal.
  for scheme in "${candidates[@]}"; do
    if [[ "$scheme" == "$container_name" ]]; then
      printf '%s\n' "$scheme"
      return 0
    fi
  done

  if [[ ${#candidates[@]} -eq 1 ]]; then
    printf '%s\n' "${candidates[0]}"
    return 0
  fi

  print_ambiguous_schemes "$container_name" "${candidates[@]}"
  return 1
}

SCHEME="${XCDEV_SCHEME_OVERRIDE:-${IOS_SCHEME:-}}"
if [[ -z "${SCHEME:-}" ]]; then
  SCHEME="$(find_default_scheme)"
fi
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
CLEAN_BUILD="${IOS_CLEAN_BUILD:-YES}"
SKIP_MACRO_VALIDATION="${XCDEV_SKIP_MACRO_VALIDATION_OVERRIDE:-${IOS_SKIP_MACRO_VALIDATION:-NO}}"

MACRO_VALIDATION_ARG=""
case "$SKIP_MACRO_VALIDATION" in
  YES|yes|TRUE|true|1)
    MACRO_VALIDATION_ARG="-skipMacroValidation"
    ;;
  NO|no|FALSE|false|0)
    ;;
  *)
    echo "Invalid IOS_SKIP_MACRO_VALIDATION value: $SKIP_MACRO_VALIDATION (expected YES or NO)."
    exit 1
    ;;
esac

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

run_xcodebuild() {
  local destination="$1"
  local build_actions=(build)
  local xcodebuild_args=(
    "${container_args[@]}"
    -scheme "$SCHEME"
    -configuration "$CONFIGURATION"
    -destination "$destination"
    "ENABLE_DEBUG_DYLIB=$ENABLE_DEBUG_DYLIB"
  )
  local build_log status

  case "$CLEAN_BUILD" in
    YES|yes|TRUE|true|1)
      build_actions=(clean build)
      echo "Performing a clean build to avoid installing stale output."
      ;;
    NO|no|FALSE|false|0)
      ;;
    *)
      echo "Invalid IOS_CLEAN_BUILD value: $CLEAN_BUILD (expected YES or NO)."
      exit 1
      ;;
  esac

  if [[ -n "$MACRO_VALIDATION_ARG" ]]; then
    xcodebuild_args+=("$MACRO_VALIDATION_ARG")
  fi

  build_log="$(mktemp "${TMPDIR:-/tmp}/xcdev-xcodebuild.XXXXXX")"
  if xcodebuild "${xcodebuild_args[@]}" "${build_actions[@]}" \
      > >(tee -a "$build_log") \
      2> >(tee -a "$build_log" >&2); then
    status=0
  else
    status=$?
  fi
  wait || true

  if [[ "$status" -eq 0 ]]; then
    rm -f "$build_log"
    return 0
  fi

  if [[ -z "$MACRO_VALIDATION_ARG" ]] &&
    grep -Eiq 'macro .*must be enabled before it can be used' "$build_log"; then
    echo "" >&2
    echo "Swift macro validation blocked this build." >&2
    echo "Review the macro, then open the project in Xcode and approve it if you trust it." >&2
    echo "Alternatively, rerun with 'xcdev $ACTION --skip-macro-validation ...' or set" >&2
    echo "IOS_SKIP_MACRO_VALIDATION=YES in .xcdev.env to bypass validation for trusted macros." >&2
  fi

  rm -f "$build_log"
  return "$status"
}

resolve_build_output() {
  local destination="$1"
  local build_settings
  local xcodebuild_args=(
    "${container_args[@]}"
    -scheme "$SCHEME"
    -configuration "$CONFIGURATION"
    -destination "$destination"
    "ENABLE_DEBUG_DYLIB=$ENABLE_DEBUG_DYLIB"
  )
  if [[ -n "$MACRO_VALIDATION_ARG" ]]; then
    xcodebuild_args+=("$MACRO_VALIDATION_ARG")
  fi
  build_settings="$(
    xcodebuild "${xcodebuild_args[@]}" -showBuildSettings
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

  run_xcodebuild "id=$udid"

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
  xcodebuild_destinations_output() {
    xcodebuild \
      "${container_args[@]}" \
      -scheme "$SCHEME" \
      -configuration "$CONFIGURATION" \
      "ENABLE_DEBUG_DYLIB=$ENABLE_DEBUG_DYLIB" \
      -showdestinations 2>/dev/null || true
  }

  find_xcodebuild_ios_destination_udid() {
    local destinations_output
    destinations_output="$(xcodebuild_destinations_output)"
    printf '%s\n' "$destinations_output" |
      awk -v pattern="$DEVICE_NAME_PATTERN" '
        /^[[:space:]]*Available destinations/ { in_available = 1; next }
        /^[[:space:]]*Ineligible destinations/ { in_available = 0; next }
        in_available && /platform:iOS,/ &&
          $0 !~ /platform:iOS Simulator/ &&
          $0 !~ /dvtdevice-/ &&
          $0 !~ /error:/ &&
          $0 ~ pattern {
          if (match($0, /id:[^,}]+/)) {
            print substr($0, RSTART + 3, RLENGTH - 3)
            exit
          }
        }
      '
  }

  find_first_xcodebuild_ios_destination_udid() {
    local destinations_output
    destinations_output="$(xcodebuild_destinations_output)"
    printf '%s\n' "$destinations_output" |
      awk '
        /^[[:space:]]*Available destinations/ { in_available = 1; next }
        /^[[:space:]]*Ineligible destinations/ { in_available = 0; next }
        in_available && /platform:iOS,/ &&
          $0 !~ /platform:iOS Simulator/ &&
          $0 !~ /dvtdevice-/ &&
          $0 !~ /error:/ {
          if (match($0, /id:[^,}]+/)) {
            print substr($0, RSTART + 3, RLENGTH - 3)
            exit
          }
        }
      '
  }

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
        $0 ~ /Simulator/ { next }
        $0 ~ pattern {
          udid = ""
          os = ""
          line = $0
          while (match(line, /\([^)]+\)/)) {
            token = substr(line, RSTART + 1, RLENGTH - 2)
            if (token ~ /^[A-Fa-f0-9-]{8,}$/) {
              udid = token
            } else if (token ~ /^[0-9]+(\.[0-9]+)*$/) {
              os = token
            }
            line = substr(line, RSTART + RLENGTH)
          }
          if (udid != "" && os != "") {
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
        $0 ~ /Simulator/ { next }
        {
          udid = ""
          os = ""
          line = $0
          while (match(line, /\([^)]+\)/)) {
            token = substr(line, RSTART + 1, RLENGTH - 2)
            if (token ~ /^[A-Fa-f0-9-]{8,}$/) {
              udid = token
            } else if (token ~ /^[0-9]+(\.[0-9]+)*$/) {
              os = token
            }
            line = substr(line, RSTART + RLENGTH)
          }
          if (udid != "" && os != "") {
            print udid
            exit
          }
        }
      '
  }

  local udid app_path bundle_id
  udid="$(find_xcodebuild_ios_destination_udid)"
  if [[ -z "${udid:-}" ]]; then
    udid="$(find_connected_device_udid)"
  fi
  if [[ -z "${udid:-}" ]]; then
    local fallback_udid
    fallback_udid="$(find_first_xcodebuild_ios_destination_udid)"
    if [[ -z "${fallback_udid:-}" ]]; then
      fallback_udid="$(find_first_connected_device_udid)"
    fi
    if [[ -z "${fallback_udid:-}" ]]; then
      echo "No connected real device found."
      exit 1
    fi
    echo "No connected real device matching pattern '$DEVICE_NAME_PATTERN'. Fallback to first connected device ($fallback_udid)."
    udid="$fallback_udid"
  fi

  run_xcodebuild "id=$udid"

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
