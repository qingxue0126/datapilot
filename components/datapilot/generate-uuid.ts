type UUIDCrypto = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
};

let fallbackSequence = 0;

/** Generate a browser-safe UUID v4, including on non-secure HTTP origins. */
export function generateUUID(source: UUIDCrypto | undefined = browserCrypto()) {
  if (typeof source?.randomUUID === "function") return source.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === "function") {
    source.getRandomValues(bytes);
  } else {
    fillFallbackBytes(bytes);
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function browserCrypto(): UUIDCrypto | undefined {
  return typeof globalThis !== "undefined" ? globalThis.crypto as UUIDCrypto | undefined : undefined;
}

function fillFallbackBytes(bytes: Uint8Array) {
  fallbackSequence = (fallbackSequence + 1) >>> 0;
  const performanceTicks = typeof performance !== "undefined" ? Math.floor(performance.now() * 1000) : 0;
  let state = (Date.now() ^ performanceTicks ^ fallbackSequence ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = (state + Math.floor(Math.random() * 256) + index * 31) & 0xff;
  }
}
