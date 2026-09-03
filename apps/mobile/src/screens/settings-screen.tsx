import {
  getAccountingSettings,
  saveAccountingSettings,
  seedAccountingDefaults,
  type AccountingSettings,
} from "@/lib/remote-store";
import { useRemoteStore } from "@/lib/remote-store";
import * as SecureStore from "expo-secure-store";
import React from "react";
import { Linking, Pressable, StyleSheet, Switch, View } from "react-native";
import QRCode from "react-native-qrcode-svg";

import { i18n, setAppLanguage } from "@/lib/i18n";
import { checkForAppUpdate, type UpdateCheck } from "@/lib/app-update";
import { getPushPermissionStatus, registerPushNotifications } from "@/lib/push-notifications";
import { createMutation } from "@/lib/mutations";
import { supabase } from "@/lib/supabase";
import { useAuth, type ActiveWorkspace } from "@/providers/auth-provider";
import { useAppTheme } from "@/providers/theme-provider";
import {
  Badge,
  Button,
  Card,
  Field,
  Header,
  Row,
  Screen,
  Segmented,
  Sheet,
} from "@/ui/components";
import { colors } from "@/ui/theme";
import { LocalizedText as Text, localizedAlert } from "@/ui/localized-text";
import { roleLabel } from "@niagacore/domain";

