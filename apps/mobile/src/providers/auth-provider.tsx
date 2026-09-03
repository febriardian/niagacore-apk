import {
  clearTenantContext,
  purgeLocalTenantData,
  saveTenantContext,
  type LocalTenantContext,
} from "@/lib/remote-store";
import * as Crypto from "expo-crypto";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { useRemoteStore } from "@/lib/remote-store";
import { Platform } from "react-native";
import type { Session } from "@supabase/supabase-js";
import type { Role } from "@niagacore/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import { supabase } from "@/lib/supabase";
import { setAppLanguage } from "@/lib/i18n";

const DEVICE_ID_KEY = "niagacore.device-id";
const SELECTED_BRANCH_KEY = "niagacore.selected-branch";
const SELECTED_BUSINESS_KEY = "niagacore.selected-business";

export type BranchOption = { id: string; name: string; code: string };
export type BusinessOption = { id: string; name: string; modules: string[] };

export interface ActiveWorkspace extends LocalTenantContext {
  tenantName: string;
  businessName: string;
  branchName: string;
  branchCode: string;
  modules: string[];
  merchantStatus: "pending" | "approved" | "rejected" | "suspended";
  qrisEnabled: boolean;
  emailVerified: boolean;
  branches: BranchOption[];
  businesses: BusinessOption[];
  isPlatformAdmin: boolean;
}

interface OnboardingInput {
  displayName: string;
  tenantName: string;
  tenantSlug: string;
  businessName: string;
  modules: string[];
  branchName: string;
  branchCode: string;
  language: "id" | "en";
}

interface AuthValue {
  session: Session | null;
  workspace: ActiveWorkspace | null;
  loading: boolean;
  staffActivationPending: boolean;
  signIn(email: string, password: string): Promise<string | null>;
  signUp(
    email: string,
    password: string,
  ): Promise<"signed-in" | "confirm-email" | string>;
  passwordRecovery: boolean;
  requestPasswordReset(email: string): Promise<string | null>;
  updateRecoveredPassword(password: string): Promise<string | null>;
  cancelPasswordRecovery(): Promise<void>;
  signOut(): Promise<void>;
  completeOnboarding(input: OnboardingInput): Promise<string | null>;
  refreshWorkspace(): Promise<void>;
  switchBranch(branchId: string): Promise<string | null>;
  switchBusiness(businessId: string): Promise<string | null>;
  resendVerification(): Promise<string | null>;
  completeStaffActivation(password: string): Promise<string | null>;
}

const AuthContext = createContext<AuthValue | null>(null);

async function getDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = Crypto.randomUUID();
  await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
  return id;
}

function currentDeviceRegistration() {
  const model = Device.modelName || Device.deviceName || "Android";
  return {
    device_label: `${Device.manufacturer || "Android"} ${model}`.trim(),
    device_platform: Platform.OS,
    device_model: model,
    device_os_version: String(Platform.Version),
    device_app_version: Constants.expoConfig?.version || "unknown",
  };
}

