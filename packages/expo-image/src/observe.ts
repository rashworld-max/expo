// Type-only imports: erased at runtime, so they add no runtime dependency on these packages.
import type { ExpoAppMetricsModuleType } from 'expo-app-metrics';
// Import from `expo-modules-core`, not `expo`: the package entry pulls this module in as a
// side-effect import, and `expo`'s `Expo.fx` side effects (the winter `fetch` runtime) can't load
// in a React Server Component environment. `expo-modules-core` has no such side effects.
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { ObserveIntegrationsConfig, ObserveModule } from 'expo-observe';
import { Dimensions, PixelRatio } from 'react-native';

import type { ImageNativeModule } from './Image.types';

/**
 * Configuration for the `expo-observe` integration, set through
 * `Observe.configure({ integrations: { 'expo-image': ... } })`. Passing `true` enables it with
 * defaults; the object form tunes the behavior.
 *
 * The native module emits one `onImageLoaded` event from every relevant load path, so the check
 * covers images loaded with `Image.loadAsync`, the `useImage` hook, and those decoded inside the
 * native view by rendering `<Image source={{ uri }} />`.
 *
 * The `declare module 'expo-observe'` augmentation that registers the `'expo-image'` key lives in
 * `Image.types.ts` (always in the package's public type graph, so it is picked up whenever
 * expo-image is imported). `Image.types.ts` `import type`s this from here. It is exported from this
 * module but not from the package entry, so it is not part of the public API.
 */
export type ExpoImageIntegrationConfig = {
  /**
   * An image is reported as oversized when its decoded pixel area exceeds the screen's area (scaled
   * by the device pixel ratio) by more than this factor. For example, `2` flags an image decoded at
   * more than twice the pixels a full-screen image would need.
   *
   * @default 2
   */
  ratio?: number;
};

const DEFAULT_RATIO = 2;

// `ExpoObserve` supplies the integration config (`getIntegrations` + the `onConfigure` event).
const observe = requireOptionalNativeModule<ObserveModule>('ExpoObserve');

// `logEvent` lives on the `ExpoAppMetrics` native module (the `Observe` JS object only surfaces it
// by forwarding to app-metrics), so reporting goes through it directly.
const appMetrics = requireOptionalNativeModule<ExpoAppMetricsModuleType>('ExpoAppMetrics');

// The `ExpoImage` module emits `onImageLoaded`. Acquired optionally (not via `./ImageModule`, which
// `requireNativeModule`s and would throw) so this stays inert in environments without the native
// module — including the React Server Component server, where `observe.ts` is still evaluated.
const imageModule = requireOptionalNativeModule<ImageNativeModule>('ExpoImage');

let enabled = false;
let threshold = DEFAULT_RATIO;
// URLs of images already reported this launch. Only oversized images are added (see below), so this
// stays small and bounded by the number of distinct offenders — not every loaded image.
const reported = new Set<string>();
// Subscription to the native `onImageLoaded` event, held only while the integration is enabled.
// Subscribing flips the module's `OnStartObserving` flag so native emits nothing for apps that
// never enabled the integration.
let subscription: { remove: () => void } | null = null;

function activate(integrations: ObserveIntegrationsConfig) {
  const config = integrations['expo-image'];
  enabled = !!config;
  threshold =
    typeof config === 'object' && config !== null ? (config.ratio ?? DEFAULT_RATIO) : DEFAULT_RATIO;
  // A new configure may change the threshold (or enable the integration), so images already
  // reported under the previous settings should be eligible to report again.
  reported.clear();
  if (enabled && !subscription && imageModule) {
    subscription = imageModule.addListener('onImageLoaded', handleImageLoaded);
  } else if (!enabled && subscription) {
    subscription.remove();
    subscription = null;
  }
}

if (observe) {
  // Read the current config (covers `configure(...)` already run before this module loaded), then
  // listen for later re-configures. Subscribed once for the app's lifetime — the module and this
  // listener live as long as the JS runtime, so there is nothing to unsubscribe.
  activate(observe.getIntegrations());
  observe.addListener('onConfigure', ({ integrations }) => activate(integrations));
}

/**
 * A decoded image (pixel dimensions, from the loader) together with the device's screen size. The
 * caller supplies the screen so `reportIfOversized` stays free of `react-native` and trivially
 * testable; `handleImageLoaded` is the production caller that reads the live screen.
 */
export type LoadedImage = {
  url: string;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
  pixelRatio: number;
};

/**
 * Logs a warning to expo-observe when a loaded image is decoded far larger than a full-screen image
 * would ever need — a common source of wasted memory and bandwidth. No-op unless the `expo-image`
 * Observe integration is enabled. Best-effort: never throws into the loader.
 *
 * The budget is the screen's logical area times the device pixel ratio; an image whose pixel area
 * exceeds that budget by the configured `ratio` is reported.
 */
export function reportIfOversized(image: LoadedImage): void {
  if (!enabled || !appMetrics) {
    return;
  }
  const { url, width, height, screenWidth, screenHeight, pixelRatio } = image;
  // Reject anything non-finite or non-positive (`!(x > 0)` also catches `NaN`/`undefined`): a bad
  // value must never produce a zero/NaN budget that flags every image or logs NaN dimensions.
  if (!url || !(width > 0) || !(height > 0)) {
    return;
  }
  if (reported.has(url)) {
    return;
  }
  const budget = screenWidth * screenHeight * pixelRatio;
  if (!(budget > 0) || width * height <= budget * threshold) {
    return;
  }
  reported.add(url);
  try {
    appMetrics.logEvent('expo-image.oversized', {
      severity: 'warn',
      body: `Image loaded at ${width}×${height}px is far larger than this device's screen (${screenWidth}×${screenHeight}pt @${pixelRatio}x). Constrain it with the maxWidth/maxHeight load options.`,
      attributes: {
        url,
        imageWidth: width,
        imageHeight: height,
        screenWidth,
        screenHeight,
        pixelRatio,
      },
    });
  } catch {
    // Reporting is best-effort; a logging failure must not disrupt image loading.
  }
}

/**
 * Handles the native `onImageLoaded` event: reads the current screen size and forwards the decoded
 * image (pixel dimensions) to `reportIfOversized`. The native module emits this event from every
 * relevant load path (`loadAsync`, `useImage`, and the rendered `<Image>` view), so this single
 * subscriber covers the whole integration and the screen read lives in one place.
 */
function handleImageLoaded(image: { url: string; width: number; height: number }): void {
  const screen = Dimensions.get('screen');
  reportIfOversized({
    ...image,
    screenWidth: screen.width,
    screenHeight: screen.height,
    pixelRatio: PixelRatio.get(),
  });
}
