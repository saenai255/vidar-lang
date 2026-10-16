// Highlighting for `vidar` and `odin` code blocks. mdBook's highlight.js has no Odin, so book.js
// leaves these blocks plain; this registers the language and highlights them afterwards.
(function () {
  if (typeof hljs === "undefined") return;

  const KEYWORDS = {
    keyword:
      "package import foreign proc struct union enum bit_set bit_field map matrix dynamic distinct " +
      "using when where if else for in not_in do switch case break continue fallthrough defer return " +
      "cast transmute auto_cast or_else or_return or_break or_continue asm context " +
      // Vidar
      "closure interface impl catch errdefer unreachable quote take",
    literal: "true false nil",
    built_in:
      "len cap size_of align_of offset_of type_of typeid_of type_info_of new new_clone make delete free free_all " +
      "append clear reserve resize shrink pop pop_front copy min max abs clamp panic assert unimplemented " +
      "ordered_remove unordered_remove remove_range inject_at assign_at delete_key raw_data swizzle real imag conj " +
      "card expand_values",
    type:
      "int uint i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 uintptr f16 f32 f64 bool b8 b16 b32 b64 " +
      "string cstring rune rawptr any byte typeid complex64 complex128 quaternion256 " +
      "Expr Stmt Type Ident Destroy Clone Pool",
  };

  hljs.registerLanguage("vidar", function (hljs) {
    return {
      name: "Vidar",
      aliases: ["odin"],
      keywords: KEYWORDS,
      illegal: "</",
      contains: [
        hljs.C_LINE_COMMENT_MODE,
        hljs.COMMENT("/\\*", "\\*/", { contains: ["self"] }),
        { className: "string", begin: '"', end: '"', contains: [hljs.BACKSLASH_ESCAPE] },
        { className: "string", begin: "`", end: "`" },
        { className: "string", begin: "'(\\\\.|[^'\\\\])'" },
        {
          className: "number",
          begin: "\\b(0[xX][0-9A-Fa-f_]+|0[bB][01_]+|0[oO][0-7_]+|\\d[\\d_]*(\\.\\d[\\d_]*)?([eE][+-]?\\d+)?[ijk]?)\\b",
          relevance: 0,
        },
        { className: "meta", begin: "#\\+?[A-Za-z_]\\w*" },
        { className: "meta", begin: "@\\(", end: "\\)" },
        { className: "meta", begin: "@[A-Za-z_]\\w*" },
        // macro calls and comptime procs: name!(...), name! { ... }, proc!
        { className: "title", begin: "\\b[A-Za-z_]\\w*!(?=\\s*[({])" },
        { className: "keyword", begin: "\\bproc!" },
        // splices inside quote: $name, $(expr), $$
        { className: "variable", begin: "\\$\\$|\\$[A-Za-z_]\\w*" },
        // declarations: name :: proc / struct / ...
        {
          begin: "\\b[A-Za-z_]\\w*(?=\\s*::)",
          className: "title",
          relevance: 0,
        },
        { className: "symbol", begin: "---" },
      ],
    };
  });

  document.querySelectorAll("code.language-vidar, code.language-odin").forEach(function (block) {
    block.classList.remove("language-odin");
    block.classList.add("language-vidar");
    hljs.highlightBlock(block);
  });
})();
