import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: "info",
};

// Node-side extension host code. `vscode` is provided by the runtime.
const extensionCtx = await esbuild.context({
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
});

// Browser-side webview bundle. CSS imported from TS is emitted as a sibling
// .css file (dist/webview.css). The theme-* entries exist only to produce
// theme-light.css / theme-dark.css; their .js output is unused.
const webviewCtx = await esbuild.context({
  ...common,
  entryPoints: {
    webview: "webview/main.ts",
    "theme-light": "webview/theme-light.ts",
    "theme-dark": "webview/theme-dark.ts",
  },
  outdir: "dist",
  platform: "browser",
  format: "iife",
  target: "es2022",
  assetNames: "assets/[name]-[hash]",
  loader: {
    ".woff": "file",
    ".woff2": "file",
    ".ttf": "file",
    ".eot": "file",
    ".svg": "dataurl",
    ".png": "dataurl",
  },
});

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
}
