import {
  businessModules,
  normalizeBranchCode,
  slugifyTenantName,
} from "@niagacore/domain";
import React from "react";
import { Controller, useForm } from "react-hook-form";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";

import { i18n } from "@/lib/i18n";
import { isBackendConfigured } from "@/lib/supabase";
import { useAuth } from "@/providers/auth-provider";
import { ProductionApp } from "@/screens/production-app";
import { BrandLockup } from "@/ui/brand";
import { LocalizedText as Text } from "@/ui/localized-text";

export default function EntryScreen() {
  const auth = useAuth();
  if (auth.loading) return <Loading />;
  if (!isBackendConfigured) return <ConfigurationRequired />;
  if (auth.passwordRecovery) return <PasswordRecovery />;
  if (!auth.session) return <Authentication />;
  if (auth.staffActivationPending) return <StaffActivation />;
  if (!auth.workspace) return <Onboarding />;
  return <ProductionApp />;
}

function StaffActivation() {
  const auth = useAuth();
  const [password, setPassword] = React.useState("");
  const [confirmation, setConfirmation] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    if (password !== confirmation) {
      setError("Kata sandi tidak sama.");
      return;
    }
    setBusy(true);
    const result = await auth.completeStaffActivation(password);
    setBusy(false);
    setError(result);
  };
  return <SafeAreaView style={s.page}><ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
    <Brand />
    <Text style={s.eyebrow}>AKTIVASI AKUN STAF</Text>
    <Text style={s.title}>Buat kata sandi untuk masuk</Text>
    <Text style={s.subtitle}>Undangan sudah diverifikasi. Buat kata sandi pribadi, lalu akses kasir atau supervisor akan mengikuti cabang yang diberikan pemilik.</Text>
    <Field value={password} set={setPassword} placeholder="Kata sandi baru" secure />
    <Field value={confirmation} set={setConfirmation} placeholder="Ulangi kata sandi" secure />
    {error && <Text style={s.error}>{error}</Text>}
    <Pressable disabled={busy} onPress={() => void submit()} style={[s.primary,busy&&s.disabled]}><Text style={s.primaryText}>{busy?"...":"Aktifkan akun staf"}</Text></Pressable>
    <Pressable onPress={() => void auth.signOut()} style={s.link}><Text style={s.linkText}>Gunakan akun lain</Text></Pressable>
  </ScrollView></SafeAreaView>;
}

function Loading() {
  return (
    <View style={s.loading}>
      <ActivityIndicator color="#E8793B" size="large" />
      <Text style={s.loadingText}>NiagaCore</Text>
    </View>
  );
}
function ConfigurationRequired() {
  return (
    <SafeAreaView style={s.page}>
      <View style={s.content}>
        <Brand />
        <Text style={s.title}>Konfigurasi production diperlukan</Text>
        <Text style={s.subtitle}>
          Mode demo sudah dihapus. Masukkan URL dan anon key Supabase pada
          environment EAS, terapkan seluruh migrasi, lalu buat APK baru.
        </Text>
      </View>
    </SafeAreaView>
  );
}

