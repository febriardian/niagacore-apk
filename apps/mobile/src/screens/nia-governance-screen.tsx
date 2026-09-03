import React from "react";
import { StyleSheet, View } from "react-native";

import { supabase } from "@/lib/supabase";
import type { ActiveWorkspace } from "@/providers/auth-provider";
import { useAppTheme } from "@/providers/theme-provider";
import { Badge, Button, Card, EmptyState, Header, Row, Screen, Segmented } from "@/ui/components";
import { LocalizedText as Text } from "@/ui/localized-text";
import { colors } from "@/ui/theme";

type Tab="summary"|"assets"|"activity";
type Model={key:string;name:string;category:string;registryStatus:string;version?:string;provider?:string;versionStatus?:string;releasedAt?:string};
type Dataset={datasetKey:string;version:string;schemaVersion:string;rowCount:number;windowDays:number;contentHash:string;createdAt:string};
type Drift={metricName:string;metricValue:number;threshold:number;status:string;measuredAt:string};
type Evaluation={suite:string;provider:string;model:string;status:string;passedCases:number;totalCases:number;groundingScore:number;regressionScore:number;startedAt:string;completedAt?:string;metadata?:{providerErrors?:number;providerErrorCodes?:string[]}};
type Job={id:string;jobName:string;status:string;triggerSource:string;traceId:string;durationMs?:number;processedCount:number;succeededCount:number;failedCount:number;errorCode?:string;startedAt:string;completedAt?:string};
type Governance={generatedAt?:string;models:Model[];datasets:Dataset[];drift:Drift[];evaluations:Evaluation[];jobs:Job[];calibration?:{version:number;category:string;sampleSize:number;calibratedAt:string}|null};

const when=(value?:string)=>value?new Date(value).toLocaleString("id-ID",{dateStyle:"medium",timeStyle:"short"}):"Belum ada";
const percent=(value?:number)=>Number.isFinite(value)?`${Math.round(Number(value)*100)}%`:"—";
const good=(status?:string)=>["active","stable","passed","succeeded"].includes((status??"").toLowerCase());
const warning=(status?:string)=>["candidate","warning","partial","running"].includes((status??"").toLowerCase());
const tone=(status?:string)=>good(status)?"green" as const:warning(status)?"amber" as const:"red" as const;
const statusLabel=(status?:string)=>({active:"Aktif",stable:"Stabil",passed:"Lulus",succeeded:"Berhasil",candidate:"Kandidat",warning:"Peringatan",partial:"Sebagian",running:"Berjalan",failed:"Gagal"}[status??""]??status??"Belum ada");
const modelName=(item:Model)=>({operational_anomaly:"Deteksi transaksi tidak biasa",customer_rfm:"Segmentasi pelanggan",nia_explainer:"Penjelas kinerja usaha",stock_forecast:"Prediksi kebutuhan stok",statistical_demand_forecast:"Prediksi kebutuhan stok",hybrid_knowledge_retrieval:"Pencarian pengetahuan usaha"}[item.key]??item.name);
const evaluationName=(suite:string)=>suite==="nia_core_v1"?"Evaluasi inti NIA":suite.replaceAll("_"," ");
const providerName=(provider:string)=>provider==="cloudflare"?"Cloudflare AI":provider==="gemini"?"Gemini":provider;
const jobName=(name:string)=>name==="nia.evaluator"?"Evaluasi otomatis":name.replaceAll("."," ");
const evaluationStatus=(item:Evaluation)=>item.model==="not_available"?{label:"Tidak tersedia",tone:"red" as const}:item.status==="passed"?{label:"Lulus",tone:"green" as const}:item.status==="partial"?{label:"Perlu ditingkatkan",tone:"amber" as const}:{label:"Perlu diperbaiki",tone:"amber" as const};
const datasetName=(key:string)=>key==="nia_business_dataset"?"Data analisis usaha":key.replaceAll("_"," ");
const providerIssue=(item:Evaluation)=>{
  const codes=item.metadata?.providerErrorCodes??[];
  if(codes.some(code=>code.endsWith("_not_configured")))return "konfigurasi provider belum tersedia";
  if(codes.some(code=>code.endsWith("_request_failed")))return "provider tidak merespons dengan benar";
  return "provider tidak dapat menjalankan evaluasi";
};

