import * as Print from "expo-print";
import React from "react";
import { StyleSheet, TextInput, View } from "react-native";

import { BarcodeScannerSheet } from "@/ui/barcode-scanner-sheet";
import { Badge, Button, Card, Header, Row, Screen } from "@/ui/components";
import { LocalizedText as Text, localizedAlert } from "@/ui/localized-text";
import { colors } from "@/ui/theme";

export function PeripheralScreen({onBack}:{onBack:()=>void}) {
  const [scanner,setScanner]=React.useState(false),[lastCode,setLastCode]=React.useState(""),[hidCode,setHidCode]=React.useState("");
  const testPrint=async()=>{try{await Print.printAsync({html:"<html><body style='font-family:sans-serif;text-align:center;padding:24px'><h2>NiagaCore</h2><p>TES PRINTER</p><p>Jika kertas ini tercetak, koneksi melalui Android Print Service berfungsi.</p><hr/><p>13 Agustus 2026</p></body></html>"})}catch(error){localizedAlert("Tes printer",error instanceof Error?error.message:"Pemilihan printer dibatalkan.")}};
  return <Screen><Header title="Printer & scanner" subtitle="Hubungkan perangkat lalu jalankan tes" right={<Button compact variant="ghost" title="Kembali" onPress={onBack}/>}/>
    <Card><Row title="Printer melalui Android" detail="Aktifkan printer di Pengaturan Android/aplikasi layanan printer, lalu pilih printer dari dialog cetak" right={<Badge text="Didukung aplikasi" tone="green"/>}/><Button title="Pilih printer & cetak tes" onPress={()=>void testPrint()}/><Text style={s.note}>Model printer baru berstatus didukung setelah hasil tes fisik, versi Android, protokol, dan bukti uji dicatat.</Text></Card>
    <Card><Row title="Scanner kamera" detail="EAN-8, EAN-13, UPC, Code 39/128, ITF-14, dan QR" right={<Badge text="Aktif" tone="green"/>}/><Button title="Uji pemindai kamera" onPress={()=>setScanner(true)}/>{lastCode?<Text style={s.result}>Hasil terakhir: {lastCode}</Text>:null}</Card>
    <Card><Row title="Scanner HID eksternal" detail="Hubungkan scanner mode keyboard, fokuskan kolom, lalu pindai kode" right={<Badge text="Perlu uji alat" tone="amber"/>}/><View style={s.hidBox}><TextInput accessibilityLabel="Kolom uji scanner HID" autoFocus={false} value={hidCode} onChangeText={setHidCode} onSubmitEditing={()=>{const value=hidCode.trim();if(value){setLastCode(value);localizedAlert("Scanner HID terbaca",`Kode terbaca: ${value}`);setHidCode("")}}} placeholder="Pindai lalu tekan Enter" placeholderTextColor={colors.muted} style={s.hidInput}/></View></Card>
    <Card><Row title="Printer ESC/POS khusus" detail="Bluetooth, USB, atau LAN memerlukan adapter vendor dan bukti uji fisik per model" right={<Badge text="Eksperimental" tone="amber"/>}/><Row title="Laci kas & timbangan" detail="Belum dinyatakan didukung sampai adapter, kalibrasi, dan pengujian perangkat tersedia" right={<Badge text="Belum didukung" tone="neutral"/>}/></Card>
    <BarcodeScannerSheet visible={scanner} title="Uji scanner kamera" onClose={()=>setScanner(false)} onScanned={value=>{setLastCode(value);setScanner(false);localizedAlert("Scanner berfungsi",`Kode terbaca: ${value}`)}}/>
  </Screen>;
}
const s=StyleSheet.create({result:{fontSize:12,fontWeight:"900",color:colors.blue,marginTop:10},note:{fontSize:11,lineHeight:17,color:colors.muted,marginTop:10},hidBox:{marginTop:10},hidInput:{minHeight:48,borderWidth:1,borderColor:colors.line,borderRadius:12,paddingHorizontal:12,color:colors.ink,backgroundColor:colors.surface}});
