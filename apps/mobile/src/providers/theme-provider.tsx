import * as SecureStore from "expo-secure-store";
import React from "react";

import { darkColors, lightColors, type ThemeColors } from "@/ui/theme";

export type ThemeMode = "light" | "dark";

type ThemeContextValue = {
  mode: ThemeMode;
  resolvedMode: "light" | "dark";
  colors: ThemeColors;
  setMode: (mode: ThemeMode) => Promise<void>;
};

const STORAGE_KEY = "niagacore.theme-mode";
const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = React.useState<ThemeMode>("light");

  React.useEffect(() => {
    void SecureStore.getItemAsync(STORAGE_KEY).then((saved) => {
      if (saved === "light" || saved === "dark") setModeState(saved);
      else if (saved === "system") void SecureStore.setItemAsync(STORAGE_KEY,"light");
    });
  }, []);

  const setMode = React.useCallback(async (next: ThemeMode) => {
    setModeState(next);
    await SecureStore.setItemAsync(STORAGE_KEY, next);
  }, []);

  const resolvedMode = mode;
  const value = React.useMemo<ThemeContextValue>(() => ({
    mode,
    resolvedMode,
    colors: resolvedMode === "dark" ? darkColors : lightColors,
    setMode,
  }), [mode, resolvedMode, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext);
  if (!context) throw new Error("ThemeProvider is required");
  return context;
}
