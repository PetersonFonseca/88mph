export function seededRandom(seed = 1) {
  let state = typeof seed === 'string' ? [...seed].reduce((s, c) => Math.imul(s ^ c.charCodeAt(0), 16777619), 2166136261) : seed;
  return () => {
    state |= 0; state = state + 0x6D2B79F5 | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export const rng = seededRandom;

