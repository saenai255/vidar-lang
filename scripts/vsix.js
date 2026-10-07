// Rebuilds the vidar-lsp binary, packages the VS Code extension with it, and installs it.
//   node scripts/vsix.js   (npm run vsix)
// The VS Code CLI is $VSCODE_CLI, else the one inside /Applications, else `code` on PATH.
const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const ROOT = resolve(__dirname, "..");
const EXT = join(ROOT, "editors/vscode");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

sh(npm, ["run", "build:binaries"], ROOT);
if (!existsSync(join(EXT, "node_modules"))) sh(npm, ["install"], EXT);
sh(npm, ["run", "package"], EXT);

const { version } = JSON.parse(readFileSync(join(EXT, "package.json"), "utf8"));
const vsix = join(EXT, `vidar-${process.platform}-${process.arch}-${version}.vsix`);
const appCli = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
const cli = process.env.VSCODE_CLI ?? (existsSync(appCli) ? appCli : "code");
sh(cli, ["--install-extension", vsix, "--force"], ROOT);
console.log("\nInstalled. Reload the VS Code window (Developer: Reload Window) to start the new server.");
