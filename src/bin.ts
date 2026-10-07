// Entry point of the standalone binary: `vidar ...` runs the transpiler, while
// `vidar-lsp` (a link to the same binary) or `vidar lsp` runs the language server.
// VIDAR_CLI=1 makes `vidar-lsp` run the transpiler too (the editor extension builds with it).
import { basename } from "node:path";

const self = basename(process.execPath).replace(/\.exe$/i, "");
const args = process.argv.slice(2);

if ((self.startsWith("vidar-lsp") && !process.env.VIDAR_CLI) || args[0] === "lsp") {
  if (args[0] === "lsp") process.argv.splice(2, 1);
  require("./lsp/server");
} else if (require("./watch").wantsWatch(args)) {
  require("./watch").watchCommand(args, [process.execPath]);
} else {
  Promise.resolve(require("./cli").main(args)).then((code: number) => (process.exitCode = code));
}
