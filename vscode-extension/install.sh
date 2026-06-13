#!/bin/bash
# install.sh — 将 myagent 插件安装到 VSCode
# 用法: cd vscode-extension && bash install.sh

set -e

EXT_DIR="$HOME/.vscode/extensions/myagent-0.1.0"

echo "=== 安装 myagent VSCode 插件 ==="
echo "[1/3] 编译..."
npx tsc -p ./

echo "[2/3] 安装到 $EXT_DIR ..."
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
cp -r package.json out "$EXT_DIR/"

echo "[3/3] 完成！"
echo ""
echo "Cmd+Shift+P → Developer: Reload Window"
