#!/usr/bin/env bash
# Builds one project folder per demo: a copy of copilot-avalonia plus the files of that demo in demos/.
# Each folder is its own git repo, because the app finds extensions only at the git root.
# Next to each folder goes its .txt, with the prompts and commands of that demo.
# Usage: bash setup.sh [folder]    (default: ~/copilot-talk)
#
# Run it again after a git pull: it rebuilds the folders it made, in the same place, so the app keeps them
# as the same projects, with the trust you already gave.
# Override the sample with COPILOT_AVALONIA_SOURCE=<url or folder> and COPILOT_AVALONIA_REF=<commit>.
set -euo pipefail

target="${1:-$HOME/copilot-talk}"
source_repo="${COPILOT_AVALONIA_SOURCE:-https://github.com/jsuarezruiz/copilot-avalonia.git}"
# The demos were measured on this commit.
source_ref="${COPILOT_AVALONIA_REF:-75c0022bc79f4a2148bd8e42f3d0cea5e783ac09}"
kit="$(cd "$(dirname "$0")" && pwd)"
projects="00-baseline 01-instructions 02-skill 03-agent 03b-hierarchy 04-mcp 05-lsp 06-hooks 07-extension 07b-workflow 08-canvas 09-real-canvas"

if ! git config user.name > /dev/null || ! git config user.email > /dev/null; then
  echo "setup.sh commits each folder, so set your git identity first: git config --global user.name \"Your Name\" and user.email." >&2
  exit 1
fi

sample="$(mktemp -d)"
trap 'rm -rf "$sample"' EXIT
echo "Fetching copilot-avalonia at ${source_ref:0:7}"
git clone --quiet "$source_repo" "$sample"
git -C "$sample" checkout --quiet "$source_ref"

mkdir -p "$target"
target="$(cd "$target" && pwd)"
for name in $projects; do
  dest="$target/$name"
  # Only a folder that setup.sh made is replaced: its first commit is "Demo <name>".
  if [ -e "$dest" ]; then
    if [ ! -d "$dest/.git" ] || [ "$(git -C "$dest" log --max-parents=0 --format=%s HEAD 2> /dev/null)" != "Demo $name" ]; then
      echo "$dest already exists and setup.sh did not make it. Move it or pick another folder." >&2
      exit 1
    fi
    rm -rf "$dest"
  fi
  mkdir -p "$dest"
  git -C "$sample" archive HEAD | tar -x -C "$dest"
  # Only demo 9 uses the canvas that copilot-avalonia ships.
  if [ "$name" != 09-real-canvas ]; then
    rm -rf "$dest/.github/extensions/copilot-avalonia"
    rmdir "$dest/.github/extensions"
  fi
  if [ -d "$kit/demos/$name" ]; then
    tar -c --exclude .DS_Store -C "$kit/demos/$name" . | tar -x -C "$dest"
  fi
  git -C "$dest" init --quiet
  git -C "$dest" add -A
  git -C "$dest" commit --quiet -m "Demo $name"
done

# The .txt files say ~/copilot-talk and <talk repo>: write the real folders, so every command can be pasted as is.
for txt in "$kit"/demos/*.txt; do
  sed -e "s#~/copilot-talk#$target#g" -e "s#<talk repo>#$kit#g" "$txt" > "$target/$(basename "$txt")"
done

echo "Done: $target"
ls "$target"
echo "Add every folder to the app as a project:"
echo "  for d in \"$target\"/*/; do open -a \"GitHub Copilot\" \"\$d\"; done"
echo "Or one at a time in the app: Add repository (File > Create from Local Folder or Repository)."
