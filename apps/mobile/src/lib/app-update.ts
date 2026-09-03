import Constants from "expo-constants";
import { evaluateUpdate, resolveUpdateManifestUrl, type UpdateCheck, type UpdateManifest } from "./app-update-evaluate";
export type { UpdateCheck, UpdateManifest } from "./app-update-evaluate";

export async function checkForAppUpdate(): Promise<UpdateCheck | null> {
  const manifestUrl = resolveUpdateManifestUrl(process.env.EXPO_PUBLIC_UPDATE_MANIFEST_URL, process.env.EXPO_PUBLIC_RECEIPT_VERIFY_URL);
  const response = await fetch(manifestUrl, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`update_manifest_http_${response.status}`);
  const raw = (await response.json()) as Partial<UpdateManifest>;
  if (
    typeof raw.version !== "string" ||
    typeof raw.versionCode !== "number" ||
    typeof raw.minimumVersionCode !== "number" ||
    typeof raw.apkUrl !== "string" ||
    typeof raw.sha256 !== "string" ||
    typeof raw.mandatory !== "boolean"
  ) throw new Error("update_manifest_invalid");
  const current = Number(Constants.nativeBuildVersion ?? Constants.expoConfig?.android?.versionCode ?? 0);
  return evaluateUpdate(raw as UpdateManifest, current, manifestUrl);
}
