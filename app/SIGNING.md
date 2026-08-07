# Signing & notarization

Blueline ships **signed and notarized**. Verified on the published v0.40.0:
`Developer ID Application: Michael Sousa (6N5KDBX8RH)`, hardened runtime, notarization
ticket stapled, `spctl` reports `source=Notarized Developer ID` — it opens with no
Gatekeeper prompt.

That comes from `npm run package:signed` / `npm run release:publish`, which need the
Developer ID certificate in the *build machine's* login Keychain plus the `APPLE_*`
notarization credentials below. `npm run package` remains deterministically **unsigned**
(`CSC_IDENTITY_AUTO_DISCOVERY=false`) — it is for local testing and the isolated smoke
test only, and **must not be used to publish**: electron-updater refuses an update that
isn't signed by the same Developer ID, so an unsigned release would break auto-update for
everyone already running Blueline.

## What's already set up

- `build/entitlements.mac.plist` — hardened-runtime entitlements. Blueline runs the
  engine bridge as a child of the packaged app via `ELECTRON_RUN_AS_NODE` and launches
  Playwright's Chromium, so it needs `allow-jit`, `allow-unsigned-executable-memory`,
  `disable-library-validation`, `allow-dyld-environment-variables`, and `inherit`.
- `package.json` → `build.mac`: `hardenedRuntime: true`, entitlements wired,
  `afterSign: build/notarize.cjs`.
- Scripts:
  - `npm run package` — deterministically **unsigned** (`CSC_IDENTITY_AUTO_DISCOVERY=false`).
    This is what the isolated smoke test and current distribution use.
  - `npm run package:signed` — signs with the Developer ID found in your Keychain, and
    notarizes **if** Apple credentials are in the environment (otherwise sign-only).

## Steps to go fully signed + notarized

### 1. Install the Developer ID Application certificate (one-time)

Xcode → Settings → Accounts → add your Apple ID → **Manage Certificates** → **+** →
**Developer ID Application**. Confirm it landed:

```bash
security find-identity -p codesigning -v | grep "Developer ID Application"
```

You should see one line with your name and Team ID.

### 2. Get notarization credentials (pick one)

**App Store Connect API key (recommended — doesn't expire):**
appstoreconnect.apple.com → Users and Access → Integrations → App Store Connect API →
generate a key with the **Developer** role. Download the `.p8` (once only), and note the
**Key ID** and **Issuer ID**.

```bash
export APPLE_API_KEY="/absolute/path/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Apple ID + app-specific password (simpler):**
appleid.apple.com → Sign-In and Security → App-Specific Passwords → generate one.

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="YOURTEAMID"
```

### 3. One-time dependency for notarization

```bash
cd app && npm i -D @electron/notarize
```

### 4. Build

```bash
cd app && npm run package:signed
```

Then verify:

```bash
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Blueline.app"
spctl -a -vvv "release/mac-arm64/Blueline.app"        # should say "accepted / Notarized Developer ID"
xcrun stapler validate "release/Blueline-<version>-arm64.dmg"
```

## Known caveat to verify when you first sign

Under a hardened runtime, macOS can refuse to launch `ELECTRON_RUN_AS_NODE` child
processes unless the JIT / library-validation entitlements above are present — they are,
but the engine bridge is a child process, so **smoke-test the signed build** (launch it,
confirm a project renders) before distributing. If the bridge fails to start only in the
signed build, that's the entitlement path to revisit.
