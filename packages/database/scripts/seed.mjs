// `new URL(...).pathname` yields a leading-slash Windows path that resolves to
// "D:\D:\..." — use fileURLToPath, which handles the platform difference.
import { fileURLToPath, pathToFileURL } from 'node:url'
const target = fileURLToPath(new URL('../src/seed-demo.ts', import.meta.url))
const mod = await import(pathToFileURL(target).href)
await mod.main()
