import React from "react";
import { StyleSheet, View } from "react-native";

import { supabase } from "@/lib/supabase";
import type { ActiveWorkspace } from "@/providers/auth-provider";
import { Badge, Button, Card, EmptyState, Header, Row, Screen } from "@/ui/components";
import { LocalizedText as Text } from "@/ui/localized-text";
import { colors } from "@/ui/theme";

type EdgeHealth={checkedAt?:string;latencyMs?:number;checks?:Record<string,string>};
type Snapshot={sync?:{openFailures?:number;openConflicts?:number;lastAcceptedAt?:string|null};qris?:{pending?:number;recoverable?:number;lastRecoveryAt?:string|null;lastRecoveryOutcome?:string|null};nia?:{latestEvaluation?:{status?:string;passedCases?:number;totalCases?:number}|null}};
const time=(value?:string|null)=>value?new Date(value).toLocaleString("id-ID"):"Belum ada";

export function OperationalHealthScreen({workspace,onBack}:{workspace:ActiveWorkspace;onBack:()=>void}){
  const[edge,setEdge]=React.useState<EdgeHealth|null>(null),[snapshot,setSnapshot]=React.useState<Snapshot|null>(null);
  const[loading,setLoading]=React.useState(true),[error,setError]=React.useState<string|null>(null);
  const load=React.useCallback(async()=>{
    if(!supabase)return;
    setLoading(true);setError(null);
    const[edgeResult,snapshotResult]=await Promise.all([
      supabase.functions.invoke("health",{body:{source:"mobile_system_status"}}),
      supabase.rpc("get_operational_health",{target_tenant_id:workspace.tenantId,target_business_id:workspace.businessId,target_branch_id:workspace.branchId}),
    ]);
    setLoading(false);
    if(edgeResult.data)setEdge(edgeResult.data as EdgeHealth);
    if(snapshotResult.data)setSnapshot(snapshotResult.data as Snapshot);
    setError(edgeResult.error?.message??snapshotResult.error?.message??null);
  },[workspace.branchId,workspace.businessId,workspace.tenantId]);
  React.useEffect(()=>{const timer=setTimeout(()=>void load(),0);return()=>clearTimeout(timer)},[load]);

  const checks=edge?.checks??{},serverOk=checks.api==="operational"&&checks.database==="operational",midtransOk=checks.midtransAuthentication==="authenticated";
  const pending=snapshot?.qris?.pending??0,recoverable=snapshot?.qris?.recoverable??0,qrisOk=midtransOk&&pending===recoverable;
  const openSync=(snapshot?.sync?.openFailures??0)+(snapshot?.sync?.openConflicts??0),evaluation=snapshot?.nia?.latestEvaluation,niaOk=evaluation?.status==="passed";

  return <Screen>
    <Header title="Status sistem" subtitle={workspace.businessName} right={<Button compact variant="ghost" title="Kembali" onPress={onBack}/>}/>
    <Card><View style={s.head}><Text style={s.title}>Ringkasan</Text><Badge text={serverOk?"Online":loading?"Memeriksa":"Bermasalah"} tone={serverOk?"green":loading?"blue":"red"}/></View><Button variant="outline" disabled={loading} title={loading?"Memeriksa...":"Periksa ulang"} onPress={()=>void load()}/>{error?<Text style={s.error}>{error}</Text>:null}</Card>
    {!snapshot&&!loading?<EmptyState title="Status belum tersedia" detail="Periksa koneksi lalu coba kembali."/>:<>
      <Card><Text style={s.section}>LAYANAN</Text>
        <Row title="Server" detail="API dan database" right={<Badge text={serverOk?"Online":"Periksa"} tone={serverOk?"green":"red"}/>}/>
        <Row title="Midtrans" detail="Kredensial production" right={<Badge text={midtransOk?"Terhubung":"Periksa"} tone={midtransOk?"green":"red"}/>}/>
        <Row title="QRIS" detail={pending?`${pending} tertunda • ${recoverable} dapat dipulihkan`:"Tidak ada pembayaran tertunda"} right={<Badge text={qrisOk?"Normal":"Periksa"} tone={qrisOk?"green":"amber"}/>}/>
        <Row title="NIA" detail={evaluation?`${evaluation.passedCases??0}/${evaluation.totalCases??0} pengujian lulus`:"Belum diuji"} right={<Badge text={niaOk?"Normal":"Periksa"} tone={niaOk?"green":"amber"}/>}/>
      </Card>
      <Card><Text style={s.section}>AKTIVITAS SERVER</Text>
        <Row title="Sinkronisasi" detail={openSync?`${openSync} masalah perlu ditinjau`:"Tidak ada masalah"} right={<Badge text={openSync?"Periksa":"Normal"} tone={openSync?"amber":"green"}/>}/>
        <Row title="Data terakhir" detail={time(snapshot?.sync?.lastAcceptedAt)}/>
        <Row title="Pemulihan QRIS" detail={snapshot?.qris?.lastRecoveryAt?`${snapshot.qris.lastRecoveryOutcome??"selesai"} • ${time(snapshot.qris.lastRecoveryAt)}`:"Belum pernah"}/>
      </Card>
      <Text style={s.checked}>Diperiksa {time(edge?.checkedAt)} • {edge?.latencyMs??0} ms</Text>
    </>}
  </Screen>;
}
const s=StyleSheet.create({head:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",marginBottom:12},title:{fontSize:16,fontWeight:"900",color:colors.ink},section:{fontSize:10,fontWeight:"900",letterSpacing:1,color:colors.muted,marginBottom:6},checked:{fontSize:10,color:colors.muted,textAlign:"center",marginBottom:12},error:{fontSize:11,lineHeight:17,color:colors.red,marginTop:8}});