export function AuthProvider({ children }: PropsWithChildren) {
  const db = useRemoteStore();
  const [session, setSession] = useState<Session | null>(null);
  const [workspace, setWorkspace] = useState<ActiveWorkspace | null>(null);
  const [loading, setLoading] = useState(Boolean(supabase));
  const [staffActivationPending, setStaffActivationPending] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(false);

  const refreshWorkspace = useCallback(async () => {
    if (!supabase) return;
    const { data: userData } = await supabase.auth.getUser();
    const user = userData.user;
    if (!user) {
      setWorkspace(null);
      return;
    }

    const { data: membership, error: membershipError } = await supabase
      .from("memberships")
      .select("id, tenant_id, role")
      .eq("user_id", user.id)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership) {
      setWorkspace(null);
      return;
    }

    const [{ data: tenant }, { data: businessRows }, { data: verification }, { data: profile }, { data: platformAdmin }] =
      await Promise.all([
        supabase
          .from("tenants")
          .select("name")
          .eq("id", membership.tenant_id)
          .single(),
        supabase
          .from("businesses")
          .select("id, name, modules")
          .eq("tenant_id", membership.tenant_id)
          .order("created_at"),
        supabase
          .from("merchant_verifications")
          .select("status, qris_enabled")
          .eq("tenant_id", membership.tenant_id)
          .maybeSingle(),
        supabase.from("profiles").select("preferred_language").eq("id", user.id).maybeSingle(),
        supabase.from("platform_admins").select("user_id").eq("user_id", user.id).eq("active", true).maybeSingle(),
      ]);
    if (!tenant || !businessRows?.length) throw new Error("workspace_incomplete");
    const tenantWide = ["owner", "business_manager"].includes(membership.role);
    const { data: branchGrants, error: grantError } = tenantWide
      ? { data: null, error: null }
      : await supabase
          .from("membership_branches")
          .select("branch_id")
          .eq("tenant_id", membership.tenant_id)
          .eq("membership_id", membership.id);
    if (grantError) throw grantError;
    let allBranchQuery = supabase
      .from("branches")
      .select("id, name, code, business_id")
      .eq("tenant_id", membership.tenant_id)
      .eq("active", true);
    if (!tenantWide) {
      const ids = (branchGrants ?? []).map((item) => item.branch_id);
      if (ids.length === 0) throw new Error("branch_grant_missing");
      allBranchQuery = allBranchQuery.in("id", ids);
    }
    const { data: allBranches, error: branchError } = await allBranchQuery.order("name");
    if (branchError) throw branchError;
    const accessibleBusinessIds=new Set((allBranches??[]).map(branch=>branch.business_id));
    const businesses=(businessRows??[]).filter(business=>accessibleBusinessIds.has(business.id)).map(business=>({id:business.id,name:business.name,modules:Array.isArray(business.modules)?business.modules:["retail"]}));
    if(!businesses.length)throw new Error("business_access_missing");
    const selectedBusinessId=await SecureStore.getItemAsync(SELECTED_BUSINESS_KEY);
    const business=businesses.find(item=>item.id===selectedBusinessId)??businesses[0]!;
    const branches=(allBranches??[]).filter(branch=>branch.business_id===business.id).map(({id,name,code})=>({id,name,code}));
    const selectedId = await SecureStore.getItemAsync(SELECTED_BRANCH_KEY);
    const branch = branches.find((item) => item.id === selectedId) ?? branches[0];
    if (!branch) throw new Error("branch_missing");

    const deviceId = await getDeviceId();
    const registration = await supabase.rpc("register_current_device_v2", {
      target_device_id: deviceId,
      target_branch_id: branch.id,
      ...currentDeviceRegistration(),
    });
    if (registration.error) {
      if (registration.error.message.includes("device_revoked")) {
        await purgeLocalTenantData(db);
        await SecureStore.deleteItemAsync(SELECTED_BRANCH_KEY);
        await SecureStore.deleteItemAsync("niagacore.device-pin-enabled");
        setWorkspace(null);
        await supabase.auth.signOut({scope:"local"});
      }
      throw registration.error;
    }
    const local: LocalTenantContext = {
      tenantId: membership.tenant_id,
      businessId: business.id,
      branchId: branch.id,
      deviceId,
      userId: user.id,
      role: membership.role as Role,
    };
    await saveTenantContext(db, local);
    if (profile?.preferred_language === "id" || profile?.preferred_language === "en") {
      await setAppLanguage(profile.preferred_language);
    }
    setWorkspace({
      ...local,
      tenantName: tenant.name,
      businessName: business.name,
      branchName: branch.name,
      branchCode: branch.code,
      modules: Array.isArray(business.modules) ? business.modules : ["retail"],
      merchantStatus: verification?.status ?? "pending",
      qrisEnabled: verification?.qris_enabled === true,
      emailVerified: Boolean(user.email_confirmed_at),
      branches: branches ?? [],
      businesses,
      isPlatformAdmin: platformAdmin?.user_id === user.id,
    });
  }, [db]);

  useEffect(() => {
    if (!supabase) {
      return;
    }
    const backend = supabase;

    void backend.auth
      .getSession()
      .then(async ({ data }) => {
        setSession(data.session);
        if (data.session) {
          await refreshWorkspace();
          if (data.session.user.user_metadata?.staff_invitation_id)
            setStaffActivationPending(true);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));

    const { data: listener } = backend.auth.onAuthStateChange(
      (event, nextSession) => {
        setSession(nextSession);
        if (!nextSession) setWorkspace(null);
        if (event === "PASSWORD_RECOVERY") setPasswordRecovery(true);
      },
    );
    const handleAuthUrl = async (url: string | null) => {
      if (!url) return;
      const query = url.includes("?") ? url.split("?")[1] : "";
      const fragment = url.includes("#") ? url.split("#")[1] : "";
      const params = new URLSearchParams(`${query}&${fragment}`);
      const code = params.get("code");
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");
      const type = params.get("type");
      if (code) await backend.auth.exchangeCodeForSession(code);
      else if (accessToken && refreshToken)
        await backend.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
      else return;
      const { data } = await backend.auth.getSession();
      setSession(data.session);
      if (type === "recovery") setPasswordRecovery(true);
      if (type === "invite" || data.session?.user.user_metadata?.staff_invitation_id)
        setStaffActivationPending(true);
    };
    void Linking.getInitialURL().then(handleAuthUrl);
    const linkListener = Linking.addEventListener("url", ({ url }) => {
      void handleAuthUrl(url);
    });
    return () => {
      listener.subscription.unsubscribe();
      linkListener.remove();
    };
  }, [db, refreshWorkspace]);

  const value = useMemo<AuthValue>(
    () => ({
      session,
      workspace,
      loading,
      staffActivationPending,
      passwordRecovery,
      signIn: async (email, password) => {
        if (!supabase) return "backend_not_configured";
        setLoading(true);
        const { data, error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) { setLoading(false); return error.message; }
        if (!data.user.email_confirmed_at) {
          await supabase.auth.signOut({scope:"local"});
          setLoading(false);
          return "email_not_verified";
        }
        const invitation = await supabase.rpc("accept_staff_invitation");
        if (invitation.error && !invitation.error.message.includes("invitation_not_found")) {
          await supabase.auth.signOut({scope:"local"});
          setLoading(false);
          return invitation.error.message;
        }
        try {
          await refreshWorkspace();
          setSession(data.session);
          setLoading(false);
          return null;
        } catch (refreshError) {
          await supabase.auth.signOut({scope:"local"});
          setSession(null);
          setWorkspace(null);
          setLoading(false);
          return refreshError instanceof Error ? refreshError.message : String(refreshError);
        }
      },
      signUp: async (email, password) => {
        if (!supabase) return "backend_not_configured";
        setLoading(true);
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        });
        if (error) { setLoading(false); return error.message; }
        if (!data.session) { setLoading(false); return "confirm-email"; }
        try {
          await refreshWorkspace();
          setSession(data.session);
          setLoading(false);
          return "signed-in";
        } catch(refreshError) {
          setLoading(false);
          return refreshError instanceof Error?refreshError.message:String(refreshError);
        }
      },
      requestPasswordReset: async (email) => {
        if (!supabase) return "backend_not_configured";
        if (!email.trim().includes("@")) return "Gunakan alamat email yang valid.";
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: Linking.createURL("auth/reset"),
        });
        return error?.message ?? null;
      },
      updateRecoveredPassword: async (password) => {
        if (!supabase) return "backend_not_configured";
        if (password.length < 8) return "Gunakan minimal 8 karakter.";
        const { error } = await supabase.auth.updateUser({ password });
        if (error) return error.message;
        setPasswordRecovery(false);
        await supabase.auth.signOut();
        setSession(null);
        setWorkspace(null);
        return null;
      },
      cancelPasswordRecovery: async () => {
        setPasswordRecovery(false);
        if (supabase) await supabase.auth.signOut({scope:"local"});
        setSession(null);
        setWorkspace(null);
      },
      signOut: async () => {
        setLoading(true);
        try {
          await clearTenantContext(db);
          setStaffActivationPending(false);
          if (supabase) await supabase.auth.signOut({scope:"local"});
        } finally {
          setSession(null);
          setWorkspace(null);
          setLoading(false);
        }
      },
      completeOnboarding: async (input) => {
        if (!supabase) return "backend_not_configured";
        const deviceId = await getDeviceId();
        const { error } = await supabase.rpc("bootstrap_owner", {
          display_name: input.displayName.trim(),
          tenant_name: input.tenantName.trim(),
          tenant_slug: input.tenantSlug,
          business_name: input.businessName.trim(),
          enabled_modules: input.modules,
          branch_name: input.branchName.trim(),
          branch_code: input.branchCode,
          device_id: deviceId,
          device_label: "Android utama",
          preferred_language: input.language,
        });
        if (error) return error.message;
        try {
          await refreshWorkspace();
          return null;
        } catch (refreshError) {
          return refreshError instanceof Error ? refreshError.message : String(refreshError);
        }
      },
      refreshWorkspace,
      switchBranch: async (branchId) => {
        if (!workspace) return "workspace_not_ready";
        const branch = workspace.branches.find((item) => item.id === branchId);
        if (!branch) return "branch_access_denied";
        if (supabase) {
          const { error } = await supabase.rpc("register_current_device_v2", {
            target_device_id: workspace.deviceId,
            target_branch_id: branch.id,
            ...currentDeviceRegistration(),
          });
          if (error) return error.message;
        }
        await SecureStore.setItemAsync(SELECTED_BRANCH_KEY, branch.id);
        const next = {
          ...workspace,
          branchId: branch.id,
          branchName: branch.name,
          branchCode: branch.code,
        };
        await saveTenantContext(db, next);
        setWorkspace(next);
        return null;
      },
      switchBusiness: async (businessId) => {
        if(!workspace)return "workspace_not_ready";
        if(!["owner","business_manager"].includes(workspace.role))return "business_access_denied";
        await SecureStore.setItemAsync(SELECTED_BUSINESS_KEY,businessId);
        await SecureStore.deleteItemAsync(SELECTED_BRANCH_KEY);
        try{await refreshWorkspace();return null}catch(error){return error instanceof Error?error.message:String(error)}
      },
      resendVerification: async () => {
        if (!supabase || !session?.user.email) return "backend_not_configured";
        const { error } = await supabase.auth.resend({
          type: "signup",
          email: session.user.email,
        });
        return error?.message ?? null;
      },
      completeStaffActivation: async (password) => {
        if (!supabase) return "backend_not_configured";
        if (password.length < 8) return "Gunakan minimal 8 karakter.";
        const { error: passwordError } = await supabase.auth.updateUser({
          password,
          data: { staff_invitation_id: null },
        });
        if (passwordError) return passwordError.message;
        const { error: invitationError } = await supabase.rpc(
          "accept_staff_invitation",
        );
        if (invitationError) return invitationError.message;
        setStaffActivationPending(false);
        await refreshWorkspace();
        return null;
      },
    }),
    [db, loading, passwordRecovery, refreshWorkspace, session, staffActivationPending, workspace],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
