import TextRecognition from "@react-native-ml-kit/text-recognition";
import { CameraView, useCameraPermissions } from "expo-camera";
import React from "react";
import { StyleSheet, View } from "react-native";

import { Button, Sheet } from "@/ui/components";
import { LocalizedText as Text, localizedAlert } from "@/ui/localized-text";
import { colors, radius } from "@/ui/theme";

export type ReceiptOcrResult = {
  rawText: string;
  amountMinor?: number;
  date?: string;
  reference?: string;
};

function parseReceipt(text: string): ReceiptOcrResult {
  const amounts = [...text.matchAll(/(?:rp\s*)?([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]{4,})(?:[.,]00)?/gi)]
    .map((match) => Number((match[1] ?? "").replace(/[.,]/g, "")))
    .filter((value) => Number.isFinite(value) && value > 0);
  const iso = text.match(/\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
  const local = text.match(/\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](20\d{2})\b/);
  const reference = text.match(/(?:invoice|faktur|nota|no\.?|ref(?:erence)?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_-]{3,})/i)?.[1];
  const isoYear = iso?.[1], isoMonth = iso?.[2], isoDay = iso?.[3];
  const localDay = local?.[1], localMonth = local?.[2], localYear = local?.[3];
  return {
    rawText: text.trim(),
    amountMinor: amounts.length ? Math.max(...amounts) : undefined,
    date: isoYear && isoMonth && isoDay ? `${isoYear}-${isoMonth.padStart(2, "0")}-${isoDay.padStart(2, "0")}` : localYear && localMonth && localDay ? `${localYear}-${localMonth.padStart(2, "0")}-${localDay.padStart(2, "0")}` : undefined,
    reference,
  };
}

export function ReceiptOcrSheet({
  visible,
  onClose,
  onApply,
}: {
  visible: boolean;
  onClose: () => void;
  onApply: (result: ReceiptOcrResult) => void;
}) {
  const camera = React.useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<ReceiptOcrResult | null>(null);
  const capture = async () => {
    try {
      setBusy(true);
      const image = await camera.current?.takePictureAsync({ quality: 0.82, skipProcessing: false });
      if (!image?.uri) throw new Error("Foto tidak tersedia.");
      const recognized = await TextRecognition.recognize(image.uri);
      if (!recognized.text.trim()) throw new Error("Teks tidak terdeteksi. Coba pencahayaan yang lebih terang.");
      setResult(parseReceipt(recognized.text));
    } catch (error) {
      localizedAlert("OCR gagal", error instanceof Error ? error.message : "Dokumen tidak dapat dibaca.");
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setResult(null);
    onClose();
  };
  return (
    <Sheet visible={visible} title="Pindai nota / invoice" onClose={close}>
      {!permission ? (
        <Text style={s.note}>Memeriksa izin kamera...</Text>
      ) : !permission.granted ? (
        <View style={s.permission}>
          <Text style={s.note}>OCR berjalan langsung di perangkat. Foto dokumen tidak dikirim ke AI cloud.</Text>
          <Button title="Izinkan kamera" onPress={() => void requestPermission()} />
        </View>
      ) : result ? (
        <View style={s.result}>
          <Text style={s.title}>Hasil pembacaan</Text>
          <Text style={s.summary}>Nominal: {result.amountMinor ?? "—"} • Tanggal: {result.date ?? "—"} • Referensi: {result.reference ?? "—"}</Text>
          <View style={s.raw}><Text numberOfLines={12} style={s.rawText}>{result.rawText}</Text></View>
          <Button title="Gunakan hasil" onPress={() => { onApply(result); close(); }} />
          <Button variant="outline" title="Foto ulang" onPress={() => setResult(null)} />
        </View>
      ) : (
        <>
          <View style={s.cameraFrame}><CameraView ref={camera} active={visible} facing="back" style={StyleSheet.absoluteFill} /></View>
          <Text style={s.note}>Letakkan nota rata, pastikan tulisan memenuhi bingkai dan tidak terkena pantulan cahaya.</Text>
          <Button disabled={busy} title={busy ? "Membaca dokumen..." : "Ambil foto & baca"} onPress={() => void capture()} />
        </>
      )}
    </Sheet>
  );
}

const s = StyleSheet.create({
  cameraFrame: { height: 350, overflow: "hidden", borderRadius: radius.lg, backgroundColor: colors.navy },
  permission: { gap: 12 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  result: { gap: 12 },
  title: { color: colors.ink, fontSize: 17, fontWeight: "900" },
  summary: { color: colors.navy, fontSize: 12, fontWeight: "800", lineHeight: 18 },
  raw: { backgroundColor: "#F4F6F8", borderRadius: radius.md, padding: 12 },
  rawText: { color: colors.muted, fontSize: 11, lineHeight: 17 },
});
