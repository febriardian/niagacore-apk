import { describe, expect, it } from "vitest";
import { MutationEnvelopeSchema, PermissionSchema } from "./index";

const id = "018f47f4-7f32-7b3f-9c66-7f6a7b4db001";

describe("sync contracts", () => {
  it("accepts a valid v2 mutation envelope with payload integrity hash", () => {
    expect(
      MutationEnvelopeSchema.safeParse({
        mutationId: id,
        idempotencyKey: `${id}:sale:create`,
        deviceId: id,
        tenantId: id,
        businessId: id,
        branchId: id,
        actorId: id,
        aggregateType: "sale_draft",
        aggregateId: id,
        operation: "create",
        baseVersion: null,
        occurredAt: "2026-08-09T10:00:00+07:00",
        schemaVersion: 2,
        payloadHash: `sha256:${"a".repeat(64)}`,
        payload: { totalMinor: 25000 },
      }).success,
    ).toBe(true);
  });

  it("rejects malformed permission names", () => {
    expect(PermissionSchema.safeParse("admin").success).toBe(false);
    expect(PermissionSchema.safeParse("sales.create.branch").success).toBe(
      true,
    );
  });

  it("accepts production operational aggregates", () => {
    for (const aggregateType of ["partner", "appointment", "dining_table"]) {
      const result = MutationEnvelopeSchema.safeParse({
        mutationId: id,
        idempotencyKey: `${id}:${aggregateType}:create`,
        deviceId: id,
        tenantId: id,
        businessId: id,
        branchId: id,
        actorId: id,
        aggregateType,
        aggregateId: id,
        operation: "create",
        baseVersion: null,
        occurredAt: "2026-08-09T10:00:00+07:00",
        schemaVersion: 1,
        payload: {},
      });
      expect(result.success).toBe(true);
    }
  });
});
