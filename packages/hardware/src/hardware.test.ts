import { describe, expect, it } from "vitest";
import { ReceiptPrintGuard, validateHardwareProfile, type PrinterAdapter } from "./index";
describe("hardware certification gate", () => {
  it("does not allow supported without a physical test record", () => {
    expect(
      validateHardwareProfile({
        id: "p1",
        kind: "printer",
        vendor: "Vendor",
        model: "58mm",
        connection: "bluetooth",
        status: "supported",
        capabilities: ["print"],
        androidVersionsTested: [],
        knownIssues: [],
      }),
    ).toContain("physical_test_required");
  });
  it("requires scale calibration metadata", () => {
    expect(
      validateHardwareProfile({
        id: "s1",
        kind: "scale",
        vendor: "Vendor",
        model: "S1",
        connection: "bluetooth",
        status: "supported",
        capabilities: ["weight"],
        androidVersionsTested: ["15"],
        knownIssues: [],
        testedAt: "2026-08-10",
        testEvidence: "lab/test-scale-s1-20260810.md",
        protocol: "serial",
      }),
    ).toContain("scale_calibration_required");
  });
  it("requires protocol, paper width, and test evidence for a supported printer", () => {
    const issues = validateHardwareProfile({
      id: "p2", kind: "printer", vendor: "Vendor", model: "P2",
      connection: "usb", status: "supported", capabilities: ["print"],
      androidVersionsTested: ["14"], knownIssues: [], testedAt: "2026-08-31",
    });
    expect(issues).toContain("physical_test_required");
    expect(issues).toContain("protocol_required");
    expect(issues).toContain("printer_paper_width_required");
  });
  it("deduplicates concurrent and repeated receipt print requests", async () => {
    let calls = 0;
    const printer: PrinterAdapter = {
      async connect() { return { ok: true, code: "connected", retryable: false }; },
      async printTest() { return { ok: true, code: "printed", retryable: false }; },
      async printReceipt() { calls += 1; return { ok: true, code: "printed", retryable: false }; },
    };
    const guard = new ReceiptPrintGuard(printer);
    const [first, second] = await Promise.all([
      guard.print({ idempotencyKey: "sale-1", text: "receipt" }),
      guard.print({ idempotencyKey: "sale-1", text: "receipt" }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(calls).toBe(1);
    expect((await guard.print({ idempotencyKey: "sale-1", text: "receipt" })).code).toBe("already_printed");
  });
});
