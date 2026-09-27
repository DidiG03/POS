#!/usr/bin/env bash
#
# Update every OneTap Waiter phone on this Wi-Fi to the latest release,
# over Android wireless debugging. Run it on the till Mac.
#
#   ./update-waiter-phones.sh                    update all paired phones
#   ./update-waiter-phones.sh --pair IP:PORT CODE    pair a phone (once)
#   ./update-waiter-phones.sh --connect IP:PORT  also try this phone directly
#   ./update-waiter-phones.sh --apk FILE         install this APK instead
#   ./update-waiter-phones.sh --reinstall        replace a debug build (wipes
#                                                that phone's app data)
#
# Pairing, once per phone: Settings > Developer options > Wireless debugging >
# "Pair device with pairing code", then run --pair with the IP:port and the
# six-digit code shown on the phone.
#
# `adb install -r` keeps the app's data (till address, pairing, orders that
# are still queued). Installing closes the app on the phone for a few
# seconds, so run it when service is quiet.

set -u

REPO="DidiG03/POS"
PACKAGE="com.codeorbit.waiter"
ACTIVITY="${PACKAGE}/.MainActivity"
SUPPORT_DIR="${HOME}/Library/Application Support/OneTap"
TOOLS_URL="https://dl.google.com/android/repository/platform-tools-latest-darwin.zip"

APK=""
PAIR_TARGET=""
PAIR_CODE=""
CONNECT_TARGETS=""
REINSTALL=0
ASSUME_YES=0

say() { printf '%s\n' "$*"; }
fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --pair)
      [ $# -ge 3 ] || fail "--pair needs IP:PORT and the pairing code"
      PAIR_TARGET="$2"
      PAIR_CODE="$3"
      shift 3
      ;;
    --connect)
      [ $# -ge 2 ] || fail "--connect needs IP:PORT"
      CONNECT_TARGETS="${CONNECT_TARGETS} $2"
      shift 2
      ;;
    --apk)
      [ $# -ge 2 ] || fail "--apk needs a file"
      APK="$2"
      shift 2
      ;;
    --reinstall) REINSTALL=1; shift ;;
    --yes | -y) ASSUME_YES=1; shift ;;
    -h | --help) usage ;;
    *) fail "Unknown option: $1 (see --help)" ;;
  esac
done

# ---------------------------------------------------------------- adb

find_adb() {
  if command -v adb >/dev/null 2>&1; then
    command -v adb
    return
  fi
  for c in \
    "${HOME}/Library/Android/sdk/platform-tools/adb" \
    "${SUPPORT_DIR}/platform-tools/adb"; do
    if [ -x "$c" ]; then
      printf '%s\n' "$c"
      return
    fi
  done
}

ADB="$(find_adb)"
if [ -z "$ADB" ]; then
  say "Android platform-tools (adb) not found. Downloading from Google..."
  mkdir -p "$SUPPORT_DIR" || fail "cannot create $SUPPORT_DIR"
  tmp_zip="${SUPPORT_DIR}/platform-tools.zip"
  curl -fL --retry 3 -o "$tmp_zip" "$TOOLS_URL" ||
    fail "could not download platform-tools"
  rm -rf "${SUPPORT_DIR}/platform-tools"
  unzip -q "$tmp_zip" -d "$SUPPORT_DIR" || fail "could not unpack platform-tools"
  rm -f "$tmp_zip"
  ADB="${SUPPORT_DIR}/platform-tools/adb"
  [ -x "$ADB" ] || fail "adb missing after download"
fi

"$ADB" start-server >/dev/null 2>&1 || fail "adb server did not start"

if [ -n "$PAIR_TARGET" ]; then
  say "Pairing with ${PAIR_TARGET}..."
  "$ADB" pair "$PAIR_TARGET" "$PAIR_CODE" || fail "pairing failed"
  say "Paired. The phone will be found automatically from now on."
  say "Run this script again without --pair to update it."
  exit 0
fi

# ---------------------------------------------------------------- APK

# "1.2.3" -> "001002003" so plain string comparison orders versions.
version_key() {
  printf '%s\n' "$1" | awk -F. '{ printf "%03d%03d%03d\n", $1, $2, $3 }'
}

TARGET_VERSION=""
if [ -n "$APK" ]; then
  [ -f "$APK" ] || fail "APK not found: $APK"
  TARGET_VERSION="$(basename "$APK" | sed -n 's/.*-\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)\.apk$/\1/p')"
