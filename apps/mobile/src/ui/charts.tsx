import React from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Line, Path, Text as SvgText } from "react-native-svg";

import { colors } from "./theme";
import { LocalizedText as Text } from "./localized-text";
import { useAppTheme } from "@/providers/theme-provider";
import { compactTrendSeries } from "@/lib/chart-data";

const compact = (value: number) => {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}M`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}jt`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(0)}rb`;
  return String(Math.round(value));
};

function trendLabel(label:string){
  return label.length===7?`${label.slice(5,7)}/${label.slice(2,4)}`:label.slice(5).replace("-", "/");
}

export function SalesTrendChart({
  data,
  emptyLabel,
}: {
  data: { label: string; amountMinor: number; transactions: number }[];
  emptyLabel: string;
}) {
  const theme=useAppTheme();
  const series=compactTrendSeries(data);
  const hasValue = series.some((item) => item.amountMinor > 0);
  if (!hasValue) return <Text style={s.empty}>{emptyLabel}</Text>;
  const width = 340;
  const height = 184;
  const left = 50;
  const right = 10;
  const top = 14;
  const bottom = 30;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const max = Math.max(...series.map((item) => item.amountMinor), 1);
  const ceiling = Math.ceil(max / 1000) * 1000 || 1;
  const x = (index: number) => left + (index / Math.max(1, series.length - 1)) * plotWidth;
  const y = (value: number) => top + plotHeight - (value / ceiling) * plotHeight;
  const line = series.map((item, index) => `${index ? "L" : "M"}${x(index)},${y(item.amountMinor)}`).join(" ");
  const area = `${line} L${x(series.length - 1)},${top + plotHeight} L${x(0)},${top + plotHeight} Z`;
  const labelEvery = series.length <= 7 ? 1 : series.length <= 14 ? 2 : series.length <= 30 ? 5 : 15;
  return (
    <View accessible accessibilityLabel={data.map((item) => `${item.label}: ${item.amountMinor}`).join(", ")}>
      <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
        {[0, 0.5, 1].map((ratio) => {
          const rowY = top + plotHeight * ratio;
          return (
            <React.Fragment key={ratio}>
              <Line x1={left} y1={rowY} x2={width - right} y2={rowY} stroke={theme.colors.line} strokeWidth="1" />
              <SvgText x={left - 7} y={rowY + 4} textAnchor="end" fontSize="9" fill={theme.colors.muted}>
                {compact(ceiling * (1 - ratio))}
              </SvgText>
            </React.Fragment>
          );
        })}
        <Path d={area} fill={theme.colors.blueSoft} opacity={0.9} />
        <Path d={line} fill="none" stroke={theme.colors.blue} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {series.map((item, index) => (
          <React.Fragment key={item.label}>
            {(index % labelEvery === 0 || index === series.length - 1) && (
              <SvgText x={x(index)} y={height - 8} textAnchor="middle" fontSize="8" fill={theme.colors.muted}>
                {trendLabel(item.label)}
              </SvgText>
            )}
            {series.length <= 30 && <Circle cx={x(index)} cy={y(item.amountMinor)} r="3.2" fill={theme.colors.surface} stroke={theme.colors.blue} strokeWidth="2" />}
          </React.Fragment>
        ))}
      </Svg>
    </View>
  );
}

export function DonutChart({
  items,
  centerLabel,
  centerValue,
}: {
  items: { label: string; value: number; color: string }[];
  centerLabel: string;
  centerValue: string;
}) {
  const theme=useAppTheme();
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  const radius = 48;
  const circumference = 2 * Math.PI * radius;
  const segments = items.map((item, index) => {
    const fraction = total ? item.value / total : 0;
    const consumed = total
      ? items.slice(0, index).reduce((sum, previous) => sum + Math.max(0, previous.value), 0) / total
      : 0;
    return { ...item, fraction, consumed };
  });
  return (
    <View style={s.donutRow}>
      <View>
        <Svg width={132} height={132} viewBox="0 0 132 132">
          <Circle cx="66" cy="66" r={radius} fill="none" stroke={theme.colors.line} strokeWidth="16" />
          {segments.map((item) => {
            const dash = item.fraction * circumference;
            const offset = -item.consumed * circumference;
            return <Circle key={item.label} cx="66" cy="66" r={radius} fill="none" stroke={item.color} strokeWidth="16" strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={offset} strokeLinecap="butt" rotation="-90" origin="66,66" />;
          })}
        </Svg>
        <View pointerEvents="none" style={s.donutCenter}>
          <Text numberOfLines={1} adjustsFontSizeToFit style={s.donutValue}>{centerValue}</Text>
          <Text style={s.donutLabel}>{centerLabel}</Text>
        </View>
      </View>
      <View style={s.legend}>
        {items.map((item) => (
          <View key={item.label} style={s.legendRow}>
            <View style={[s.dot, { backgroundColor: item.color }]} />
            <View style={s.legendCopy}>
              <Text style={s.legendTitle}>{item.label}</Text>
              <Text style={s.legendValue}>{total ? `${Math.round((item.value / total) * 100)}%` : "0%"}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  empty: { color: colors.muted, fontSize: 12, lineHeight: 18, paddingVertical: 34, textAlign: "center" },
  donutRow: { flexDirection: "row", alignItems: "center", gap: 18, marginTop: 10 },
  donutCenter: { position: "absolute", left: 30, top: 30, width: 72, height:72, alignItems: "center", justifyContent:"center" },
  donutValue: { color: colors.ink, fontSize: 13, fontWeight: "900", maxWidth: 70 },
  donutLabel: { color: colors.muted, fontSize: 8, marginTop: 2 },
  legend: { flex: 1, gap: 9 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 9, height: 9, borderRadius: 3 },
  legendCopy: { flex: 1, flexDirection: "row", justifyContent: "space-between" },
  legendTitle: { color: colors.muted, fontSize: 11 },
  legendValue: { color: colors.ink, fontSize: 11, fontWeight: "900" },
});
