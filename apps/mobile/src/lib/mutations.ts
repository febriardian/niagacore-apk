import type { MutationEnvelope } from '@niagacore/contracts';
import * as Crypto from 'expo-crypto';

import type { ActiveWorkspace } from '@/providers/auth-provider';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function createMutation(
  workspace: ActiveWorkspace,
  aggregateType: MutationEnvelope['aggregateType'],
  aggregateId: string,
  operation: MutationEnvelope['operation'],
  payload: Record<string, unknown>,
  baseVersion: number | null = null,
): Promise<MutationEnvelope> {
  const mutationId=Crypto.randomUUID();
  const payloadHash = `sha256:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonicalJson(payload))}`;
  return {mutationId,idempotencyKey:`${workspace.deviceId}:${mutationId}`,deviceId:workspace.deviceId,
    tenantId:workspace.tenantId,businessId:workspace.businessId,branchId:workspace.branchId,
    actorId:workspace.userId,aggregateType,aggregateId,operation,baseVersion,
    occurredAt:new Date().toISOString(),schemaVersion:2,payloadHash,payload};
}
