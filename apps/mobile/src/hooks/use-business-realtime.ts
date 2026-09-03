import React from "react";
import {AppState} from "react-native";

import {supabase} from "@/lib/supabase";
import type {ActiveWorkspace} from "@/providers/auth-provider";

const tables=["sales","payments","inventory_movements","subledger_documents","shifts","sale_drafts"] as const;

export function useBusinessRealtime(workspace:ActiveWorkspace,onRefresh:()=>void|Promise<void>,fallbackMs=30_000){
  React.useEffect(()=>{
    let timer:ReturnType<typeof setTimeout>|null=null;
    const refresh=()=>{if(timer)clearTimeout(timer);timer=setTimeout(()=>void onRefresh(),250)};
    const interval=setInterval(refresh,fallbackMs);
    const appState=AppState.addEventListener("change",state=>{if(state==="active")refresh()});
    const backend=supabase;
    if(!backend)return()=>{clearInterval(interval);appState.remove();if(timer)clearTimeout(timer)};
    let channel=backend.channel(`business:${workspace.tenantId}:${workspace.businessId}:${workspace.branchId}:${Math.random().toString(36).slice(2)}`);
    for(const table of tables)channel=channel.on("postgres_changes",{event:"*",schema:"public",table,filter:`tenant_id=eq.${workspace.tenantId}`},refresh);
    channel.subscribe();
    return()=>{clearInterval(interval);appState.remove();if(timer)clearTimeout(timer);void backend.removeChannel(channel)};
  },[fallbackMs,onRefresh,workspace.branchId,workspace.businessId,workspace.tenantId]);
}
