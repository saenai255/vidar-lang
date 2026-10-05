// Entry point of the standalone binary: `vidar ...` runs the transpiler, while
// `vidar-lsp` (a link to the same binary) or `vidar lsp` runs the language server.
import { basename } from "node:path";

const self = basename(process.execPath).replace(/\.exe$/i, "");
const args = process.argv.slice(2);

if (self.startsWith("vidar-lsp") || args[0] === "lsp") {
  if (args[0] === "lsp") process.argv.splice(2, 1);
  require("./lsp/server");
} else {
  process.exitCode = require("./cli").main(args);
}
