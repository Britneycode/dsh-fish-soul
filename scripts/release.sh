#!/usr/bin/env bash
# 发版：打附注 tag + 推 + 建 GitHub release
# 用法：bash scripts/release.sh <版本号> <release 正文文件>
#   bash scripts/release.sh 0.9.0 /tmp/rel-v090.md
#
# 前置：在 main 上、工作区干净、测试已过。正文文件由人写，脚本不生成。
set -euo pipefail

VER="${1:?用法: bash scripts/release.sh <版本号> <正文文件>}"
NOTES="${2:?用法: bash scripts/release.sh <版本号> <正文文件>}"
REPO="Britneycode/dsh-fish-soul"
TAG="v${VER}"

cd "$(dirname "$0")/.."
[ -f "$NOTES" ] || { echo "正文文件不存在: $NOTES" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "工作区不干净，先提交" >&2; git status --short; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "不在 main 上" >&2; exit 1; }

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "$TAG 已存在" >&2; exit 1; }

grep -q "\"version\": \"$VER\"" package.json || echo "警告：package.json 版本不是 $VER" >&2

git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"

VER="$VER" NOTES="$NOTES" TAG="$TAG" REPO="$REPO" python - << 'PY'
import json, os, sys, urllib.request, urllib.error
ver, notes, tag, repo = (os.environ[k] for k in ("VER", "NOTES", "TAG", "REPO"))
tok = os.environ.get("GITHUB_TOKEN_BRITNEYCODE")
if not tok:
    sys.exit("缺 GITHUB_TOKEN_BRITNEYCODE")

body = open(notes, encoding="utf-8").read()
if "\ufffd" in body:
    sys.exit("正文有编码坏字符（U+FFFD），先修文件")

title = body.splitlines()[0].lstrip("# ").strip() or tag
payload = json.dumps({
    "tag_name": tag,
    "name": f"{tag} {title}" if title != tag else tag,
    "body": body,
    "draft": False,
    "prerelease": False,
    "target_commitish": "main",
}).encode()

req = urllib.request.Request(
    f"https://api.github.com/repos/{repo}/releases",
    data=payload, method="POST",
    headers={"Authorization": "Bearer " + tok, "Accept": "application/vnd.github+json",
             "Content-Type": "application/json", "User-Agent": "alma"},
)
try:
    res = json.load(urllib.request.urlopen(req))
except urllib.error.HTTPError as e:
    sys.exit(f"HTTP {e.code}: {e.read().decode()[:400]}")

print(f"OK {res['tag_name']} {res['html_url']}")
print(f"  正文 {len(res['body'])} 字符 / {res['body'].count(chr(10)) + 1} 行")
PY