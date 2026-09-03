import { formatRupiah } from "@niagacore/domain";
import React from "react";
import { StyleSheet, View } from "react-native";

import { bankName, indonesianBanks } from "@/lib/indonesian-banks";
import { explainWalletAccountError } from "@/lib/wallet-account-error";
import { supabase } from "@/lib/supabase";
import type { ActiveWorkspace } from "@/providers/auth-provider";
import { Badge, Button, Card, EmptyState, Field, Header, Row, Screen, Sheet } from "@/ui/components";
import { LocalizedText as Text, localizedAlert } from "@/ui/localized-text";
import { colors } from "@/ui/theme";

type Wallet = { pending_minor:number; available_minor:number; reserve_minor:number; withdrawal_locked_minor:number; updated_at:string };
type Account = { id:string; bank_code:string; account_holder:string; account_last4:string; kyc_status:string; active:boolean };
type Withdrawal = { id:string; amount_minor:number; status:string; created_at:string; external_reference:string|null };
type Ledger = { id:string; event_type:string; available_delta_minor:number; pending_delta_minor:number; reserve_delta_minor:number; created_at:string };
const amountMinorFromInput=(value:string)=>Number(value.replace(/\D/g,""));

export function WalletScreen({workspace,onBack}:{workspace:ActiveWorkspace;onBack:()=>void}) {
  const [wallet,setWallet]=React.useState<Wallet|null>(null);
  const [accounts,setAccounts]=React.useState<Account[]>([]);
  const [withdrawals,setWithdrawals]=React.useState<Withdrawal[]>([]);
  const [ledger,setLedger]=React.useState<Ledger[]>([]);
  const [accountSheet,setAccountSheet]=React.useState(false);
  const [choosingBank,setChoosingBank]=React.useState(false);
  const [withdrawSheet,setWithdrawSheet]=React.useState(false);
  const [busy,setBusy]=React.useState(false);
  const [bank,setBank]=React.useState("BCA");
  const [bankQuery,setBankQuery]=React.useState("");
  const [holder,setHolder]=React.useState("");
  const [number,setNumber]=React.useState("");
  const [amount,setAmount]=React.useState("");
  const [selectedAccountId,setSelectedAccountId]=React.useState<string|null>(null);

  const load=React.useCallback(async()=>{
    if(!supabase)return;
    const [w,a,r,l]=await Promise.all([
      supabase.from("merchant_wallets").select("pending_minor,available_minor,reserve_minor,withdrawal_locked_minor,updated_at").eq("tenant_id",workspace.tenantId).maybeSingle(),
      supabase.from("withdrawal_accounts").select("id,bank_code,account_holder,account_last4,kyc_status,active").eq("tenant_id",workspace.tenantId).eq("active",true).order("created_at",{ascending:false}),
      supabase.from("withdrawal_requests").select("id,amount_minor,status,created_at,external_reference").eq("tenant_id",workspace.tenantId).order("created_at",{ascending:false}).limit(20),
      supabase.from("wallet_ledger").select("id,event_type,available_delta_minor,pending_delta_minor,reserve_delta_minor,created_at").eq("tenant_id",workspace.tenantId).order("created_at",{ascending:false}).limit(30),
    ]);
    setWallet(w.data);setAccounts(a.data??[]);setWithdrawals(r.data??[]);setLedger(l.data??[]);
  },[workspace.tenantId]);

  React.useEffect(()=>{const timer=setTimeout(()=>void load(),0);return()=>clearTimeout(timer)},[load]);

  if(workspace.role!=="owner") return <Screen><Header title="Saldo Merchant" right={<Button compact variant="ghost" title="Kembali" onPress={onBack}/>}/><EmptyState title="Akses pemilik diperlukan" detail="Saldo dan penarikan hanya dapat dikelola pemilik merchant."/></Screen>;

  const closeAccountSheet=()=>{setAccountSheet(false);setChoosingBank(false);setBankQuery("")};
  const saveAccount=async()=>{
    if(!supabase)return;
    if(holder.trim().length<3||!/^[0-9]{6,24}$/.test(number.replace(/\s+/g,"")))return localizedAlert("Rekening","Periksa nama pemilik dan nomor rekening.");
    setBusy(true);
    const {error}=await supabase.functions.invoke("wallet-account",{body:{action:"set",tenantId:workspace.tenantId,bankCode:bank,accountHolder:holder,accountNumber:number}});
    setBusy(false);
    if(error)return localizedAlert("Rekening",await explainWalletAccountError(error));
    closeAccountSheet();setHolder("");setNumber("");await load();
  };
  const verifiedAccounts=accounts.filter((item)=>item.kyc_status==="verified");
  const selectedAccount=verifiedAccounts.find((item)=>item.id===selectedAccountId)??verifiedAccounts[0];
  const requestWithdrawal=async()=>{
    if(!supabase||!selectedAccount)return;
    const amountMinor=amountMinorFromInput(amount);
    if(amountMinor<50000)return localizedAlert("Tarik dana","Minimum penarikan Rp50.000.");
    if(amountMinor>(wallet?.available_minor??0))return localizedAlert("Tarik dana","Nominal melebihi saldo yang tersedia.");
    setBusy(true);
    const {error}=await supabase.rpc("request_withdrawal",{target_account_id:selectedAccount.id,amount_minor:amountMinor});
    setBusy(false);
    if(error)return localizedAlert("Tarik dana",error.message.includes("verified_account_required")?"Rekening tujuan belum diverifikasi admin.":error.message);
    setWithdrawSheet(false);setAmount("");localizedAlert("Permintaan dibuat","Saldo dikunci sampai admin menyetujui atau menolak. Status dibayar hanya diberikan setelah referensi dan bukti transfer tersimpan.");await load();
  };
  const normalizedQuery=bankQuery.trim().toLowerCase();
  const filteredBanks=indonesianBanks.filter((item)=>`${item.code} ${item.name} ${item.aliases??""}`.toLowerCase().includes(normalizedQuery));

  return <Screen><Header title="Saldo Merchant" subtitle="Pembayaran QRIS platform dan pencairan manual" right={<Button compact variant="ghost" title="Kembali" onPress={onBack}/>}/>
    <View style={s.balanceGrid}><Balance label="Tersedia" value={wallet?.available_minor??0} tone="green"/><Balance label="Pending" value={wallet?.pending_minor??0} tone="amber"/><Balance label="Reserve" value={wallet?.reserve_minor??0} tone="blue"/><Balance label="Dikunci" value={wallet?.withdrawal_locked_minor??0} tone="neutral"/></View>
    <Card><Text style={s.title}>PENARIKAN DANA</Text><Text style={s.note}>Rekening baru diperiksa admin. Penarikan hanya dapat diajukan ke rekening terverifikasi dan status dibayar wajib memiliki referensi serta bukti transfer.</Text>
      {accounts.map(item=><Row key={item.id} title={`${bankName(item.bank_code)} •••• ${item.account_last4}`} detail={item.account_holder} right={<Badge text={item.kyc_status==="verified"?"Terverifikasi":item.kyc_status==="rejected"?"Ditolak":"Menunggu verifikasi"} tone={item.kyc_status==="verified"?"green":item.kyc_status==="rejected"?"red":"amber"}/>}/>) }
      <View style={s.actions}><Button variant="outline" title="Tambah rekening" onPress={()=>setAccountSheet(true)}/><Button disabled={!verifiedAccounts.length||(wallet?.available_minor??0)<50000} title="Tarik dana" onPress={()=>setWithdrawSheet(true)}/></View>
      {!verifiedAccounts.length?<Text style={s.note}>Tombol tarik dana aktif setelah minimal satu rekening diverifikasi.</Text>:null}
    </Card>
    <Card><Text style={s.title}>PERMINTAAN TERAKHIR</Text>{withdrawals.length?withdrawals.map(item=><Row key={item.id} title={formatRupiah(item.amount_minor)} detail={`${new Date(item.created_at).toLocaleString("id-ID")}${item.external_reference?` • ${item.external_reference}`:""}`} right={<Badge text={item.status} tone={item.status==="paid"?"green":item.status==="rejected"?"red":"amber"}/>}/>):<Text style={s.note}>Belum ada permintaan penarikan.</Text>}</Card>
    <Card><Text style={s.title}>MUTASI SALDO</Text>{ledger.length?ledger.map(item=>{const delta=item.available_delta_minor+item.pending_delta_minor+item.reserve_delta_minor;return <Row key={item.id} title={item.event_type.replaceAll("_"," ")} detail={new Date(item.created_at).toLocaleString("id-ID")} right={<Text style={[s.delta,delta<0&&s.negative]}>{delta>0?"+":""}{formatRupiah(delta)}</Text>}/> }):<Text style={s.note}>Mutasi akan muncul setelah pembayaran QRIS settlement.</Text>}</Card>

    <Sheet visible={accountSheet} title={choosingBank?"Pilih bank":"Tambah rekening"} onClose={choosingBank?()=>{setChoosingBank(false);setBankQuery("")}:closeAccountSheet}>
      {choosingBank?<>
        <Field label="Cari bank" value={bankQuery} onChangeText={setBankQuery} placeholder="Nama bank atau kode"/>
        {filteredBanks.map(item=><Row key={item.code} title={item.name} detail={item.code} right={bank===item.code?<Badge text="Dipilih" tone="blue"/>:undefined} onPress={()=>{setBank(item.code);setChoosingBank(false);setBankQuery("")}}/>)}
        {!filteredBanks.length?<EmptyState embedded title="Bank tidak ditemukan" detail="Coba nama atau kode bank lain."/>:null}
      </>:<>
        <Text style={s.note}>Nomor rekening disimpan dengan aman. Setelah tersimpan, aplikasi hanya menampilkan empat digit terakhir.</Text>
        <Text style={s.fieldLabel}>BANK TUJUAN</Text>
        <Row title={bankName(bank)} detail={bank} right={<Text style={s.change}>Ganti</Text>} onPress={()=>setChoosingBank(true)}/>
        <Field label="Nama pemilik rekening" value={holder} onChangeText={setHolder}/>
        <Field label="Nomor rekening" value={number} onChangeText={setNumber} keyboardType="numeric"/>
        <Button disabled={busy} title={busy?"Menyimpan...":"Simpan rekening"} onPress={()=>void saveAccount()}/>
      </>}
    </Sheet>

    <Sheet visible={withdrawSheet} title="Tarik dana" onClose={()=>setWithdrawSheet(false)}><Row title="Saldo tersedia" detail={formatRupiah(wallet?.available_minor??0)}/><Text style={s.title}>REKENING TERVERIFIKASI</Text>{verifiedAccounts.map(item=><Row key={`withdraw:${item.id}`} title={`${bankName(item.bank_code)} •••• ${item.account_last4}`} detail={item.account_holder} right={selectedAccount?.id===item.id?<Badge text="Dipilih" tone="blue"/>:undefined} onPress={()=>setSelectedAccountId(item.id)}/>)}<Field label="Nominal (rupiah)" value={amount} onChangeText={value=>setAmount(value.replace(/\D/g,""))} keyboardType="numeric"/><Text style={s.note}>Minimum Rp50.000. Saldo akan dikunci sampai proses pemeriksaan selesai.</Text><Button disabled={busy||!selectedAccount||amountMinorFromInput(amount)<50000||amountMinorFromInput(amount)>(wallet?.available_minor??0)} title={busy?"Mengirim...":"Ajukan penarikan"} onPress={()=>void requestWithdrawal()}/></Sheet>
  </Screen>;
}

function Balance({label,value,tone}:{label:string;value:number;tone:"green"|"amber"|"blue"|"neutral"}){return <Card style={s.balance}><Badge text={label} tone={tone}/><Text style={s.value}>{formatRupiah(value)}</Text></Card>}

const s=StyleSheet.create({
  balanceGrid:{flexDirection:"row",flexWrap:"wrap",gap:10},balance:{width:"47%"},value:{fontSize:18,fontWeight:"900",color:colors.navy,marginTop:12},
  title:{fontSize:11,fontWeight:"900",color:colors.navy,letterSpacing:1},note:{fontSize:11,lineHeight:17,color:colors.muted,marginVertical:8},
  actions:{gap:8,marginTop:10},delta:{fontSize:11,fontWeight:"900",color:colors.green},negative:{color:colors.red},
  fieldLabel:{fontSize:10,fontWeight:"900",letterSpacing:.8,color:colors.muted,marginTop:8},change:{fontSize:11,fontWeight:"900",color:colors.blue},
});
