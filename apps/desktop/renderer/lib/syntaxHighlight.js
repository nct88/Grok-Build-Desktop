/**
 * Dependency-free syntax highlighting for the sandboxed desktop renderer.
 * Raw file content is always appended with textContent; it is never trusted as HTML.
 */
(function (global) {
  "use strict";

  const LANGUAGE_BY_EXTENSION = {
    js: ["javascript", "JavaScript"], jsx: ["javascript", "JavaScript"],
    mjs: ["javascript", "JavaScript"], cjs: ["javascript", "JavaScript"],
    ts: ["typescript", "TypeScript"], tsx: ["typescript", "TypeScript"],
    rs: ["rust", "Rust"], py: ["python", "Python"], pyw: ["python", "Python"],
    c: ["c", "C"], h: ["c", "C"], cc: ["cpp", "C++"], cpp: ["cpp", "C++"],
    cxx: ["cpp", "C++"], hpp: ["cpp", "C++"], cs: ["csharp", "C#"],
    java: ["java", "Java"], kt: ["kotlin", "Kotlin"], kts: ["kotlin", "Kotlin"],
    go: ["go", "Go"], php: ["php", "PHP"], rb: ["ruby", "Ruby"],
    sh: ["shell", "Shell"], bash: ["shell", "Shell"], zsh: ["shell", "Shell"],
    ps1: ["powershell", "PowerShell"], psm1: ["powershell", "PowerShell"],
    json: ["json", "JSON"], jsonc: ["json", "JSON with comments"],
    yaml: ["yaml", "YAML"], yml: ["yaml", "YAML"], toml: ["toml", "TOML"],
    xml: ["markup", "XML"], html: ["markup", "HTML"], htm: ["markup", "HTML"],
    vue: ["markup", "Vue"], svelte: ["markup", "Svelte"], svg: ["markup", "SVG"],
    css: ["css", "CSS"], scss: ["css", "SCSS"], less: ["css", "Less"],
    sql: ["sql", "SQL"], md: ["markdown", "Markdown"], mdx: ["markdown", "MDX"],
    lua: ["lua", "Lua"], dart: ["dart", "Dart"], swift: ["swift", "Swift"],
    ex: ["elixir", "Elixir"], exs: ["elixir", "Elixir"], erl: ["erlang", "Erlang"],
    hs: ["haskell", "Haskell"], lhs: ["haskell", "Haskell"],
    r: ["r", "R"], vuex: ["markup", "Vue"], ini: ["ini", "INI"],
    env: ["ini", "Environment"], txt: ["plain", "Plain text"], log: ["plain", "Log"],
  };

  const NAME_LANGUAGES = {
    dockerfile: ["dockerfile", "Dockerfile"], makefile: ["makefile", "Makefile"],
    rakefile: ["ruby", "Ruby"], gemfile: ["ruby", "Ruby"],
    "package.json": ["json", "JSON"], "tsconfig.json": ["json", "JSON"],
    ".gitignore": ["gitignore", "Git ignore"], ".editorconfig": ["ini", "EditorConfig"],
  };

  const KEYWORDS = {
    javascript: "as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch throw try typeof var void while with yield",
    typescript: "abstract any as asserts async await bigint boolean break case catch class const constructor continue declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object of override private protected public readonly require return satisfies set static string super switch symbol this throw try type typeof undefined unique unknown var void while with yield",
    rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
    python: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield",
    c: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while",
    cpp: "alignas alignof and asm auto bitand bitor bool break case catch char class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not nullptr operator or private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor",
    csharp: "abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach from get global goto if implicit in int interface internal into is join let lock long namespace new null object operator out override params partial private protected public readonly record ref return sbyte sealed select set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using value var virtual void volatile when where while yield",
    java: "abstract assert boolean break byte case catch char class const continue default do double else enum exports extends final finally float for goto if implements import instanceof int interface long module native new non-sealed null open opens package permits private protected provides public record requires return sealed short static strictfp super switch synchronized this throw throws to transient transitive true try uses var void volatile while with yield",
    kotlin: "as break by catch class constructor continue crossinline data delegate do dynamic else enum expect external false field file final finally for fun get if import in infix init inline inner interface internal is lateinit noinline null object open operator out override package param private property protected public receiver reified return sealed set setparam super suspend tailrec this throw true try typealias typeof val var vararg when where while",
    go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
    php: "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield",
    ruby: "alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield",
    shell: "case do done elif else esac export fi for function if in local readonly return select then time trap until while",
    powershell: "begin break catch class continue data do dynamicparam else elseif end enum exit filter finally for foreach from function if in inlineScript parallel param process return sequence switch throw trap try until using var while workflow",
    sql: "add all alter and any as asc backup between by case check column constraint create database default delete desc distinct drop exec exists foreign from full group having in index inner insert into is join key left like limit not null on or order outer primary procedure right rownum select set table top truncate union unique update values view where with",
    lua: "and break do else elseif end false for function goto if in local nil not or repeat return then true until while",
    dart: "abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for Function get hide if implements import in interface is late library mixin new null on operator part required rethrow return set show static super switch sync this throw true try typedef var void while with yield",
    swift: "Any as associatedtype async await break case catch class continue convenience default defer deinit didSet do dynamic else enum extension fallthrough false fileprivate final for func get guard if import in indirect infix init inout internal is lazy let mutating nil nonmutating open operator optional override precedencegroup private protocol public repeat required rethrows return self Self set some static struct subscript super switch throw throws true try typealias unowned var weak where while willSet",
    elixir: "after alias and case catch cond def defdelegate defexception defguard defimpl defmacro defmodule defp defprotocol defstruct do else end fn for if import in not or quote raise receive require rescue try unless unquote use when",
    erlang: "after begin case catch cond end fun if let of query receive try when",
    haskell: "as case class data default deriving do else family forall foreign hiding if import in infix infixl infixr instance let mdo module newtype of qualified rec role safe then type unsafe where",
    r: "break else FALSE for function if Inf NA NaN next NULL repeat return TRUE while",
  };

  const KEYWORD_SETS = Object.fromEntries(
    Object.entries(KEYWORDS).map(([id, words]) => [id, new Set(words.split(/\s+/))]),
  );
  const LITERALS = new Set(["true", "false", "null", "undefined", "None", "True", "False", "nil", "NaN", "Infinity"]);
  const TYPE_WORDS = new Set([
    "bool", "boolean", "byte", "char", "decimal", "double", "float", "int", "long", "number", "object", "short", "string", "str", "symbol", "void",
    "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64", "Vec", "Option", "Result", "String",
  ]);
  const HASH_COMMENT = new Set(["python", "ruby", "shell", "powershell", "yaml", "toml", "makefile", "dockerfile", "r"]);
  const DASH_COMMENT = new Set(["sql", "lua", "haskell"]);
  const BLOCK_COMMENT = new Set(["javascript", "typescript", "rust", "c", "cpp", "csharp", "java", "kotlin", "go", "php", "css", "sql", "dart", "swift"]);

  function languageForPath(filePath) {
    const normalized = String(filePath || "").replace(/\\/g, "/");
    const base = normalized.slice(normalized.lastIndexOf("/") + 1);
    const lower = base.toLowerCase();
    let found = NAME_LANGUAGES[lower];
    if (!found) {
      const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
      found = LANGUAGE_BY_EXTENSION[ext];
    }
    const [id, label] = found || ["plain", lower.includes(".") ? "Text" : "File"];
    return { id, label, extension: lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "" };
  }

  function push(tokens, type, text) {
    if (!text) return;
    const previous = tokens[tokens.length - 1];
    if (previous?.type === type) previous.text += text;
    else tokens.push({ type, text });
  }

  function markdownTokens(source) {
    const out = [];
    let fenced = false;
    for (const line of String(source).split(/(?<=\n)/)) {
      const body = line.replace(/\n$/, "");
      const newline = line.endsWith("\n") ? "\n" : "";
      if (/^\s*```/.test(body)) {
        push(out, "keyword", body);
        fenced = !fenced;
      } else if (fenced) push(out, "code", body);
      else if (/^\s{0,3}#{1,6}\s/.test(body)) push(out, "heading", body);
      else if (/^\s*>/.test(body)) push(out, "comment", body);
      else if (/^\s*(?:[-*+] |\d+\. )/.test(body)) push(out, "operator", body);
      else {
        let cursor = 0;
        const pattern = /(`[^`]+`|\[[^\]]+\]\([^\)]+\)|\*\*[^*]+\*\*)/g;
        for (const match of body.matchAll(pattern)) {
          push(out, "plain", body.slice(cursor, match.index));
          push(out, match[0].startsWith("`") ? "code" : "string", match[0]);
          cursor = match.index + match[0].length;
        }
        push(out, "plain", body.slice(cursor));
      }
      push(out, "plain", newline);
    }
    return out;
  }

  function tokenize(source, languageInput) {
    const text = String(source ?? "").replace(/\r\n?/g, "\n");
    const language = typeof languageInput === "string" ? languageInput : languageInput?.id || "plain";
    if (language === "plain" || language === "gitignore") return [{ type: "plain", text }];
    if (language === "markdown") return markdownTokens(text);

    const tokens = [];
    const keywords = KEYWORD_SETS[language] || new Set();
    const hasSlashComment = !new Set(["json", "yaml", "toml", "ini", "css", "markup", "sql", "shell", "powershell", "python", "ruby", "makefile", "dockerfile", "haskell", "r"]).has(language);
    let i = 0;
    let inMarkupTag = false;
    let expectTagName = false;
    while (i < text.length) {
      const rest = text.slice(i);
      if (language === "markup" && rest.startsWith("<!--")) {
        const end = text.indexOf("-->", i + 4);
        const stop = end < 0 ? text.length : end + 3;
        push(tokens, "comment", text.slice(i, stop)); i = stop; continue;
      }
      if (BLOCK_COMMENT.has(language) && rest.startsWith("/*")) {
        const end = text.indexOf("*/", i + 2);
        const stop = end < 0 ? text.length : end + 2;
        push(tokens, "comment", text.slice(i, stop)); i = stop; continue;
      }
      if ((hasSlashComment && rest.startsWith("//")) || (DASH_COMMENT.has(language) && rest.startsWith("--")) || (HASH_COMMENT.has(language) && text[i] === "#")) {
        const end = text.indexOf("\n", i);
        const stop = end < 0 ? text.length : end;
        push(tokens, "comment", text.slice(i, stop)); i = stop; continue;
      }
      const ch = text[i];
      if (/\s/.test(ch)) {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        push(tokens, "plain", text.slice(i, j)); i = j; continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        let j = i + 1;
        while (j < text.length) {
          if (text[j] === "\\") { j += 2; continue; }
          if (text[j] === ch) { j++; break; }
          j++;
        }
        const after = text.slice(j).match(/^\s*/)?.[0].length || 0;
        const isProperty = (language === "json" || language === "yaml" || language === "toml") && text[j + after] === ":";
        push(tokens, isProperty ? "property" : "string", text.slice(i, j)); i = j; continue;
      }
      const number = rest.match(/^(?:0x[\da-f]+|0b[01]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i);
      if (number) { push(tokens, "number", number[0]); i += number[0].length; continue; }
      if (language === "markup" && ch === "<") {
        const marker = rest.startsWith("</") ? "</" : rest.startsWith("<!") ? "<!" : "<";
        push(tokens, "punctuation", marker); i += marker.length; inMarkupTag = true; expectTagName = true; continue;
      }
      if (language === "markup" && ch === ">") {
        push(tokens, "punctuation", ch); i++; inMarkupTag = false; expectTagName = false; continue;
      }
      const identifier = rest.match(/^[A-Za-z_$][\w$-]*/);
      if (identifier) {
        const word = identifier[0];
        let j = i + word.length;
        while (j < text.length && /\s/.test(text[j])) j++;
        let type = "plain";
        if (language === "markup" && inMarkupTag) {
          type = expectTagName ? "tag" : "attribute";
          expectTagName = false;
        } else if (keywords.has(word) || keywords.has(word.toLowerCase())) type = "keyword";
        else if (LITERALS.has(word)) type = "literal";
        else if (TYPE_WORDS.has(word) || TYPE_WORDS.has(word.toLowerCase())) type = "type";
        else if ((language === "json" || language === "yaml" || language === "toml" || language === "css" || language === "ini") && /[:=]/.test(text[j] || "")) type = "property";
        else if (text[j] === "(") type = "function";
        else if (/^[A-Z][A-Za-z0-9_$]*$/.test(word)) type = "type";
        push(tokens, type, word); i += word.length; continue;
      }
      const operator = rest.match(/^(?:=>|===|!==|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|\?\.|::|->|\+=|-=|\*=|\/=|\.\.|[+\-*\/%=&|!<>?:~])/);
      if (operator) { push(tokens, "operator", operator[0]); i += operator[0].length; continue; }
      push(tokens, "punctuation", ch); i++;
    }
    return tokens;
  }

  function render(codeElement, source, filePath, options = {}) {
    if (!codeElement || !global.document) return { highlighted: false, lineCount: 0, language: languageForPath(filePath) };
    const text = String(source ?? "").replace(/\r\n?/g, "\n");
    const language = languageForPath(filePath);
    const maxChars = Number(options.maxChars) || 500_000;
    const limited = text.length > maxChars;
    const highlighted = language.id !== "plain" && !limited;
    if (limited) {
      const lineCount = (text.match(/\n/g) || []).length + 1;
      codeElement.textContent = text;
      codeElement.dataset.language = language.id;
      codeElement.setAttribute("aria-label", `${language.label} source code, ${lineCount} lines`);
      return { highlighted: false, limited: true, lineCount, language };
    }
    const tokens = highlighted ? tokenize(text, language.id) : [{ type: "plain", text }];
    const fragment = document.createDocumentFragment();
    let lineNumber = 1;
    let lineContent = null;

    function newLine() {
      const line = document.createElement("span");
      line.className = "code-line";
      const number = document.createElement("span");
      number.className = "code-line-number";
      number.textContent = String(lineNumber++);
      number.setAttribute("aria-hidden", "true");
      lineContent = document.createElement("span");
      lineContent.className = "code-line-content";
      line.append(number, lineContent);
      fragment.appendChild(line);
    }

    newLine();
    for (const token of tokens) {
      const pieces = token.text.split("\n");
      pieces.forEach((piece, index) => {
        if (piece) {
          const span = document.createElement("span");
          span.className = token.type === "plain" ? "tok-plain" : `tok-${token.type}`;
          span.textContent = piece;
          lineContent.appendChild(span);
        }
        if (index < pieces.length - 1) newLine();
      });
    }
    codeElement.replaceChildren(fragment);
    codeElement.dataset.language = language.id;
    codeElement.setAttribute("aria-label", `${language.label} source code, ${lineNumber - 1} lines`);
    return { highlighted, limited: false, lineCount: lineNumber - 1, language };
  }

  global.GrokSyntax = { languageForPath, tokenize, render };
})(typeof window !== "undefined" ? window : globalThis);
