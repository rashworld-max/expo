import { Image, useImage } from 'expo-image';
import { useState } from 'react';
import { Dimensions, PixelRatio, Platform, ScrollView, StyleSheet, Text } from 'react-native';

import { useTheme } from '@/utils/theme';

// The criterion is screen-relative: `width*height > screenWidth*screenHeight*pixelRatio*2`. A
// 1700×1700px image (2.89M px) sits between a phone's budget (~2.0–2.4M on common phones) and a
// tablet's (~3.1M and up), so it's flagged on a phone but not on an iPad — same image, same code,
// different verdict by device. Numbers are approximate and vary by exact screen size.
const SIZE = 200;
const IMAGE_PX = 1700;
const SOURCE = `https://picsum.photos/seed/expo-image-phone/${IMAGE_PX}/${IMAGE_PX}`;

export default function TooBigPhone() {
  const theme = useTheme();
  const [failed, setFailed] = useState(false);
  const image = useImage(SOURCE, { onError: () => setFailed(true) });
  const screen = Dimensions.get('screen');
  const scale = PixelRatio.get();
  const budget = Math.round(screen.width * screen.height * scale * 2);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.background.screen }]}
      contentContainerStyle={styles.content}>
      {image ? <Image style={styles.image} source={image} /> : null}
      <Text style={[styles.heading, { color: theme.text.default }]}>Too big on phone</Text>
      <Text style={[styles.body, { color: theme.text.secondary }]}>
        A {IMAGE_PX}×{IMAGE_PX}px image ({(IMAGE_PX * IMAGE_PX).toLocaleString()}px²) loaded with
        `useImage`. This device's threshold is {budget.toLocaleString()}px² (
        {Math.round(screen.width)}×{Math.round(screen.height)}pt @{scale}x × 2). On a phone the image
        exceeds it and an `expo-image.oversized` warning is logged; on an iPad the same image is
        within budget and no warning fires.
      </Text>
      {failed ? (
        <Text style={[styles.body, { color: theme.text.secondary }]}>Failed to load the image.</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 20,
    paddingBottom: Platform.select({ ios: 30, android: 150 }),
  },
  image: {
    width: SIZE,
    height: SIZE,
    borderRadius: 8,
    marginBottom: 16,
  },
  heading: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
  },
  body: {
    fontSize: 15,
  },
});
