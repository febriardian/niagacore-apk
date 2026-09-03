import React from "react";
import { Image, StyleSheet, View, type ViewStyle } from "react-native";

import { LocalizedText as Text } from "./localized-text";
import { colors } from "./theme";

export function BrandSymbol({ size = 38, style }: { size?: number; style?: ViewStyle }) {
  return (
    <View style={[s.symbolWrap, { width: size, height: size, borderRadius: Math.round(size * 0.29) }, style]}>
      <Image
        accessibilityLabel="Logo NiagaCore"
        resizeMode="cover"
        source={require("../../assets/images/niagacore-symbol.png")}
        style={{ width: size, height: size }}
      />
    </View>
  );
}

export function BrandLockup({ light = false }: { light?: boolean }) {
  return (
    <View style={s.lockup}>
      <BrandSymbol size={48} />
      <View>
        <Text style={[s.name, light && s.light]}>NiagaCore</Text>
        <Text style={[s.tagline, light && s.taglineLight]}>POS · Accounting · AI</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  symbolWrap: { overflow: "hidden", backgroundColor: colors.white },
  lockup: { flexDirection: "row", alignItems: "center", gap: 12 },
  name: { color: colors.ink, fontSize: 23, fontWeight: "900", letterSpacing: -0.6 },
  light: { color: colors.white },
  tagline: { color: colors.muted, fontSize: 9, fontWeight: "800", letterSpacing: 1.1, marginTop: 2 },
  taglineLight: { color: "#AFC4E7" },
});
