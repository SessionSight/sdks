// Preload: set up browser globals before any module evaluates canUseStorage

const storage = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => storage.clear(),
  get length() { return storage.size; },
  key: (i: number) => [...storage.keys()][i] ?? null,
} as any;

globalThis.window = globalThis as any;
globalThis.document = {
  createElement: () => ({ id: '', textContent: '', remove() {} }),
  head: { appendChild() {} },
} as any;
globalThis.navigator = { sendBeacon: () => true } as any;

// Export storage so tests can access it for clearing
(globalThis as any).__testStorage = storage;
