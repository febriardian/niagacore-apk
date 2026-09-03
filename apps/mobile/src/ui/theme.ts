export const lightColors = {
  ink: "#101B35",
  navy: "#0D1B36",
  navy2: "#17315C",
  orange: "#FF8A1F",
  orangeSoft: "#FFF3E7",
  cream: "#F4F7FC",
  surface: "#FFFFFF",
  muted: "#66738A",
  line: "#E4EAF4",
  green: "#1F9D75",
  greenSoft: "#E8F7F1",
  red: "#D64545",
  redSoft: "#FDECEC",
  amber: "#B7791F",
  amberSoft: "#FFF7DF",
  blue: "#1267F4",
  blue2: "#0752D7",
  blueSoft: "#EAF2FF",
  white: "#FFFFFF",
  shadow: "#0B1628",
} as const;

export const darkColors = {
  ink: "#F4F7FC",
  navy: "#DCE9FF",
  navy2: "#AFC8F5",
  orange: "#FFAA5C",
  orangeSoft: "#32251C",
  cream: "#09111F",
  surface: "#121F32",
  muted: "#A9B5C8",
  line: "#2B3D56",
  green: "#3CCF9A",
  greenSoft: "#12382F",
  red: "#FF7A8A",
  redSoft: "#3B2028",
  amber: "#F3C453",
  amberSoft: "#382F19",
  blue: "#4A8CFF",
  blue2: "#2D6FE4",
  blueSoft: "#172A47",
  white: "#FFFFFF",
  shadow: "#020817",
} as const;

export type ThemeColors = { [K in keyof typeof lightColors]: string };

// Static styles keep the light palette. Theme-aware components append the
// resolved palette at render time so changing mode does not require a restart.
export const colors = lightColors;

export const radius = { sm: 10, md: 14, lg: 20, xl: 26, pill: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 22, xxl: 30 } as const;
