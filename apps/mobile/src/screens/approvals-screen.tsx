import {
  listPendingApprovals,
  resolveLocalApproval,
  type PendingApproval,
} from "@/lib/remote-store";
import { formatRupiah } from "@niagacore/domain";
import { useRemoteStore } from "@/lib/remote-store";
import React from "react";
import { StyleSheet, View } from "react-native";

import { supabase } from "@/lib/supabase";
import type { ActiveWorkspace } from "@/providers/auth-provider";
import { Badge, Button, Card, EmptyState, Header, LoadingBlock, Screen } from "@/ui/components";
import { LocalizedText as Text, localizedAlert } from "@/ui/localized-text";
import { colors } from "@/ui/theme";

export function ApprovalsScreen({ workspace, onChanged, onBack }: { workspace: ActiveWorkspace; onChanged: () => Promise<void>; onBack: () => void }) {
  const db = useRemoteStore();
  const [items, setItems] = React.useState<PendingApproval[]>([]);
  const [loading, setLoading] = React.useState(true);
  const load = React.useCallback(async () => {
    setLoading(true);
    setItems(await listPendingApprovals(db, workspace));
    setLoading(false);
  }, [db, workspace]);
  React.useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  const decide = async (item: PendingApproval, decision: "approved" | "rejected") => {
    try {
      if (supabase) {
        const saleResult = item.kind === "refund" && item.resourceId
          ? await db.from("sales").select("payment_method").eq("id", item.resourceId)
              .eq("tenant_id", workspace.tenantId).eq("branch_id", workspace.branchId).maybeSingle()
          : null;
        if (saleResult?.error) throw saleResult.error;
        const sale = saleResult?.data ?? null;
        if (decision === "approved" && sale?.payment_method === "qris") {
          const result = await supabase.functions.invoke("refund-midtrans", {
            body: { pendingRefundId: item.id },
          });
          if (result.error) throw result.error;
        } else {
          const result = await supabase.rpc("resolve_approval_request", {
            target_approval_id: item.id,
            decision,
            decision_note: null,
          });
          if (result.error && !result.error.message.includes("approval_not_found")) throw result.error;
        }
      }
      await resolveLocalApproval(db, workspace, item, decision);
      await onChanged();
      await load();
    } catch (error) {
      localizedAlert("Persetujuan", error instanceof Error ? error.message : String(error));
    }
  };
  return <Screen>
    <Header title="Pusat persetujuan" subtitle={`${workspace.branchName} · tindakan yang memerlukan pemeriksaan`} right={<Button compact variant="ghost" title="Kembali" onPress={onBack}/>} />
    {loading ? <LoadingBlock /> : items.length === 0 ? (
      <EmptyState title="Tidak ada antrean" detail="Permintaan retur, diskon, stok, pembelian, dan jurnal akan tampil di sini." />
    ) : items.map((item) => <Card key={item.id}>
      <View style={s.head}><Badge text={label(item.kind)} tone="amber"/><Text style={s.date}>{new Date(item.createdAt).toLocaleString("id-ID")}</Text></View>
      <Text style={s.title}>{item.reason}</Text>
      {typeof item.payload.amountMinor === "number" ? <Text style={s.amount}>{formatRupiah(item.payload.amountMinor)}</Text> : null}
      <Text style={s.meta}>Diajukan oleh {item.requestedBy.slice(0, 8)} · referensi {item.resourceId?.slice(0, 12) ?? "-"}</Text>
      <View style={s.actions}><Button compact variant="danger" title="Tolak" onPress={() => void decide(item, "rejected")}/><Button compact title="Setujui" onPress={() => void decide(item, "approved")}/></View>
    </Card>)}
  </Screen>;
}

function label(kind: string) {
  const labels: Record<string, string> = { refund: "Retur", discount: "Diskon", stock: "Stok", purchase_order: "PO", manual_journal: "Jurnal" };
  return labels[kind] ?? kind;
}
const s = StyleSheet.create({ head:{flexDirection:"row",alignItems:"center",justifyContent:"space-between"},date:{fontSize:10,color:colors.muted},title:{fontSize:15,fontWeight:"900",color:colors.ink,marginTop:12},amount:{fontSize:20,fontWeight:"900",color:colors.blue,marginTop:5},meta:{fontSize:11,lineHeight:16,color:colors.muted,marginTop:5},actions:{flexDirection:"row",justifyContent:"flex-end",gap:8,marginTop:14} });
