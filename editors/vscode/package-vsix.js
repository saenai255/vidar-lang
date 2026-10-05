// Packages the extension as a .vsix with the vidar-lsp binary bundled inside.
//   node package-vsix.js                   current platform, using ../../bin/<os>-<arch>/vidar-lsp
//   node package-vsix.js --target linux-x64  another platform built with scripts/build-binaries.js --target
//   node package-vsix.js --no-server       a platform-independent .vsix that expects vidar-lsp on PATH
const { execFileSync } = require("node:child_process");
const { copyFileSync, chmodSync, existsSync, mkdirSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");

const i = process.argv.indexOf("--target");
const target = i >= 0 ? process.argv[i + 1] : `${process.platform}-${process.arch}`;
const bundle = !process.argv.includes("--no-server");
const exe = target.startsWith("win32") ? "vidar-lsp.exe" : "vidar-lsp";

rmSync("server", { recursive: true, force: true });
if (bundle) {
  const binary = resolve("..", "..", "bin", target, exe);
  if (!existsSync(binary)) {
    console.error(`missing ${binary}\nbuild it first: (cd ../.. && npm run build:binaries)`);
    process.exit(1);
  }
  mkdirSync("server");
  copyFileSync(binary, join("server", exe));
  chmodSync(join("server", exe), 0o755);
}
// VS Code's platform names (darwin-arm64, linux-x64, win32-x64, ...) match Node's
const args = ["package", "--allow-missing-repository", "--skip-license", ...(bundle ? ["--target", target] : [])];
execFileSync(process.execPath, [require.resolve("@vscode/vsce/vsce"), ...args], { stdio: "inherit" });
rmSync("server", { recursive: true, force: true });
