// Packages the extension as a platform-independent .vsix. The language server is not bundled:
// the extension runs `vidar-lsp` from PATH, or `vidar.server.path`.
//   node package-vsix.js
const { execFileSync } = require("node:child_process");

execFileSync(process.execPath, [require.resolve("@vscode/vsce/vsce"), "package", "--allow-missing-repository", "--skip-license"], { stdio: "inherit" });