function Authentication() {
  const auth = useAuth();
  const [mode, setMode] = React.useState<"signin" | "signup">("signin");
  const [forgot, setForgot] = React.useState(false);
  const { control, getValues, handleSubmit } = useForm<{ email: string; password: string }>({
    defaultValues: { email: "", password: "" },
    mode: "onBlur",
  });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const en = i18n.language === "en";
  const submit = async ({ email, password }: { email: string; password: string }) => {
    setError(null);
    if (!email.includes("@") || password.length < 8) {
      setError(
        en
          ? "Use a valid email and at least 8 characters."
          : "Gunakan email valid dan minimal 8 karakter.",
      );
      return;
    }
    setBusy(true);
    const result =
      mode === "signin"
        ? await auth.signIn(email, password)
        : await auth.signUp(email, password);
    setBusy(false);
    if (result === "confirm-email") {
      Alert.alert(
        en ? "Verify email" : "Verifikasi email",
        en
          ? "Open the link sent to your email, then sign in."
          : "Buka tautan yang dikirim ke email, lalu masuk.",
      );
      setMode("signin");
    } else if (result === "email_not_verified")
      setError(
        en ? "Email has not been verified." : "Email belum diverifikasi.",
      );
    else if (result && result !== "signed-in") setError(result);
  };
  const sendReset = async () => {
    const email = getValues("email");
    setError(null);
    if (!email.includes("@")) {
      setError(en ? "Use a valid email address." : "Gunakan alamat email yang valid.");
      return;
    }
    setBusy(true);
    const result = await auth.requestPasswordReset(email);
    setBusy(false);
    if (result) setError(result);
    else Alert.alert(
      en ? "Check your email" : "Periksa email Anda",
      en ? "Open the password reset link we sent to continue." : "Buka tautan atur ulang kata sandi yang telah dikirim untuk melanjutkan.",
      [{ text: "OK", onPress: () => setForgot(false) }],
    );
  };
  return (
    <SafeAreaView style={s.page}>
      <ScrollView
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
      >
        <Brand />
        <Text style={s.title}>
          {forgot
            ? en ? "Forgot password" : "Lupa kata sandi"
            : mode === "signin"
            ? en
              ? "Sign in"
              : "Masuk"
            : en
              ? "Create merchant account"
              : "Buat akun merchant"}
        </Text>
        <Text style={s.subtitle}>
          {forgot
            ? en ? "Enter your email and we will send a secure reset link." : "Masukkan email dan kami akan mengirim tautan pengaturan ulang yang aman."
            : en
            ? "Email and password with mandatory email verification."
            : "Email dan kata sandi dengan verifikasi email wajib."}
        </Text>
        <Controller control={control} name="email" rules={{ required: true, pattern: /\S+@\S+\.\S+/ }} render={({ field }) => (
          <Field value={field.value} set={field.onChange} placeholder="Email" />
        )} />
        {!forgot && <Controller control={control} name="password" rules={{ required: true, minLength: 8 }} render={({ field }) => (
          <Field value={field.value} set={field.onChange} placeholder={en ? "Password" : "Kata sandi"} secure />
        )} />}
        {error && <Text style={s.error}>{error}</Text>}
        <Pressable
          disabled={busy}
          onPress={() => void (forgot ? sendReset() : handleSubmit(submit)())}
          style={[s.primary, busy && s.disabled]}
        >
          <Text style={s.primaryText}>
            {busy
              ? "..."
              : forgot
                ? en ? "Send reset link" : "Kirim tautan pemulihan"
                : mode === "signin"
                ? en
                  ? "Sign in"
                  : "Masuk"
                : en
                  ? "Register"
                  : "Daftar"}
          </Text>
        </Pressable>
        {mode === "signin" && !forgot && <Pressable onPress={() => { setError(null); setForgot(true); }} style={s.forgotLink}>
          <Text style={s.forgotText}>{en ? "Forgot password?" : "Lupa kata sandi?"}</Text>
        </Pressable>}
        <Pressable
          onPress={() => {
            setError(null);
            if (forgot) setForgot(false);
            else setMode(mode === "signin" ? "signup" : "signin");
          }}
          style={s.link}
        >
          <Text style={s.linkText}>
            {forgot
              ? en ? "Back to sign in" : "Kembali ke halaman masuk"
              : mode === "signin"
              ? en
                ? "Create a new account"
                : "Buat akun baru"
              : en
                ? "Already have an account"
                : "Sudah punya akun"}
          </Text>
        </Pressable>
        <Language />
      </ScrollView>
    </SafeAreaView>
  );
}

