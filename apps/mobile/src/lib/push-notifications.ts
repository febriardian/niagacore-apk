import Constants from "expo-constants";
import * as Device from "expo-device";
import {Platform} from "react-native";

import {supabase} from "@/lib/supabase";
import type {ActiveWorkspace} from "@/providers/auth-provider";

export type PushRegistrationResult={status:"enabled"|"denied"|"unsupported";detail:string};
export type PushPermissionStatus="granted"|"denied"|"undetermined"|"unavailable";
type NotificationsModule=typeof import("expo-notifications");
let handlerConfigured=false;

function isExpoGo(){return Constants.appOwnership==="expo"}
async function loadNotifications():Promise<NotificationsModule|null>{
  if(isExpoGo())return null;
  try{
    const notifications=await import("expo-notifications");
    if(!handlerConfigured){
      notifications.setNotificationHandler({handleNotification:async()=>({shouldShowBanner:true,shouldShowList:true,shouldPlaySound:true,shouldSetBadge:false})});
      handlerConfigured=true;
    }
    return notifications;
  }catch{return null}
}

export async function getPushPermissionStatus():Promise<PushPermissionStatus>{
  const notifications=await loadNotifications();
  return notifications?(await notifications.getPermissionsAsync()).status:"unavailable";
}
export async function registerPushNotifications(workspace:ActiveWorkspace,requestPermission=true):Promise<PushRegistrationResult>{
  if(!supabase||!Device.isDevice)return{status:"unsupported",detail:"Notifikasi push memerlukan APK pada perangkat fisik."};
  const notifications=await loadNotifications();
  if(!notifications)return{status:"unsupported",detail:isExpoGo()?"Push notification tidak tersedia di Expo Go. Gunakan development build atau APK NiagaCore.":"Modul notifikasi belum tersedia pada build ini."};
  if(Platform.OS==="android")await notifications.setNotificationChannelAsync("operasional",{name:"Operasional usaha",importance:notifications.AndroidImportance.HIGH,vibrationPattern:[0,250,180,250],sound:"default"});
  let permission=await notifications.getPermissionsAsync();
  if(permission.status!=="granted"&&requestPermission)permission=await notifications.requestPermissionsAsync();
  if(permission.status!=="granted")return{status:"denied",detail:"Izin notifikasi belum diberikan pada perangkat ini."};
  const projectId=Constants.expoConfig?.extra?.eas?.projectId??Constants.easConfig?.projectId;
  if(!projectId)return{status:"unsupported",detail:"Project ID notifikasi belum tersedia pada build ini."};
  const token=(await notifications.getExpoPushTokenAsync({projectId})).data;
  const{error}=await supabase.rpc("register_push_token",{target_device_id:workspace.deviceId,target_token:token,target_platform:Platform.OS});
  if(error)throw new Error(error.message);
  return{status:"enabled",detail:"Peringatan operasional akan dikirim ke perangkat ini."};
}
