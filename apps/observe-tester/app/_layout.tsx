import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Observe, ObserveRoot } from 'expo-observe';
import { Stack } from 'expo-router';
import { useColorScheme } from 'react-native';

Observe.configure({
  environment: 'custom-env',
  dispatchingEnabled: true,
  dispatchInDebug: true,
  integrations: {
    'expo-router': true,
    // Report images decoded more than 2× larger than they are rendered.
    'expo-image': {
      ratio: 2,
    },
  },
});

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <ObserveRoot>
      <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack
          screenOptions={{
            headerShown: false,
          }}
        />
      </ThemeProvider>
    </ObserveRoot>
  );
}
