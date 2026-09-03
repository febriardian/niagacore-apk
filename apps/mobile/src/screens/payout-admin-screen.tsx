import React from "react";
import {StyleSheet,View} from "react-native";
import * as Crypto from "expo-crypto";
import * as ImagePicker from "expo-image-picker";

import {formatRupiah} from "@niagacore/domain";
import {supabase} from "@/lib/supabase";
import type {ActiveWorkspace} from "@/providers/auth-provider";
import {Badge,Button,Card,EmptyState,Field,Header,Row,Screen,Sheet} from "@/ui/components";
import {LocalizedText as Text,localizedAlert} from "@/ui/localized-text";
import {colors} from "@/ui/theme";

type PendingAccount={id:string;tenantId:string;tenantName:string;bankCode:string;accountHolder:string;accountLast4:string;status:string;createdAt:string};
type PendingWithdrawal={id:string;tenantId:string;tenantName:string;accountId:string;bankCode:string;accountHolder:string;accountLast4:string;amountMinor:number;status:"requested"|"approved";createdAt:string};
const bytes=(value:string)=>{const raw=globalThis.atob(value),result=new Uint8Array(raw.length);for(let i=0;i<raw.length;i+=1)result[i]=raw.charCodeAt(i);return result.buffer};

export function PayoutAdminScreen({workspace,onBack}:{workspace:ActiveWorkspace;onBack:()=>void}){
  const[accounts,setAccounts]=React.useState<PendingAccount[]>([]),[withdrawals,setWithdrawals]=React.useState<PendingWithdrawal[]>([]),[busy,setBusy]=React.useState(false);
  const[selected,setSelected]=React.useState<PendingWithdrawal|null>(null),[reference,setReference]=React.useState(""),[note,setNote]=React.useState(""),[proof,setProof]=React.useState<{base64:string;mimeType:string}|null>(null);
  const load=React.useCallback(async()=>{if(!supabase)return;setBusy(true);const{data,error}=await supabase.rpc("list_manual_payout_queue");setBusy(false);if(error)return localizedAlert("Pencairan",error.message);const value=(data??{}) as {accounts?:PendingAccount[];withdrawals?:PendingWithdrawal[]};setAccounts(value.accounts??[]);setWithdrawals(value.withdrawals??[])},[]);
  React.useEffect(()=>{const timer=setTimeout(()=>void load(),0);return()=>clearTimeout(timer)},[load]);
  if(!workspace.isPlatformAdmin)return <Screen><Header title="Pencairan manual" right={<Button compact variant="ghost" title="Kembali" onPress={onBack}/>}/><EmptyState title="Akses admin diperlukan" detail="Antrean verifikasi hanya tersedia untuk platform admin."/></Screen>;
  const reveal=async(account:PendingAccount)=>{if(!supabase)return;setBusy(true);const{data,error}=await supabase.functions.invoke("wallet-account",{body:{action:"reveal",accountId:account.id}});setBusy(false);if(error)return localizedAlert("Rekening",error.message);localizedAlert("Nomor rekening",`${account.bankCode} • ${account.accountHolder}\n${String(data?.accountNumber??"")}`)};
  const verify=async(account:PendingAccount,decision:"verified"|"rejected")=>{if(!supabase)return;setBusy(true);const{error}=await supabase.rpc("admin_verify_withdrawal_account",{target_account_id:account.id,decision,note:null});setBusy(false);if(error)return localizedAlert("Verifikasi rekening",error.message);await load()};
  const review=async(item:PendingWithdrawal,decision:"approved"|"rejected")=>{if(!supabase)return;setBusy(true);const{error}=await supabase.rpc("admin_review_withdrawal",{target_request_id:item.id,decision,transfer_reference:null,note:null,evidence_path:null});setBusy(false);if(error)return localizedAlert("Pencairan",error.message);await load()};
  const chooseProof=async()=>{const permission=await ImagePicker.requestMediaLibraryPermissionsAsync();if(!permission.granted)return localizedAlert("Bukti transfer","Izinkan akses galeri untuk memilih bukti transfer.");const result=await ImagePicker.launchImageLibraryAsync({mediaTypes:["images"],quality:.8,base64:true});if(result.canceled)return;const asset=result.assets[0];if(!asset?.base64)return localizedAlert("Bukti transfer","Berkas tidak dapat dibaca.");if((asset.fileSize??0)>5*1024*1024)return localizedAlert("Bukti transfer","Ukuran maksimal 5 MB.");setProof({base64:asset.base64,mimeType:asset.mimeType??"image/jpeg"})};
  const markPaid=async()=>{if(!supabase||!selected||!proof||reference.trim().length<6)return localizedAlert("Pencairan","Referensi transfer dan bukti wajib diisi.");setBusy(true);try{const extension=proof.mimeType.includes("png")?"png":"jpg",path=`${selected.tenantId}/${selected.id}/${Crypto.randomUUID()}.${extension}`;const upload=await supabase.storage.from("payout-evidence").upload(path,bytes(proof.base64),{contentType:proof.mimeType,upsert:false});if(upload.error)throw upload.error;const result=await supabase.rpc("admin_review_withdrawal",{target_request_id:selected.id,decision:"paid",transfer_reference:reference.trim(),note:note.trim()||null,evidence_path:path});if(result.error)throw result.error;setSelected(null);setReference("");setNote("");setProof(null);localizedAlert("Pencairan selesai","Status dibayar, referensi, bukti, audit log, dan mutasi saldo telah disimpan.");await load()}catch(error){localizedAlert("Pencairan",error instanceof Error?error.message:String(error))}finally{setBusy(false)}};
  return <Screen><Header title="Pencairan manual" subtitle="Verifikasi rekening, persetujuan, transfer, dan bukti" right={<Button compact variant="ghost" title="Kembali" onPress={onBack}/>}/>
    <Card><Text style={s.title}>REKENING MENUNGGU VERIFIKASI</Text>{accounts.length?accounts.map(item=><View key={item.id} style={s.item}><Row title={`${item.tenantName} • ${item.bankCode} •••• ${item.accountLast4}`} detail={item.accountHolder}/><View style={s.actions}><Button compact variant="outline" title="Lihat nomor" onPress={()=>void reveal(item)}/><Button compact title="Verifikasi" onPress={()=>void verify(item,"verified")}/><Button compact variant="danger" title="Tolak" onPress={()=>void verify(item,"rejected")}/></View></View>):<Text style={s.note}>Tidak ada rekening yang menunggu.</Text>}</Card>
    <Card>
      <Text style={s.title}>ANTREAN PENCAIRAN</Text>
      {withdrawals.length ? withdrawals.map((item)=><View key={item.id} style={s.item}>
        <Row title={`${item.tenantName} • ${formatRupiah(item.amountMinor)}`} detail={`${item.bankCode} •••• ${item.accountLast4} • ${item.accountHolder}`} right={<Badge text={item.status==="approved"?"Siap ditransfer":"Menunggu"} tone={item.status==="approved"?"green":"amber"}/>} />
        <View style={s.actions}>{item.status==="requested" ? <>
          <Button compact title="Setujui" onPress={()=>void review(item,"approved")}/>
          <Button compact variant="danger" title="Tolak" onPress={()=>void review(item,"rejected")}/>
        </> : <Button compact title="Catat transfer" onPress={()=>{setSelected(item);setReference("");setNote("");setProof(null)}}/>}</View>
      </View>) : <Text style={s.note}>Tidak ada pencairan aktif.</Text>}
    </Card>
    <Button disabled={busy} variant="outline" title={busy?"Memuat...":"Muat ulang antrean"} onPress={()=>void load()}/>
    <Sheet visible={Boolean(selected)} title="Catat transfer manual" onClose={()=>setSelected(null)}><Row title={selected?.tenantName??""} detail={formatRupiah(selected?.amountMinor??0)}/><Field label="Referensi transfer bank" value={reference} onChangeText={setReference}/><Field label="Catatan admin" value={note} onChangeText={setNote} multiline/><Button variant="outline" title={proof?"Bukti transfer dipilih ✓":"Pilih bukti transfer"} onPress={()=>void chooseProof()}/><Text style={s.note}>Status dibayar tidak dapat disimpan tanpa referensi dan bukti transfer.</Text><Button disabled={busy||!proof||reference.trim().length<6} title={busy?"Menyimpan...":"Tandai dibayar"} onPress={()=>void markPaid()}/></Sheet>
  </Screen>;
}
const s=StyleSheet.create({title:{fontSize:11,fontWeight:"900",letterSpacing:1,color:colors.navy},note:{fontSize:11,lineHeight:17,color:colors.muted,marginVertical:8},item:{gap:6,marginTop:8},actions:{flexDirection:"row",flexWrap:"wrap",gap:6}});
