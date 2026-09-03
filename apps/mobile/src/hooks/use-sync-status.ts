import { useCallback, useEffect, useState } from 'react';
import { pendingMutationCount, useRemoteStore } from '@/lib/remote-store';

export function useSyncStatus(deviceId?: string, tenantId?: string, branchId?: string) {
  const db = useRemoteStore();
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [pendingCount,setPendingCount]=useState(0);
  const [ready,setReady]=useState(false);
  const [checking,setChecking]=useState(false);
  const [lastCheckedAt,setLastCheckedAt]=useState<string|null>(null);
  const synchronize = useCallback(async () => {
    if (!tenantId||!branchId||!deviceId) return;
    setChecking(true);
    try{
      const [{data:tenant,error:tenantError},{data:device,error:deviceError},{data:lastMutation,error:mutationError},reviews]=await Promise.all([
        db.from('tenants').select('id').eq('id',tenantId).maybeSingle(),
        db.from('devices').select('status,last_seen_at').eq('tenant_id',tenantId).eq('id',deviceId).maybeSingle(),
        db.from('sync_mutations').select('accepted_at').eq('tenant_id',tenantId).eq('branch_id',branchId).order('accepted_at',{ascending:false}).limit(1).maybeSingle(),
        pendingMutationCount(db,tenantId,branchId),
      ]);
      const error=tenantError??deviceError??mutationError;
      if(error)throw new Error(error.message);
      if(!tenant)throw new Error('tenant_access_denied');
      if(!device||device.status!=='active')throw new Error('device_not_active');
      setPendingCount(reviews);
      setLastSyncedAt(lastMutation?.accepted_at??device.last_seen_at??null);
      setLastCheckedAt(new Date().toISOString());
      setLastError(null);setReady(true);
    }catch(error){const message=error instanceof Error?error.message:String(error);setLastCheckedAt(new Date().toISOString());setReady(false);setLastError(message);throw error;}
    finally{setChecking(false)}
  }, [branchId,db,deviceId,tenantId]);

  useEffect(() => {
    if (!tenantId) return;
    const timer = setTimeout(() => void synchronize().catch(() => undefined), 0);
    return () => clearTimeout(timer);
  }, [synchronize, tenantId]);

  return { pendingCount, ready, checking, refresh: synchronize, synchronize, lastError, lastSyncedAt, lastCheckedAt };
}