export function NiaGovernanceScreen({workspace,onBack}:{workspace:ActiveWorkspace;onBack:()=>void}){
  const theme=useAppTheme();
  const [tab,setTab]=React.useState<Tab>("summary"),[data,setData]=React.useState<Governance|null>(null),[loading,setLoading]=React.useState(true),[error,setError]=React.useState<string|null>(null);
  const load=React.useCallback(async()=>{if(!supabase)return;setLoading(true);setError(null);const{data:result,error:rpcError}=await supabase.rpc("get_nia_governance_dashboard",{target_tenant_id:workspace.tenantId,target_business_id:workspace.businessId,target_branch_id:workspace.branchId});setLoading(false);if(rpcError)setError("Data NIA belum dapat dimuat.");else setData(result as Governance)},[workspace.branchId,workspace.businessId,workspace.tenantId]);
  React.useEffect(()=>{const timer=setTimeout(()=>void load(),0);return()=>clearTimeout(timer)},[load]);
  const models=data?.models??[],datasets=data?.datasets??[],drift=data?.drift??[],evaluations=data?.evaluations??[],jobs=data?.jobs??[];
  const latestDatasets=datasets.filter((item,index,items)=>items.findIndex(candidate=>candidate.datasetKey===item.datasetKey)===index);
  const latestEvaluations=evaluations.filter((item,index,items)=>items.findIndex(candidate=>candidate.provider===item.provider)===index);
  const latestJobs=jobs.filter((item,index,items)=>items.findIndex(candidate=>candidate.jobName===item.jobName)===index);
  const activeModels=models.filter(item=>good(item.versionStatus??item.registryStatus)).length;
  const driftWarnings=drift.filter(item=>!good(item.status)).length;
  const failedJobs=latestJobs.filter(item=>item.status==="failed"||item.failedCount>0).length;
  const latestEvaluation=evaluations[0];
  const evaluationIssues=latestEvaluations.filter(item=>!good(item.status)||item.model==="not_available").length;
  const needsAttention=driftWarnings+failedJobs+evaluationIssues;
  return <Screen>
    <Header title="Kinerja NIA" subtitle="Kualitas analisis dan proses otomatis" right={<Button compact variant="ghost" title="Kembali" onPress={onBack}/>}/>
    <Card>
      <View style={s.head}><View style={s.flex}><Text style={s.cardTitle}>Kondisi saat ini</Text><Text style={s.note}>Ringkasan kualitas NIA untuk usaha ini.</Text></View><Badge text={loading?"Memuat":needsAttention?"Perlu diperiksa":"Normal"} tone={loading?"blue":needsAttention?"amber":"green"}/></View>
      <Button compact variant="outline" disabled={loading} title={loading?"Memuat...":"Perbarui"} onPress={()=>void load()}/>
      {error?<Text style={s.error}>{error}</Text>:null}
    </Card>
    <Segmented value={tab} onChange={setTab} items={[{value:"summary",label:"Ringkasan"},{value:"assets",label:"Model & data"},{value:"activity",label:"Aktivitas"}]}/>
    {!data&&!loading?<EmptyState title="Data NIA belum tersedia" detail="Jalankan analisis NIA, lalu perbarui halaman ini."/>:null}
    {tab==="summary"&&data?<>
      <Card><Text style={s.sectionTitle}>RINGKASAN</Text><View style={s.metrics}>
        <Metric label="Model aktif" value={`${activeModels}/${models.length}`} background={theme.colors.blueSoft}/>
        <Metric label="Sumber data aktif" value={String(latestDatasets.length)} background={theme.colors.blueSoft}/>
        <Metric label="Peringatan" value={String(driftWarnings)} background={driftWarnings?theme.colors.amberSoft:theme.colors.greenSoft}/>
        <Metric label="Job gagal" value={String(failedJobs)} background={failedJobs?theme.colors.redSoft:theme.colors.greenSoft}/>
      </View></Card>
      {latestEvaluation?<Card><View style={s.head}><View style={s.flex}><Text style={s.cardTitle}>Evaluasi terakhir</Text><Text style={s.note}>{when(latestEvaluation.completedAt??latestEvaluation.startedAt)}</Text></View><Badge text={evaluationStatus(latestEvaluation).label} tone={evaluationStatus(latestEvaluation).tone}/></View><View style={s.scoreRow}><Metric label="Kasus lulus" value={`${latestEvaluation.passedCases}/${latestEvaluation.totalCases}`} background={theme.colors.blueSoft}/><Metric label="Akurasi sumber" value={percent(latestEvaluation.groundingScore)} background={theme.colors.blueSoft}/></View></Card>:<EmptyState title="Belum ada evaluasi" detail="Evaluasi otomatis akan muncul setelah jadwal NIA berjalan."/>}
    </>:null}
    {tab==="assets"&&data?<>
      <Text style={s.sectionTitle}>MODEL AKTIF</Text>
      {models.length?models.map(item=><Card key={item.key}><View style={s.head}><View style={s.flex}><Text style={s.cardTitle}>{modelName(item)}</Text><Text style={s.note}>Versi {item.version??"—"} • {item.provider??"NiagaCore"}</Text></View><Badge text={statusLabel(item.versionStatus??item.registryStatus)} tone={tone(item.versionStatus??item.registryStatus)}/></View></Card>):<EmptyState title="Model belum tersedia" detail="Belum ada model yang terdaftar untuk usaha ini."/>}
      <Text style={s.sectionTitle}>DATA ANALISIS</Text>
      {latestDatasets.length?latestDatasets.map(item=>{const versions=datasets.filter(candidate=>candidate.datasetKey===item.datasetKey).length,ready=item.rowCount>=7&&item.windowDays>=30;return <Card key={item.datasetKey}><Row title={datasetName(item.datasetKey)} detail={`${item.rowCount} data • periode ${item.windowDays} hari • ${versions} versi tersimpan`} right={<Badge text={ready?"Siap":"Belum cukup"} tone={ready?"green":"amber"}/>} /><Text style={s.datasetNote}>{ready?`Diperbarui ${when(item.createdAt)} dan siap dipakai untuk membaca tren usaha.`:"NIA tetap dapat berjalan, tetapi hasil tren belum cukup kuat. Data akan bertambah otomatis dari transaksi."}</Text></Card>}):<EmptyState title="Data analisis belum tersedia" detail="Data dibuat otomatis setelah analisis NIA dijalankan."/>}
      {data.calibration?<Card><Row title="Deteksi anomali" detail={`${data.calibration.sampleSize} transaksi dianalisis • diperbarui ${when(data.calibration.calibratedAt)}`} right={<Badge text={data.calibration.sampleSize>=30?"Siap":"Sedang belajar"} tone={data.calibration.sampleSize>=30?"green":"amber"}/>} /><Text style={s.datasetNote}>{data.calibration.sampleSize>=30?"Batas peringatan telah disesuaikan dengan pola usaha.":"Batas awal sudah aktif dan akan semakin akurat setelah data transaksi bertambah."}</Text></Card>:null}
    </>:null}
    {tab==="activity"&&data?<>
      <Text style={s.sectionTitle}>EVALUASI</Text>
      {latestEvaluations.length?latestEvaluations.map((item,index)=><Card key={`${item.provider}:${item.startedAt}:${index}`}><View style={s.head}><View style={s.flex}><Text style={s.cardTitle}>{evaluationName(item.suite)}</Text><Text style={s.note}>{providerName(item.provider)} • {item.model==="not_available"?providerIssue(item):`${item.passedCases}/${item.totalCases} kasus lulus • akurasi sumber ${percent(item.groundingScore)}`}</Text><Text style={s.activityTime}>{when(item.completedAt??item.startedAt)}</Text></View><Badge text={evaluationStatus(item).label} tone={evaluationStatus(item).tone}/></View></Card>):<EmptyState title="Evaluasi belum tersedia" detail="Belum ada hasil evaluasi terjadwal."/>}
      <Text style={s.sectionTitle}>PROSES OTOMATIS</Text>
      {latestJobs.length?latestJobs.slice(0,5).map(item=><Card key={item.id}><View style={s.head}><View style={s.flex}><Text style={s.cardTitle}>{jobName(item.jobName)}</Text><Text style={s.note}>{item.processedCount?`${item.succeededCount} berhasil • ${item.failedCount} bermasalah`:"Tidak ada evaluasi yang jatuh tempo"}</Text><Text style={s.activityTime}>{when(item.completedAt??item.startedAt)}</Text></View><Badge text={statusLabel(item.status)} tone={tone(item.status)}/></View>{item.errorCode?<Text style={s.error}>Masalah proses: {item.errorCode}</Text>:null}</Card>):<EmptyState title="Belum ada aktivitas" detail="Proses NIA akan muncul ketika jadwal otomatis berjalan."/>}
    </>:null}
  </Screen>;
}