function PasswordRecovery() {
  const auth = useAuth();
  const en = i18n.language === "en";
  const [password, setPassword] = React.useState("");
  const [confirmation, setConfirmation] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    setError(null);
    if (password !== confirmation) {
      setError(en ? "Passwords do not match." : "Kata sandi tidak sama.");
      return;
    }
    setBusy(true);
    const result = await auth.updateRecoveredPassword(password);
    setBusy(false);
    if (result) setError(result);
    else Alert.alert(en ? "Password updated" : "Kata sandi diperbarui", en ? "Sign in using your new password." : "Silakan masuk memakai kata sandi baru.");
  };
  return <SafeAreaView style={s.page}><ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
    <Brand />
    <Text style={s.title}>{en ? "Create a new password" : "Buat kata sandi baru"}</Text>
    <Text style={s.subtitle}>{en ? "Use at least 8 characters and do not reuse an old password." : "Gunakan minimal 8 karakter dan jangan gunakan kembali kata sandi lama."}</Text>
    <Field value={password} set={setPassword} placeholder={en ? "New password" : "Kata sandi baru"} secure />
    <Field value={confirmation} set={setConfirmation} placeholder={en ? "Repeat new password" : "Ulangi kata sandi baru"} secure />
    {error && <Text style={s.error}>{error}</Text>}
    <Pressable disabled={busy} onPress={() => void submit()} style={[s.primary,busy&&s.disabled]}><Text style={s.primaryText}>{busy ? "..." : en ? "Save new password" : "Simpan kata sandi baru"}</Text></Pressable>
    <Pressable onPress={() => void auth.cancelPasswordRecovery()} style={s.link}><Text style={s.linkText}>{en ? "Cancel" : "Batal"}</Text></Pressable>
  </ScrollView></SafeAreaView>;
}

