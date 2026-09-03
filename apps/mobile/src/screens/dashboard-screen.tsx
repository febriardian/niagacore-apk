import { areasFor, formatRupiah, roleLabel } from "@niagacore/domain";
import {
  getAccountingSettings,
  getCashierDashboardAnalytics,
  getDashboardAnalytics,
  type DashboardAnalytics,
} from "@/lib/remote-store";
import { useRemoteStore } from "@/lib/remote-store";
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { supabase } from "@/lib/supabase";
import { useBusinessRealtime } from "@/hooks/use-business-realtime";
import type { ActiveWorkspace } from "@/providers/auth-provider";
import { useAppTheme } from "@/providers/theme-provider";
import {
  Badge,
  Button,
  Card,
  Field,
  Header,
  ProgressBar,
  Screen,
  Segmented,
} from "@/ui/components";
import { SalesTrendChart } from "@/ui/charts";
import { colors, radius } from "@/ui/theme";
import { LocalizedText as Text, localizedAlert } from "@/ui/localized-text";

type InsightKind="overview"|"forecast"|"anomaly"|"finance"|"sales"|"customers"|"ask";
type NiaError={title:string;detail:string};
const NIA_CONTRACT_VERSION="nia-insights/v3";
type Insight = {
  ok?: boolean;
  contractVersion?: string;
  requestId?: string;
  id?: string;
  title: string;
  summary: string;
  explanation?: string;
  confidence?: number;
  dataWindow?: string;
  recommendations?: string[];
  evidence?: string[];
  model?: string;
  provider?: string;
  source?: string;
  generatedAt?: string;
  signalStrength?: "low" | "medium" | "high";
  evidenceIds?: string[];
  dataQuality?: {level:"limited"|"fair"|"good";label:string;score:number;observedDays:number;windowDays:number};
};