function Metric({label,value,background}:{label:string;value:string;background:string}){return <View style={[s.metric,{backgroundColor:background}]}><Text style={s.metricValue}>{value}</Text><Text style={s.metricLabel}>{label}</Text></View>}
const s=StyleSheet.create({head:{flexDirection:"row",gap:12,alignItems:"flex-start",marginBottom:12},flex:{flex:1},cardTitle:{fontSize:16,fontWeight:"900",color:colors.ink},note:{fontSize:12,lineHeight:18,color:colors.muted,marginTop:3},activityTime:{fontSize:10,lineHeight:15,color:colors.muted,marginTop:5},datasetNote:{fontSize:11,lineHeight:17,color:colors.muted,marginTop:8},sectionTitle:{fontSize:12,fontWeight:"900",letterSpacing:1.2,color:colors.muted,marginTop:4,marginBottom:2},metrics:{flexDirection:"row",flexWrap:"wrap",gap:10,marginTop:12},scoreRow:{flexDirection:"row",gap:10,marginTop:12},metric:{flexGrow:1,flexBasis:"44%",minHeight:86,borderRadius:18,padding:14,justifyContent:"center"},metricValue:{fontSize:22,fontWeight:"900",color:colors.navy},metricLabel:{fontSize:11,fontWeight:"700",color:colors.muted,marginTop:4},error:{fontSize:12,lineHeight:18,color:colors.red,marginTop:8}});
