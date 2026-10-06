// Builds standalone executables (no Node.js or node_modules needed at runtime) using
// Node's single executable applications: the bundled compiler is injected into a copy
// of a Node binary.
//
//   node scripts/build-binaries.js                    binary for this machine, from the running node
//   node scripts/build-binaries.js --node <path>      use another Node binary (e.g. one downloaded
//                                                     for a different OS/arch) and name the output
//                                                     after --target <os-arch>
//
// Output: bin/<os-arch>/vidar and vidar-lsp (a hard link to the same file), plus a .tar.gz.
const { execFileSync } = require("node:child_process");
const { copyFileSync, chmodSync, linkSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const nodeBin = resolve(arg("--node") ?? process.execPath);
const target = arg("--target") ?? `${process.platform}-${process.arch}`;
const windows = target.startsWith("win32");
const mac = target.startsWith("darwin");
const exe = (name) => (windows ? `${name}.exe` : name);
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

const build = resolve("build");
const out = resolve("bin", target);
rmSync(out, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
mkdirSync(out, { recursive: true });

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });

console.log("bundling");
require("esbuild").buildSync({
  entryPoints: ["dist/bin.js"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: join(build, "vidar.cjs"),
  define: { VIDAR_VERSION: JSON.stringify(version), VIDAR_PRELUDE: JSON.stringify(readFileSync("src/prelude.vidar", "utf8")) },
  logLevel: "warning",
});

console.log("creating the SEA blob");
const config = join(build, "sea-config.json");
writeFileSync(config, JSON.stringify({ main: join(build, "vidar.cjs"), output: join(build, "vidar.blob"), disableExperimentalSEAWarning: true }));
run(process.execPath, ["--experimental-sea-config", config]);

const binary = join(out, exe("vidar"));
console.log(`injecting into a copy of ${nodeBin}`);
copyFileSync(nodeBin, binary);
chmodSync(binary, 0o755);
if (mac) run("codesign", ["--remove-signature", binary]);
run(process.execPath, [
  require.resolve("postject/dist/cli.js"), binary, "NODE_SEA_BLOB", join(build, "vidar.blob"),
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(mac ? ["--macho-segment-name", "NODE_SEA"] : []),
]);
if (mac) run("codesign", ["--sign", "-", binary]);

const lsp = join(out, exe("vidar-lsp"));
try {
  linkSync(binary, lsp);
} catch {
  copyFileSync(binary, lsp);
}

const archive = resolve("bin", `vidar-${version}-${target}.tar.gz`);
if (existsSync(archive)) rmSync(archive);
run("tar", ["-czf", archive, "-C", out, exe("vidar"), exe("vidar-lsp")]);
console.log(`\nbuilt ${binary}\n      ${lsp}\n      ${archive}`);
