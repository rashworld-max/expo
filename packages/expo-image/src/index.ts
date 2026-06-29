// Side-effect import: subscribes the expo-observe oversized-image integration to the native
// `onImageLoaded` event. Nothing else imports `observe.ts` at runtime (the `Image.types.ts`
// reference is type-only), so the always-loaded package entry must pull it in.
import './observe';

export * from './Image.types';
export { Image } from './Image';
export { ImageBackground } from './ImageBackground';
export { useImage } from './useImage';
