// electron-builder afterSign hook. Notarizes the signed .app ONLY when Apple
// credentials are present in the environment — with none set it is a clean no-op,
// so `npm run package` (unsigned) and `npm run package:signed` (sign-only) both
// succeed. Enable notarization by exporting EITHER:
//   App Store Connect API key:  APPLE_API_KEY (path to .p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER
//   Apple ID:                   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
// then run `npm run package:signed`. See SIGNING.md.
exports.default = async function notarize(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const hasApiKey = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER;
  const hasAppleId = process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;
  if (!hasApiKey && !hasAppleId) {
    console.log("[notarize] no Apple credentials in env — skipping notarization (see app/SIGNING.md)");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  const { notarize } = require("@electron/notarize");
  const opts = hasApiKey
    ? {
        appPath,
        appleApiKey: process.env.APPLE_API_KEY,
        appleApiKeyId: process.env.APPLE_API_KEY_ID,
        appleApiIssuer: process.env.APPLE_API_ISSUER,
      }
    : {
        appPath,
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      };
  console.log(`[notarize] submitting ${appName}.app to Apple — this can take a few minutes…`);
  await notarize(opts);
  // Staple the ticket INTO the .app now (afterSign runs before dmg/zip packaging),
  // so the notarized app launches offline with no Gatekeeper round-trip.
  require("node:child_process").execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
  console.log("[notarize] notarization + stapling complete");
};
