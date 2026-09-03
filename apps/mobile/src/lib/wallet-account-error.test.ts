import { describe, expect, it } from "vitest";
import { explainWalletAccountError, walletAccountErrorMessage } from "./wallet-account-error";

describe("wallet account errors", () => {
  it("never exposes a raw edge function error", () => {
    expect(walletAccountErrorMessage("not_configured")).not.toContain("not_configured");
  });

  it("reads the server error code from the response", async () => {
    const message = await explainWalletAccountError({context:new Response(JSON.stringify({error:"owner_required"}),{headers:{"Content-Type":"application/json"}})});
    expect(message).toContain("pemilik");
  });
});
