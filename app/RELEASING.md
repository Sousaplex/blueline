# Releasing & auto-update

Blueline auto-updates from **GitHub Releases** via `electron-updater`. Each published
release carries three things the updater needs:

- `Blueline-<version>-arm64.dmg` — first-time install
- `Blueline-<version>-arm64-mac.zip` — the payload the updater actually downloads
  (macOS/Squirrel updates from a zip, not a dmg)
- `latest-mac.yml` — the manifest the installed app reads to decide "is there a newer version?"

On launch (packaged, non-smoke) the app checks the repo's **latest** release, and if a
newer signed build exists it downloads it in the background and notifies the user to
restart. Config lives in `package.json` → `build.publish` (`github` / `Sousaplex` / `blueline`)
and the updater wiring is in `electron/main.ts`.

## Requirements

- **Signed builds only.** electron-updater applies an update only if it's signed by the
  same Developer ID. Signing is set up (see SIGNING.md); the certificate must be in the
  Keychain at build time.
- **Notarization strongly recommended.** Without it, the *first* download from GitHub is
  quarantined and hits Gatekeeper ("Open Anyway"); subsequent auto-updates still apply
  (Squirrel swaps in place without re-quarantining), but the initial install is rough.
  Add the `APPLE_*` env vars from SIGNING.md to notarize.
- **A GitHub token** with `repo` scope to upload the release, exported as `GH_TOKEN`.
- The installed app must run from **/Applications** for an update to apply (Squirrel.Mac
  limitation) — a dmg dragged to Applications satisfies this.

## Publish a release

```bash
# 1. bump the version
#    edit app/package.json "version" (must be > the currently published release)

# 2. export credentials
export GH_TOKEN="ghp_…"                         # repo scope, to upload the release
# and, to notarize (recommended) — see SIGNING.md for how to obtain these:
export APPLE_API_KEY="/path/AuthKey_XXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-…"

# 3. build signed (+ notarized if APPLE_* set) and upload to GitHub Releases
cd app && npm run release:publish
```

`--publish always` creates/updates a **draft** GitHub Release for that version and uploads
the dmg, zip, and `latest-mac.yml`. Review the draft on GitHub, then click **Publish
release** — the update goes live to everyone on the next launch.

## First download link (for the README / teammates)

Once a release is published, the newest installer is always at:

```
https://github.com/Sousaplex/blueline/releases/latest
```

## Testing the update UI without a release

The update UI is otherwise unreachable without shipping — which is how a 200 MB+ download
with no progress detail stayed unnoticed. `BLUELINE_UPDATE_SIMULATE` drives the whole
sequence (availability prompt → byte-accurate progress with a moving ETA → the silent unpack
window → restart) with **no download, no packaging and no release**:

```bash
cd app && BLUELINE_UPDATE_SIMULATE=1 npm run electron:app       # the happy path
cd app && BLUELINE_UPDATE_SIMULATE=error npm run electron:app   # the failure toast
```

Tunables — useful for judging whether a slow download still reads as "working":

| Variable | Default | What it does |
|---|---|---|
| `BLUELINE_UPDATE_SIMULATE_VERSION` | `9.9.9` | version offered in the prompt |
| `BLUELINE_UPDATE_SIMULATE_SECONDS` | `12` | how long the fake download takes |
| `BLUELINE_UPDATE_SIMULATE_MB` | `223.3` | payload size (a real Blueline update) |

The simulator replaces the real updater while it's active and is inert unless the variable is
set, so it cannot affect a shipped build. **Restart now** shows a dialog instead of relaunching —
the actual bundle swap is Squirrel's job and only a signed build can prove it (below).

## Verifying an update end-to-end

1. Publish version N.
2. Install it (drag to /Applications), launch once.
3. Publish version N+1.
4. Relaunch the installed N — within a few seconds the updater downloads N+1 and offers to
   restart. Confirm it relaunches as N+1.
