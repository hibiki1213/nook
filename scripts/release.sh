#!/usr/bin/env bash
# One-command release. The ONLY variables are the version and a summary:
#
#   bash scripts/release.sh 0.4.0 "Nani デザイン刷新 — スキン/レール/アイランド"
#
# Everything else is fixed. It releases the CURRENT state of origin/main:
#
#   1. bump the version in all 6 lockstep files (+ the README download link)
#   2. signed `tauri build`, hard-failing if the updater .sig is missing
#      (tauri exits 0 and silently skips it when the key isn't set)
#   3. generate latest.json (the auto-updater manifest)
#   4. commit "Release <version>" and push to main
#   5. create the GitHub release (tag v<version>) and upload the 3 assets
#   6. verify every published URL actually resolves
#
# Requirements: clean tree, on main, in sync with origin, tag unused,
# ~/.tauri/nook.key present, GitHub token in the macOS keychain (osxkeychain).
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="hibiki1213/nook"
KEY_PATH="$HOME/.tauri/nook.key"
BUNDLE="src-tauri/target/release/bundle"

VERSION="${1:?usage: release.sh <version> \"<summary>\"   e.g. release.sh 0.4.0 \"新機能まとめ\"}"
VERSION="${VERSION#v}"
NOTES="${2:?a one-or-more-line summary is required as the 2nd argument}"
TAG="v$VERSION"

# ---- Preflight — fail before touching anything -----------------------------
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "✗ version must look like 0.4.0"; exit 1; }
[[ -f "$KEY_PATH" ]] || { echo "✗ signing key missing: $KEY_PATH (lose it and existing installs can never update)"; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "✗ working tree not clean — the release must equal the repo state. Commit first."; exit 1; }
[[ "$(git branch --show-current)" == "main" ]] || { echo "✗ not on main"; exit 1; }
git fetch origin main --quiet
[[ "$(git rev-parse main)" == "$(git rev-parse origin/main)" ]] || { echo "✗ main と origin/main がズレています — 先に push/pull してください"; exit 1; }
git ls-remote --tags origin "refs/tags/$TAG" | grep -q . && { echo "✗ tag $TAG は既に存在します"; exit 1; }

GH_TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null | sed -n 's/^password=//p')"
[[ -n "$GH_TOKEN" ]] || { echo "✗ GitHub トークンが keychain にありません"; exit 1; }
export GH_TOKEN

OLD="$(sed -n 's/.*"version": "\([0-9.]*\)".*/\1/p' src-tauri/tauri.conf.json | head -1)"
[[ -n "$OLD" && "$OLD" != "$VERSION" ]] || { echo "✗ 現在のバージョン($OLD)と同じか、読み取れません"; exit 1; }
echo "▸ $OLD → $VERSION としてリリースします"

# ---- 1. Version bump (6 lockstep files + README) ---------------------------
export OLD NEW="$VERSION"
perl -pi -e 's/"version": "\Q$ENV{OLD}\E"/"version": "$ENV{NEW}"/' \
  package.json mcp-server/package.json mcp-server/manifest.json src-tauri/tauri.conf.json
perl -pi -e 's/^version = "\Q$ENV{OLD}\E"/version = "$ENV{NEW}"/' src-tauri/Cargo.toml
perl -pi -e 's/EXT_VERSION = "\Q$ENV{OLD}\E"/EXT_VERSION = "$ENV{NEW}"/' mcp-server/src/index.ts
perl -pi -e 's{v\Q$ENV{OLD}\E/Nook_\Q$ENV{OLD}\E_aarch64\.dmg}{v$ENV{NEW}/Nook_$ENV{NEW}_aarch64.dmg}g' README.md

for f in package.json mcp-server/package.json mcp-server/manifest.json \
         src-tauri/tauri.conf.json src-tauri/Cargo.toml mcp-server/src/index.ts; do
  grep -q "$VERSION" "$f" || { echo "✗ bump 失敗: $f"; exit 1; }
done
echo "✓ 6ファイル + README を $VERSION に統一"

# ---- 2. Signed build --------------------------------------------------------
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
pnpm tauri build

DMG="$BUNDLE/dmg/Nook_${VERSION}_aarch64.dmg"
TARBALL="$BUNDLE/macos/Nook.app.tar.gz"
[[ -f "$DMG" ]] || { echo "✗ $DMG が生成されていません"; exit 1; }
[[ -f "$TARBALL.sig" ]] || { echo "✗ .sig がありません — 署名鍵が渡っていない（このままでは自動更新が配信できません）"; exit 1; }
echo "✓ 署名付きビルド完了"

