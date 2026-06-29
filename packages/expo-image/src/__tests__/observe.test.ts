import type { LoadedImage } from '../observe';

// The `ExpoObserve` native module: supplies the config and the `onConfigure` event.
type FakeObserve = {
  getIntegrations: jest.Mock;
  addListener: jest.Mock;
  emit: (name: string, payload: unknown) => void;
};

// The `ExpoAppMetrics` native module: `logEvent` lives here, not on `ExpoObserve`.
type FakeAppMetrics = { logEvent: jest.Mock };

// The `ExpoImage` native module: emits `onImageLoaded`. `observe.ts` subscribes to it while the
// integration is enabled. Captures the subscriber so a test can drive an emission, and exposes the
// shared `remove` mock so unsubscription can be asserted.
type FakeImageModule = {
  addListener: jest.Mock;
  remove: jest.Mock;
  emit: (name: string, payload: unknown) => void;
};

function makeObserve(integrations: Record<string, unknown>): FakeObserve {
  const listeners: Record<string, ((payload: unknown) => void)[]> = {};
  return {
    getIntegrations: jest.fn(() => integrations),
    addListener: jest.fn((name: string, cb: (payload: unknown) => void) => {
      (listeners[name] ??= []).push(cb);
      return { remove: jest.fn() };
    }),
    emit(name, payload) {
      (listeners[name] ?? []).forEach((cb) => cb(payload));
    },
  };
}

function makeImageModule(): FakeImageModule {
  const listeners: Record<string, ((payload: unknown) => void)[]> = {};
  const remove = jest.fn();
  return {
    remove,
    addListener: jest.fn((name: string, cb: (payload: unknown) => void) => {
      (listeners[name] ??= []).push(cb);
      return { remove };
    }),
    emit(name, payload) {
      (listeners[name] ?? []).forEach((cb) => cb(payload));
    },
  };
}

// Re-import `observe.ts` with a fresh module state and controlled mocks so each test observes
// activation/dedup/subscription from a clean slate. `requireOptionalNativeModule` (from
// `expo-modules-core`) is keyed on module name so the three native modules (`ExpoObserve` for config,
// `ExpoAppMetrics` for `logEvent`, `ExpoImage` for the `onImageLoaded` event) stay separate — each
// can independently be absent. `react-native` is mocked so `handleImageLoaded` reads a fixed screen.
function loadObserveModule(
  observe: FakeObserve | null,
  appMetrics: FakeAppMetrics | null = { logEvent: jest.fn() },
  imageModule: FakeImageModule = makeImageModule(),
  screen = { width: 100, height: 100 },
  pixelRatio = 1
) {
  let mod: typeof import('../observe');
  jest.isolateModules(() => {
    jest.doMock('expo-modules-core', () => ({
      requireOptionalNativeModule: (name: string) => {
        if (name === 'ExpoObserve') return observe;
        if (name === 'ExpoImage') return imageModule;
        return appMetrics;
      },
    }));
    // Give `handleImageLoaded` a deterministic screen across all four platform projects. The
    // mechanism that works differs per preset (`doMock` takes on iOS/Android; `spyOn` on the real
    // singleton takes on Node/Web), so apply both — whichever the project honors wins.
    jest.doMock('react-native', () => ({
      Dimensions: { get: () => screen },
      PixelRatio: { get: () => pixelRatio },
    }));
    const { Dimensions, PixelRatio } = require('react-native');
    jest.spyOn(Dimensions, 'get').mockReturnValue(screen as ReturnType<typeof Dimensions.get>);
    jest.spyOn(PixelRatio, 'get').mockReturnValue(pixelRatio);
    mod = require('../observe');
  });
  jest.dontMock('expo-modules-core');
  jest.dontMock('react-native');
  return { reportIfOversized: mod!.reportIfOversized, logEvent: appMetrics?.logEvent, imageModule };
}

// Restore the `Dimensions`/`PixelRatio` spies installed by `loadObserveModule`.
afterEach(() => jest.restoreAllMocks());

