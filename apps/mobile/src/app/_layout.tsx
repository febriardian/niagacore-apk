import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Sentry from '@sentry/react-native';

import { i18n, initializeAppLanguage } from '@/lib/i18n';
import { AuthProvider } from '@/providers/auth-provider';
import { ThemeProvider, useAppTheme } from '@/providers/theme-provider';

const sentryDsn=process.env.EXPO_PUBLIC_SENTRY_DSN;
Sentry.init({
  dsn:sentryDsn,
  enabled:Boolean(sentryDsn),
  environment:process.env.EXPO_PUBLIC_APP_ENV??'development',
  sendDefaultPii:false,
  tracesSampleRate:0.1,
  enableNativeFramesTracking:true,
});

function RootLayout() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: 2, staleTime: 30_000 } },
  }));

  useEffect(() => {
    void initializeAppLanguage();
  }, []);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <I18nextProvider i18n={i18n}>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <ThemedNavigation />
            </AuthProvider>
          </QueryClientProvider>
        </I18nextProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function ThemedNavigation() {
  const theme = useAppTheme();
  return <>
      <StatusBar style={theme.resolvedMode === "dark" ? "light" : "dark"} />
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.cream } }} />
  </>;
}

export default Sentry.wrap(RootLayout);
