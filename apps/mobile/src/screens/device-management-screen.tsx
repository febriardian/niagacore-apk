import React from "react";

import { supabase } from "@/lib/supabase";
import type { ActiveWorkspace } from "@/providers/auth-provider";
import { Badge, Button, Card, EmptyState, Header, Row, Screen } from "@/ui/components";
import { LocalizedText as Text, localizedAlert } from "@/ui/localized-text";
import { colors } from "@/ui/theme";
import { StyleSheet } from "react-native";

type RegisteredDevice = { id:string;label:string;status:string;last_seen_at:string|null;platform:string|null;model:string|null;os_version:string|null;app_version:string|null;branches:{name:string}|{name:string}[]|null };

export function DeviceManagementScreen({workspace,onBack}:{workspace:ActiveWorkspace;onBack:()=>void}) {
  const [devices,setDevices]=React.useState<RegisteredDevice[]>([]),[loading,setLoading]=React.useState(true);
  const load=React.useCallback(async()=>{if(!supabase)return;setLoading(true);const {data,error}=await supabase.from("devices").select("id,label,status,last_seen_at,platform,model,os_version,app_version,branches(name)").eq("tenant_id",workspace.tenantId).order("last_seen_at",{ascending:false});setLoading(false);if(error)return localizedAlert("Perangkat login",error.message);setDevices((data??[]) as RegisteredDevice[])},[workspace.tenantId]);
  React.useEffect(()=>{const timer=setTimeout(()=>void load(),0);return()=>clearTimeout(timer)},[load]);
  const revoke=(item:RegisteredDevice)=>localizedAlert("Cabut perangkat",`Akses ${item.label} akan ditolak saat perangkat tersambung kembali.`,[{text:"Batal",style:"cancel"},{text:"Cabut",style:"destructive",onPress:()=>void supabase?.rpc("revoke_registered_device",{target_device_id:item.id}).then(({error})=>error?localizedAlert("Perangkat",error.message):load())}]);
  return <Screen><Header title="Perangkat login" subtitle="Tercatat otomatis setiap kali akun berhasil masuk" right={<Button compact variant="ghost" title="Kembali" onPress={onBack}/>}/>
    {loading?<Text style={s.note}>Memuat perangkat...</Text>:devices.length===0?<EmptyState title="Belum ada perangkat" detail="Perangkat akan muncul otomatis setelah login berhasil."/>:devices.map(item=>{const relation=Array.isArray(item.branches)?item.branches[0]:item.branches;const current=item.id===workspace.deviceId;return <Card key={item.id}><Row title={item.label} detail={`${relation?.name??"Cabang"} • ${item.platform??"android"} ${item.os_version??""} • aplikasi ${item.app_version??"-"}`} right={<Badge text={current?"Perangkat ini":item.status} tone={item.status==="active"?"green":"red"}/>} /><Text style={s.last}>Terakhir online: {item.last_seen_at?new Date(item.last_seen_at).toLocaleString("id-ID"):"Belum tercatat"}</Text>{!current&&item.status!=="revoked"&&["owner","business_manager"].includes(workspace.role)?<Button compact variant="danger" title="Cabut akses perangkat" onPress={()=>revoke(item)}/>:null}</Card>})}
  </Screen>;
}
const s=StyleSheet.create({note:{fontSize:12,lineHeight:19,color:colors.muted},last:{fontSize:10,color:colors.muted,marginVertical:8}});