# ---- 3. Updater manifest ----------------------------------------------------
bash scripts/make-latest-json.sh

# ---- 4. Commit & push -------------------------------------------------------
git add package.json mcp-server/package.json mcp-server/manifest.json \
        mcp-server/src/index.ts src-tauri/Cargo.toml src-tauri/Cargo.lock \
        src-tauri/tauri.conf.json README.md
git commit -m "Release $VERSION"
git push origin main
echo "✓ push 済み ($(git rev-parse --short HEAD))"

# ---- 5. GitHub release ------------------------------------------------------
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT
cat > "$BODY_FILE" <<EOF
$NOTES

## Install

Download **\`Nook_${VERSION}_aarch64.dmg\`** below (Apple Silicon), open it, and drag **Nook** into **Applications**.

**Already running Nook?** No download needed — the app offers this update in its sidebar; one click installs and relaunches.

**First launch (new installs).** This build isn't notarized, so macOS blocks it once:

\`\`\`
xattr -cr /Applications/Nook.app
\`\`\`

…or open it, dismiss the warning, then **System Settings → Privacy & Security → "Open Anyway."**

**日本語:** 未署名のため初回だけブロックされます。ターミナルで \`xattr -cr /Applications/Nook.app\` を実行するか、**システム設定 → プライバシーとセキュリティ →「このまま開く」** をクリックしてください。既にNookをお使いの場合はダウンロード不要です — サイドバー左下の更新バナーからワンクリックで更新できます。

---

\`Nook.app.tar.gz\` and \`latest.json\` are consumed by the auto-updater; you don't need to download them.
EOF

export BODY_FILE TAG VERSION REPO DMG TARBALL BUNDLE
python3 - <<'PY'
import json, os, sys, urllib.request, urllib.error

token = os.environ["GH_TOKEN"]
repo, tag, version = os.environ["REPO"], os.environ["TAG"], os.environ["VERSION"]

def req(url, data=None, ctype=None, method="GET"):
    h = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
         "X-GitHub-Api-Version": "2022-11-28"}
    if ctype: h["Content-Type"] = ctype
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h, method=method)) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        print(f"✗ HTTP {e.code} {url}\n{e.read().decode()[:500]}", file=sys.stderr)
        sys.exit(1)

with open(os.environ["BODY_FILE"], encoding="utf-8") as f:
    body = f.read()

rel = req(f"https://api.github.com/repos/{repo}/releases",
          data=json.dumps({"tag_name": tag, "target_commitish": "main",
                           "name": f"Nook {version}", "body": body,
                           "draft": False, "prerelease": False}).encode(),
          ctype="application/json", method="POST")
print(f"✓ release created: {rel['html_url']}")

assets = [(os.environ["DMG"], f"Nook_{version}_aarch64.dmg", "application/x-apple-diskimage"),
          (os.environ["TARBALL"], "Nook.app.tar.gz", "application/gzip"),
          (os.environ["BUNDLE"] + "/latest.json", "latest.json", "application/json")]
for path, name, ctype in assets:
    with open(path, "rb") as f:
        blob = f.read()
    req(f"https://uploads.github.com/repos/{repo}/releases/{rel['id']}/assets?name={name}",
        data=blob, ctype=ctype, method="POST")
    print(f"  ✓ uploaded {name} ({len(blob):,} bytes)")
PY

# ---- 6. Verify what users will actually hit ---------------------------------
check() { curl -s -o /dev/null -w "%{http_code}" -L -r 0-0 --max-time 60 "$1"; }
DL="https://github.com/$REPO/releases/download/$TAG"
for url in "$DL/Nook_${VERSION}_aarch64.dmg" "$DL/Nook.app.tar.gz"; do
  code="$(check "$url")"
  [[ "$code" == "200" || "$code" == "206" ]] || { echo "✗ $url → HTTP $code"; exit 1; }
done
LATEST="$(curl -sL --max-time 60 "https://github.com/$REPO/releases/latest/download/latest.json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["version"])')"
[[ "$LATEST" == "$VERSION" ]] || { echo "✗ updater endpoint がまだ $LATEST を返しています"; exit 1; }

echo
echo "🎉 Release $TAG 配信完了 — https://github.com/$REPO/releases/tag/$TAG"
echo "   既存ユーザーには次回起動時に更新バナーが表示されます。"
