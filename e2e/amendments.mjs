// Plain-JS copy of the level -> amendment rules in src/amendments.ts, so the e2e runs on any
// Node with Playwright (no TypeScript import). test/e2e.test.ts checks it matches the server's.

/** Each game feature maps to required amendments; all must be enabled. Inner array = any one. */
export const FEATURE_AMENDMENTS = {
  Clawback: ["Clawback"],
  Credentials: ["Credentials"],
  PermissionedDomains: ["PermissionedDomains", "PermissionedDEX"],
  Batch: [["Batch", "BatchV1_1"]],
  MPTokensV1: ["MPTokensV1"],
  SingleAssetVault: ["MPTokensV1", "SingleAssetVault"],
  LendingProtocol: ["MPTokensV1", "SingleAssetVault", "LendingProtocol"],
  LendingProtocolV1_1: ["LendingProtocolV1_1"],
  ConfidentialTransfer: ["MPTokensV1", "ConfidentialTransfer"],
};

/** Turn a `feature` RPC result into name -> { name, enabled, known, supported }. */
export function parseFeatures(features) {
  const out = {};
  for (const v of Object.values(features)) {
    if (!v?.name) continue;
    out[v.name] = { name: v.name, enabled: v.enabled === true, known: true, supported: v.supported };
  }
  return out;
}

export function featureEnabled(report, feature) {
  if (!report) return false;
  const reqs = FEATURE_AMENDMENTS[feature] ?? [feature];
  return reqs.every((r) => (Array.isArray(r) ? r : [r]).some((n) => report.amendments[n]?.enabled === true));
}
