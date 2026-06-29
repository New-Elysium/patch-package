#!/usr/bin/env bash
set -e

export CI=true

bun run clean
bun run build
bun pm pack --filename patch-package.test.$(date +%s).tgz
bunx jest "$@"
