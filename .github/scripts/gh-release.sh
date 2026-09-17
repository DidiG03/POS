#!/usr/bin/env bash
# Shared helpers for tag-release workflows that all publish onto the same GitHub
# Release. Concurrent `gh release create/edit/upload --clobber` calls 404 when
# GitHub invalidates an upload URL mid-flight.

gh_ensure_release() {
  local tag="$1"
  local title="$2"
  local notes="$3"
  local i
  local -a create_args=(--title "$title")
  if [[ -f "$notes" ]]; then
    create_args+=(--notes-file "$notes")
  else
    create_args+=(--notes "$notes")
  fi
  for i in 1 2 3 4 5 6; do
    if gh release view "$tag" >/dev/null 2>&1; then
      return 0
    fi
    gh release create "$tag" "${create_args[@]}" || true
    sleep $((i * 4))
  done
  if ! gh release view "$tag" >/dev/null 2>&1; then
    echo "::error::Could not create or find release $tag"
    return 1
  fi
}

gh_upload_with_retry() {
  local tag="$1"
  shift
  local n=0
  local delay
  while true; do
    if gh release upload "$tag" "$@" --clobber; then
      return 0
    fi
    n=$((n + 1))
    if [[ $n -ge 6 ]]; then
      echo "::error::gh release upload failed after ${n} attempts"
      return 1
    fi
    delay=$((n * 12))
    echo "Upload failed (attempt $n); retrying in ${delay}s..."
    sleep "$delay"
  done
}
