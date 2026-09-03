import React from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, radius } from "./theme";
import { LocalizedText as Text, translateUi } from "./localized-text";
import { useAppTheme } from "@/providers/theme-provider";

export function Screen({
  children,
  scroll = true,
  style,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  style?: ViewStyle;
}) {
  const theme=useAppTheme();
  const insets=useSafeAreaInsets();
  const safeBottom={paddingBottom:80+insets.bottom};
  if (!scroll) return <View style={[s.screen,{backgroundColor:theme.colors.cream},safeBottom,style]}>{children}</View>;
  return (
    <ScrollView
      contentContainerStyle={[s.screen,{backgroundColor:theme.colors.cream},safeBottom,style]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}
export function Header({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  const theme=useAppTheme();
  return (
    <View style={s.header}>
      <View style={s.flex}>
        <Text style={[s.title,{color:theme.colors.ink}]}>{title}</Text>
        {subtitle && <Text style={[s.subtitle,{color:theme.colors.muted}]}>{subtitle}</Text>}
      </View>
      {right}
    </View>
  );
}
export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  const theme=useAppTheme();
  return <View style={[s.card,{backgroundColor:theme.colors.surface,borderColor:theme.colors.line,shadowColor:theme.colors.shadow},style]}>{children}</View>;
}
export function Badge({
  text,
  tone = "blue",
}: {
  text: string;
  tone?: "blue" | "green" | "amber" | "red" | "neutral";
}) {
  const theme=useAppTheme();
  const map = {
    blue: [theme.colors.blueSoft, theme.colors.blue],
    green: [theme.colors.greenSoft, theme.colors.green],
    amber: [theme.colors.amberSoft, theme.colors.amber],
    red: [theme.colors.redSoft, theme.colors.red],
    neutral: [theme.resolvedMode==="dark"?theme.colors.blueSoft:"#EEF1F5", theme.colors.muted],
  } as const;
  return (
    <View style={[s.badge, { backgroundColor: map[tone][0] }]}>
      <Text style={[s.badgeText, { color: map[tone][1] }]}>{text}</Text>
    </View>
  );
}
export function Button({
  title,
  onPress,
  variant = "primary",
  disabled = false,
  compact = false,
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "outline" | "danger" | "ghost";
  disabled?: boolean;
  compact?: boolean;
}) {
  const theme=useAppTheme();
  const backgrounds={primary:theme.colors.blue,secondary:theme.colors.navy,outline:theme.colors.surface,danger:theme.colors.redSoft,ghost:"transparent"};
  const foregrounds={primary:theme.colors.white,secondary:theme.resolvedMode==="dark"?theme.colors.cream:theme.colors.white,outline:theme.colors.navy,danger:theme.colors.red,ghost:theme.colors.blue};
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        s[`button_${variant}`],
        {backgroundColor:backgrounds[variant]},
        variant==="outline"&&{borderColor:theme.colors.line},
        compact && s.compact,
        (disabled || pressed) && s.dim,
      ]}
    >
      <Text style={[s.buttonText, s[`buttonText_${variant}`],{color:foregrounds[variant]}]}>{title}</Text>
    </Pressable>
  );
}
export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = "default",
  multiline = false,
  secureTextEntry = false,
}: {
  label?: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "numeric" | "email-address" | "phone-pad";
  multiline?: boolean;
  secureTextEntry?: boolean;
}) {
  const theme=useAppTheme();
  return (
    <View style={s.fieldWrap}>
      {label && <Text style={[s.label,{color:theme.colors.muted}]}>{label}</Text>}
      <TextInput
        accessibilityLabel={label ?? placeholder}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ? translateUi(placeholder) : undefined}
        placeholderTextColor={theme.colors.muted}
        keyboardType={keyboardType}
        multiline={multiline}
        secureTextEntry={secureTextEntry}
        style={[s.input,{backgroundColor:theme.colors.surface,borderColor:theme.colors.line,color:theme.colors.ink}, multiline && s.multiline]}
      />
    </View>
  );
}
export function EmptyState({
  title,
  detail,
  action,
  embedded = false,
}: {
  title: string;
  detail: string;
  action?: React.ReactNode;
  embedded?: boolean;
}) {
  const theme=useAppTheme();
  const content = (
    <>
      <View style={[s.emptyIcon,{backgroundColor:theme.colors.blueSoft}]}>
        <Text style={s.emptyIconText}>◇</Text>
      </View>
      <Text style={s.emptyTitle}>{title}</Text>
      <Text style={s.emptyDetail}>{detail}</Text>
      {action}
    </>
  );
  return embedded ? <View style={s.empty}>{content}</View> : <Card style={s.empty}>{content}</Card>;
}
export function ProductImage({uri,name,size=52}:{uri?:string|null;name:string;size?:number}) {
  const theme=useAppTheme();
  return uri ? <Image accessibilityLabel={`Foto ${name}`} source={{uri}} resizeMode="cover" style={[s.productImage,{borderColor:theme.colors.line,width:size,height:size,borderRadius:Math.max(12,size*.24)}]}/>
    : <View style={[s.productImagePlaceholder,{backgroundColor:theme.colors.blueSoft,borderColor:theme.colors.line,width:size,height:size,borderRadius:Math.max(12,size*.24)}]}><Text style={[s.productImageInitial,{color:theme.colors.blue,fontSize:Math.max(15,size*.34)}]}>{name.trim().slice(0,1).toUpperCase()||"N"}</Text></View>;
}
export function Row({
  title,
  detail,
  left,
  right,
  onPress,
  accent,
}: {
  title: string;
  detail?: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  onPress?: () => void;
  accent?: string;
}) {
  const theme=useAppTheme();
  const body = (
    <View
      style={[
        s.row,
        {backgroundColor:theme.colors.surface,borderColor:theme.colors.line},
        accent ? { borderLeftColor: accent, borderLeftWidth: 4 } : null,
      ]}
    >
      {left}
      <View style={s.flex}>
        <Text style={s.rowTitle}>{title}</Text>
        {detail && (
          <Text numberOfLines={2} style={s.rowDetail}>
            {detail}
          </Text>
        )}
      </View>
      {right ?? (onPress ? <Text style={s.chevron}>›</Text> : null)}
    </View>
  );
  return onPress ? <Pressable onPress={onPress}>{body}</Pressable> : body;
}
export function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const theme=useAppTheme();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <SafeAreaView style={s.shade}>
        <Pressable style={s.dismiss} onPress={onClose} />
        <View style={[s.sheet,{backgroundColor:theme.colors.cream}]}>
          <View style={[s.grabber,{backgroundColor:theme.colors.line}]} />
          <View style={s.sheetHeader}>
            <Text numberOfLines={2} style={s.sheetTitle}>{title}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Tutup" hitSlop={10} onPress={onClose} style={[s.closeButton,{backgroundColor:theme.colors.blueSoft}]}>
              <Text style={s.closeIcon}>×</Text>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={s.sheetBody}
          >
            {children}
          </ScrollView>
        </View>
      </SafeAreaView>
    </Modal>
  );
}
export function LoadingBlock({ label = "Memuat..." }: { label?: string }) {
  const theme=useAppTheme();
  return (
    <View style={s.loading}>
      <ActivityIndicator color={theme.colors.orange} />
      <Text style={s.loadingText}>{label}</Text>
    </View>
  );
}
export function Segmented<T extends string>({
  value,
  items,
  onChange,
}: {
  value: T;
  items: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const theme=useAppTheme();
  return (
    <View style={[s.segment,{backgroundColor:theme.resolvedMode==="dark"?theme.colors.cream:"#EDEFF2"}]}>
      {items.map((item) => (
        <Pressable
          key={item.value}
          onPress={() => onChange(item.value)}
          style={[s.segmentItem, value === item.value && s.segmentActive,value===item.value&&{backgroundColor:theme.colors.surface}]}
        >
          <Text
            style={[s.segmentText, value === item.value && s.segmentActiveText]}
          >
            {item.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
export function ProgressBar({
  value,
  color,
}: {
  value: number;
  color?: string;
}) {
  const theme=useAppTheme();
  return (
    <View style={[s.track,{backgroundColor:theme.colors.line}]}>
      <View
        style={[
          s.fill,
          {
            width: `${Math.max(2, Math.min(100, value))}%`,
            backgroundColor: color??theme.colors.blue,
          },
        ]}
      />
    </View>
  );
}

const s = StyleSheet.create({
  screen: {
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 80,
    gap: 12,
    backgroundColor: colors.cream,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  flex: { flex: 1 },
  title: {
    fontSize: 20,
    fontWeight: "900",
    color: colors.ink,
    letterSpacing: -0.6,
  },
  subtitle: { fontSize: 11, color: colors.muted, marginTop: 2, lineHeight: 15 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.line,
    shadowColor: colors.shadow,
    shadowOpacity: 0.04,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  badge: {
    alignSelf: "flex-start",
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  button: {
    minHeight: 40,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  compact: { minHeight: 32, paddingVertical: 6, paddingHorizontal: 10 },
  dim: { opacity: 0.55 },
  button_primary: { backgroundColor: colors.blue },
  button_secondary: { backgroundColor: colors.navy },
  button_outline: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  button_danger: { backgroundColor: colors.redSoft },
  button_ghost: { backgroundColor: "transparent" },
  buttonText: { fontWeight: "900", fontSize: 13 },
  buttonText_primary: { color: colors.white },
  buttonText_secondary: { color: colors.white },
  buttonText_outline: { color: colors.navy },
  buttonText_danger: { color: colors.red },
  buttonText_ghost: { color: colors.blue },
  fieldWrap: { gap: 7 },
  label: {
    fontSize: 10,
    fontWeight: "900",
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  input: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    paddingHorizontal: 15,
    paddingVertical: 8,
    color: colors.ink,
    fontSize: 13,
  },
  multiline: { minHeight: 64, textAlignVertical: "top" },
  empty: { alignItems: "center", paddingVertical: 22 },
  emptyIcon: {
    width: 48,
    height: 48,
    borderRadius: 18,
    backgroundColor: colors.blueSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyIconText: { fontSize: 23, color: colors.blue, fontWeight: "900" },
  emptyTitle: {
    fontSize: 16,
    color: colors.ink,
    fontWeight: "900",
    marginTop: 12,
  },
  emptyDetail: {
    fontSize: 13,
    color: colors.muted,
    textAlign: "center",
    lineHeight: 19,
    marginVertical: 6,
  },
  productImage:{backgroundColor:colors.blueSoft,borderWidth:1,borderColor:colors.line},
  productImagePlaceholder:{backgroundColor:colors.blueSoft,borderWidth:1,borderColor:"#D6E5FF",alignItems:"center",justifyContent:"center"},
  productImageInitial:{color:colors.blue,fontWeight:"900"},
  row: {
    minHeight: 54,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowTitle: { fontSize: 13, fontWeight: "900", color: colors.ink },
  rowDetail: {
    fontSize: 11,
    color: colors.muted,
    marginTop: 4,
    lineHeight: 15,
  },
  chevron: { fontSize: 28, color: "#AAB4C2" },
  shade: {
    flex: 1,
    backgroundColor: "rgba(8,18,32,.45)",
    justifyContent: "flex-end",
  },
  dismiss: { flex: 1 },
  sheet: {
    maxHeight: "92%",
    backgroundColor: colors.cream,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 14,
    paddingTop: 12,
  },
  grabber: {
    width: 44,
    height: 5,
    borderRadius: 4,
    backgroundColor: "#CCD3DC",
    alignSelf: "center",
    marginBottom: 10,
  },
  sheetHeader: { minHeight: 48, flexDirection: "row", alignItems: "flex-start", gap: 12, paddingBottom: 10 },
  sheetTitle: { flex: 1, color: colors.ink, fontSize: 19, lineHeight: 24, fontWeight: "900", letterSpacing: -0.3 },
  closeButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  closeIcon: { color: colors.blue, fontSize: 25, lineHeight: 27, fontWeight: "600" },
  sheetBody: { gap: 11, paddingBottom: 28 },
  loading: { padding: 30, alignItems: "center", gap: 10 },
  loadingText: { color: colors.muted, fontWeight: "700" },
  segment: {
    flexDirection: "row",
    backgroundColor: "#EDEFF2",
    padding: 4,
    borderRadius: radius.md,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: 9,
    alignItems: "center",
    borderRadius: 12,
  },
  segmentActive: { backgroundColor: colors.surface },
  segmentText: { fontSize: 12, fontWeight: "800", color: colors.muted },
  segmentActiveText: { color: colors.ink },
  track: {
    height: 7,
    borderRadius: 7,
    backgroundColor: "#EEF1F4",
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: 7 },
});
