#!/bin/sh
# Checks every item before a push: Herdr's own load check, each item's tests,
# runtime-only mod folders, and no private names or CJK in what gets published.
# usage: scripts/check.sh   (from anywhere; needs herdr-app, node, python3, rg)
set -u
cd "$(dirname "$0")/.." || exit 1
fail=0
note() { printf '%s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fail=1; }

for item in */; do
  item=${item%/}
  [ -d "$item/mods" ] || continue
  for mod in "$item"/mods/*/; do
    mod=${mod%/}
    if herdr-app check "$mod" >/dev/null 2>&1; then note "ok   herdr-app check $mod"; else bad "herdr-app check $mod"; herdr-app check "$mod"; fi
    rm -f "$mod/gpui-kit.d.ts" "$mod/jsconfig.json"
    # Tests and dev files stay outside the folder users copy.
    extra=$(ls -a "$mod" | grep -v -E '^\.{1,2}$|\.(js|json|sh|py|svg|png)$' | grep -v -E '^__pycache__$')
    [ -z "$extra" ] || bad "$mod has non-runtime files: $extra"
    [ ! -e "$mod/test" ] && [ ! -e "$mod/package.json" ] || bad "$mod contains test/ or package.json"
    rm -rf "$mod/__pycache__"
  done
  if [ -d "$item/test" ]; then
    if ls "$item"/test/*.py >/dev/null 2>&1; then
      if (cd "$item" && python3 -I -m unittest discover -s test >/dev/null 2>&1); then note "ok   python tests $item"; else bad "python tests $item"; fi
    fi
    if [ -n "$(find "$item/test" -name '*.test.mjs' -o -name '*.test.js' | head -1)" ]; then
      if (cd "$item" && node --test >/dev/null 2>&1); then note "ok   node tests $item"; else bad "node tests $item"; fi
    fi
  fi
  [ -f "$item/RECIPE.md" ] && [ -f "$item/preview.png" ] || bad "$item needs RECIPE.md and preview.png"
done

# Mods run in QuickJS, not Node: tests pass under Node even when the runtime would throw.
if rg -n -e '\bBuffer\.[a-zA-Z]' -e '\brequire\(' -e '\bprocess\.(env|argv|exit|cwd|platform|stdout|stderr)' -e 'from "node:' -e '__dirname' -e '\bsetTimeout\(' -e '\bsetInterval\(' --glob '*/mods/**/*.js' . ; then bad "Node-only API in mod code"; else note "ok   no Node-only APIs in mods"; fi

# A method defined twice in one class: the later one silently replaces the first.
if node scripts/dup-methods.mjs */mods/*/*.js; then note "ok   no duplicate class methods"; else bad "duplicate class methods"; fi

# Nothing private goes public. The word list stays local (scripts/.private-words, gitignored,
# one regex per line) so the list itself is never published.
words="scripts/.private-words"
if [ -s "$words" ]; then
  if rg -n -i -f "$words" --glob '!scripts/*' --glob '!*.png' --glob '!*.d.ts' . ; then bad "private words found"; else note "ok   no private words"; fi
  for c in $(git rev-list --all 2>/dev/null); do
    hits=$(git grep -n -i -E -f "$words" "$c" -- . ':!*.png' ':!scripts/*' 2>/dev/null)
    [ -z "$hits" ] || { bad "private words in commit $c"; printf '%s\n' "$hits"; }
  done
else
  note "skip private-word scan: create $words (one regex per line, gitignored)"
fi
if rg -n '[一-龥]' --glob '!scripts/check.sh' --glob '!*.png' --glob '!*.d.ts' --glob '!**/languages.js' --glob '!*/test/**' --glob '!claude-goal/README.md' --glob '!claude-goal/RECIPE.md' . ; then bad "CJK text found"; else note "ok   no CJK"; fi

[ "$fail" -eq 0 ] && note "all checks passed" || note "some checks failed"
exit "$fail"
