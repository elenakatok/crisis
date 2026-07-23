import { defineConfig, configDefaults } from 'vitest/config'

// Crisis Slice 0 (scaffold): pure unit tests only (no emulator). Compiled lib/ output
// is CommonJS that vitest can't import, so it is excluded alongside the vitest defaults.
// The round-resolver unit tests arrive with Slice 1.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'lib/**'],
  },
})
