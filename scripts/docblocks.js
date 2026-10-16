// Fenced code blocks in the book's Markdown, shared by the mdBook preprocessor (scripts/mdbook-vidar.js)
// and the doc tests (scripts/test-docs.js).
//
// Info strings, after the Rust book's:
//   ```vidar                        a program: checked; run when an ```output block follows
//   ```vidar,ignore                 not compiled (fragments, pseudo-code)
//   ```vidar,compile_fail           must fail to compile; an ```error block after it holds the message
//   ```vidar,should_panic           must build and then fail when run (an ```error block holds what it prints)
//   ```vidar,no_run                 compiled, never run, even with an ```output block
//   ```vidar,opt                    built with -opt
//   ```vidar,test                   run with `vidar test`: its @(test) procs must pass (or fail, with should_panic)
//   ```vidar,project=NAME,file=PATH one file of a multi-file program; blocks with the same NAME make one program,
//                                   across pages in reading order, tested at each ```output / ```error block
//                                   that follows one (any other block with project= and file= adds a file)
// Lines starting with "# " (or a lone "#") are compiled but not shown, as in rustdoc.

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

const parseInfo = (info) => {
  const [lang = "", ...rest] = info.trim().split(",").map((s) => s.trim()).filter((s, i) => s || i === 0);
  const attrs = { flags: new Set(), project: null, file: null };
  for (const r of rest) {
    const m = /^(\w+)=(.*)$/.exec(r);
    if (m) attrs[m[1]] = m[2];
    else attrs.flags.add(r);
  }
  return { lang, attrs };
};

/** Every fenced block, with its line range (0-based, fences included) and its content lines, unindented. */
const parseBlocks = (text) => {
  const lines = text.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i]);
    if (!m) continue;
    const [, indent, fence, info] = m;
    let j = i + 1;
    const close = new RegExp(`^\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
    while (j < lines.length && !close.test(lines[j])) j++;
    const content = lines.slice(i + 1, j).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart()));
    blocks.push({ ...parseInfo(info), info: info.trim(), start: i, end: j, indent, fence, content });
    i = j;
  }
  return blocks;
};

const isHidden = (line) => line === "#" || line.startsWith("# ");
/** The lines a reader sees. */
const shown = (content) => content.filter((l) => !isHidden(l));
/** The lines that are compiled. */
const compiled = (content) => content.map((l) => (l === "#" ? "" : l.startsWith("# ") ? l.slice(2) : l));

// `odin` blocks are shown as they are (generated code, plain Odin); only `vidar` blocks are tested.
const isVidar = (b) => b.lang === "vidar";

module.exports = { parseBlocks, parseInfo, shown, compiled, isHidden, isVidar };