export function SettingsScreen({
  workspace,
  onBack,
  onOpenWallet,
  onOpenStaff,
}: {
  workspace: ActiveWorkspace;
  onBack: () => void;
  onOpenWallet: () => void;
  onOpenStaff: () => void;
}) {
  const db = useRemoteStore();
  const auth = useAuth();
  const theme=useAppTheme();
  const managesTeam = ["owner", "business_manager"].includes(workspace.role);
  const managesAccounting = workspace.role === "owner";
  const managesPolicy = workspace.role === "owner";
  const roleName=roleLabel(workspace.role);
  const roleSummary=workspace.role==="owner"?"Kelola usaha, keamanan, akuntansi, perangkat, dan kebijakan dari satu tempat.":workspace.role==="cashier"?"Atur keamanan akun, bahasa, pembaruan, dan perangkat kerja kasir.":"Preferensi dan kontrol ditampilkan sesuai izin peran Anda.";
  const [settings, setSettings] = React.useState<AccountingSettings | null>(
    null,
  );
  const [mfa, setMfa] = React.useState(false);
  const [updateCheck,setUpdateCheck]=React.useState<UpdateCheck|null>(null);
  const [updateBusy,setUpdateBusy]=React.useState(false);
  const [pushStatus,setPushStatus]=React.useState<"granted"|"denied"|"undetermined"|"unavailable">("undetermined");
  const [pushBusy,setPushBusy]=React.useState(false);
  const [pinOpen,setPinOpen]=React.useState(false),[pin,setPin]=React.useState(""),[pinConfirm,setPinConfirm]=React.useState(""),[pinBusy,setPinBusy]=React.useState(false);
  React.useEffect(() => {
    const timer = setTimeout(() => {
      void seedAccountingDefaults(db, workspace)
        .then(() => getAccountingSettings(db, workspace))
        .then(setSettings);
      if (supabase)
        void supabase.auth.mfa
          .listFactors()
          .then(({ data }) => setMfa((data?.totp?.length ?? 0) > 0));
      void getPushPermissionStatus().then(status=>setPushStatus(status)).catch(()=>setPushStatus("unavailable"));
    }, 0);
    return () => clearTimeout(timer);
  }, [db, workspace]);
  const updateAccounting = async (next: AccountingSettings) => {
    setSettings(next);
    await saveAccountingSettings(
      db,
      workspace,
      next,
      await createMutation(
        workspace,
        "accounting_settings",
        workspace.businessId,
        "update",
        next as unknown as Record<string, unknown>,
      ),
    );
  };
  const saveDevicePin=async()=>{
    if(!supabase||!/^[0-9]{6}$/.test(pin)||pin!==pinConfirm)return localizedAlert("PIN perangkat","Gunakan 6 digit yang sama pada kedua kolom.");
    setPinBusy(true);
    const {error}=await supabase.rpc("set_device_unlock_pin",{target_device_id:workspace.deviceId,pin});
    setPinBusy(false);
    if(error)return localizedAlert("PIN perangkat",error.message.includes("pin_temporarily_locked")?"Terlalu banyak percobaan. PIN dikunci selama 15 menit.":error.message.includes("device_access_denied")?"Perangkat ini tidak aktif atau tidak terhubung ke akun Anda.":error.message);
    await SecureStore.setItemAsync("niagacore.device-pin-enabled","true");
    setPinOpen(false);setPin("");setPinConfirm("");localizedAlert("PIN perangkat","PIN perangkat berhasil diperbarui.");
  };
  const refreshUpdate=async()=>{
    setUpdateBusy(true);
    try {
      const result=await checkForAppUpdate();
      setUpdateCheck(result);
      if(!result) localizedAlert("Pembaruan aplikasi","Pemeriksaan pembaruan belum tersedia. Silakan coba kembali setelah layanan rilis aktif.");
    } catch {
      localizedAlert("Pembaruan aplikasi","Status versi tidak dapat diperiksa. Periksa koneksi lalu coba lagi.");
    } finally { setUpdateBusy(false); }
  };
  const enablePush=async()=>{
    setPushBusy(true);
    try{
      const result=await registerPushNotifications(workspace,true);
      setPushStatus(result.status==="enabled"?"granted":result.status==="denied"?"denied":"unavailable");
      localizedAlert("Notifikasi operasional",result.detail);
    }catch(error){localizedAlert("Notifikasi operasional",error instanceof Error?error.message:String(error))}
    finally{setPushBusy(false)}
  };
  return (
    <Screen>
      <Header
        title="Pengaturan"
        subtitle={`Kelola akun, usaha, dan perangkat • ${roleName}`}
        right={
          <Button compact variant="ghost" title="Kembali" onPress={onBack} />
        }
      />
      <View style={s.settingsHero}>
        <View style={s.heroTop}>
          <View style={s.roleMark}><Text style={s.roleMarkText}>{roleName.slice(0,1)}</Text></View>
          <View style={s.flex}><Text style={s.heroEyebrow}>RUANG KONTROL</Text><Text style={s.heroTitle}>Pengaturan {roleName}</Text></View>
          <Badge text={roleName} tone="blue"/>
        </View>
        <Text style={s.heroDetail}>{roleSummary}</Text>
        <View style={s.heroMeta}>
          <View style={s.heroMetaItem}><Text style={s.heroMetaLabel}>USAHA</Text><Text numberOfLines={1} style={s.heroMetaValue}>{workspace.businessName}</Text></View>
          <View style={s.heroMetaDivider}/>
          <View style={s.heroMetaItem}><Text style={s.heroMetaLabel}>CABANG</Text><Text numberOfLines={1} style={s.heroMetaValue}>{workspace.branchName} · {workspace.branchCode}</Text></View>
        </View>
      </View>
      {managesTeam && <View style={s.quickSection}>
        <View style={s.sectionHeading}><Text style={s.section}>PUSAT OPERASIONAL</Text><Text style={s.sectionDetail}>Akses cepat untuk pekerjaan utama</Text></View>
        <View style={s.quickGrid}>
          {workspace.role === "owner" && <QuickAction symbol="Rp" title="Saldo usaha" detail="Pembayaran & penarikan" onPress={onOpenWallet}/>} 
          <QuickAction symbol="A" title="Staf & akses" detail="Peran, cabang & perangkat" onPress={onOpenStaff}/>
        </View>
      </View>}
      <SettingsCard title="PROFIL & STATUS" detail="Identitas usaha dan kesiapan pembayaran">
        <Row
          title={workspace.businessName}
          detail={`${workspace.tenantName} • ${workspace.branchName}`}
          right={
            <Badge
              text={workspace.merchantStatus}
              tone={workspace.merchantStatus === "approved" ? "green" : "amber"}
            />
          }
        />
        <Row
          title="QRIS"
          detail={
            workspace.qrisEnabled
              ? "Pembayaran gateway aktif"
              : "Menunggu verifikasi dan aktivasi Midtrans"
          }
          right={
            <Badge
              text={workspace.qrisEnabled ? "Aktif" : "Terkunci"}
              tone={workspace.qrisEnabled ? "green" : "amber"}
            />
          }
        />
        <Button
          variant="outline"
          title="Segarkan status merchant"
          onPress={() => void auth.refreshWorkspace()}
        />
      </SettingsCard>
      <SettingsCard title="KEAMANAN AKUN" detail="Perlindungan akses akun dan perangkat">
        {managesTeam && <Row
          title="Verifikasi dua langkah"
          detail={
            mfa
              ? "Faktor TOTP sudah terdaftar"
              : "Wajib sebelum tindakan sensitif dan production"
          }
          right={
            <Badge
              text={mfa ? "Aktif" : "Belum aktif"}
              tone={mfa ? "green" : "red"}
            />
          }
        />}
        {managesTeam && <MfaButton active={mfa} onChanged={setMfa} />}
        <Button variant="outline" title="Atur PIN perangkat" onPress={()=>setPinOpen(true)}/>
        <Text style={s.note}>
          PIN cepat hanya akan membuka sesi perangkat yang sudah terautentikasi;
          PIN tidak menggantikan identitas server.
        </Text>
      </SettingsCard>
      <Sheet visible={pinOpen} title="Atur PIN perangkat" onClose={()=>setPinOpen(false)}>
        <Text style={s.note}>PIN 6 digit hanya membuka kembali sesi akun aktif pada perangkat ini. Login server tetap diperlukan saat berganti akun staf.</Text>
        <Field label="PIN 6 digit" value={pin} onChangeText={setPin} keyboardType="numeric" secureTextEntry/>
        <Field label="Ulangi PIN" value={pinConfirm} onChangeText={setPinConfirm} keyboardType="numeric" secureTextEntry/>
        <Button disabled={pinBusy} title={pinBusy?"Menyimpan...":"Simpan PIN aman"} onPress={()=>void saveDevicePin()}/>
      </Sheet>
      {settings && managesAccounting && (
        <SettingsCard title="AKUNTANSI & PAJAK" detail="Profil pajak dan metode penilaian persediaan">
          <View style={[s.controlGroup,{backgroundColor:theme.colors.cream,borderColor:theme.colors.line}]}>
          <Text style={s.label}>PROFIL PAJAK</Text>
          <Segmented
            value={settings.taxProfile}
            onChange={(value) =>
              void updateAccounting({
                ...settings,
                taxProfile: value,
                ppnEnabled: value === "pkp" ? settings.ppnEnabled : false,
              })
            }
            items={[
              { value: "non_pkp", label: "Non-PKP" },
              { value: "pkp", label: "PKP" },
            ]}
          />
          </View>
          <Toggle
            label="PPN aktif"
            detail="Default nonaktif; aktifkan hanya sesuai status dan review pajak."
            value={settings.ppnEnabled}
            disabled={settings.taxProfile === "non_pkp"}
            onChange={(value) =>
              void updateAccounting({ ...settings, ppnEnabled: value })
            }
          />
          <View style={[s.controlGroup,{backgroundColor:theme.colors.cream,borderColor:theme.colors.line}]}>
          <Text style={s.label}>METODE HPP</Text>
          <Segmented
            value={settings.inventoryCosting}
            onChange={(value) =>
              void updateAccounting({ ...settings, inventoryCosting: value })
            }
            items={[
              { value: "moving_average", label: "Moving average" },
            ]}
          />
          </View>
          <Text style={s.note}>
            Nilai persediaan menggunakan metode rata-rata tertimbang. Metode lain baru ditampilkan setelah perhitungan dan pengujiannya tersedia.
            Perubahan kebijakan dicatat per versi saat tersinkron.
          </Text>
        </SettingsCard>
      )}
      {settings && managesPolicy && <SettingsCard title="KEBIJAKAN OPERASI" detail="Aturan transaksi dan layanan cerdas">
        <View style={[s.controlGroup,{backgroundColor:theme.colors.cream,borderColor:theme.colors.line}]}>
        <Text style={s.label}>STOK TIDAK CUKUP</Text>
        <Segmented
          value={settings?.negativeStockPolicy ?? "approval"}
          onChange={(value) =>
            settings &&
            void updateAccounting({ ...settings, negativeStockPolicy: value })
          }
          items={[
            { value: "blocked", label: "Blokir" },
            { value: "approval", label: "Approval" },
            { value: "allowed", label: "Izinkan" },
          ]}
        />
        <Text style={s.note}>
          Default Approval: diblokir untuk kasir, supervisor/pemilik dapat
          menyetujui dengan audit log.
        </Text>
        </View>
        <Toggle
          label="AI cloud"
          detail="Analisis memakai Cloudflare atau Gemini dengan batas pemakaian aman dan cadangan analitik lokal."
          value={settings.cloudAiEnabled}
          onChange={(value) =>
            void updateAccounting({ ...settings, cloudAiEnabled: value })
          }
        />
      </SettingsCard>}
      <SettingsCard title="NOTIFIKASI OPERASIONAL" detail="Peringatan penting dari server ke perangkat ini">
        <Row
          title="Push notification"
          detail="Jatuh tempo piutang, stok minimum, kedaluwarsa, pembayaran diterima, dan shift belum ditutup."
          right={<Badge text={pushStatus==="granted"?"Aktif":pushStatus==="denied"?"Ditolak":pushStatus==="unavailable"?"Tidak tersedia":"Belum aktif"} tone={pushStatus==="granted"?"green":pushStatus==="denied"?"red":"amber"}/>} 
        />
        {pushStatus!=="unavailable" && <Button disabled={pushBusy} variant={pushStatus==="granted"?"outline":undefined} title={pushBusy?"Mengaktifkan...":pushStatus==="granted"?"Perbarui perangkat push":"Aktifkan notifikasi"} onPress={()=>void enablePush()}/>}
        <Text style={s.note}>{pushStatus==="unavailable"?"Notifikasi push belum tersedia pada aplikasi yang sedang digunakan. Peringatan operasional tetap diperbarui saat aplikasi dibuka.":"Peringatan dihitung di server setiap 15 menit dan diperbarui kembali saat aplikasi dibuka."}</Text>
      </SettingsCard>
      <SettingsCard title="BAHASA & DATA" detail="Bahasa tampilan dan versi aplikasi">
        <View style={[s.controlGroup,{backgroundColor:theme.colors.cream,borderColor:theme.colors.line}]}>
          <Text style={s.label}>TEMA APLIKASI</Text>
          <Segmented
            value={theme.mode}
            onChange={(value)=>void theme.setMode(value)}
            items={[
              {value:"light",label:"Terang"},
              {value:"dark",label:"Gelap"},
            ]}
          />
          <Text style={s.note}>Pilih tampilan terang atau gelap. Pilihan disimpan khusus untuk aplikasi ini.</Text>
        </View>
        <Row
          title="Bahasa aplikasi"
          detail={i18n.language === "en" ? "English" : "Bahasa Indonesia"}
          right={
            <Button
              compact
              variant="outline"
              title={i18n.language === "en" ? "Gunakan ID" : "Use EN"}
              onPress={() => {
                const language = i18n.language === "en" ? "id" : "en";
                void setAppLanguage(language).then(async () => {
                  if (supabase) await supabase.from("profiles").update({ preferred_language: language }).eq("id", workspace.userId);
                });
              }}
            />
          }
        />
        <Row
          title="Pembaruan aplikasi"
          detail={updateCheck ? (updateCheck.available ? `Versi ${updateCheck.manifest.version} tersedia${updateCheck.mandatory ? " dan wajib dipasang" : ""}` : "Aplikasi sudah menggunakan versi terbaru") : "Periksa versi resmi dan batas minimum yang didukung"}
          right={<Badge text={updateCheck?.available ? "Tersedia" : "Periksa"} tone={updateCheck?.mandatory ? "red" : updateCheck?.available ? "amber" : "blue"}/>} 
        />
        <Button variant="outline" disabled={updateBusy} title={updateBusy ? "Memeriksa..." : "Periksa pembaruan"} onPress={()=>void refreshUpdate()}/>
        {updateCheck?.downloadUrl ? <Button title={updateCheck.mandatory ? "Pasang pembaruan wajib" : "Unduh versi terbaru"} onPress={()=>void Linking.openURL(updateCheck.downloadUrl!)}/> : null}
      </SettingsCard>
      <View style={[s.sessionCard,{backgroundColor:theme.colors.redSoft,borderColor:theme.colors.red}]}>
        <View style={s.flex}><Text style={s.sessionTitle}>Sesi akun</Text><Text style={s.sessionDetail}>Keluar hanya dari perangkat ini. Data usaha tetap tersimpan.</Text></View>
        <Button compact variant="danger" title="Keluar" onPress={() => localizedAlert("Keluar dari akun","Sesi pada perangkat ini akan ditutup. Data transaksi yang sudah tersimpan tetap aman.",[{text:"Batal",style:"cancel"},{text:"Keluar",style:"destructive",onPress:()=>void auth.signOut()}])}/>
      </View>
    </Screen>
  );
}

