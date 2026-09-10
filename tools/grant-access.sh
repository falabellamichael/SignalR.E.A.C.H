#!/usr/bin/env bash
# SignalR.E.A.C.H — controlled handout of the (private) repository.
#
# The repo is private, so nobody can clone it anonymously. This script is the
# single place you hand access out and take it back. It never stores or prints
# a token: it uses your existing `gh` login.
#
# Usage:
#   ./tools/grant-access.sh invite  <github-user> [--read|--write]   # add a person
#   ./tools/grant-access.sh revoke  <github-user>                    # remove a person
#   ./tools/grant-access.sh list                                     # who has access
#   ./tools/grant-access.sh audit                                    # flag risky perms
#   ./tools/grant-access.sh bundle  [out-file.tar.gz]                # code-only archive
#
# `--read` (default) is the safe choice for "let them run it": they can clone
# and pull, but cannot push changes back into your repo.
set -euo pipefail

REPO="falabellamichael/SignalR.E.A.C.H"
GH="${GH_BIN:-$HOME/.local/bin/gh}"
command -v "$GH" >/dev/null 2>&1 || GH="gh"
command -v "$GH" >/dev/null 2>&1 || { echo "error: gh not found (set GH_BIN)" >&2; exit 1; }

die() { echo "error: $*" >&2; exit 1; }

cmd_invite() {
    local user="${1:-}"; shift || true
    [ -n "$user" ] || die "usage: invite <github-user> [--read|--write]"
    local perm="pull"
    for a in "$@"; do
        case "$a" in
            --read)  perm="pull" ;;
            --write) perm="push" ;;
            *) die "unknown flag: $a" ;;
        esac
    done
    "$GH" api -X PUT "repos/$REPO/collaborators/$user" -f permission="$perm" >/dev/null
    echo "invited $user to $REPO with permission=$perm"
    echo "they must ACCEPT the invitation: https://github.com/$REPO/invitations"
}

cmd_revoke() {
    local user="${1:-}"
    [ -n "$user" ] || die "usage: revoke <github-user>"
    "$GH" api -X DELETE "repos/$REPO/collaborators/$user" >/dev/null 2>&1 \
        || die "could not remove $user (may not be a collaborator)"
    echo "revoked $user from $REPO"
}

cmd_list() {
    echo "Collaborators on $REPO:"
    "$GH" api "repos/$REPO/collaborators" \
        --jq '.[] | "  \(.login)\t\(.role_name)"' 2>/dev/null || echo "  (unable to read)"
}

cmd_audit() {
    echo "Access audit for $REPO"
    "$GH" api "repos/$REPO" --jq '"  visibility: \(.visibility)"'
    local admins
    admins=$("$GH" api "repos/$REPO/collaborators" \
        --jq '.[] | select(.role_name=="admin" or .permissions.admin==true) | .login' 2>/dev/null || true)
    if [ -n "$admins" ]; then
        echo "  !! ADMIN (can change visibility / delete / re-add people):"
        echo "$admins" | sed 's/^/     - /'
    else
        echo "  no extra admins — good"
    fi
    local writers
    writers=$("$GH" api "repos/$REPO/collaborators" \
        --jq '.[] | select((.permissions.push==true) and (.permissions.admin!=true)) | .login' 2>/dev/null || true)
    if [ -n "$writers" ]; then
        echo "  write access (can push code):"
        echo "$writers" | sed 's/^/     - /'
    fi
}

# A code-only archive built from GIT-TRACKED files only. That deliberately
# leaves out .git (no history to rewrite, no remote pointing back at your
# private repo) and any local build artifacts such as the Electron .dmg in
# copilot/tray/dist, which is gitignored and can be ~90MB on its own.
# Good for "here is the code, run it" without handing over your git remote.
cmd_bundle() {
    local out="${1:-signal-reach-source.tar.gz}"
    local root
    root="$(cd "$(dirname "$0")/.." && pwd)"
    case "$out" in /*) ;; *) out="$root/$out" ;; esac
    ( cd "$root" && git archive --format=tar.gz -o "$out" HEAD )
    echo "wrote $out ($(du -h "$out" | cut -f1))"
    echo "files: $(tar -tzf "$out" | wc -l | tr -d ' ') (git-tracked only)"
    echo "note: no .git, so this cannot be pushed back to $REPO."
}

case "${1:-}" in
    invite) shift; cmd_invite "$@" ;;
    revoke) shift; cmd_revoke "$@" ;;
    list)   cmd_list ;;
    audit)  cmd_audit ;;
    bundle) shift; cmd_bundle "$@" ;;
    *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' ; exit 1 ;;
esac
