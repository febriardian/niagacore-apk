import {
  getDashboardAnalytics,
  getFinancialStatements,
  getManagementReport,
  type DashboardAnalytics,
  type FinancialStatements,
  type ManagementReport,
  type ReportingScope,
} from "@/lib/remote-store";
import { formatRupiah } from "@niagacore/domain";
import { useRemoteStore } from "@/lib/remote-store";
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import type { ActiveWorkspace } from "@/providers/auth-provider";
import { useAppTheme } from "@/providers/theme-provider";
import { supabase } from "@/lib/supabase";
import {
  Badge,
  Button,
  Card,
  Header,
  ProgressBar,
  Screen,
  Segmented,
} from "@/ui/components";
import { colors } from "@/ui/theme";
import { DonutChart, SalesTrendChart } from "@/ui/charts";
import { LocalizedText as Text, localizedAlert } from "@/ui/localized-text";
import {
  sharePdfFromHtml,
  shareTextReport,
  type ReportExportFormat,
} from "@/lib/report-export";
import {useBusinessRealtime} from "@/hooks/use-business-realtime";

type ReportTab = "overview" | "profit" | "balance" | "ledger" | "detail";
const escapeHtml=(value:unknown)=>String(value??"").replace(/[&<>"']/g,(character)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]!));
const csvCell=(value:unknown)=>`"${String(value??"").replace(/"/g,'""')}"`;
const exportErrorMessage=(error:unknown)=>{
  const detail=error instanceof Error?error.message:String(error);
  if(detail.includes("sharing_not_available"))return "Menu simpan atau bagikan file tidak tersedia pada perangkat ini.";
  if(detail.includes("export_file_not_ready"))return "File belum selesai dibuat. Silakan coba lagi.";
  return "File belum dapat dibuka. Silakan coba lagi setelah aplikasi diperbarui.";
};
const exportFormats:{format:ReportExportFormat;label:string;detail:string}[]=[
  {format:"pdf",label:"PDF",detail:"Siap dibaca"},
  {format:"csv",label:"CSV",detail:"Untuk spreadsheet"},
  {format:"json",label:"JSON",detail:"Arsip terstruktur"},
];
export function ReportsScreen({ workspace }: { workspace: ActiveWorkspace }) {
  const db = useRemoteStore();
  const [tab, setTab] = React.useState<ReportTab>("overview");
  const [period, setPeriod] = React.useState<"7" | "30" | "90">("30");
  const [scope,setScope]=React.useState<ReportingScope>("branch");
  const [analytics, setAnalytics] = React.useState<DashboardAnalytics | null>(
    null,
  );
  const [financial, setFinancial] = React.useState<FinancialStatements | null>(
    null,
  );
  const [management, setManagement] = React.useState<ManagementReport | null>(null);
  const [reportError,setReportError]=React.useState<string|null>(null);
  const [accountingBusy,setAccountingBusy]=React.useState(false);
  const load=React.useCallback(async()=>{
    try{setReportError(null);const [a,f,m]=await Promise.all([getDashboardAnalytics(db,workspace,Number(period),scope),getFinancialStatements(db,workspace,scope),getManagementReport(db,workspace,scope)]);setAnalytics(a);setFinancial(f);setManagement(m)}catch(error){setAnalytics(null);setFinancial(null);setManagement(null);setReportError(error instanceof Error?error.message:String(error))}
  },[db,period,scope,workspace]);
  React.useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  useBusinessRealtime(workspace,load);
  const runDepreciation=async()=>{
    if(!supabase)return localizedAlert("Akuntansi","Backend belum dikonfigurasi.");
    setAccountingBusy(true);
    const {data,error}=await supabase.rpc("run_monthly_depreciation",{target_business:workspace.businessId,period_end:new Date().toISOString().slice(0,10)});
    setAccountingBusy(false);
    if(error)return localizedAlert("Penyusutan",error.message);
    localizedAlert("Penyusutan",`${Number(data??0)} aset berhasil diposting secara idempoten.`);
  };
  const exportTax=async(format:ReportExportFormat)=>{
    if(!supabase)return localizedAlert("Pajak","Backend belum dikonfigurasi.");
    setAccountingBusy(true);
    try {
      const until=new Date(),from=new Date(until);from.setDate(from.getDate()-Number(period));
      const {data,error}=await supabase.rpc("export_tax_reconciliation",{target_business:workspace.businessId,date_from:from.toISOString().slice(0,10),date_until:until.toISOString().slice(0,10)});
      if(error)throw error;
      const rows=(data??[]) as {policy_code:string;policy_version:number;coretax_code:string|null;tax_base_minor:number;tax_minor:number}[];
      const html=`<html><body style="font-family:sans-serif;padding:32px"><h1>Rekonsiliasi Pajak NiagaCore</h1><p>${from.toLocaleDateString("id-ID")}–${until.toLocaleDateString("id-ID")}</p><table style="width:100%;border-collapse:collapse"><tr><th>Kebijakan</th><th>Versi</th><th>Coretax</th><th>DPP</th><th>Pajak</th></tr>${rows.map(row=>`<tr><td>${escapeHtml(row.policy_code)}</td><td>${row.policy_version}</td><td>${escapeHtml(row.coretax_code??"Belum dipetakan")}</td><td>${formatRupiah(row.tax_base_minor)}</td><td>${formatRupiah(row.tax_minor)}</td></tr>`).join("")}</table><p>Dokumen persiapan. Periksa kembali sebelum pelaporan resmi.</p></body></html>`;
      const csv=["policy_code,policy_version,coretax_code,tax_base_minor,tax_minor",...rows.map(row=>[row.policy_code,row.policy_version,row.coretax_code??"",row.tax_base_minor,row.tax_minor].map(csvCell).join(","))].join("\n");
      if(format==="pdf") await sharePdfFromHtml("rekonsiliasi-pajak",html,"Bagikan rekonsiliasi pajak");
      else await shareTextReport("rekonsiliasi-pajak",format,format==="csv"?csv:JSON.stringify({period:{from:from.toISOString(),until:until.toISOString()},rows},null,2),"Bagikan rekonsiliasi pajak");
    } catch(error) {
      localizedAlert("Ekspor pajak",exportErrorMessage(error));
    } finally { setAccountingBusy(false); }
  };
  const exportReport=async(format:ReportExportFormat)=>{
    if(!analytics&&!financial&&!management)return localizedAlert("Ekspor laporan","Laporan belum tersedia.");
    setAccountingBusy(true);
    try {
      const rows=[
        ["Penjualan",analytics?.grossSalesMinor??0],
        ["Laba estimasi",analytics?.profitMinor??0],
        ["Jumlah transaksi",analytics?.transactionCount??0],
        ["Piutang",analytics?.receivableMinor??0],
        ["Utang",analytics?.payableMinor??0],
        ["Kas masuk",management?.cashInMinor??0],
        ["Kas keluar",management?.cashOutMinor??0],
        ["Nilai persediaan",management?.inventoryValueMinor??0],
      ] as const;
      const payload={generatedAt:new Date().toISOString(),periodDays:Number(period),scope,workspace:{businessId:workspace.businessId,branchId:workspace.branchId},analytics,financial,management};
      const html=`<html><body style="font-family:sans-serif;padding:32px"><h1>Laporan NiagaCore</h1><p>${scope==="business"?"Semua cabang":"Cabang "+escapeHtml(workspace.branchName)} • Periode ${period} hari</p><table style="width:100%;border-collapse:collapse">${rows.map(([label,value])=>`<tr><td>${escapeHtml(label)}</td><td style="text-align:right">${typeof value==="number"&&label!=="Jumlah transaksi"?formatRupiah(value):escapeHtml(value)}</td></tr>`).join("")}</table></body></html>`;
      const csv=["metric,value",...rows.map(row=>row.map(csvCell).join(","))].join("\n");
      if(format==="pdf") await sharePdfFromHtml("laporan-usaha",html,"Bagikan laporan usaha");
      else await shareTextReport("laporan-usaha",format,format==="csv"?csv:JSON.stringify(payload,null,2),"Bagikan laporan usaha");
    } catch(error) {
      localizedAlert("Ekspor laporan",exportErrorMessage(error));
    } finally { setAccountingBusy(false); }
  };
  return (
    <Screen>
      <Header
        title="Laporan"
        subtitle={`${scope==="business"?`Semua cabang ${workspace.businessName}`:`Cabang aktif • ${workspace.branchName}`} • data server`}
      />
      {["owner","business_manager"].includes(workspace.role)&&workspace.branches.length>1?<Card><Text style={s.scopeTitle}>CAKUPAN SELURUH LAPORAN</Text><Segmented value={scope} onChange={setScope} items={[{value:"branch",label:"Cabang aktif"},{value:"business",label:"Semua cabang"}]}/><Text style={s.note}>{scope==="business"?`Semua angka, termasuk jurnal dan laporan keuangan, menggabungkan ${workspace.branches.length} cabang dalam ${workspace.businessName}.`:`Semua angka hanya berasal dari ${workspace.branchName}. Jurnal pusat tanpa cabang tidak ikut dihitung.`}</Text></Card>:null}
      <Segmented
        value={tab}
        onChange={setTab}
        items={[
          { value: "overview", label: "Ringkas" },
          { value: "profit", label: "Laba rugi" },
          { value: "balance", label: "Neraca" },
          { value: "ledger", label: "Ledger" },
          { value: "detail", label: "Detail" },
        ]}
      />
      {(tab === "overview" || tab === "detail") && (
        <Segmented value={period} onChange={setPeriod} items={[{ value: "7", label: "7 hari" }, { value: "30", label: "30 hari" }, { value: "90", label: "90 hari" }]} />
      )}
      {["profit","balance","ledger"].includes(tab)?<Card><Text style={s.note}>Laporan akuntansi mengikuti cakupan yang sama: {scope==="business"?`semua cabang ${workspace.businessName}`:workspace.branchName}.</Text></Card>:null}
      {reportError?<Card><Text style={s.statementTitle}>Laporan gagal dimuat</Text><Text style={s.note}>{reportError}</Text><Button variant="outline" title="Coba lagi" onPress={()=>void load()}/></Card>:<>{tab === "overview" && <Overview data={analytics} />}{tab === "profit" && <Profit data={financial} />}{tab === "balance" && <Balance data={financial} />}{tab === "ledger" && <Ledger data={financial} />}{tab === "detail" && <Detail data={management} />}</>}
      <Card>
        <Text style={s.statementTitle}>Ekspor laporan</Text>
        <Text style={s.note}>Simpan laporan sebagai PDF, CSV, atau JSON sesuai kebutuhan.</Text>
        <FormatButtons disabled={accountingBusy||!!reportError} onSelect={format=>void exportReport(format)}/>
      </Card>
      {["owner","finance"].includes(workspace.role) && <Card><Text style={s.statementTitle}>Tindakan akuntansi</Text><Text style={s.note}>Hitung penyusutan aset atau unduh data pajak untuk periode yang sedang dipilih.</Text><View style={s.actionRow}><Button disabled={accountingBusy} variant="outline" title="Hitung penyusutan" onPress={()=>void runDepreciation()}/><Text style={s.actionLabel}>Unduh data pajak</Text><FormatButtons disabled={accountingBusy} onSelect={format=>void exportTax(format)}/></View></Card>}
    </Screen>
  );
}
function FormatButtons({disabled,onSelect}:{disabled:boolean;onSelect:(format:ReportExportFormat)=>void}){
  const theme=useAppTheme();
  return <View accessibilityLabel="Pilihan format unduhan" style={s.formatGrid}>
    {exportFormats.map(item=><Pressable accessibilityRole="button" accessibilityLabel={`Unduh ${item.label}`} disabled={disabled} key={item.format} onPress={()=>onSelect(item.format)} style={({pressed})=>[s.formatOption,{backgroundColor:theme.colors.surface,borderColor:theme.colors.line},(disabled||pressed)&&s.formatOptionDim]}>
      <Text style={[s.formatLabel,{color:theme.colors.blue}]}>{item.label}</Text>
      <Text style={[s.formatDetail,{color:theme.colors.muted}]}>{item.detail}</Text>
    </Pressable>)}
  </View>;
}
function Detail({ data }: { data: ManagementReport | null }) {
  return (
    <>
      <Card>
        <Text style={s.statementTitle}>Arus kas langsung</Text>
        <Line label="Kas masuk" value={data?.cashInMinor ?? 0} />
        <Line label="Kas keluar" value={-(data?.cashOutMinor ?? 0)} />
        <View style={s.divider} />
        <Line
          label="Arus kas bersih"
          value={(data?.cashInMinor ?? 0) - (data?.cashOutMinor ?? 0)}
          strong
        />
      </Card>
      <Card>
        <Text style={s.statementTitle}>Persediaan & pajak</Text>
        <Line label="Nilai persediaan" value={data?.inventoryValueMinor ?? 0} />
        <Line label="Pajak keluaran" value={data?.outputTaxMinor ?? 0} />
        <Line label="Pajak masukan" value={-(data?.inputTaxMinor ?? 0)} />
        <View style={s.divider} />
        <Line
          label="Rekonsiliasi pajak"
          value={(data?.outputTaxMinor ?? 0) - (data?.inputTaxMinor ?? 0)}
          strong
        />
      </Card>
      {data?.aging.map((row) => (
        <Card key={row.kind}>
          <Text style={s.title}>Umur {row.kind.toLowerCase()}</Text>
          <Line label="Belum jatuh tempo" value={row.currentMinor} />
          <Line label="1–30 hari" value={row.days30Minor} />
          <Line label="31–60 hari" value={row.days60Minor} />
          <Line label=">60 hari" value={row.over90Minor} />
        </Card>
      ))}
    </>
  );
}
function Overview({ data }: { data: DashboardAnalytics | null }) {
  const receivedMinor=(data?.paymentMix??[]).filter((item)=>item.method!=="receivable").reduce((sum,item)=>sum+item.amountMinor,0);
  const total = Math.max(
    1,
    (data?.grossSalesMinor ?? 0) + (data?.receivableMinor ?? 0),
  );
  return (
    <>
      <View style={s.metricGrid}>
        <Metric
          label="Penjualan"
          value={data?.grossSalesMinor ?? 0}
          tone="blue"
        />
        <Metric
          label="Laba estimasi"
          value={data?.profitMinor ?? 0}
          tone={(data?.profitMinor ?? 0) >= 0 ? "green" : "red"}
        />
        <Metric
          label="Sudah diterima"
          value={receivedMinor}
          tone="green"
        />
        <Metric
          label="Piutang"
          value={data?.receivableMinor ?? 0}
          tone="amber"
        />
        <Metric label="Utang" value={data?.payableMinor ?? 0} tone="red" />
      </View>
      <Card>
        <Text style={s.title}>Tren periode</Text>
        <Text style={s.note}>Sumbu vertikal menunjukkan nilai penjualan, sumbu horizontal menunjukkan tanggal.</Text>
        <SalesTrendChart data={data?.dailySales ?? []} emptyLabel="Belum ada penjualan pada periode ini." />
      </Card>
      <Card>
        <Text style={s.title}>Komposisi arus usaha</Text>
        <Stack
          label="Penjualan"
          value={data?.grossSalesMinor ?? 0}
          max={total}
          color={colors.orange}
        />
        <Stack
          label="HPP"
          value={data?.costMinor ?? 0}
          max={total}
          color={colors.navy}
        />
        <Stack
          label="Beban"
          value={data?.expenseMinor ?? 0}
          max={total}
          color={colors.red}
        />
      </Card>
      <Card>
        <Text style={s.title}>Status penerimaan</Text>
        {!data || data.paymentMix.length === 0 ? (
          <Text style={s.note}>Belum ada pembayaran.</Text>
        ) : (
          <DonutChart
            centerLabel="Total"
            centerValue={formatRupiah(data.grossSalesMinor)}
            items={data.paymentMix.map((item, index) => ({
              label: item.method === "cash" ? "Tunai" : item.method === "receivable" ? "Piutang" : item.method.toUpperCase(),
              value: item.amountMinor,
              color: ([colors.green, colors.blue, colors.orange, colors.navy] as string[])[index % 4] ?? colors.blue,
            }))}
          />
        )}
      </Card>
    </>
  );
}
function Profit({ data }: { data: FinancialStatements | null }) {
  return (
    <Card>
      <Text style={s.statementTitle}>Laporan laba rugi</Text>
      <Line label="Pendapatan" value={data?.revenueMinor ?? 0} />
      <Line label="Beban dan HPP" value={-(data?.expenseMinor ?? 0)} />
      <View style={s.divider} />
      <Line
        label="Laba (rugi) bersih"
        value={data?.netIncomeMinor ?? 0}
        strong
      />
    </Card>
  );
}
function Balance({ data }: { data: FinancialStatements | null }) {
  return (
    <>
      <Card>
        <Text style={s.statementTitle}>Neraca</Text>
        <Line label="Total aset" value={data?.assetsMinor ?? 0} />
        <Line label="Total liabilitas" value={data?.liabilitiesMinor ?? 0} />
        <Line
          label="Ekuitas"
          value={(data?.equityMinor ?? 0) + (data?.netIncomeMinor ?? 0)}
        />
        <View style={s.divider} />
        <Line label="Kas" value={data?.cashMinor ?? 0} />
        <Line label="Persediaan" value={data?.inventoryMinor ?? 0} />
      </Card>
      <Badge
        text={
          (data?.assetsMinor ?? 0) ===
          (data?.liabilitiesMinor ?? 0) +
            (data?.equityMinor ?? 0) +
            (data?.netIncomeMinor ?? 0)
            ? "Neraca seimbang"
            : "Perlu rekonsiliasi"
        }
        tone={
          (data?.assetsMinor ?? 0) ===
          (data?.liabilitiesMinor ?? 0) +
            (data?.equityMinor ?? 0) +
            (data?.netIncomeMinor ?? 0)
            ? "green"
            : "amber"
        }
      />
    </>
  );
}
function Ledger({ data }: { data: FinancialStatements | null }) {
  return (
    <Card>
      <Text style={s.statementTitle}>Neraca saldo</Text>
      {(data?.trialBalance ?? []).length === 0 ? (
        <Text style={s.note}>Belum ada jurnal terposting.</Text>
      ) : (
        data?.trialBalance.map((x) => (
          <View key={x.accountCode} style={s.ledgerRow}>
            <Text style={s.account}>{x.accountCode}</Text>
            <View style={s.flex}>
              <Text style={s.debit}>D {formatRupiah(x.debitMinor)}</Text>
              <Text style={s.credit}>K {formatRupiah(x.creditMinor)}</Text>
            </View>
            <Text style={s.balance}>{formatRupiah(x.balanceMinor)}</Text>
          </View>
        ))
      )}
    </Card>
  );
}
function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "blue" | "green" | "amber" | "red";
}) {
  return (
    <Card style={s.metric}>
      <Badge text={label} tone={tone} />
      <Text adjustsFontSizeToFit numberOfLines={1} style={s.metricValue}>
        {formatRupiah(value)}
      </Text>
    </Card>
  );
}
function Stack({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  return (
    <View style={s.stack}>
      <View style={s.stackHead}>
        <Text style={s.stackLabel}>{label}</Text>
        <Text style={s.stackValue}>{formatRupiah(value)}</Text>
      </View>
      <ProgressBar value={(value / max) * 100} color={color} />
    </View>
  );
}
function Line({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <View style={s.line}>
      <Text style={[s.lineLabel, strong && s.strong]}>{label}</Text>
      <Text style={[s.lineValue, strong && s.strong, value < 0 && s.negative]}>
        {formatRupiah(value)}
      </Text>
    </View>
  );
}
const s = StyleSheet.create({
  scopeTitle:{fontSize:10,fontWeight:"900",color:colors.muted,letterSpacing:1,marginBottom:8},
  actionRow:{gap:10,marginTop:14},
  actionLabel:{fontSize:12,fontWeight:"900",color:colors.ink,marginTop:4},
  formatGrid:{flexDirection:"row",gap:8,marginTop:12},
  formatOption:{flex:1,minHeight:70,borderWidth:1,borderRadius:14,alignItems:"center",justifyContent:"center",paddingHorizontal:6,paddingVertical:10},
  formatOptionDim:{opacity:.55},
  formatLabel:{fontSize:14,fontWeight:"900",color:colors.blue},
  formatDetail:{fontSize:9,lineHeight:13,color:colors.muted,textAlign:"center",marginTop:3},
  metricGrid: { flexDirection: "row", flexWrap: "wrap", gap: 9 },
  metric: { width: "48.6%" },
  metricValue: {
    fontSize: 16,
    fontWeight: "900",
    color: colors.ink,
    marginTop: 13,
  },
  title: {
    fontSize: 15,
    fontWeight: "900",
    color: colors.ink,
    marginBottom: 4,
  },
  stack: { gap: 7, marginTop: 15 },
  stackHead: { flexDirection: "row", justifyContent: "space-between" },
  stackLabel: { fontSize: 12, color: colors.muted },
  stackValue: { fontSize: 12, fontWeight: "900", color: colors.ink },
  note: { fontSize: 11, color: colors.muted, lineHeight: 18 },
  statementTitle: {
    fontSize: 18,
    fontWeight: "900",
    color: colors.ink,
    marginBottom: 8,
  },
  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 11,
  },
  lineLabel: { fontSize: 13, color: colors.muted },
  lineValue: { fontSize: 13, fontWeight: "800", color: colors.ink },
  strong: { fontWeight: "900", fontSize: 15, color: colors.navy },
  negative: { color: colors.red },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: 5 },
  ledgerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  account: { width: 42, fontSize: 12, fontWeight: "900", color: colors.navy },
  flex: { flex: 1 },
  debit: { fontSize: 10, color: colors.muted },
  credit: { fontSize: 10, color: colors.muted, marginTop: 2 },
  balance: { fontSize: 11, fontWeight: "900", color: colors.ink },
});