function Onboarding() {
  const auth = useAuth();
  const en = i18n.language === "en";
  const [owner, setOwner] = React.useState("");
  const [tenant, setTenant] = React.useState("");
  const [business, setBusiness] = React.useState("");
  const [branch, setBranch] = React.useState("Cabang Utama");
  const [code, setCode] = React.useState("UTAMA");
  const [modules, setModules] = React.useState<string[]>(["retail"]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    if ([owner, tenant, business, branch].some((x) => x.trim().length < 2)) {
      setError(
        en ? "Complete all required fields." : "Lengkapi semua data wajib.",
      );
      return;
    }
    setBusy(true);
    const result = await auth.completeOnboarding({
      displayName: owner,
      tenantName: tenant,
      tenantSlug: slugifyTenantName(tenant),
      businessName: business,
      modules,
      branchName: branch,
      branchCode: normalizeBranchCode(code),
      language: en ? "en" : "id",
    });
    setBusy(false);
    setError(result);
  };
  return (
    <SafeAreaView style={s.page}>
      <ScrollView
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
      >
        <Brand />
        <Text style={s.title}>{en ? "Business profile" : "Profil usaha"}</Text>
        <Text style={s.subtitle}>
          {en
            ? "The account may operate while admin verification is pending, except QRIS."
            : "Akun dapat beroperasi selama menunggu verifikasi admin, kecuali QRIS."}
        </Text>
        <Field
          value={owner}
          set={setOwner}
          placeholder={en ? "Owner full name" : "Nama lengkap pemilik"}
        />
        <Field
          value={tenant}
          set={setTenant}
          placeholder={en ? "Organization name" : "Nama organisasi"}
        />
        <Field
          value={business}
          set={setBusiness}
          placeholder={en ? "Business name" : "Nama usaha"}
        />
        <Field
          value={branch}
          set={setBranch}
          placeholder={en ? "First branch" : "Cabang pertama"}
        />
        <Field
          value={code}
          set={setCode}
          placeholder={en ? "Branch code" : "Kode cabang"}
        />
        <Text style={s.label}>{en ? "BUSINESS MODULES" : "MODUL USAHA"}</Text>
        <View style={s.chips}>
          {businessModules.map((item) => {
            const active = modules.includes(item);
            return (
              <Pressable
                key={item}
                style={[s.chip, active && s.chipActive]}
                onPress={() =>
                  setModules((now) =>
                    active
                      ? now.length > 1
                        ? now.filter((x) => x !== item)
                        : now
                      : [...now, item],
                  )
                }
              >
                <Text style={[s.chipText, active && s.chipTextActive]}>
                  {item.replace("_", " ")}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {error && <Text style={s.error}>{error}</Text>}
        <Pressable
          disabled={busy}
          style={[s.primary, busy && s.disabled]}
          onPress={() => void submit()}
        >
          <Text style={s.primaryText}>
            {busy ? "..." : en ? "Create business" : "Buat usaha"}
          </Text>
        </Pressable>
        <Pressable style={s.link} onPress={() => void auth.signOut()}>
          <Text style={s.linkText}>
            {en ? "Use another account" : "Gunakan akun lain"}
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function Brand() {
  return <BrandLockup light />;
}
function Field({
  value,
  set,
  placeholder,
  secure,
}: {
  value: string;
  set: (value: string) => void;
  placeholder: string;
  secure?: boolean;
}) {
  const [visible,setVisible]=React.useState(false);
  return (
    <View style={s.inputWrap}>
      <TextInput
        value={value}
        onChangeText={set}
        placeholder={placeholder}
        secureTextEntry={Boolean(secure&&!visible)}
        autoCapitalize={placeholder.toLowerCase()==="email"||secure?"none":"sentences"}
        autoCorrect={false}
        placeholderTextColor="#8190A4"
        style={[s.input,secure&&s.secureInput]}
      />
      {secure&&<Pressable accessibilityRole="button" accessibilityLabel={visible?"Sembunyikan kata sandi":"Lihat kata sandi"} accessibilityState={{checked:visible}} hitSlop={8} onPress={()=>setVisible((value)=>!value)} style={({pressed})=>[s.passwordToggle,pressed&&s.passwordTogglePressed]}>
        <PasswordVisibilityIcon hidden={visible}/>
      </Pressable>}
    </View>
  );
}
function PasswordVisibilityIcon({hidden}:{hidden:boolean}) {
  return <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" accessibilityElementsHidden>
    <Path d="M2.5 12s3.4-5.2 9.5-5.2 9.5 5.2 9.5 5.2-3.4 5.2-9.5 5.2S2.5 12 2.5 12Z" stroke="#73A7FF" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"/>
    <Circle cx={12} cy={12} r={2.6} stroke="#73A7FF" strokeWidth={1.8}/>
    {hidden&&<Path d="m4 4 16 16" stroke="#73A7FF" strokeWidth={1.8} strokeLinecap="round"/>}
  </Svg>;
}
function Language() {
  const en = i18n.language === "en";
  return (
    <Pressable
      style={s.language}
      onPress={() => void i18n.changeLanguage(en ? "id" : "en")}
    >
      <Text style={s.languageText}>{en ? "Bahasa Indonesia" : "English"}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: "#08172F",
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: { color: "#FFF", fontWeight: "900", marginTop: 14 },
  page: { flex: 1, backgroundColor: "#08172F" },
  content: {
    flexGrow: 1,
    padding: 24,
    paddingTop: 48,
    paddingBottom: 40,
    gap: 12,
  },
  eyebrow: { color: "#73A7FF", fontSize: 10, fontWeight: "900", letterSpacing: 1.2, marginTop: 24 },
  title: { color: "#FFF", fontSize: 30, fontWeight: "900", marginTop: 22 },
  subtitle: { color: "#96A9BF", fontSize: 14, lineHeight: 21, marginBottom: 8 },
  inputWrap:{position:"relative"},
  input: {
    backgroundColor: "#10233D",
    borderWidth: 1,
    borderColor: "#29405D",
    borderRadius: 13,
    paddingHorizontal: 15,
    paddingVertical: 13,
    color: "#FFF",
  },
  secureInput:{paddingRight:56},
  passwordToggle:{position:"absolute",right:6,top:0,bottom:0,width:44,alignItems:"center",justifyContent:"center",borderRadius:12},
  passwordTogglePressed:{backgroundColor:"rgba(115,167,255,.12)"},
  primary: {
    backgroundColor: "#1267F4",
    borderRadius: 13,
    padding: 15,
    alignItems: "center",
    marginTop: 5,
  },
  primaryText: { color: "#FFF", fontWeight: "900" },
  disabled: { opacity: 0.5 },
  link: { padding: 10, alignItems: "center" },
  linkText: { color: "#A8BCD2", fontWeight: "700" },
  forgotLink: { alignSelf: "flex-end", paddingVertical: 4, paddingHorizontal: 2 },
  forgotText: { color: "#73A7FF", fontWeight: "800", fontSize: 13 },
  error: { color: "#FF9B91", fontSize: 12 },
  language: {
    alignSelf: "center",
    borderWidth: 1,
    borderColor: "#405572",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  languageText: { color: "#C5D3E3", fontWeight: "800" },
  label: {
    color: "#9EB0C6",
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 1,
    marginTop: 5,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: "#405572",
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipActive: { backgroundColor: "#1267F4", borderColor: "#1267F4" },
  chipText: { color: "#B9C8DA", textTransform: "capitalize" },
  chipTextActive: { color: "#FFF", fontWeight: "900" },
});
