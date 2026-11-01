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
# Python 是 Windows 原生进程，看不懂 Git Bash 的 /tmp 这类路径；换成 Windows 形式
NOTES_WIN="$(cygpath -w "$NOTES" 2>/dev/null || printf '%s' "$NOTES")"
[ -z "$(git status --porcelain)" ] || { echo "工作区不干净，先提交" >&2; git status --short; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "不在 main 上" >&2; exit 1; }

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "$TAG 已存在" >&2; exit 1; }

grep -q "\"version\": \"$VER\"" package.json || { echo "package.json 版本不是 $VER（先改再发）" >&2; exit 1; }

# README 第 5 行要同步：0.11.0→0.11.2 连发两版都没更新，对外行为变了文档却没跟上
grep -q "版本 \*\*$VER\*\*" README.md || { echo "README 里的版本没写成 $VER（搜「版本 **」那一行）" >&2; exit 1; }

# 先校验再打 tag：正文有坏字符 / 缺 token 时就别留个推上去的孤儿 tag
python - "$NOTES_WIN" << 'PY'
import os, sys
body = open(sys.argv[1], encoding="utf-8").read()
if "\ufffd" in body:
    sys.exit("正文有编码坏字符（U+FFFD），先修文件")
if not os.environ.get("GITHUB_TOKEN_BRITNEYCODE"):
    sys.exit("缺 GITHUB_TOKEN_BRITNEYCODE")
if not body.strip():
    sys.exit("正文是空的")
PY

git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"
# 分支也要推：只推 tag 会让远程 main 停在旧提交，tag 落在分支之外（2026-11-02 踩过）
git push origin main

VER="$VER" NOTES="$NOTES_WIN" TAG="$TAG" REPO="$REPO" python - << 'PY'
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