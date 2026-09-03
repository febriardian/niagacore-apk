import React from "react";
import { AppState, Pressable, StyleSheet, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { useSyncStatus } from "@/hooks/use-sync-status";
import { i18n, setAppLanguage } from "@/lib/i18n";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/auth-provider";
import { useAppTheme } from "@/providers/theme-provider";
import { areasFor, roleLabel, type WorkspaceArea } from "@niagacore/domain";
import { ApprovalsScreen } from "@/screens/approvals-screen";
import { DashboardScreen } from "@/screens/dashboard-screen";
import { BusinessManagementScreen } from "@/screens/business-management-screen";
import { DeviceManagementScreen } from "@/screens/device-management-screen";
import { OperationsScreen } from "@/screens/operations-screen";
import { PeripheralScreen } from "@/screens/peripheral-screen";
import { PosScreen } from "@/screens/pos-screen";
import { ProductsScreen } from "@/screens/products-screen";
import { ReportsScreen } from "@/screens/reports-screen";
import { ReceiptsScreen } from "@/screens/receipts-screen";
import { SettingsScreen } from "@/screens/settings-screen";
import { StaffAccessScreen } from "@/screens/staff-access-screen";
import { WalletScreen } from "@/screens/wallet-screen";
import { KnowledgeScreen } from "@/screens/knowledge-screen";
import { OperationalHealthScreen } from "@/screens/operational-health-screen";
import { NiaGovernanceScreen } from "@/screens/nia-governance-screen";
import { BrandSymbol } from "@/ui/brand";
import { colors } from "@/ui/theme";
import { LocalizedText as Text, localizedAlert } from "@/ui/localized-text";
import { Button, Field, Sheet, Row } from "@/ui/components";

type Tab = WorkspaceArea;
const allItems: { key: Tab; icon: string; id: string; en: string }[] = [
  { key: "home", icon: "⌂", id: "Beranda", en: "Home" },
  { key: "pos", icon: "▣", id: "Kasir", en: "POS" },
  { key: "products", icon: "▦", id: "Produk", en: "Products" },
  { key: "reports", icon: "▥", id: "Laporan", en: "Reports" },
  { key: "approvals", icon: "✓", id: "Setujui", en: "Approve" },
  { key: "operations", icon: "•••", id: "Lainnya", en: "More" },
];

export function ProductionApp() {
  const theme=useAppTheme();
  const insets=useSafeAreaInsets();
  const { workspace, switchBranch, switchBusiness } = useAuth();
  const [tab, setTab] = React.useState<Tab>("home");
  const [settings, setSettings] = React.useState(false);
  const [utility, setUtility] = React.useState<"wallet" | "staff" | "receipts" | "approvals" | "devices" | "peripherals" | "businesses" | "knowledge" | "operationalHealth" | "niaGovernance" | null>(null);
  const [languageVersion, setLanguageVersion] = React.useState(0);
  const [branchPicker, setBranchPicker] = React.useState(false);
  const [locked,setLocked]=React.useState(false);
  const [unlockPin,setUnlockPin]=React.useState("");
  const [unlockBusy,setUnlockBusy]=React.useState(false);
  const backgroundAt=React.useRef<number|null>(null);
  const sync = useSyncStatus(workspace?.deviceId, workspace?.tenantId, workspace?.branchId);
  React.useEffect(() => {
    const handler = () => setLanguageVersion((v) => v + 1);
    i18n.on("languageChanged", handler);
    return () => {
      i18n.off("languageChanged", handler);
    };
  }, []);
  React.useEffect(()=>{
    const subscription=AppState.addEventListener("change",async(state)=>{
      if(state==="background"||state==="inactive") backgroundAt.current=Date.now();
      if(state==="active"&&backgroundAt.current&&Date.now()-backgroundAt.current>=5*60_000){
        if(await SecureStore.getItemAsync("niagacore.device-pin-enabled")==="true") setLocked(true);
        backgroundAt.current=null;
      }
    });
    return()=>subscription.remove();
  },[]);
  if (!workspace) return null;
  const items = allItems.filter((item) => areasFor(workspace.role).includes(item.key));
  const activeTab = items.some((item) => item.key === tab) ? tab : items[0]?.key ?? "home";
  const changed = async () => {
    await sync.refresh();
  };
  const navigate = (target: string) => {
    if (target === "settings") setSettings(true);
    else if (["wallet", "staff", "receipts", "devices", "peripherals", "businesses", "knowledge", "operationalHealth", "niaGovernance"].includes(target)) {
      setSettings(false);
      setUtility(target as Exclude<typeof utility, null>);
    }
    else if (items.some((x) => x.key === target)) setTab(target as Tab);
  };
  const changeLanguage = async (language: "id" | "en") => {
    await setAppLanguage(language);
    if (supabase) {
      await supabase.from("profiles").update({ preferred_language: language }).eq("id", workspace.userId);
    }
  };
  const unlock=async()=>{
    if(!supabase||!/^\d{6}$/.test(unlockPin))return localizedAlert("PIN perangkat","Masukkan PIN 6 digit.");
    setUnlockBusy(true);
    const {data,error}=await supabase.rpc("verify_device_unlock_pin",{target_device_id:workspace.deviceId,pin:unlockPin});
    setUnlockBusy(false);
    if(error||data!==true)return localizedAlert("PIN perangkat",error?.message??"PIN salah atau sementara dikunci.");
    setUnlockPin("");setLocked(false);
  };
  if(locked)return <SafeAreaView style={[s.lockScreen,{backgroundColor:theme.colors.cream}]} edges={["top","bottom"]}>
    <BrandSymbol size={64}/><Text style={s.lockTitle}>NiagaCore terkunci</Text>
    <Text style={s.lockDetail}>Masukkan PIN perangkat untuk melanjutkan sesi aktif.</Text>
    <View style={s.lockForm}><Field label="PIN 6 digit" value={unlockPin} onChangeText={setUnlockPin} keyboardType="numeric" secureTextEntry/>
      <Button disabled={unlockBusy} title={unlockBusy?"Memeriksa...":"Buka aplikasi"} onPress={()=>void unlock()}/></View>
  </SafeAreaView>;
  return (
    <View key={`${languageVersion}:${theme.resolvedMode}`} style={[s.page,{backgroundColor:theme.colors.cream}]}>
      <SafeAreaView style={s.safe} edges={["top"]}>
        <View style={[s.topbar,{backgroundColor:theme.colors.surface,borderBottomColor:theme.colors.line}]}>
          <BrandSymbol size={34} />
          <Pressable accessibilityRole="button" accessibilityLabel="Pilih usaha atau cabang" onPress={() => (workspace.branches.length > 1||workspace.businesses.length>1) && setBranchPicker(true)} style={s.identity}>
            <Text style={s.product}>NiagaCore</Text>
            <Text numberOfLines={1} style={s.branch}>{workspace.businessName} · {workspace.branchName} • {roleLabel(workspace.role)}{workspace.branches.length > 1||workspace.businesses.length>1 ? "  ▾" : ""}</Text>
          </Pressable>
          <View accessibilityRole="tablist" style={[s.languageSwitch,{backgroundColor:theme.colors.blueSoft}]}>
            {(["id", "en"] as const).map((language) => (
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: i18n.language === language }}
                key={language}
                onPress={() => void changeLanguage(language)}
                style={[s.languageButton, i18n.language === language && s.languageActive]}
              >
                <Text style={[s.languageText, i18n.language === language && s.languageTextActive]}>
                  {language.toUpperCase()}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={i18n.language === "en" ? "Settings" : "Pengaturan"} onPress={() => { setUtility(null); setSettings(true); }} style={[s.settingsButton,{backgroundColor:theme.colors.blueSoft}]}>
            <Text style={s.settingsIcon}>•••</Text>
          </Pressable>
        </View>
        {utility === "wallet" ? (
          <WalletScreen workspace={workspace} onBack={() => setUtility(null)} />
        ) : utility === "staff" ? (
          <StaffAccessScreen workspace={workspace} onBack={() => setUtility(null)} />
        ) : utility === "receipts" ? (
          <ReceiptsScreen workspace={workspace} onBack={() => setUtility(null)} />
        ) : utility === "approvals" ? (
          <ApprovalsScreen workspace={workspace} onChanged={changed} onBack={() => setUtility(null)} />
        ) : utility === "devices" ? (
          <DeviceManagementScreen workspace={workspace} onBack={() => setUtility(null)} />
        ) : utility === "peripherals" ? (
          <PeripheralScreen onBack={() => setUtility(null)} />
        ) : utility === "businesses" ? (
          <BusinessManagementScreen workspace={workspace} onBack={() => setUtility(null)} />
        ) : utility === "knowledge" ? (
          <KnowledgeScreen workspace={workspace} onBack={() => setUtility(null)} />
        ) : utility === "operationalHealth" ? (
          <OperationalHealthScreen workspace={workspace} onBack={() => setUtility(null)} />
        ) : utility === "niaGovernance" ? (
          <NiaGovernanceScreen workspace={workspace} onBack={() => setUtility(null)} />
        ) : settings ? (
          <SettingsScreen
            workspace={workspace}
            onBack={() => setSettings(false)}
            onOpenWallet={() => navigate("wallet")}
            onOpenStaff={() => navigate("staff")}
          />
        ) : (
          <>
            {activeTab === "home" && (
              <DashboardScreen
                workspace={workspace}
                onNavigate={navigate}
                sync={sync}
              />
            )}
            {activeTab === "pos" && (
              <PosScreen workspace={workspace} onChanged={changed} />
            )}
            {activeTab === "products" && (
              <ProductsScreen workspace={workspace} onChanged={changed} />
            )}
            {activeTab === "reports" && <ReportsScreen workspace={workspace} />}
            {activeTab === "approvals" && <ApprovalsScreen workspace={workspace} onChanged={changed} onBack={() => setTab("home")} />}
            {activeTab === "operations" && (
              <OperationsScreen
                workspace={workspace}
                onChanged={changed}
                onOpenSettings={() => setSettings(true)}
                onOpenWallet={() => navigate("wallet")}
                onOpenReceipts={() => navigate("receipts")}
                onOpenStaff={() => navigate("staff")}
                onOpenApprovals={() => setUtility("approvals")}
                onOpenDevices={() => navigate("devices")}
                onOpenPeripherals={() => navigate("peripherals")}
                onOpenWorkspaces={() => navigate("businesses")}
                onOpenKnowledge={() => navigate("knowledge")}
                onOpenOperationalHealth={() => navigate("operationalHealth")}
                onOpenNiaGovernance={() => navigate("niaGovernance")}
              />
            )}
            <View pointerEvents="none" style={[s.navigationGuard,{height:insets.bottom,backgroundColor:theme.colors.surface}]} />
            <View style={[s.nav,{bottom:insets.bottom,backgroundColor:theme.colors.surface,borderColor:theme.colors.line,shadowColor:theme.colors.shadow}]}>
              {items.map((item) => {
                const active = activeTab === item.key;
                return (
                  <Pressable
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                    key={item.key}
                    onPress={() => setTab(item.key)}
                    style={s.navItem}
                  >
                    <View style={[s.iconWrap, active && s.iconActive,active&&{backgroundColor:theme.colors.blueSoft}]}>
                      <Text style={[s.icon, active && s.iconTextActive]}>
                        {item.icon}
                      </Text>
                    </View>
                    <Text style={[s.label, active && s.labelActive]}>
                      {i18n.language === "en" ? item.en : item.id}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        )}
        <Sheet visible={branchPicker} title="Pilih ruang kerja" onClose={() => setBranchPicker(false)}>
          {workspace.businesses.length>1 ? <>
            <Text style={s.pickerLabel}>USAHA</Text>
            {workspace.businesses.map((business)=><Row
              key={business.id}
              title={business.name}
              detail={business.modules.join(" • ")}
              right={business.id===workspace.businessId?<Text style={s.selectedBranch}>AKTIF</Text>:undefined}
              onPress={business.id===workspace.businessId?undefined:()=>{void switchBusiness(business.id).then(()=>{setBranchPicker(false);setTab("home")})}}
            />)}
            <Text style={s.pickerLabel}>CABANG {workspace.businessName.toUpperCase()}</Text>
          </> : null}
          {workspace.branches.map((branch) => <Row
            key={branch.id}
            title={branch.name}
            detail={branch.code}
            right={branch.id === workspace.branchId ? <Text style={s.selectedBranch}>AKTIF</Text> : undefined}
            onPress={branch.id === workspace.branchId ? undefined : () => {
              void switchBranch(branch.id).then(() => { setBranchPicker(false); setTab("home"); void sync.refresh(); });
            }}
          />)}
        </Sheet>
      </SafeAreaView>
    </View>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.cream },
  safe: { flex: 1 },
  topbar: {
    minHeight: 62,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  identity: { flex: 1 },
  product: { color: colors.ink, fontSize: 15, fontWeight: "900" },
  branch: { color: colors.muted, fontSize: 10, marginTop: 1 },
  languageSwitch: { flexDirection: "row", padding: 3, borderRadius: 12, backgroundColor: colors.blueSoft },
  languageButton: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 9 },
  languageActive: { backgroundColor: colors.blue },
  languageText: { color: colors.blue, fontSize: 10, fontWeight: "900" },
  languageTextActive: { color: "#FFFFFF" },
  settingsButton: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.blueSoft },
  settingsIcon: { color: colors.blue, fontSize: 14, fontWeight: "900" },
  nav: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 64,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    borderWidth: 1,
    borderColor: colors.line,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    shadowColor: colors.shadow,
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
    paddingHorizontal: 5,
  },
  navigationGuard:{position:"absolute",left:0,right:0,bottom:0,backgroundColor:colors.surface},
  navItem: { flex: 1, alignItems: "center", gap: 3 },
  iconWrap: {
    width: 32,
    height: 27,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  iconActive: { backgroundColor: colors.blueSoft },
  icon: { fontSize: 18, lineHeight: 20, color: colors.muted, fontWeight: "900" },
  iconTextActive: { color: colors.blue },
  label: { fontSize: 9, color: "#526078", fontWeight: "800" },
  labelActive: { color: colors.navy, fontWeight: "900" },
  selectedBranch: { color: colors.blue, fontSize: 10, fontWeight: "900" },
  pickerLabel:{fontSize:10,fontWeight:"900",color:colors.muted,letterSpacing:1,marginTop:8},
  lockScreen:{flex:1,backgroundColor:colors.cream,alignItems:"center",justifyContent:"center",padding:28,gap:12},
  lockTitle:{fontSize:24,fontWeight:"900",color:colors.navy,marginTop:8},
  lockDetail:{fontSize:13,lineHeight:20,textAlign:"center",color:colors.muted,maxWidth:340},
  lockForm:{width:"100%",maxWidth:380,gap:12,marginTop:14},
});