function SettingsCard({title,detail,children}:{title:string;detail:string;children:React.ReactNode}) {
  return <Card style={s.settingsCard}>
    <View style={s.sectionHeading}>
      <Text style={s.section}>{title}</Text>
      <Text style={s.sectionDetail}>{detail}</Text>
    </View>
    {children}
  </Card>;
}

function QuickAction({symbol,title,detail,onPress}:{symbol:string;title:string;detail:string;onPress:()=>void}) {
  const theme=useAppTheme();
  return <Pressable accessibilityRole="button" onPress={onPress} style={({pressed})=>[s.quickAction,{backgroundColor:theme.colors.surface,borderColor:theme.colors.line,shadowColor:theme.colors.shadow},pressed&&s.quickActionPressed]}>
    <View style={[s.quickIcon,{backgroundColor:theme.colors.blueSoft}]}><Text style={s.quickIconText}>{symbol}</Text></View>
    <Text style={s.quickTitle}>{title}</Text>
    <Text style={s.quickDetail}>{detail}</Text>
    <Text style={s.quickArrow}>›</Text>
  </Pressable>;
}

function Toggle({
  label,
  detail,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  detail: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const theme=useAppTheme();
  return (
    <View style={[s.toggle,{borderBottomColor:theme.colors.line}]}>
      <View style={s.flex}>
        <Text style={s.toggleTitle}>{label}</Text>
        <Text style={s.toggleDetail}>{detail}</Text>
      </View>
      <Switch
        disabled={disabled}
        value={value}
        onValueChange={onChange}
        trackColor={{ false: "#D7DDE5", true: "#9CD7C4" }}
        thumbColor={value ? colors.green : "#FFF"}
      />
    </View>
  );
}
function MfaButton({
  active,
  onChanged,
}: {
  active: boolean;
  onChanged: (value: boolean) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [factorId, setFactorId] = React.useState("");
  const [uri, setUri] = React.useState("");
  const [code, setCode] = React.useState("");
  const enroll = async () => {
    if (!supabase) return;
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "NiagaCore Android",
    });
    if (error) {
      localizedAlert("MFA", error.message);
      return;
    }
    setFactorId(data.id);
    setUri(data.totp.uri);
    setOpen(true);
  };
  const verify = async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code,
    });
    if (error) {
      localizedAlert("MFA", error.message);
      return;
    }
    setOpen(false);
    onChanged(true);
    localizedAlert("MFA aktif", "Authenticator berhasil dihubungkan.");
  };
  return (
    <>
      {active ? (
        <Button
          variant="outline"
          title="MFA sudah aktif"
          onPress={() =>
            localizedAlert(
              "MFA",
              "Penghapusan faktor harus melalui proses re-authentication dan halaman keamanan akun.",
            )
          }
        />
      ) : (
        <Button title="Aktifkan verifikasi dua langkah" onPress={() => void enroll()} />
      )}
      <Sheet visible={open} title="Aktifkan verifikasi dua langkah" onClose={() => setOpen(false)}>
        {uri ? (
          <View style={s.qr}>
            <QRCode
              value={uri}
              size={210}
              backgroundColor="#FFFFFF"
              color={colors.navy}
            />
          </View>
        ) : null}
        <Text style={s.note}>
          Pindai QR memakai aplikasi authenticator, lalu masukkan kode 6 digit.
          Jangan membagikan QR atau kode ini.
        </Text>
        <Field
          label="Kode 6 digit"
          value={code}
          onChangeText={setCode}
          keyboardType="numeric"
        />
        <Button title="Verifikasi & aktifkan" onPress={() => void verify()} />
      </Sheet>
    </>
  );
}
const s = StyleSheet.create({
  settingsHero:{gap:14,backgroundColor:colors.navy,borderRadius:22,padding:18,overflow:"hidden"},
  heroTop:{flexDirection:"row",alignItems:"center",gap:12},
  roleMark:{width:48,height:48,borderRadius:16,backgroundColor:colors.blue,alignItems:"center",justifyContent:"center"},
  roleMarkText:{color:colors.white,fontSize:21,fontWeight:"900"},
  heroEyebrow:{fontSize:9,color:"#87B4FF",fontWeight:"900",letterSpacing:1.2,marginBottom:3},
  heroTitle:{fontSize:18,color:colors.white,fontWeight:"900",letterSpacing:-.35},
  heroDetail:{fontSize:12,color:"#C7D5E8",lineHeight:18},
  heroMeta:{flexDirection:"row",alignItems:"center",borderRadius:15,backgroundColor:"rgba(255,255,255,.07)",paddingVertical:10,paddingHorizontal:12},
  heroMetaItem:{flex:1,minWidth:0},
  heroMetaDivider:{width:1,height:28,backgroundColor:"rgba(255,255,255,.14)",marginHorizontal:12},
  heroMetaLabel:{fontSize:8,color:"#87A0C0",fontWeight:"900",letterSpacing:1},
  heroMetaValue:{fontSize:11,color:colors.white,fontWeight:"800",marginTop:3},
  quickSection:{gap:9},
  quickGrid:{flexDirection:"row",flexWrap:"wrap",gap:10},
  quickAction:{position:"relative",flexGrow:1,flexBasis:"46%",minHeight:118,backgroundColor:colors.surface,borderRadius:18,borderWidth:1,borderColor:colors.line,padding:14,shadowColor:colors.shadow,shadowOpacity:.04,shadowRadius:8,shadowOffset:{width:0,height:4},elevation:1},
  quickActionPressed:{opacity:.72,transform:[{scale:.985}]},
  quickIcon:{width:36,height:36,borderRadius:12,backgroundColor:colors.blueSoft,alignItems:"center",justifyContent:"center",marginBottom:10},
  quickIconText:{fontSize:13,color:colors.blue,fontWeight:"900"},
  quickTitle:{fontSize:13,color:colors.ink,fontWeight:"900"},
  quickDetail:{fontSize:10,color:colors.muted,lineHeight:14,marginTop:3,paddingRight:14},
  quickArrow:{position:"absolute",right:12,top:13,fontSize:22,color:colors.blue,fontWeight:"700"},
  settingsCard:{padding:16,gap:10,borderRadius:18},
  sectionHeading:{gap:3},
  section:{fontSize:11,fontWeight:"900",letterSpacing:1.05,color:colors.blue},
  sectionDetail:{fontSize:10,color:colors.muted,lineHeight:14},
  label:{fontSize:11,fontWeight:"900",letterSpacing:.8,color:colors.muted,marginBottom:7},
  controlGroup:{backgroundColor:colors.cream,borderRadius:15,padding:11,borderWidth:1,borderColor:colors.line},
  note:{fontSize:12,color:colors.muted,lineHeight:18,marginTop:2},
  toggle:{flexDirection:"row",alignItems:"center",gap:12,paddingVertical:12,borderBottomWidth:1,borderBottomColor:colors.line},
  flex:{flex:1},
  toggleTitle:{fontSize:14,fontWeight:"900",color:colors.ink},
  toggleDetail:{fontSize:11,color:colors.muted,lineHeight:16,marginTop:4},
  sessionCard:{flexDirection:"row",alignItems:"center",gap:12,backgroundColor:colors.redSoft,borderRadius:18,borderWidth:1,borderColor:"#F8D7D7",padding:14},
  sessionTitle:{fontSize:13,color:colors.red,fontWeight:"900"},
  sessionDetail:{fontSize:10,color:"#9C5A5A",lineHeight:15,marginTop:2},
  qr:{alignSelf:"center",padding:14,backgroundColor:"#FFF",borderRadius:18},
});
