/**
 * Type shim for the Cloudflare CompiledWasm import of the fula-client WASM.
 * `import wasmModule from "@functionland/fula-client/fula_js_bg.wasm"` resolves,
 * at build/test time, to a `WebAssembly.Module` (wrangler/esbuild + vitest-pool-
 * workers handle the .wasm → CompiledWasm binding). TypeScript needs this ambient
 * declaration to accept the import.
 */
declare module "@functionland/fula-client/fula_js_bg.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
