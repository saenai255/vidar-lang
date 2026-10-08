import { withMermaid } from "vitepress-plugin-mermaid";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

const vidarGrammar = JSON.parse(readFileSync(new URL("../../editors/vscode/syntaxes/vidar.tmLanguage.json", import.meta.url), "utf8"));

const REPO = "https://github.com/saenai255/vidar-lang/blob/main";
const BASE = process.env.DOCS_BASE ?? "/vidar-lang/";

const sidebar = [
  { text: "Using Vidar", items: [
    { text: "Getting started", link: "/getting-started" },
    { text: "Command line", link: "/cli" },
    { text: "Limits", link: "/limits" },
    { text: "FAQ", link: "/faq" },
  ] },
  { text: "The language", items: [
    { text: "Closures", link: "/language/closures" },
    { text: "Interfaces", link: "/language/interfaces" },
    { text: "Error handling", link: "/language/error-handling" },
    { text: "Anonymous struct literals", link: "/language/anonymous-structs" },
    { text: "Cyclic imports", link: "/language/cyclic-imports" },
    { text: "Collections", link: "/language/collections" },
    { text: "Goroutines and channels", link: "/language/goroutines" },
    { text: "Built-in macros", link: "/language/builtin-macros" },
    { text: "Comptime procs", link: "/language/comptime" },
    { text: "Faster code: -opt", link: "/language/optimization" },
  ] },
  { text: "Tools", items: [
    { text: "Testing", link: "/tools/testing" },
    { text: "Debugging", link: "/tools/debugging" },
    { text: "Language server", link: "/tools/language-server" },
  ] },
  { text: "Reference", items: [
    { text: "Keywords", link: "/reference/keywords" },
    { text: "Built-ins", link: "/reference/builtins" },
    { text: "Comptime built-ins", link: "/reference/comptime" },
    { text: "Attributes", link: "/reference/attributes" },
    { text: "Command line", link: "/reference/cli" },
    { text: "Built-in macro definitions", link: "/reference/macros" },
    { text: "Build flags", link: "/reference/defines" },
    { text: "vidar:sched API", link: "/reference/sched" },
    { text: "Compile errors", link: "/reference/errors" },
  ] },
  { text: "How the compiler works", items: [
    { text: "Architecture", link: "/internals/architecture" },
    { text: "Source layout", link: "/internals/source-layout" },
    { text: "What Vidar generates", link: "/internals/lowering" },
    { text: "Contributing", link: "/contributing" },
  ] },
];

// Links that leave docs/ (src/, examples/, SYNTAX.md, ...) point at the repository.
const outside = (href) => /^\.\.\/(?!reference|language)/.test(href) || href.startsWith("../../");

export default withMermaid({
  title: "Vidar",
  description: "Odin with closures, interfaces, error handling, cyclic imports, comptime macros and goroutines.",
  base: BASE,
  rewrites: { "README.md": "index.md" },
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: [/^\.\.\/.*(src|examples|tests|editors|SYNTAX|AGENTS)/, /^\.\.\/SYNTAX/, /^\.\.\/AGENTS/, /^\.\.\/examples/],
  vite: { optimizeDeps: { include: ["mermaid"] } },
  themeConfig: {
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "Reference", link: "/reference/keywords" },
      { text: "Syntax cheat sheet", link: `${REPO}/SYNTAX.md` },
    ],
    sidebar,
    search: { provider: "local" },
    outline: [2, 3],
    socialLinks: [{ icon: "github", link: "https://github.com/saenai255/vidar-lang" }],
    editLink: { pattern: "https://github.com/saenai255/vidar-lang/edit/main/docs/:path" },
  },
  markdown: {
    languages: [{ ...vidarGrammar, name: "odin", aliases: ["vidar"] }],
    config(md) {
      const base = md.renderer.rules.link_open ?? ((t, i, o, e, s) => s.renderToken(t, i, o));
      md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
        const t = tokens[i];
        const href = t.attrGet("href");
        if (href && !/^(https?:|#|mailto:)/.test(href) && env.relativePath) {
          const resolved = posix.normalize(posix.join(posix.dirname(env.relativePath), href.split("#")[0]));
          if (resolved.startsWith("..")) t.attrSet("href", `${REPO}/${posix.normalize(posix.join("docs", posix.dirname(env.relativePath), href)).replace(/^\.\.\/?/, "")}`);
        }
        return base(tokens, i, opts, env, self);
      };
    },
  },
});
