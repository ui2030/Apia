import { defineConfig } from 'vitest/config'

// Pure schema tests live under tests/ and only require Node — no jsdom, no
// Electron, no Three.js. Keep this config minimal; if renderer-side tests
// land later they should likely live in a separate config (or move this one
// to `projects: []`) rather than bolting jsdom on here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{js,mjs}'],
    reporters: ['default']
  }
})
