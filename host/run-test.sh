#!/bin/bash
cd "$(dirname "$0")"
npx vitest run --project gui "$@"