export function DashboardScreen({
  workspace,
  onNavigate,
  sync,
}: {
  workspace: ActiveWorkspace;
  onNavigate: (target: string) => void;
  sync: {
    pendingCount: number;
    lastError: string | null;
    lastSyncedAt: string | null;
    lastCheckedAt: string | null;
    ready: boolean;
    checking: boolean;
    synchronize: () => Promise<void>;
  };
}) {
  const theme=useAppTheme();
  const db = useRemoteStore();
  const [data, setData] = React.useState<DashboardAnalytics | null>(null);
  const [analyticsError,setAnalyticsError]=React.useState<string|null>(null);
  const [insight, setInsight] = React.useState<Insight | null>(null);
  const [aiBusy, setAiBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const [question,setQuestion]=React.useState("");
  const [niaError,setNiaError]=React.useState<NiaError|null>(null);
  const [lastAiKind,setLastAiKind]=React.useState<InsightKind>("overview");
  const [cloudAiEnabled, setCloudAiEnabled] = React.useState(true);
  const [period, setPeriod] = React.useState<"7" | "30" | "90">("7");
  const load = React.useCallback(async () => {
    try{
      setAnalyticsError(null);
      const cashierView=workspace.role==="cashier";
      const analytics=cashierView?await getCashierDashboardAnalytics(db,workspace,Number(period)):await getDashboardAnalytics(db,workspace,Number(period));
      setData(analytics);
      if(!cashierView){const settings=await getAccountingSettings(db,workspace);setCloudAiEnabled(settings.cloudAiEnabled)}
    }catch(error){setData(null);setAnalyticsError(error instanceof Error?error.message:String(error))}
  }, [db, period, workspace]);
  React.useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  useBusinessRealtime(workspace,load);
  const ai = async (kind:InsightKind = "overview") => {
    setLastAiKind(kind);
    setNiaError(null);
    if (!cloudAiEnabled) {
      setNiaError({title:"NIA sedang dinonaktifkan",detail:"Aktifkan AI cloud pada Pengaturan Usaha untuk memakai penjelasan Gemini atau Cloudflare."});
      return;
    }
    if (!supabase) {
      setNiaError({title:"Backend belum siap",detail:"Konfigurasi Supabase belum ditemukan pada aplikasi ini."});
      return;
    }
    const client=supabase;
    const invoke=async()=>client.functions.invoke("ai-insights",{
      body: {
          tenantId: workspace.tenantId,
          businessId: workspace.businessId,
          branchId: workspace.branchId,
          kind,
          windowDays:Number(period),
          question:kind==="ask"?question.trim():undefined,
          clientContractVersion:NIA_CONTRACT_VERSION,
        },
      });
    setAiBusy(true);
    const { data: result, error } = await invoke();
    setAiBusy(false);
    if (error) setNiaError({title:error.message.includes("429")?"Batas analisis tercapai":"NIA belum dapat terhubung",detail:error.message.includes("429")?"Tunggu satu menit lalu coba kembali.":"Periksa koneksi dan deploy Edge Function ai-insights versi terbaru."});
    else {
      const next=result as Insight;
      if(next?.ok===false||next?.contractVersion!==NIA_CONTRACT_VERSION){
        setNiaError({title:"Layanan NIA perlu diperbarui",detail:"Versi aplikasi dan Edge Function belum cocok. Jalankan scripts/deploy-nia.ps1, lalu coba lagi."});
        return;
      }
      setInsight(next);
      if(kind==="ask")setQuestion("");
      setFeedback(null);
    }
  };
  const submitFeedback = async (rating: "helpful" | "incorrect") => {
    if (!supabase || !insight?.id) return;
    const { error } = await supabase.rpc("submit_ai_feedback", {
      target_output_id: insight.id,
      feedback_rating: rating,
      feedback_note: null,
    });
    if (error) localizedAlert("NIA", error.message);
    else setFeedback(rating);
  };
  const comparison = data?.previousGrossSalesMinor
    ? (((data.grossSalesMinor - data.previousGrossSalesMinor) /
        data.previousGrossSalesMinor) *
      100)
    : null;
  const canSeeBusinessDashboard = [
    "owner","business_manager","branch_manager","supervisor","finance","auditor",
  ].includes(workspace.role);
  const isCashierDashboard=workspace.role==="cashier";
  const canSeeSalesAnalytics=canSeeBusinessDashboard||isCashierDashboard;
  return (
    <Screen>
      <Header
        title={`Halo, ${workspace.businessName}`}
        subtitle={`${workspace.branchName} • ${roleLabel(workspace.role)}`}
        right={
          <Badge
            text={
              workspace.merchantStatus === "approved"
                ? "Terverifikasi"
                : "Dalam tinjauan"
            }
            tone={workspace.merchantStatus === "approved" ? "green" : "amber"}
          />
        }
      />
      <View style={s.hero}>
        <View style={s.heroGlow} />
        <Text style={s.heroLabel}>{canSeeSalesAnalytics ? `${isCashierDashboard?"PENJUALAN CABANG":"PENJUALAN"} ${period} HARI` : "RUANG KERJA AKTIF"}</Text>
        <Text style={s.heroValue}>{canSeeSalesAnalytics ? analyticsError ? "Data gagal dimuat" : formatRupiah(data?.grossSalesMinor ?? 0) : roleLabel(workspace.role)}</Text>
        <Text style={s.heroDetail}>{canSeeSalesAnalytics
          ? analyticsError ? "Data tidak diganti dengan angka nol. Periksa koneksi lalu coba lagi." : isCashierDashboard ? `${data?.transactionCount ?? 0} transaksi • rata-rata ${formatRupiah(data?.averageTicketMinor ?? 0)}` : `Laba estimasi ${formatRupiah(data?.profitMinor ?? 0)} • ${data?.transactionCount ?? 0} transaksi`
          : "Hanya data dan tindakan yang sesuai dengan peran Anda yang ditampilkan."}</Text>
        <View style={s.heroActions}>
          {areasFor(workspace.role).includes("pos") && <Pressable onPress={() => onNavigate("pos")} style={s.heroButton}>
            <Text style={s.heroButtonText}>＋ Transaksi</Text>
          </Pressable>}
          {areasFor(workspace.role).includes("reports") && <Pressable
            onPress={() => onNavigate("reports")}
            style={s.heroButtonAlt}
          >
            <Text style={s.heroButtonAltText}>Lihat laporan</Text>
          </Pressable>}
          {isCashierDashboard && <Pressable onPress={()=>onNavigate("receipts")} style={s.heroButtonAlt}><Text style={s.heroButtonAltText}>Riwayat</Text></Pressable>}
        </View>
      </View>
      {canSeeSalesAnalytics && analyticsError && <Card><Text style={s.cardTitle}>Data gagal dimuat</Text><Text style={s.cardSub}>{analyticsError}</Text><Button variant="outline" title="Coba lagi" onPress={()=>void load()}/></Card>}
      {canSeeBusinessDashboard && !analyticsError && <View style={s.metrics}>
        <Metric
          label="Sudah diterima"
          value={formatRupiah((data?.paymentMix ?? []).filter((item)=>item.method!=="receivable").reduce((sum,item)=>sum+item.amountMinor,0))}
          tone="green"
        />
        <Metric
          label="Piutang"
          value={formatRupiah(data?.receivableMinor ?? 0)}
          tone="blue"
        />
        <Metric
          label="Utang"
          value={formatRupiah(data?.payableMinor ?? 0)}
          tone="amber"
        />
        <Metric
          label="Stok menipis"
          value={String(data?.lowStockCount ?? 0)}
          tone={(data?.lowStockCount ?? 0) > 0 ? "red" : "green"}
        />
      </View>}
      {isCashierDashboard && !analyticsError && <View style={s.metrics}>
        <Metric
          label="Sudah diterima"
          value={formatRupiah((data?.paymentMix ?? []).filter((item)=>item.method!=="receivable").reduce((sum,item)=>sum+item.amountMinor,0))}
          tone="green"
        />
        <Metric label="Piutang aktif" value={formatRupiah(data?.receivableMinor??0)} tone="blue"/>
        <Metric label="Transaksi" value={String(data?.transactionCount??0)} tone="blue"/>
        <Metric label="Rata-rata" value={formatRupiah(data?.averageTicketMinor??0)} tone="green"/>
      </View>}
      {canSeeSalesAnalytics && !analyticsError && <Card>
        <View style={s.cardHead}>
          <View style={s.cardHeadCopy}>
            <Text style={s.cardTitle}>Tren penjualan</Text>
            <Text style={s.cardSub}>{isCashierDashboard?`Seluruh transaksi ${workspace.branchName}`:"Data aktual • dibanding periode sebelumnya"}</Text>
          </View>
          {!isCashierDashboard && <Badge
            text={comparison === null ? "Periode pertama" : `${comparison >= 0 ? "▲" : "▼"} ${Math.abs(comparison).toFixed(1)}%`}
            tone={comparison === null ? "neutral" : comparison >= 0 ? "green" : "red"}
          />}
        </View>
        <View style={s.periodRow}>
          <Segmented value={period} onChange={setPeriod} items={[{ value: "7", label: "7 hari" }, { value: "30", label: "30 hari" }, { value: "90", label: "90 hari" }]} />
        </View>
        <SalesTrendChart data={data?.dailySales ?? []} emptyLabel="Belum ada transaksi pada periode ini." />
        <View style={s.chartSummary}>
          <View style={[s.chartStat,{backgroundColor:theme.colors.cream}]}><Text style={s.chartStatLabel}>Rata-rata transaksi</Text><Text style={s.chartStatValue}>{formatRupiah(data?.averageTicketMinor ?? 0)}</Text></View>
          <View style={[s.chartStat,{backgroundColor:theme.colors.cream}]}><Text style={s.chartStatLabel}>{isCashierDashboard?"Jumlah transaksi":"Periode sebelumnya"}</Text><Text style={s.chartStatValue}>{isCashierDashboard?String(data?.transactionCount??0):formatRupiah(data?.previousGrossSalesMinor ?? 0)}</Text></View>
        </View>
      </Card>}
      {canSeeBusinessDashboard && !analyticsError && <Card>
        <View style={s.cardHead}>
          <View>
            <Text style={s.cardTitle}>Produk teratas</Text>
            <Text style={s.cardSub}>Berdasarkan pendapatan</Text>
          </View>
        </View>
        {(data?.topProducts ?? []).length === 0 ? (
          <Text style={s.empty}>
            Data akan muncul setelah transaksi pertama.
          </Text>
        ) : (
          (data?.topProducts ?? []).map((item, index) => (
            <View key={item.name} style={s.rank}>
              <View style={s.rankNo}>
                <Text style={s.rankNoText}>{index + 1}</Text>
              </View>
              <View style={s.flex}>
                <Text style={s.rankTitle}>{item.name}</Text>
                <ProgressBar
                  value={
                    (item.revenueMinor /
                      (data?.topProducts[0]?.revenueMinor || 1)) *
                    100
                  }
                />
              </View>
              <Text style={s.rankValue}>{formatRupiah(item.revenueMinor)}</Text>
            </View>
          ))
        )}
      </Card>}
      {canSeeBusinessDashboard && <Card style={s.nia}>
        <View style={s.niaHead}>
          <View style={s.niaMark}>
            <Text style={s.niaMarkText}>N</Text>
          </View>
          <View style={s.flex}>
            <Text style={s.niaTitle}>NIA Business Copilot</Text>
            <Text style={s.niaSub}>Tanya, pahami, lalu ambil keputusan</Text>
          </View>
          <Badge text={aiBusy?"MEMPROSES":"SIAP"} tone={aiBusy?"amber":"green"}/>
        </View>
        <View style={[s.askBox,{backgroundColor:theme.colors.surface,borderColor:theme.colors.line}]}>
          <Text style={s.askTitle}>Tanya NIA</Text>
          <Text style={s.askDetail}>Tanyakan panduan atau kondisi usaha dengan bahasa sehari-hari.</Text>
          <Field value={question} onChangeText={setQuestion} placeholder="Contoh: bagaimana aturan retur usaha saya?"/>
          <Button compact disabled={aiBusy||question.trim().length<4} title={aiBusy?"Menganalisis...":"Tanyakan"} onPress={()=>void ai("ask")}/>
          <View style={s.suggestionRow}>
            {["Bagaimana cara retur?","Stok apa yang perlu dipesan?"].map(item=><Pressable key={item} onPress={()=>setQuestion(item)} style={[s.suggestionChip,{borderColor:theme.colors.line}]}><Text style={s.suggestionText}>{item}</Text></Pressable>)}
          </View>
        </View>
        <Text style={s.shortcutTitle}>Pilih kebutuhan</Text>
        <View style={s.shortcutGrid}>
          {([
            ["overview","↗","Ringkasan usaha","Kinerja dan langkah utama"],
            ["forecast","▤","Prediksi stok","Saran pemesanan barang"],
            ["anomaly","!","Periksa risiko","Transaksi dan stok tidak biasa"],
            ["customers","◎","Pelanggan","Segmen dan pelanggan kembali"],
          ] as [InsightKind,string,string,string][]).map(([kind,mark,title,detail])=><Pressable key={kind} disabled={aiBusy} onPress={()=>void ai(kind)} style={[s.shortcut,{backgroundColor:theme.colors.surface,borderColor:theme.colors.line}]}><View style={s.shortcutMark}><Text style={s.shortcutMarkText}>{mark}</Text></View><Text style={s.shortcutName}>{title}</Text><Text style={s.shortcutDetail}>{detail}</Text></Pressable>)}
        </View>
        <View style={s.secondaryRow}>
          <Button compact variant="ghost" title="Keuangan" disabled={aiBusy} onPress={()=>void ai("finance")}/>
          <Button compact variant="ghost" title="Penjualan" disabled={aiBusy} onPress={()=>void ai("sales")}/>
        </View>
      </Card>}
      {canSeeBusinessDashboard&&niaError&&<Card style={s.niaError}><Text style={s.niaErrorTitle}>{niaError.title}</Text><Text style={s.niaErrorDetail}>{niaError.detail}</Text><Button compact variant="outline" title="Coba lagi" disabled={aiBusy} onPress={()=>void ai(lastAiKind)}/></Card>}
      {canSeeBusinessDashboard&&insight&&<Card style={s.niaResult}>
        <View style={s.resultHead}><Text style={s.resultEyebrow}>HASIL NIA</Text><Badge text={insight.dataQuality?.label?.toUpperCase()??"DATA TERVERIFIKASI"} tone="blue"/></View>
        <Text style={s.insightTitle}>{insight.title}</Text><Text style={s.niaSummary}>{insight.summary}</Text>
        {insight.explanation&&insight.dataQuality?.level!=="limited"&&<View style={[s.explanationBox,{backgroundColor:theme.colors.blueSoft}]}><Text style={s.explanationLabel}>PENJELASAN</Text><Text style={s.explanationText}>{insight.explanation}</Text></View>}
        <Text style={s.providerMeta}>{insight.dataWindow??"Data saat ini"} • angka dihitung dari data usaha</Text>
        {(insight.recommendations??[]).map(item=><Text key={item} style={s.recommendation}>• {item}</Text>)}
        {(insight.evidence??[]).length>0&&<View style={[s.evidenceBox,{backgroundColor:theme.colors.cream,borderColor:theme.colors.line}]}><Text style={s.evidenceTitle}>{insight.source?.startsWith("grounded_")&&insight.evidenceIds?.some(id=>id.startsWith("K"))?"SUMBER JAWABAN":"BUKTI TERVERIFIKASI"}</Text>{(insight.evidence??[]).map(item=><Text key={item} style={s.evidenceText}>• {item}</Text>)}</View>}
        {insight.id&&<View style={s.feedbackRow}><Text style={s.window}>Apakah analisis ini membantu?</Text><Button compact variant="ghost" title={feedback==="helpful"?"✓ Membantu":"Membantu"} onPress={()=>void submitFeedback("helpful")}/><Button compact variant="ghost" title={feedback==="incorrect"?"✓ Keliru":"Keliru"} onPress={()=>void submitFeedback("incorrect")}/></View>}
      </Card>}
      <Pressable
        disabled={sync.checking}
        onPress={() => void sync.synchronize().then(load).catch(()=>undefined)}
        style={[s.sync,{backgroundColor:sync.lastError?theme.colors.redSoft:theme.colors.greenSoft}, sync.lastError && s.syncError]}
      >
        <View>
          <Text style={s.syncTitle}>
            {sync.checking
              ? "Memeriksa server..."
              : sync.lastError
              ? "Koneksi server perlu perhatian"
              : sync.pendingCount
                ? `${sync.pendingCount} konflik perlu ditinjau`
                : sync.ready ? "Server dapat diakses" : "Belum diperiksa"}
          </Text>
          <Text style={s.syncSub}>
            {sync.checking?"Memvalidasi tenant, perangkat, mutasi, dan konflik...":sync.lastError ??
              `${sync.lastCheckedAt?`Diperiksa ${new Date(sync.lastCheckedAt).toLocaleString("id-ID")}`:"Belum pernah diperiksa"} • ${sync.lastSyncedAt?`aktivitas data terakhir ${new Date(sync.lastSyncedAt).toLocaleString("id-ID")}`:"belum ada mutasi server"}`}
          </Text>
        </View>
        <Text style={s.syncArrow}>{sync.checking?"…":"↻"}</Text>
      </Pressable>
      {!workspace.qrisEnabled && (
        <Card>
          <Badge text="QRIS terkunci" tone="amber" />
          <Text style={s.noticeTitle}>Pembayaran tunai tetap aktif</Text>
          <Text style={s.noticeBody}>
            QRIS baru dapat digunakan setelah merchant terverifikasi dan
            aktivasi Midtrans resmi selesai.
          </Text>
        </Card>
      )}
    </Screen>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "blue" | "amber" | "red" | "green";
}) {
  const palette={
    blue:{background:colors.blueSoft,foreground:colors.blue},
    amber:{background:colors.orangeSoft,foreground:colors.orange},
    red:{background:colors.redSoft,foreground:colors.red},
    green:{background:colors.greenSoft,foreground:colors.green},
  }[tone];
  return (
    <Card style={s.metric}>
      <View style={[s.metricLabelPill,{backgroundColor:palette.background}]}>
        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={[s.metricLabel,{color:palette.foreground}]}>{label}</Text>
      </View>
      <Text numberOfLines={1} adjustsFontSizeToFit style={s.metricValue}>
        {value}
      </Text>
    </Card>
  );
}
const s = StyleSheet.create({
  hero: {
    backgroundColor: colors.blue,
    borderRadius: 20,
    padding: 18,
    overflow: "hidden",
  },
  heroGlow: {
    position: "absolute",
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: colors.blue2,
    right: -60,
    top: -80,
  },
  heroLabel: {
    color: "#D8E6FF",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1.3,
  },
  heroValue: {
    color: colors.white,
    fontSize: 28,
    fontWeight: "900",
    letterSpacing: -1,
    marginTop: 6,
  },
  heroDetail: { color: "#D8E6FF", fontSize: 12, marginTop: 5 },
  heroActions: { flexDirection: "row", gap: 8, marginTop: 14 },
  heroButton: {
    backgroundColor: colors.white,
    borderRadius: 13,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  heroButtonText: { color: colors.blue, fontWeight: "900" },
  heroButtonAlt: {
    backgroundColor: "rgba(255,255,255,.1)",
    borderRadius: 13,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  heroButtonAltText: { color: colors.white, fontWeight: "800" },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  metric: { width: "48%", flexGrow: 1, flexBasis: "46%", minWidth: 140, padding: 14 },
  metricLabelPill:{alignSelf:"flex-start",maxWidth:"100%",minHeight:28,borderRadius:999,paddingHorizontal:10,paddingVertical:6,justifyContent:"center"},
  metricLabel:{fontSize:10,fontWeight:"900",letterSpacing:.25,textTransform:"uppercase"},
  metricValue: {
    fontSize: 17,
    fontWeight: "900",
    color: colors.ink,
    marginTop: 13,
  },
  cardHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
  },
  cardHeadCopy: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 16, fontWeight: "900", color: colors.ink },
  cardSub: { fontSize: 11, color: colors.muted, marginTop: 3 },
  periodRow: { marginTop: 10 },
  chartSummary: { flexDirection: "row", gap: 8, marginTop: 4 },
  chartStat: { flex: 1, backgroundColor: "#F7F8FA", borderRadius: 12, padding: 10 },
  chartStatLabel: { color: colors.muted, fontSize: 9 },
  chartStatValue: { color: colors.ink, fontSize: 11, fontWeight: "900", marginTop: 4 },
  empty: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  rank: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 15 },
  rankNo: {
    width: 28,
    height: 28,
    borderRadius: 10,
    backgroundColor: colors.orangeSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  rankNoText: { color: colors.blue, fontWeight: "900" },
  flex: { flex: 1 },
  rankTitle: {
    fontSize: 12,
    fontWeight: "800",
    color: colors.ink,
    marginBottom: 6,
  },
  rankValue: { fontSize: 11, fontWeight: "900", color: colors.navy },
  nia: { backgroundColor: "#F2F7FC", borderColor: "#D9E8F4" },
  niaHead: { flexDirection: "row", alignItems: "center", gap: 11 },
  niaMark: {
    width: 42,
    height: 42,
    borderRadius: 15,
    backgroundColor: colors.navy,
    alignItems: "center",
    justifyContent: "center",
  },
  niaMarkText: { color: colors.blue, fontSize: 20, fontWeight: "900" },
  niaTitle: { fontSize: 15, fontWeight: "900", color: colors.navy },
  niaSub: { fontSize: 10, color: colors.muted, marginTop: 2 },
  insightTitle:{fontSize:17,fontWeight:"900",color:colors.ink,marginTop:12},
  niaSummary: {
    fontSize: 13,
    color: colors.ink,
    lineHeight: 20,
    marginTop: 14,
  },
  providerMeta:{flex:1,minWidth:140,fontSize:10,lineHeight:15,color:colors.muted},
  window: { fontSize: 10, color: colors.muted },
  recommendation: { fontSize: 11, color: colors.ink, lineHeight: 17, marginTop: 5 },
  evidenceBox:{borderWidth:1,borderRadius:12,padding:10,marginTop:10},
  evidenceTitle:{fontSize:9,fontWeight:"900",letterSpacing:.8,color:colors.blue},
  evidenceText:{fontSize:10,lineHeight:16,color:colors.muted,marginTop:3},
  feedbackRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 5, marginTop: 10 },
  askBox:{borderWidth:1,borderRadius:16,marginTop:16,padding:12,gap:9},
  askTitle:{fontSize:13,fontWeight:"900",color:colors.ink},
  askDetail:{fontSize:10,lineHeight:15,color:colors.muted},
  suggestionRow:{flexDirection:"row",flexWrap:"wrap",gap:6},
  suggestionChip:{maxWidth:"100%",borderWidth:1,borderRadius:999,paddingHorizontal:10,paddingVertical:7},
  suggestionText:{color:colors.blue,fontSize:9,fontWeight:"800",flexShrink:1},
  shortcutTitle:{fontSize:12,fontWeight:"900",color:colors.ink,marginTop:16,marginBottom:8},
  shortcutGrid:{flexDirection:"row",flexWrap:"wrap",gap:8},
  shortcut:{width:"48%",flexGrow:1,minWidth:130,borderWidth:1,borderRadius:14,padding:11},
  shortcutMark:{width:30,height:30,borderRadius:10,backgroundColor:"#E7F0FF",alignItems:"center",justifyContent:"center",marginBottom:8},
  shortcutMarkText:{fontSize:15,fontWeight:"900",color:colors.blue},
  shortcutName:{fontSize:11,fontWeight:"900",color:colors.ink},
  shortcutDetail:{fontSize:9,lineHeight:13,color:colors.muted,marginTop:3},
  secondaryRow:{flexDirection:"row",justifyContent:"center",gap:12,marginTop:6},
  niaError:{borderColor:"#F2B8BE",backgroundColor:colors.redSoft},
  niaErrorTitle:{fontSize:14,fontWeight:"900",color:colors.red},
  niaErrorDetail:{fontSize:11,lineHeight:17,color:colors.ink,marginVertical:7},
  niaResult:{borderColor:"#CFE1F6"},
  resultHead:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",gap:8},
  resultEyebrow:{fontSize:9,fontWeight:"900",letterSpacing:1,color:colors.blue},
  explanationBox:{borderRadius:12,padding:11,marginTop:10},
  explanationLabel:{fontSize:9,fontWeight:"900",letterSpacing:.8,color:colors.blue},
  explanationText:{fontSize:10,lineHeight:16,color:colors.ink,marginTop:4},
  sync: {
    backgroundColor: colors.greenSoft,
    borderRadius: radius.lg,
    padding: 15,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  syncError: { backgroundColor: colors.redSoft },
  syncTitle: { fontSize: 13, fontWeight: "900", color: colors.ink },
  syncSub: { fontSize: 10, color: colors.muted, marginTop: 3 },
  syncArrow: { fontSize: 24, color: colors.green, fontWeight: "900" },
  noticeTitle: {
    fontSize: 15,
    fontWeight: "900",
    color: colors.ink,
    marginTop: 12,
  },
  noticeBody: {
    fontSize: 12,
    color: colors.muted,
    lineHeight: 18,
    marginTop: 5,
  },
});
