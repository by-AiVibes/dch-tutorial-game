// Runtime amendment check via the `feature` RPC. A level whose amendment is not
// enabled on the connected network shows "coming soon" instead of failing.
// Background: https://xrpl.org/docs/concepts/networks-and-servers/amendments

import type { Client } from "xrpl";

/**
 * Each game feature maps to required amendments; all must be enabled. An inner array means
 * "any one of these names" (e.g. Batch or its BatchV1_1 revision).
 */
export type Requirement = string | string[];
export const FEATURE_AMENDMENTS: Record<string, Requirement[]> = {
  Clawback: ["Clawback"],
  Credentials: ["Credentials"],
  PermissionedDomains: ["PermissionedDomains", "PermissionedDEX"],
  Batch: [["Batch", "BatchV1_1"]], // "Batch" is obsolete; BatchV1_1 is the live one
  MPTokensV1: ["MPTokensV1"],
  SingleAssetVault: ["MPTokensV1", "SingleAssetVault"],
  LendingProtocol: ["MPTokensV1", "SingleAssetVault", "LendingProtocol"],
  /** Optional: changes Level 7 rules (closed-ended vaults), not required to play it. */
  LendingProtocolV1_1: ["LendingProtocolV1_1"],
  ConfidentialTransfer: ["MPTokensV1", "ConfidentialTransfer"],
};

export interface AmendmentStatus {
  name: string;
  enabled: boolean;
  /** true when the server knows the amendment (it may be in voting). */
  known: boolean;
  supported?: boolean;
}

export interface AmendmentReport {
  checkedAt: string;
  network: string;
  amendments: Record<string, AmendmentStatus>;
}

type FeatureEntry = { name?: string; enabled?: boolean; supported?: boolean };

/** Pure: turn a `feature` RPC result into name -> status. */
export function parseFeatures(features: Record<string, FeatureEntry>): Record<string, AmendmentStatus> {
  const out: Record<string, AmendmentStatus> = {};
  for (const v of Object.values(features)) {
    if (!v?.name) continue;
    out[v.name] = { name: v.name, enabled: v.enabled === true, known: true, supported: v.supported };
  }
  return out;
}

export function featureEnabled(report: AmendmentReport | null, feature: string): boolean {
  if (!report) return false;
  const reqs = FEATURE_AMENDMENTS[feature] ?? [feature];
  return reqs.every((r) => (Array.isArray(r) ? r : [r]).some((n) => report.amendments[n]?.enabled === true));
}

export async function checkAmendments(client: Client, network: string): Promise<AmendmentReport> {
  // The `feature` method is admin-gated for some fields but returns names/enabled publicly.
  const res = (await client.request({ command: "feature" } as never)) as { result: { features: Record<string, FeatureEntry> } };
  const all = parseFeatures(res.result.features);
  const wanted = new Set(Object.values(FEATURE_AMENDMENTS).flat(2));
  const amendments: Record<string, AmendmentStatus> = {};
  for (const n of wanted) amendments[n] = all[n] ?? { name: n, enabled: false, known: false };
  return { checkedAt: new Date().toISOString(), network, amendments };
}
