import { describe, expect, it } from "vitest";

import { decodeProductImageBase64, productImageErrorMessage } from "./product-image";

describe("product image", () => {
  it("decodes picker base64 without reading a content URI", () => {
    expect(Array.from(new Uint8Array(decodeProductImageBase64("AQIDBA==")))).toEqual([1, 2, 3, 4]);
  });

  it("returns a user friendly read error", () => {
    expect(productImageErrorMessage(new Error("product_image_read_failed"))).not.toContain("product_image_read_failed");
  });
});
