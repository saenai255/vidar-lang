#!/usr/bin/env node
// mdBook preprocessor for the book in docs/ (see docs/book.toml).
//  - `vidar` blocks lose their hidden lines ("# ...") and test-only attributes; `file=` becomes a filename
//    line above the block, and compile_fail / should_panic stay as classes for the stylesheet.
//  - ```output and ```error blocks become plain text with a class of their own.
//  - Links that leave docs/src (to examples/, src/, tests/) point at the repository on GitHub.
const fs = require("fs");
const path = require("path");
const { parseBlocks, shown } = require("./docblocks");

const REPO = "https://github.com/saenai255/vidar-lang/blob/main";
const root = path.join(__dirname, "..");
const srcDir = path.join(root, "docs", "src");

if (process.argv[2] === "supports") process.exit(0);

const SHOWN_FLAGS = ["compile_fail", "should_panic"];

const rewriteLinks = (line, chapterPath) => {
  const dir = path.dirname(path.join(srcDir, chapterPath));
  return line.replace(/\]\(([^)\s]+)\)/g, (all, href) => {
    if (/^(https?:|mailto:|#)/.test(href)) return all;
    const [file, anchor] = href.split("#");
    const abs = path.resolve(dir, file);
    if (abs.startsWith(srcDir + path.sep)) return all;
    const rel = path.relative(root, abs).split(path.sep).join("/");
    const kind = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? "tree" : "blob";
    return `](${REPO.replace("/blob/", `/${kind}/`)}/${rel}${anchor ? "#" + anchor : ""})`;
  });
};

const transform = (content, chapterPath) => {
  const lines = content.split("\n");
  const blocks = parseBlocks(content);
  const out = [];
  let next = 0;
  const copyText = (upTo) => {
    for (; next < upTo; next++) out.push(rewriteLinks(lines[next], chapterPath));
  };
  for (const b of blocks) {
    copyText(b.start);
    const open = (info) => `${b.indent}${b.fence}${info}`;
    let body = b.content;
    let info = b.info;
    if (b.lang === "vidar") {
      body = shown(b.content);
      info = ["vidar", ...SHOWN_FLAGS.filter((f) => b.attrs.flags.has(f))].join(",");
      if (b.attrs.file) out.push(`${b.indent}<span class="filename">Filename: ${b.attrs.file}</span>`, "");
    } else if (b.lang === "output") {
      info = "text,output";
    } else if (b.lang === "error") {
      info = "text,error-output";
    } else if (b.attrs.file) {
      out.push(`${b.indent}<span class="filename">Filename: ${b.attrs.file}</span>`, "");
      info = b.lang;
    }
    out.push(open(info), ...body.map((l) => (l ? b.indent + l : l)), lines[b.end]);
    next = b.end + 1;
  }
  copyText(lines.length);
  return out.join("\n");
};

const walk = (items) => {
  for (const item of items) {
    if (!item.Chapter) continue;
    const ch = item.Chapter;
    if (ch.path) ch.content = transform(ch.content, ch.path);
    walk(ch.sub_items);
  }
};

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const [, book] = JSON.parse(input);
  walk(book.sections ?? book.items);
  process.stdout.write(JSON.stringify(book));
});
