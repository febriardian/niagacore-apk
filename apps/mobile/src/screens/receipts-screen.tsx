import {
  getSaleReceipt,
  expireStaleQrisPayments,
  getTransactionHistoryAnalyticsForContext,
  listSalesForContext,
  salePaymentStatusLabel,
  type SaleHistoryItem,
  type SaleReceiptDetail,
  type TransactionHistoryAnalytics,
  type TransactionHistoryDays,
} from "@/lib/remote-store";
import { formatRupiah } from "@niagacore/domain";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { useRemoteStore } from "@/lib/remote-store";
import React from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { buildReceiptHtml } from "@/lib/receipt";
import { useBusinessRealtime } from "@/hooks/use-business-realtime";
import type { ActiveWorkspace } from "@/providers/auth-provider";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Header,
  Row,
  Screen,
  Sheet,
} from "@/ui/components";
import { LocalizedText as Text, localizedAlert } from "@/ui/localized-text";
import { colors } from "@/ui/theme";
import { DonutChart, SalesTrendChart } from "@/ui/charts";

export function ReceiptsScreen({
  workspace,
  onBack,
}: {
  workspace: ActiveWorkspace;
  onBack: () => void;
}) {
  const db = useRemoteStore();
  const [sales, setSales] = React.useState<SaleHistoryItem[]>([]);
  const [detail, setDetail] = React.useState<SaleReceiptDetail | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [period, setPeriod] = React.useState<TransactionHistoryDays>(7);
  const [analytics, setAnalytics] = React.useState<TransactionHistoryAnalytics | null>(null);

  const load=React.useCallback(async()=>{
    await expireStaleQrisPayments(db,workspace);
    const [history,summary]=await Promise.all([
      listSalesForContext(db, workspace, 250, period),
      getTransactionHistoryAnalyticsForContext(db, workspace, period),
    ]);
    setSales(history);setAnalytics(summary);
  },[db,period,workspace]);
  React.useEffect(() => {
    const timer=setTimeout(()=>void load(),0);
    return()=>clearTimeout(timer);
  }, [load]);
  useBusinessRealtime(workspace,load);

  const loadDetail = async (sale: SaleHistoryItem) => {
    setBusyId(sale.id);
    const result = await getSaleReceipt(
      db,
      workspace,
      sale.branchId,
      sale.id,
    );
    setBusyId(null);
    if (!result) {
      localizedAlert("Struk", "Detail transaksi tidak ditemukan.");
      return;
    }
    setDetail({ ...result, branchName: sale.branchName });
  };

  const html = async (sale: SaleReceiptDetail) =>
    buildReceiptHtml({
      saleId: sale.id,
      receiptNumber: sale.receiptNumber,
      businessName: workspace.businessName,
      branchName: sale.branchName ?? workspace.branchName,
      occurredAt: sale.occurredAt,
      paymentMethod: sale.paymentMethod,
      lines: sale.lines,
      subtotalMinor: sale.subtotalMinor,
      discountMinor: sale.discountMinor,
      taxMinor: sale.taxMinor,
      totalMinor: sale.totalMinor,
      customerName: sale.customerName,
      paidMinor: sale.paymentMethod === "credit" ? sale.paidMinor : undefined,
      outstandingMinor: sale.paymentMethod === "credit" ? sale.outstandingMinor : undefined,
    });

  const share = async (sale: SaleReceiptDetail) => {
    const file = await Print.printToFileAsync({ html: await html(sale) });
    if (await Sharing.isAvailableAsync())
      await Sharing.shareAsync(file.uri, {
        mimeType: "application/pdf",
        dialogTitle: `Struk ${sale.receiptNumber}`,
      });
  };

  return (
    <Screen>
      <Header
        title="Riwayat Transaksi"
        subtitle={`${workspace.branchName} • filter, omzet, visualisasi, dan struk`}
        right={
          <Button compact variant="ghost" title="Kembali" onPress={onBack} />
        }
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.periods}>
        {([{value:1,label:"Hari ini"},{value:7,label:"7 hari"},{value:30,label:"30 hari"},{value:90,label:"90 hari"},{value:365,label:"1 tahun"},{value:0,label:"Semua"}] as const).map((item)=><Pressable key={item.value} onPress={()=>setPeriod(item.value)} style={[s.periodChip,period===item.value&&s.periodActive]}><Text style={[s.periodText,period===item.value&&s.periodTextActive]}>{item.label}</Text></Pressable>)}
      </ScrollView>
      <View style={s.metrics}>
        <Card style={s.metric}><Text style={s.metricLabel}>TRANSAKSI</Text><Text style={s.metricValue}>{analytics?.transactionCount ?? 0}</Text></Card>
        <Card style={s.metric}><Text style={s.metricLabel}>OMZET</Text><Text adjustsFontSizeToFit numberOfLines={1} style={s.metricValue}>{formatRupiah(analytics?.totalMinor ?? 0)}</Text></Card>
        <Card style={s.metric}><Text style={s.metricLabel}>RATA-RATA</Text><Text adjustsFontSizeToFit numberOfLines={1} style={s.metricValue}>{formatRupiah(analytics?.averageTicketMinor ?? 0)}</Text></Card>
        <Card style={s.metric}><Text style={s.metricLabel}>RETUR</Text><Text adjustsFontSizeToFit numberOfLines={1} style={s.metricValue}>{formatRupiah(analytics?.refundedMinor ?? 0)}</Text></Card>
      </View>
      <Card><Text style={s.chartTitle}>Tren transaksi</Text><SalesTrendChart data={analytics?.dailySales ?? []} emptyLabel="Belum ada transaksi pada periode ini."/></Card>
      {(analytics?.paymentMix.length ?? 0)>0 && <Card><Text style={s.chartTitle}>Status penerimaan</Text><Text style={s.chartNote}>Memisahkan uang yang sudah diterima dan sisa piutang.</Text><DonutChart centerLabel="Penjualan" centerValue={formatRupiah(analytics?.totalMinor ?? 0)} items={(analytics?.paymentMix ?? []).map((item,index)=>({label:item.method==='cash'?'Tunai':item.method==='receivable'?'Piutang':item.method.toUpperCase(),value:item.amountMinor,color:[colors.green,colors.orange,colors.blue,colors.navy][index%4] ?? colors.navy}))}/></Card>}
      {sales.length ? (
        sales.map((sale) => (
          <Row
            key={sale.id}
            title={sale.receiptNumber}
            detail={`${sale.branchName ? `${sale.branchName} • ` : ""}${new Date(sale.occurredAt).toLocaleString("id-ID")} • ${sale.paymentMethod.toUpperCase()} • ${formatRupiah(sale.totalMinor)}`}
            right={<Badge text={busyId===sale.id?"Memuat":salePaymentStatusLabel(sale)} tone={sale.paymentStatus === "paid" ? "green" : sale.status === "void" ? "red" : "amber"}/>} 
            onPress={() => void loadDetail(sale)}
          />
        ))
      ) : (
        <EmptyState
          title="Belum ada struk"
          detail="Struk tunai dan QRIS yang selesai akan muncul di sini."
        />
      )}
      <Sheet
        visible={detail !== null}
        title={detail?.receiptNumber ?? "Detail struk"}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <>
            <Row
              title={new Date(detail.occurredAt).toLocaleString("id-ID")}
              detail={detail.paymentMethod.toUpperCase()}
              right={
                <Badge
                  text={salePaymentStatusLabel(detail)}
                  tone={detail.paymentStatus === "paid" ? "green" : detail.status === "void" ? "red" : "amber"}
                />
              }
            />
            {detail.customerName && (
              <Text style={s.customer}>Pelanggan: {detail.customerName}</Text>
            )}
            <View style={s.lines}>
              {detail.lines.map((line, index) => (
                <Row
                  key={`${line.name}-${index}`}
                  title={`${line.name} × ${line.quantity}`}
                  detail={formatRupiah(line.totalMinor)}
                />
              ))}
            </View>
            <Row title="Subtotal" detail={formatRupiah(detail.subtotalMinor)} />
            {detail.discountMinor > 0 && (
              <Row
                title="Diskon"
                detail={`-${formatRupiah(detail.discountMinor)}`}
              />
            )}
            <Row title="Pajak" detail={formatRupiah(detail.taxMinor)} />
            <Text style={s.grandTotal}>{formatRupiah(detail.totalMinor)}</Text>
            {detail.paymentMethod === "credit" && <>
              <Row title="Sudah diterima" detail={formatRupiah(detail.paidMinor)} />
              <Row title="Sisa piutang" detail={formatRupiah(detail.outstandingMinor)} />
            </>}
            <Button
              title="Cetak struk + QR"
              onPress={() =>
                void html(detail).then((value) =>
                  Print.printAsync({ html: value }),
                )
              }
            />
            <Button
              variant="outline"
              title="Bagikan PDF"
              onPress={() => void share(detail)}
            />
          </>
        )}
      </Sheet>
    </Screen>
  );
}

