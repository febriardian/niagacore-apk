import { describe, expect, it } from "vitest";
import { evaluateUpdate, resolveUpdateManifestUrl, type UpdateManifest } from "./app-update-evaluate";

const manifest: UpdateManifest = {
  version: "2.1.0", versionCode: 24, minimumVersionCode: 23,
  apkUrl: "niagacore-latest.apk", sha256: "a".repeat(64), mandatory: false,
};

describe("update manifest", () => {
  it("resolves a downloadable newer build", () => {
    const result = evaluateUpdate(manifest, 23, "https://download.example/releases/release.json");
    expect(result.available).toBe(true);
    expect(result.mandatory).toBe(false);
    expect(result.downloadUrl).toBe("https://download.example/releases/niagacore-latest.apk");
  });

  it("forces builds below the supported minimum", () => {
    expect(evaluateUpdate(manifest, 22, "https://download.example/release.json").mandatory).toBe(true);
  });

  it("does not expose an unsigned placeholder", () => {
    expect(evaluateUpdate({ ...manifest, sha256: "GENERATE_AFTER_SIGNED_BUILD" }, 23, "https://download.example/release.json").downloadUrl).toBeNull();
  });

  it("uses the public release manifest when build configuration is absent", () => {
    expect(resolveUpdateManifestUrl()).toBe("https://niagacore.app/releases/release.json");
    expect(resolveUpdateManifestUrl(undefined,"https://download.example/receipt")).toBe("https://download.example/releases/release.json");
  });
});
