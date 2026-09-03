export type UpdateManifest = {
  version: string;
  versionCode: number;
  minimumVersionCode: number;
  apkUrl: string;
  sha256: string;
  mandatory: boolean;
};

export type UpdateCheck = {
  currentVersionCode: number;
  available: boolean;
  mandatory: boolean;
  downloadUrl: string | null;
  manifest: UpdateManifest;
};

export function resolveUpdateManifestUrl(configured?: string, receiptVerifyUrl?: string): string {
  if (configured?.trim()) return configured.trim();
  if (receiptVerifyUrl?.trim()) {
    try { return new URL("/releases/release.json", receiptVerifyUrl.trim()).toString(); }
    catch { /* fall through to the production download domain */ }
  }
  return "https://niagacore.app/releases/release.json";
}

export function evaluateUpdate(
  manifest: UpdateManifest,
  currentVersionCode: number,
  manifestUrl: string,
): UpdateCheck {
  const available = manifest.versionCode > currentVersionCode;
  const mandatory = available && (manifest.mandatory || currentVersionCode < manifest.minimumVersionCode);
  let downloadUrl: string | null = null;
  if (available && manifest.apkUrl && !manifest.sha256.startsWith("GENERATE_")) {
    downloadUrl = new URL(manifest.apkUrl, manifestUrl).toString();
  }
  return { currentVersionCode, available, mandatory, downloadUrl, manifest };
}