else
  say "Looking up the latest OneTap Waiter release..."
  # The releases page redirects to the newest tag. Unlike the GitHub API it
  # has no 60-requests-an-hour limit, which shared venue connections hit.
  latest="$(curl -fsSL --retry 3 -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO}/releases/latest")" ||
    fail "could not reach GitHub"
  TARGET_VERSION="$(printf '%s\n' "$latest" |
    sed -n 's#.*/releases/tag/v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$#\1#p')"
  [ -n "$TARGET_VERSION" ] || fail "could not find the latest release"
  name="OneTap-Waiter-${TARGET_VERSION}.apk"
  url="https://github.com/${REPO}/releases/download/v${TARGET_VERSION}/${name}"
  mkdir -p "${SUPPORT_DIR}/apk" || fail "cannot create ${SUPPORT_DIR}/apk"
  APK="${SUPPORT_DIR}/apk/${name}"
  if [ ! -s "$APK" ]; then
    say "Downloading ${name}..."
    if ! curl -fL --retry 3 -o "${APK}.part" "$url"; then
      rm -f "${APK}.part"
      fail "could not download ${name} (the latest release may not have a Waiter APK yet)"
    fi
    mv "${APK}.part" "$APK"
  fi
fi
say "Installing: $(basename "$APK")${TARGET_VERSION:+ (version ${TARGET_VERSION})}"

# ---------------------------------------------------------------- phones

for target in $CONNECT_TARGETS; do
  "$ADB" connect "$target" >/dev/null 2>&1
done

# Paired phones advertise themselves on the Wi-Fi; give discovery a moment,
# then connect to each one it found (a no-op for ones already connected).
sleep 3
"$ADB" mdns services 2>/dev/null |
  awk '$2 ~ /_adb-tls-connect/ { print $3 }' |
  while read -r target; do
    [ -n "$target" ] && "$ADB" connect "$target" >/dev/null 2>&1
  done
sleep 1

SERIALS="$("$ADB" devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
if [ -z "$SERIALS" ]; then
  say ""
  say "No phones found. On each phone check that Wireless debugging is on"
  say "(it switches off after a restart or a Wi-Fi change), that it is on"
  say "this Wi-Fi, and that it was paired with --pair."
  exit 1
fi

updated=0
current=0
failed=0
seen=" "

for serial in $SERIALS; do
  # One phone can show up twice (found on the network and connected by
  # address). Its hardware serial tells the two apart.
  hw="$("$ADB" -s "$serial" shell -n getprop ro.serialno 2>/dev/null | tr -d '\r')"
  case "$seen" in *" ${hw:-$serial} "*) continue ;; esac
  seen="${seen}${hw:-$serial} "

  model="$("$ADB" -s "$serial" shell -n getprop ro.product.model 2>/dev/null | tr -d '\r')"
  label="${model:-phone} (${serial})"
  installed="$("$ADB" -s "$serial" shell -n dumpsys package "$PACKAGE" 2>/dev/null |
    tr -d '\r' | sed -n 's/^ *versionName=//p' | head -n 1)"

  if [ -n "$installed" ] && [ -n "$TARGET_VERSION" ] &&
    [ ! "$(version_key "$installed")" \< "$(version_key "$TARGET_VERSION")" ]; then
    say "  ${label}: already on ${installed}"
    current=$((current + 1))
    continue
  fi

  say "  ${label}: ${installed:-not installed} -> ${TARGET_VERSION:-new}..."
  out="$("$ADB" -s "$serial" install -r "$APK" 2>&1)"
  if printf '%s' "$out" | grep -q 'Success'; then
    "$ADB" -s "$serial" shell -n am start -n "$ACTIVITY" >/dev/null 2>&1
    say "    updated"
    updated=$((updated + 1))
    continue
  fi

  if printf '%s' "$out" | grep -q 'INSTALL_FAILED_UPDATE_INCOMPATIBLE'; then
    if [ "$REINSTALL" -ne 1 ]; then
      say "    this phone has a build signed with a different key (the old"
      say "    debug install). Run again with --reinstall to replace it."
      failed=$((failed + 1))
      continue
    fi
    if [ "$ASSUME_YES" -ne 1 ]; then
      say "    Replacing it deletes the app's data on this phone: the saved"
      say "    till address, the pairing, and any orders not yet sent."
      printf '    Make sure it has no unsent orders. Replace it now? [y/N] '
      answer=""
      { read -r answer </dev/tty; } 2>/dev/null || answer=""
      case "$answer" in
        y | Y | yes | YES) ;;
        *)
          say "    skipped"
          failed=$((failed + 1))
          continue
          ;;
      esac
    fi
    "$ADB" -s "$serial" uninstall "$PACKAGE" >/dev/null 2>&1
    out="$("$ADB" -s "$serial" install "$APK" 2>&1)"
    if printf '%s' "$out" | grep -q 'Success'; then
      "$ADB" -s "$serial" shell -n am start -n "$ACTIVITY" >/dev/null 2>&1
      say "    reinstalled: sign in again and re-pair it with the till"
      updated=$((updated + 1))
      continue
    fi
  fi

  say "    FAILED: $(printf '%s' "$out" | tail -n 1)"
  failed=$((failed + 1))
done

say ""
say "Done: ${updated} updated, ${current} already current, ${failed} need attention."
[ "$failed" -eq 0 ]
