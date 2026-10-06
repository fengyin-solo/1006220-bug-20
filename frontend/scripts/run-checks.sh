#!/usr/bin/env bash
# 数据层自检：把 src/data、src/api 与 scripts/*.check.ts 编译成 commonjs 后在 node 里跑。
# tsc 不重写 @ 别名，这里用 sed 把编译产物里的 '@/...' 改成相对路径。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=.check-output
rm -rf "$OUT"
node_modules/.bin/tsc -p tsconfig.check.json
# 仓库是 "type": "module"，输出目录单独标成 commonjs，node 才能直接跑编译产物。
printf '{ "type": "commonjs" }\n' > "$OUT/package.json"
sed -i "s|require('@/|require('../src/|g; s|require(\"@/|require(\"../src/|g" "$OUT"/scripts/*.js
sed -i "s|require('@/|require('../|g; s|require(\"@/|require(\"../|g" "$OUT"/src/api/*.js
node "$OUT/scripts/governor-calibration.check.js"
node "$OUT/scripts/local-store-persistence.check.js"
