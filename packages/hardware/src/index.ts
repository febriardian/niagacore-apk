export type HardwareStatus =
  "not_configured" | "experimental" | "supported" | "deprecated";
export interface HardwareProfile {
  id: string;
  kind: "printer" | "scanner" | "cash_drawer" | "scale" | "camera_ocr";
  vendor: string;
  model: string;
  connection: "bluetooth" | "usb" | "network" | "camera";
  protocol?: "android_print" | "esc_pos" | "hid_keyboard" | "serial" | "camera";
  paperWidthMm?: 58 | 80;
  codePage?: string;
  status: HardwareStatus;
  capabilities: string[];
  androidVersionsTested: string[];
  firmware?: string;
  knownIssues: string[];
  testedAt?: string;
  testEvidence?: string;
}
export interface HardwareResult<T = void> {
  ok: boolean;
  code: string;
  data?: T;
  retryable: boolean;
}
export interface PrinterAdapter {
  connect(): Promise<HardwareResult>;
  printReceipt(payload: {
    idempotencyKey: string;
    text: string;
  }): Promise<HardwareResult>;
  printTest(): Promise<HardwareResult>;
  cut?(): Promise<HardwareResult>;
  openDrawer?(): Promise<HardwareResult>;
}
export interface BarcodeScannerAdapter {
  connect(): Promise<HardwareResult>;
  read(): Promise<HardwareResult<{ value: string; symbology: string }>>;
  disconnect(): Promise<void>;
}
export interface ScaleAdapter {
  connect(): Promise<HardwareResult>;
  readStableWeight(): Promise<
    HardwareResult<{ value: number; unit: "g" | "kg" }>
  >;
  tare(): Promise<HardwareResult>;
}
export interface OcrCandidate {
  text: string;
  confidence: number;
  field: "product" | "amount" | "date" | "unknown";
}
export interface OcrAdapter {
  isAvailable(): Promise<boolean>;
  recognize(
    imageUri: string,
  ): Promise<HardwareResult<{ candidates: OcrCandidate[] }>>;
}

export function validateHardwareProfile(profile: HardwareProfile): string[] {
  const issues: string[] = [];
  if (!profile.vendor.trim()) issues.push("vendor_required");
  if (!profile.model.trim()) issues.push("model_required");
  if (
    profile.status === "supported" &&
    (!profile.testedAt ||
      profile.androidVersionsTested.length === 0 ||
      !profile.testEvidence?.trim())
  )
    issues.push("physical_test_required");
  if (profile.status === "supported" && !profile.protocol)
    issues.push("protocol_required");
  if (
    profile.kind === "printer" &&
    profile.status === "supported" &&
    !profile.paperWidthMm
  )
    issues.push("printer_paper_width_required");
  if (
    profile.kind === "scanner" &&
    profile.status === "supported" &&
    !["hid_keyboard", "serial", "camera"].includes(profile.protocol ?? "")
  )
    issues.push("scanner_protocol_unsupported");
  if (
    profile.kind === "scale" &&
    profile.status === "supported" &&
    !profile.capabilities.includes("calibration_metadata")
  )
    issues.push("scale_calibration_required");
  return issues;
}

/** Prevents a retry or double-tap from printing the same receipt twice. */
export class ReceiptPrintGuard {
  private readonly completed = new Set<string>();
  private readonly running = new Map<string, Promise<HardwareResult>>();

  constructor(private readonly printer: PrinterAdapter) {}

  async print(payload: {
    idempotencyKey: string;
    text: string;
  }): Promise<HardwareResult> {
    if (!payload.idempotencyKey.trim()) {
      return { ok: false, code: "idempotency_key_required", retryable: false };
    }
    if (this.completed.has(payload.idempotencyKey)) {
      return { ok: true, code: "already_printed", retryable: false };
    }
    const existing = this.running.get(payload.idempotencyKey);
    if (existing) return existing;
    const operation = this.printer.printReceipt(payload).then((result) => {
      if (result.ok) this.completed.add(payload.idempotencyKey);
      return result;
    }).finally(() => this.running.delete(payload.idempotencyKey));
    this.running.set(payload.idempotencyKey, operation);
    return operation;
  }

  allowReprint(idempotencyKey: string) {
    this.completed.delete(idempotencyKey);
  }
}

export class NotConfiguredPrinter implements PrinterAdapter {
  async connect(): Promise<HardwareResult> {
    return { ok: false, code: "printer_not_configured", retryable: false };
  }
  async printReceipt(): Promise<HardwareResult> {
    return { ok: false, code: "printer_not_configured", retryable: false };
  }
  async printTest(): Promise<HardwareResult> {
    return { ok: false, code: "printer_not_configured", retryable: false };
  }
}
export class NotConfiguredOcr implements OcrAdapter {
  async isAvailable() {
    return false;
  }
  async recognize(): Promise<HardwareResult<{ candidates: OcrCandidate[] }>> {
    return { ok: false, code: "ocr_not_configured", retryable: false };
  }
}
