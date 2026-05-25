// @colyseus/schema v3 needs Symbol.metadata. Polyfill before any schema import.
(Symbol as any).metadata ??= Symbol.for("Symbol.metadata");
export {};
