import React from "react";
import { Alert, StyleSheet, Switch, View } from "react-native";

import { supabase } from "@/lib/supabase";
import type { ActiveWorkspace } from "@/providers/auth-provider";
import { useAppTheme } from "@/providers/theme-provider";
import { Badge, Button, Card, EmptyState, Field, Header, Screen } from "@/ui/components";
import { LocalizedText as Text, localizedAlert } from "@/ui/localized-text";
import { colors } from "@/ui/theme";

type KnowledgeDocument={id:string;title:string;content:string;branch_id:string|null;updated_at:string;metadata?:{chunkCount?:number;embeddingProvider?:string}};

function message(error:string){
  if(error.includes("knowledge_index_failed")||error.includes("knowledge_embedding_failed"))return "Dokumen belum berhasil diindeks. Periksa status Gemini/Cloudflare dan pastikan migration basis pengetahuan terbaru sudah diterapkan.";
  if(error.includes("knowledge_management_denied"))return "Hanya pemilik atau pengelola yang dapat mengubah basis pengetahuan.";
  return "Basis pengetahuan belum dapat diproses. Periksa koneksi lalu coba lagi.";
}

export function KnowledgeScreen({workspace,onBack}:{workspace:ActiveWorkspace;onBack:()=>void}){
  const theme=useAppTheme();
  const [documents,setDocuments]=React.useState<KnowledgeDocument[]>([]);
  const [title,setTitle]=React.useState("");
  const [content,setContent]=React.useState("");
  const [allBranches,setAllBranches]=React.useState(true);
  const [busy,setBusy]=React.useState(false);
  const load=React.useCallback(async()=>{
    if(!supabase)return;
    const {data,error}=await supabase.functions.invoke("nia-knowledge",{body:{action:"list",tenantId:workspace.tenantId,businessId:workspace.businessId,branchId:workspace.branchId}});
    if(!error)setDocuments((data?.documents??[]) as KnowledgeDocument[]);
  },[workspace]);
  React.useEffect(()=>{const timer=setTimeout(()=>void load(),0);return()=>clearTimeout(timer);},[load]);
  const save=async()=>{
    if(title.trim().length<3||content.trim().length<20)return localizedAlert("Basis pengetahuan","Isi judul dan penjelasan minimal 20 karakter.");
    if(!supabase)return localizedAlert("Basis pengetahuan","Backend belum dikonfigurasi.");
    setBusy(true);
    const {error}=await supabase.functions.invoke("nia-knowledge",{body:{action:"upsert",tenantId:workspace.tenantId,businessId:workspace.businessId,branchId:workspace.branchId,title,content,allBranches}});
    setBusy(false);
    if(error)return localizedAlert("Basis pengetahuan",message(error.message));
    setTitle("");setContent("");await load();
  };
  const remove=(document:KnowledgeDocument)=>Alert.alert("Hapus panduan?",`“${document.title}” tidak akan digunakan lagi oleh NIA.`,[{text:"Batal",style:"cancel"},{text:"Hapus",style:"destructive",onPress:async()=>{if(!supabase)return;const {error}=await supabase.functions.invoke("nia-knowledge",{body:{action:"delete",id:document.id,tenantId:workspace.tenantId,businessId:workspace.businessId,branchId:workspace.branchId}});if(error)localizedAlert("Basis pengetahuan",message(error.message));else await load();}}]);
  return <Screen>
    <Header title="Basis pengetahuan NIA" subtitle="Kelola panduan dan kebijakan usaha" right={<Button compact variant="ghost" title="Kembali" onPress={onBack}/>}/>
    <Card>
      <Text style={s.sectionTitle}>Tambah panduan atau kebijakan</Text>
      <Text style={s.sectionSub}>Contoh: aturan retur, SOP kasir, kebijakan diskon, atau penjelasan laporan.</Text>
      <View style={s.form}>
        <Field label="Judul" value={title} onChangeText={setTitle} placeholder="Contoh: Kebijakan retur"/>
        <Field label="Isi panduan" value={content} onChangeText={setContent} placeholder="Tuliskan aturan yang sudah disetujui usaha..." multiline/>
        <View style={s.scopeRow}>
          <View style={s.scopeCopy}><Text style={s.scopeTitle}>Berlaku untuk semua cabang</Text><Text style={s.scopeDetail}>{allBranches?"Dapat digunakan di seluruh cabang":"Hanya untuk cabang aktif"}</Text></View>
          <Switch value={allBranches} onValueChange={setAllBranches} trackColor={{false:theme.colors.line,true:theme.colors.blueSoft}} thumbColor={allBranches?theme.colors.blue:theme.colors.muted}/>
        </View>
        <Button disabled={busy} title={busy?"Membuat embedding...":"Simpan ke basis pengetahuan"} onPress={()=>void save()}/>
      </View>
    </Card>
    <View style={s.listHead}><Text style={s.sectionTitle}>Dokumen aktif</Text><Badge text={`${documents.length} DOKUMEN`} tone="neutral"/></View>
    {documents.length===0?<EmptyState title="Belum ada panduan" detail="Tambahkan kebijakan pertama agar fitur Tanya NIA dapat menjawab berdasarkan aturan usaha."/>:documents.map(document=><Card key={document.id}>
      <View style={s.documentHead}><View style={s.documentCopy}><Text style={s.documentTitle}>{document.title}</Text><Text style={s.documentScope}>{document.branch_id?"Cabang aktif":"Semua cabang"}{document.metadata?.chunkCount?` • ${document.metadata.chunkCount} bagian terindeks`:" • perlu diindeks ulang"}</Text></View><Button compact variant="danger" title="Hapus" onPress={()=>remove(document)}/></View>
      <Text numberOfLines={4} style={s.documentContent}>{document.content}</Text>
    </Card>)}
  </Screen>;
}

const s=StyleSheet.create({
  sectionTitle:{fontSize:16,fontWeight:"900",color:colors.ink},sectionSub:{fontSize:11,lineHeight:17,color:colors.muted,marginTop:4},form:{gap:12,marginTop:15},
  scopeRow:{flexDirection:"row",alignItems:"center",gap:12},scopeCopy:{flex:1},scopeTitle:{fontSize:12,fontWeight:"800",color:colors.ink},scopeDetail:{fontSize:10,color:colors.muted,marginTop:2},
  listHead:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",gap:10},documentHead:{flexDirection:"row",alignItems:"flex-start",gap:10},documentCopy:{flex:1},documentTitle:{fontSize:14,fontWeight:"900",color:colors.ink},documentScope:{fontSize:10,color:colors.blue,fontWeight:"800",marginTop:3},documentContent:{fontSize:11,lineHeight:18,color:colors.muted,marginTop:10},
});