const s = StyleSheet.create({
  periods:{gap:8,paddingRight:12},
  periodChip:{paddingHorizontal:16,paddingVertical:11,borderRadius:14,backgroundColor:"#E9EDF5",borderWidth:1,borderColor:colors.line},
  periodActive:{backgroundColor:colors.blue,borderColor:colors.blue},
  periodText:{color:colors.muted,fontSize:11,fontWeight:"900"},
  periodTextActive:{color:colors.white},
  metrics:{flexDirection:"row",flexWrap:"wrap",gap:9},
  metric:{width:"48.5%"},
  metricLabel:{color:colors.muted,fontSize:9,fontWeight:"900",letterSpacing:.7},
  metricValue:{color:colors.navy,fontSize:18,fontWeight:"900",marginTop:9},
  chartTitle:{color:colors.ink,fontSize:15,fontWeight:"900",marginBottom:4},
  chartNote:{color:colors.muted,fontSize:10,lineHeight:15,marginBottom:8},
  customer: { color: colors.muted, fontSize: 11, marginVertical: 8 },
  lines: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.line,
    marginVertical: 10,
  },
  grandTotal: {
    color: colors.navy,
    fontSize: 22,
    fontWeight: "900",
    textAlign: "right",
    marginVertical: 14,
  },
});