// The caller passes the screen size; the tests fix it at 100×100pt @1x, a budget of 10000px²
// (width × height × pixel ratio). Override `pixelRatio` to exercise the scaling.
function image(
  width: number,
  height = width,
  url = 'https://example.com/a.png',
  pixelRatio = 1
): LoadedImage {
  return { url, width, height, screenWidth: 100, screenHeight: 100, pixelRatio };
}

describe('reportIfOversized', () => {
  it('logs a warning once when the image area exceeds the screen budget times the ratio', () => {
    const observe = makeObserve({ 'expo-image': { ratio: 3 } });
    const { reportIfOversized, logEvent } = loadObserveModule(observe);

    // budget 10000 × ratio 3 = 30000; 200×200 = 40000 > 30000
    reportIfOversized(image(200, 200, 'https://example.com/a.png', 1));

    expect(logEvent).toHaveBeenCalledTimes(1);
    const [name, options] = logEvent!.mock.calls[0];
    expect(name).toBe('expo-image.oversized');
    expect(options.severity).toBe('warn');
    expect(options.attributes).toMatchObject({
      url: 'https://example.com/a.png',
      imageWidth: 200,
      imageHeight: 200,
      screenWidth: 100,
      screenHeight: 100,
      pixelRatio: 1,
    });
  });

  it('does not log when the image area is within the budget', () => {
    const observe = makeObserve({ 'expo-image': { ratio: 3 } });
    const { reportIfOversized, logEvent } = loadObserveModule(observe);

    // budget 10000 × ratio 3 = 30000; 150×150 = 22500 < 30000
    reportIfOversized(image(150));

    expect(logEvent).not.toHaveBeenCalled();
  });

  it('uses the default ratio of 2 when enabled with `true`', () => {
    const observe = makeObserve({ 'expo-image': true });
    const { reportIfOversized, logEvent } = loadObserveModule(observe);

    // budget 10000 × ratio 2 = 20000; 150×150 = 22500 > 20000
    reportIfOversized(image(150));

    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it('scales the budget by the device pixel ratio', () => {
    // screen 100×100pt @3x → budget 30000; default ratio 2 → 60000
    const observe = makeObserve({ 'expo-image': true });
    const { reportIfOversized, logEvent } = loadObserveModule(observe);

    reportIfOversized(image(200, 200, 'https://example.com/a.png', 3)); // 40000 < 60000
    expect(logEvent).not.toHaveBeenCalled();

    reportIfOversized(image(300, 300, 'https://example.com/b.png', 3)); // 90000 > 60000
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it('does not log when the integration is not enabled', () => {
    const observe = makeObserve({}); // no 'expo-image' key
    const { reportIfOversized, logEvent } = loadObserveModule(observe);

    reportIfOversized(image(1000));

    expect(logEvent).not.toHaveBeenCalled();
  });

  it('does not log when the integration is disabled with `false`', () => {
    const observe = makeObserve({ 'expo-image': false });
    const { reportIfOversized, logEvent } = loadObserveModule(observe);

    reportIfOversized(image(1000));

    expect(logEvent).not.toHaveBeenCalled();
  });

  it('activates from a later `onConfigure` event', () => {
    const observe = makeObserve({}); // disabled at load
    const { reportIfOversized, logEvent } = loadObserveModule(observe);

    reportIfOversized(image(1000));
    expect(logEvent).not.toHaveBeenCalled();

    observe.emit('onConfigure', { integrations: { 'expo-image': { ratio: 2 } } });
    reportIfOversized(image(1000, 1000, 'https://example.com/b.png'));
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it('reports each source url at most once', () => {
    const observe = makeObserve({ 'expo-image': { ratio: 2 } });
    const { reportIfOversized, logEvent } = loadObserveModule(observe);

    reportIfOversized(image(1000));
    reportIfOversized(image(1000));

    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it('clears the dedup set on a new configure so a reported url can report again', () => {
    const observe = makeObserve({ 'expo-image': { ratio: 2 } });
    const { reportIfOversized, logEvent } = loadObserveModule(observe);

    reportIfOversized(image(1000));
    expect(logEvent).toHaveBeenCalledTimes(1);

    observe.emit('onConfigure', { integrations: { 'expo-image': { ratio: 2 } } });
    reportIfOversized(image(1000));
    expect(logEvent).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when expo-observe is not installed', () => {
    const { reportIfOversized } = loadObserveModule(null);

    expect(() => reportIfOversized(image(1000))).not.toThrow();
  });

  it('is a no-op when expo-observe is present but app-metrics is not', () => {
    const observe = makeObserve({ 'expo-image': { ratio: 2 } });
    const { reportIfOversized } = loadObserveModule(observe, null);

    expect(() => reportIfOversized(image(1000))).not.toThrow();
  });

  it('does not log when the area exactly equals the budget times the ratio', () => {
    const observe = makeObserve({ 'expo-image': { ratio: 2 } });
    const { reportIfOversized, logEvent } = loadObserveModule(observe);

    // budget 10000 × ratio 2 = 20000; 200×100 = 20000 — strictly greater is required
    reportIfOversized(image(200, 100));

    expect(logEvent).not.toHaveBeenCalled();
  });

  it('does not log or throw when the image has no measurable size', () => {
    const observe = makeObserve({ 'expo-image': { ratio: 2 } });
    const { reportIfOversized, logEvent } = loadObserveModule(observe);

    expect(() => reportIfOversized(image(0))).not.toThrow();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('reports distinct oversized urls independently', () => {
    const observe = makeObserve({ 'expo-image': { ratio: 2 } });
    const { reportIfOversized, logEvent } = loadObserveModule(observe);

    reportIfOversized(image(1000, 1000, 'https://example.com/a.png'));
    reportIfOversized(image(1000, 1000, 'https://example.com/b.png'));

    expect(logEvent).toHaveBeenCalledTimes(2);
  });
});

describe('onImageLoaded subscription', () => {
  it('subscribes to the native event when the integration is enabled', () => {
    const observe = makeObserve({ 'expo-image': true });
    const { imageModule } = loadObserveModule(observe);

    expect(imageModule.addListener).toHaveBeenCalledWith('onImageLoaded', expect.any(Function));
  });

  it('does not subscribe when the integration is disabled', () => {
    const observe = makeObserve({});
    const { imageModule } = loadObserveModule(observe);

    expect(imageModule.addListener).not.toHaveBeenCalled();
  });

  it('subscribes only once across repeated enabling configures', () => {
    const observe = makeObserve({ 'expo-image': true });
    const { imageModule } = loadObserveModule(observe);

    observe.emit('onConfigure', { integrations: { 'expo-image': { ratio: 4 } } });

    expect(imageModule.addListener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes when a later configure disables the integration', () => {
    const observe = makeObserve({ 'expo-image': true });
    const { imageModule } = loadObserveModule(observe);

    observe.emit('onConfigure', { integrations: {} });

    expect(imageModule.remove).toHaveBeenCalledTimes(1);
  });

  it('re-subscribes after being disabled and enabled again', () => {
    const observe = makeObserve({ 'expo-image': true });
    const { imageModule } = loadObserveModule(observe);

    observe.emit('onConfigure', { integrations: {} });
    observe.emit('onConfigure', { integrations: { 'expo-image': true } });

    expect(imageModule.addListener).toHaveBeenCalledTimes(2);
  });

  it('routes a native onImageLoaded event through reportIfOversized', () => {
    const observe = makeObserve({ 'expo-image': true });
    const imageModule = makeImageModule();
    // screen 100×100pt @1x → budget 10000; default ratio 2 → 20000
    const { logEvent } = loadObserveModule(observe, { logEvent: jest.fn() }, imageModule);

    imageModule.emit('onImageLoaded', {
      url: 'https://example.com/big.png',
      width: 300,
      height: 300,
    });

    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent!.mock.calls[0][1].attributes).toMatchObject({
      url: 'https://example.com/big.png',
      imageWidth: 300,
      imageHeight: 300,
      screenWidth: 100,
      screenHeight: 100,
      pixelRatio: 1,
    });
  });
});
