# Frozen external App v1 fixtures

`reference-app.py` and `vectors.json` preserve the first verified `aotui-app` major 1 App and its Schema and XML expectations. The files match the Python App and vectors in the first passing candidate, A2. Leave these bytes fixed when replaying a later Runtime. The examples under `runtime/examples` can evolve independently.

Run the following from the repository root. The replay was verified with Node 24.15.0 and Python 3.14.0. Set `RELEASE` to the absolute output path of a passing `scripts/release-local.mjs --out` run. The release check creates both the installed Host and the compiled TypeScript comparison App.

```sh
(cd tests/fixtures/app-v1 && shasum -a 256 -c SHA256SUMS)
SCRATCH=$(jq -r .scratch "$RELEASE/release-manifest.json")
CONSUMER="$SCRATCH/host-first/consumers/host"
TS_APP="$SCRATCH/author-plain-first/consumers/author-plain/package-checks/app"
REPLAY=$(mktemp -d "$CONSUMER/app-v1-replay.XXXXXX")
mkdir "$REPLAY/reference app"
cp tests/fixtures/app-v1/reference-app.py tests/fixtures/app-v1/vectors.json "$REPLAY/reference app/"
cp tests/fixtures/verify-external-app.mjs "$REPLAY/"
node "$REPLAY/verify-external-app.mjs" "$REPLAY/reference app/reference-app.py" \
  "$PWD/tests/fixtures/external-app-behavior.py" "$REPLAY/reference app/vectors.json" \
  "$TS_APP" "$REPLAY/results" with-attention
```

The space in the staging path exercises literal command arguments. Use `baseline` for a Runtime that supports major 1 and omits `attention`. Results are written to `results/evidence.json` under the replay directory.
