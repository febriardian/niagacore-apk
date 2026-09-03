import { CameraView, useCameraPermissions } from "expo-camera";
import React from "react";
import { StyleSheet, View } from "react-native";

import { Button, Sheet } from "@/ui/components";
import { colors, radius } from "@/ui/theme";
import { LocalizedText as Text } from "@/ui/localized-text";

export function BarcodeScannerSheet({
  visible,
  title = "Pindai barcode",
  onClose,
  onScanned,
}: {
  visible: boolean;
  title?: string;
  onClose: () => void;
  onScanned: (value: string) => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [locked, setLocked] = React.useState(false);

  return (
    <Sheet
      visible={visible}
      title={title}
      onClose={() => {
        setLocked(false);
        onClose();
      }}
    >
      {!permission ? (
        <Text style={s.note}>Memeriksa izin kamera...</Text>
      ) : !permission.granted ? (
        <View style={s.permission}>
          <Text style={s.note}>
            Kamera hanya dipakai saat layar pemindai terbuka untuk membaca kode
            produk.
          </Text>
          <Button title="Izinkan kamera" onPress={() => void requestPermission()} />
        </View>
      ) : (
        <>
          <View style={s.cameraFrame}>
            <CameraView
              active={visible}
              facing="back"
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{
                barcodeTypes: [
                  "ean13",
                  "ean8",
                  "upc_a",
                  "upc_e",
                  "code128",
                  "code39",
                  "itf14",
                  "qr",
                ],
              }}
              onBarcodeScanned={
                locked
                  ? undefined
                  : ({ data }) => {
                      const value = data.trim();
                      if (!value) return;
                      setLocked(true);
                      onScanned(value);
                      setTimeout(() => setLocked(false), 300);
                    }
              }
            />
            <View pointerEvents="none" style={s.target} />
          </View>
          <Text style={s.note}>
            Arahkan garis kode ke bingkai. Hasil dibaca di perangkat dan tidak
            mengunggah gambar kamera.
          </Text>
          {locked && (
            <Button
              variant="outline"
              title="Pindai ulang"
              onPress={() => setLocked(false)}
            />
          )}
        </>
      )}
    </Sheet>
  );
}

const s = StyleSheet.create({
  permission: { gap: 12 },
  cameraFrame: {
    height: 330,
    overflow: "hidden",
    borderRadius: radius.lg,
    backgroundColor: colors.navy,
  },
  target: {
    position: "absolute",
    left: 30,
    right: 30,
    top: 105,
    height: 120,
    borderRadius: radius.md,
    borderWidth: 3,
    borderColor: colors.orange,
  },
  note: { color: colors.muted, fontSize: 12, lineHeight: 18 },
});
