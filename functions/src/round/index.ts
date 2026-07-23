// CRISIS round core (Slice 1) — pure resolver + validator + default table. No firebase,
// no round loop, no clock, no callables. The single import surface the Slice-2 round loop,
// the Slice-5 seat-filler bot, and the Slice-5 browser robot driver all consume (§5.5:
// one source, no mirror).

export * from './settings'
export * from './allocation'
export * from './resolver'
export * from './decide'
export * from './machine'
