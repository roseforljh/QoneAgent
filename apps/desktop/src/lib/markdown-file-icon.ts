import { attachmentFileIcon, attachmentFileKind, type AttachmentFileKind } from "./attachment-file-kind";
import css from "../assets/codex-icons/file-css-26-928.svg";
import react from "../assets/codex-icons/file-react-26-928.svg";
import typescript from "../assets/codex-icons/file-typescript-26-928.svg";
import javascript from "../assets/codex-icons/file-javascript-26-928.svg";
import cplusplus from "../assets/codex-icons/file-cplusplus-26-928.svg";
import html from "../assets/codex-icons/file-html-26-928.svg";
import java from "../assets/codex-icons/file-java-26-928.svg";
import json from "../assets/codex-icons/file-json-26-928.svg";
import notebook from "../assets/codex-icons/file-notebook-26-928.svg";
import php from "../assets/codex-icons/file-php-26-928.svg";
import python from "../assets/codex-icons/file-python-26-928.svg";
import rust from "../assets/codex-icons/file-rust-26-928.svg";
import shell from "../assets/codex-icons/file-shell-26-928.svg";
import skill from "../assets/codex-icons/file-skill-26-928.svg";
import build from "../assets/codex-icons/file-build-26-928.svg";
import hashes from "../assets/codex-icons/file-hashes-26-928.svg";
import terminal from "../assets/codex-icons/file-terminal-26-928.svg";
import toml from "../assets/codex-icons/file-toml-26-928.svg";
import word from "../assets/codex-icons/ms-word-light-16.svg";
import excel from "../assets/codex-icons/ms-excel-light-16.svg";
import powerpoint from "../assets/codex-icons/ms-powerpoint-light-16.svg";
import spreadsheet from "../assets/codex-icons/spreadsheet-light-16.svg";
import presentation from "../assets/codex-icons/presentation-light-16.svg";
import pdf from "../assets/codex-icons/document-pdf-light-16.svg";
import bookOpen from "../assets/codex-icons/book-open-light-16.svg";
import textDocument from "../assets/codex-icons/document-text-light-16.svg";
import archive from "../assets/codex-icons/document-zip-light-16.svg";
import photo from "../assets/codex-icons/photo-light-16.svg";
import vector from "../assets/codex-icons/paint-palette-light-16.svg";
import design from "../assets/codex-icons/sketch-light-16.svg";
import video from "../assets/codex-icons/video-light-16.svg";
import subtitle from "../assets/codex-icons/film-strip-light-16.svg";
import audio from "../assets/codex-icons/music-note-light-16.svg";
import waveform from "../assets/codex-icons/wavelength-light-16.svg";
import braces from "../assets/codex-icons/braces-light-16.svg";
import table from "../assets/codex-icons/table-light-16.svg";
import config from "../assets/codex-icons/sliders-light-16.svg";
import lock from "../assets/codex-icons/lock-light-16.svg";
import securityKey from "../assets/codex-icons/key-badge-lock-light-16.svg";
import branch from "../assets/codex-icons/branch-light-16.svg";
import font from "../assets/codex-icons/text-format-light-16.svg";
import mail from "../assets/codex-icons/envelope-light-16.svg";
import calendar from "../assets/codex-icons/calendar-light-16.svg";
import webLink from "../assets/codex-icons/globe-light-16.svg";
import binary from "../assets/codex-icons/cube-light-16.svg";
import code from "../assets/codex-icons/code-light-16.svg";
import document from "../assets/codex-icons/document-light-16.svg";
import folder from "../assets/codex-icons/folder-light-16.svg";

export interface FileTypeIconInfo {
  icon: string;
  colorClass: string;
}

const COLORS = {
  word: "text-blue-600 dark:text-blue-400",
  excel: "text-emerald-600 dark:text-emerald-400",
  csv: "text-teal-600 dark:text-teal-400",
  ppt: "text-orange-600 dark:text-orange-400",
  pdf: "text-rose-600 dark:text-rose-400",
  markdown: "text-indigo-600 dark:text-indigo-400",
  skill: "text-violet-600 dark:text-violet-400",
  text: "text-slate-500 dark:text-slate-400",
  image: "text-purple-600 dark:text-purple-400",
  vector: "text-amber-600 dark:text-amber-400",
  design: "text-pink-600 dark:text-pink-400",
  video: "text-fuchsia-600 dark:text-fuchsia-400",
  audio: "text-cyan-600 dark:text-cyan-400",
  typescript: "text-sky-600 dark:text-sky-400",
  react: "text-cyan-500 dark:text-cyan-400",
  javascript: "text-amber-500 dark:text-amber-400",
  css: "text-indigo-500 dark:text-indigo-400",
  html: "text-orange-600 dark:text-orange-400",
  python: "text-yellow-600 dark:text-yellow-400",
  notebook: "text-orange-500 dark:text-orange-400",
  rust: "text-orange-700 dark:text-orange-400",
  cplusplus: "text-blue-600 dark:text-blue-400",
  java: "text-red-600 dark:text-red-400",
  php: "text-violet-600 dark:text-violet-400",
  shell: "text-emerald-600 dark:text-emerald-400",
  code: "text-sky-600 dark:text-sky-400",
  json: "text-amber-600 dark:text-amber-400",
  schema: "text-purple-600 dark:text-purple-400",
  database: "text-cyan-600 dark:text-cyan-400",
  config: "text-slate-500 dark:text-slate-300",
  docker: "text-sky-500 dark:text-sky-400",
  build: "text-amber-600 dark:text-amber-400",
  git: "text-orange-600 dark:text-orange-400",
  lock: "text-amber-700 dark:text-amber-400",
  key: "text-emerald-600 dark:text-emerald-400",
  archive: "text-amber-600 dark:text-amber-400",
  font: "text-rose-500 dark:text-rose-400",
  mail: "text-sky-600 dark:text-sky-400",
  calendar: "text-teal-600 dark:text-teal-400",
  web: "text-blue-500 dark:text-blue-400",
  binary: "text-violet-500 dark:text-violet-400",
  folder: "text-amber-500 dark:text-amber-400",
  default: "text-slate-500 dark:text-slate-400",
} as const;

const KIND_COLORS: Record<AttachmentFileKind, string> = {
  folder: COLORS.folder,
  image: COLORS.image,
  pdf: COLORS.pdf,
  spreadsheet: COLORS.excel,
  presentation: COLORS.ppt,
  document: COLORS.markdown,
  code: COLORS.code,
  archive: COLORS.archive,
  audio: COLORS.audio,
  video: COLORS.video,
  file: COLORS.default,
};

const v = (icon: string, colorClass: string): FileTypeIconInfo => ({ icon, colorClass });

// 按完整文件名优先匹配特定工程文件
const exactNameIcons: Record<string, FileTypeIconInfo> = {
  "skill.md": v(skill, COLORS.skill),
  dockerfile: v(terminal, COLORS.docker),
  containerfile: v(terminal, COLORS.docker),
  makefile: v(build, COLORS.build),
  "cmakelists.txt": v(build, COLORS.build),
  build: v(build, COLORS.build),
  "build.bazel": v(build, COLORS.build),
  workspace: v(build, COLORS.build),
  justfile: v(build, COLORS.build),
  rakefile: v(build, COLORS.build),
  gemfile: v(build, COLORS.build),
  podfile: v(build, COLORS.build),
  "package-lock.json": v(lock, COLORS.lock),
  "pnpm-lock.yaml": v(lock, COLORS.lock),
  "yarn.lock": v(lock, COLORS.lock),
  "bun.lock": v(lock, COLORS.lock),
  "bun.lockb": v(lock, COLORS.lock),
  "cargo.lock": v(lock, COLORS.lock),
  "poetry.lock": v(lock, COLORS.lock),
  "gemfile.lock": v(lock, COLORS.lock),
  "composer.lock": v(lock, COLORS.lock),
  "uv.lock": v(lock, COLORS.lock),
  ".gitignore": v(branch, COLORS.git),
  ".gitattributes": v(branch, COLORS.git),
  ".gitmodules": v(branch, COLORS.git),
  ".gitkeep": v(branch, COLORS.git),
  ".env": v(config, COLORS.config),
  ".editorconfig": v(config, COLORS.config),
  ".npmrc": v(config, COLORS.config),
  ".nvmrc": v(config, COLORS.config),
  ".prettierrc": v(config, COLORS.config),
  ".eslintrc": v(config, COLORS.config),
  ".babelrc": v(config, COLORS.config),
  license: v(bookOpen, COLORS.markdown),
};

// 按扩展名细化文档、办公格式、多媒体、编程语言与工程配置文件图标及色彩
const extensionIcons: Record<string, FileTypeIconInfo> = {
  // 办公文档与电子书
  doc: v(word, COLORS.word), docx: v(word, COLORS.word), odt: v(word, COLORS.word), pages: v(word, COLORS.word), rtf: v(word, COLORS.word),
  xls: v(excel, COLORS.excel), xlsx: v(excel, COLORS.excel), xlsm: v(excel, COLORS.excel), xlsb: v(excel, COLORS.excel), ods: v(excel, COLORS.excel), numbers: v(excel, COLORS.excel),
  csv: v(spreadsheet, COLORS.csv), tsv: v(spreadsheet, COLORS.csv),
  ppt: v(powerpoint, COLORS.ppt), pptx: v(powerpoint, COLORS.ppt),
  key: v(presentation, COLORS.ppt), odp: v(presentation, COLORS.ppt),
  pdf: v(pdf, COLORS.pdf),
  md: v(bookOpen, COLORS.markdown), mdx: v(bookOpen, COLORS.markdown), markdown: v(bookOpen, COLORS.markdown), mkd: v(bookOpen, COLORS.markdown), mdown: v(bookOpen, COLORS.markdown),
  rst: v(bookOpen, COLORS.markdown), adoc: v(bookOpen, COLORS.markdown), tex: v(bookOpen, COLORS.markdown), epub: v(bookOpen, COLORS.markdown),
  txt: v(textDocument, COLORS.text), text: v(textDocument, COLORS.text), log: v(textDocument, COLORS.text), out: v(textDocument, COLORS.text),

  // 图片、矢量与设计源文件
  png: v(photo, COLORS.image), jpg: v(photo, COLORS.image), jpeg: v(photo, COLORS.image), gif: v(photo, COLORS.image), webp: v(photo, COLORS.image), bmp: v(photo, COLORS.image),
  heic: v(photo, COLORS.image), heif: v(photo, COLORS.image), avif: v(photo, COLORS.image), ico: v(photo, COLORS.image), tif: v(photo, COLORS.image), tiff: v(photo, COLORS.image), psd: v(photo, COLORS.image), raw: v(photo, COLORS.image),
  svg: v(vector, COLORS.vector), ai: v(vector, COLORS.vector), eps: v(vector, COLORS.vector),
  sketch: v(design, COLORS.design), fig: v(design, COLORS.design), xd: v(design, COLORS.design),

  // 视频、字幕与音频
  mp4: v(video, COLORS.video), mov: v(video, COLORS.video), mkv: v(video, COLORS.video), avi: v(video, COLORS.video), webm: v(video, COLORS.video), flv: v(video, COLORS.video), m4v: v(video, COLORS.video), wmv: v(video, COLORS.video),
  srt: v(subtitle, COLORS.video), vtt: v(subtitle, COLORS.video), ass: v(subtitle, COLORS.video), ssa: v(subtitle, COLORS.video), m3u8: v(subtitle, COLORS.video),
  mp3: v(audio, COLORS.audio), flac: v(audio, COLORS.audio), aac: v(audio, COLORS.audio), m4a: v(audio, COLORS.audio), ogg: v(audio, COLORS.audio), opus: v(audio, COLORS.audio), wma: v(audio, COLORS.audio), mid: v(audio, COLORS.audio), midi: v(audio, COLORS.audio),
  wav: v(waveform, COLORS.audio), aiff: v(waveform, COLORS.audio), amr: v(waveform, COLORS.audio), pcm: v(waveform, COLORS.audio),

  // 编程语言（细分常见语言）
  ts: v(typescript, COLORS.typescript), mts: v(typescript, COLORS.typescript), cts: v(typescript, COLORS.typescript),
  tsx: v(react, COLORS.react), jsx: v(react, COLORS.react),
  js: v(javascript, COLORS.javascript), mjs: v(javascript, COLORS.javascript), cjs: v(javascript, COLORS.javascript),
  css: v(css, COLORS.css), scss: v(css, COLORS.css), sass: v(css, COLORS.css), less: v(css, COLORS.css), styl: v(css, COLORS.css), pcss: v(css, COLORS.css),
  html: v(html, COLORS.html), htm: v(html, COLORS.html), xhtml: v(html, COLORS.html), vue: v(html, COLORS.excel), svelte: v(html, COLORS.html), astro: v(html, COLORS.html),
  py: v(python, COLORS.python), pyi: v(python, COLORS.python), pyw: v(python, COLORS.python),
  ipynb: v(notebook, COLORS.notebook),
  rs: v(rust, COLORS.rust),
  c: v(cplusplus, COLORS.cplusplus), cc: v(cplusplus, COLORS.cplusplus), cpp: v(cplusplus, COLORS.cplusplus), cxx: v(cplusplus, COLORS.cplusplus),
  h: v(cplusplus, COLORS.cplusplus), hh: v(cplusplus, COLORS.cplusplus), hpp: v(cplusplus, COLORS.cplusplus), hxx: v(cplusplus, COLORS.cplusplus), m: v(cplusplus, COLORS.cplusplus), mm: v(cplusplus, COLORS.cplusplus),
  java: v(java, COLORS.java), jar: v(java, COLORS.java), class: v(java, COLORS.java),
  php: v(php, COLORS.php), phtml: v(php, COLORS.php),
  sh: v(shell, COLORS.shell), bash: v(shell, COLORS.shell), zsh: v(shell, COLORS.shell), fish: v(shell, COLORS.shell), ps1: v(shell, COLORS.shell), psm1: v(shell, COLORS.shell), bat: v(shell, COLORS.shell), cmd: v(shell, COLORS.shell),
  go: v(code, COLORS.react), kt: v(code, COLORS.php), kts: v(code, COLORS.php), swift: v(code, COLORS.html), cs: v(code, COLORS.excel), rb: v(code, COLORS.java), dart: v(code, COLORS.typescript), lua: v(code, COLORS.word),
  zig: v(code, COLORS.javascript), ex: v(code, COLORS.php), exs: v(code, COLORS.php), scala: v(code, COLORS.java), r: v(code, COLORS.typescript), pl: v(code, COLORS.code), hs: v(code, COLORS.php), clj: v(code, COLORS.excel),
  erl: v(code, COLORS.java), jl: v(code, COLORS.php), sol: v(code, COLORS.config), nim: v(code, COLORS.javascript), ml: v(code, COLORS.html), fs: v(code, COLORS.typescript),

  // 结构化数据、数据库与配置
  json: v(json, COLORS.json), jsonc: v(json, COLORS.json), json5: v(json, COLORS.json), jsonl: v(json, COLORS.json), ndjson: v(json, COLORS.json), geojson: v(json, COLORS.json),
  toml: v(toml, COLORS.schema),
  yaml: v(braces, COLORS.schema), yml: v(braces, COLORS.schema), xml: v(braces, COLORS.html), plist: v(braces, COLORS.schema), xaml: v(braces, COLORS.word),
  graphql: v(braces, COLORS.design), gql: v(braces, COLORS.design), proto: v(braces, COLORS.database), prisma: v(braces, COLORS.database), hcl: v(braces, COLORS.schema), tf: v(braces, COLORS.schema),
  sql: v(table, COLORS.database), db: v(table, COLORS.database), sqlite: v(table, COLORS.database), sqlite3: v(table, COLORS.database), duckdb: v(table, COLORS.json), parquet: v(table, COLORS.database), arrow: v(table, COLORS.database),
  env: v(config, COLORS.config), dotenv: v(config, COLORS.config), ini: v(config, COLORS.config), cfg: v(config, COLORS.config), conf: v(config, COLORS.config), config: v(config, COLORS.config), properties: v(config, COLORS.config),

  // 构建、容器、安全与版本控制
  build: v(build, COLORS.build), bazel: v(build, COLORS.build), bzl: v(build, COLORS.build), ninja: v(build, COLORS.build), gradle: v(build, COLORS.build), mk: v(build, COLORS.build), cmake: v(build, COLORS.build), makefile: v(build, COLORS.build),
  dockerfile: v(terminal, COLORS.docker),
  sha: v(hashes, COLORS.key), sha1: v(hashes, COLORS.key), sha256: v(hashes, COLORS.key), sha512: v(hashes, COLORS.key), md5: v(hashes, COLORS.key), checksum: v(hashes, COLORS.key), sum: v(hashes, COLORS.key),
  lock: v(lock, COLORS.lock), lockb: v(lock, COLORS.lock),
  pem: v(securityKey, COLORS.key), pub: v(securityKey, COLORS.key), crt: v(securityKey, COLORS.key), cer: v(securityKey, COLORS.key), p12: v(securityKey, COLORS.key), pfx: v(securityKey, COLORS.key), jks: v(securityKey, COLORS.key),
  gitignore: v(branch, COLORS.git), patch: v(branch, COLORS.git), diff: v(branch, COLORS.git),

  // 压缩包、字体、邮件、日历、链接与二进制包
  zip: v(archive, COLORS.archive), gz: v(archive, COLORS.archive), tgz: v(archive, COLORS.archive), tar: v(archive, COLORS.archive), "7z": v(archive, COLORS.archive), rar: v(archive, COLORS.archive), bz2: v(archive, COLORS.archive), xz: v(archive, COLORS.archive), zst: v(archive, COLORS.archive),
  ttf: v(font, COLORS.font), otf: v(font, COLORS.font), woff: v(font, COLORS.font), woff2: v(font, COLORS.font), eot: v(font, COLORS.font),
  eml: v(mail, COLORS.mail), msg: v(mail, COLORS.mail),
  ics: v(calendar, COLORS.calendar),
  url: v(webLink, COLORS.web), webloc: v(webLink, COLORS.web), har: v(webLink, COLORS.web),
  wasm: v(binary, COLORS.binary), exe: v(binary, COLORS.binary), msi: v(binary, COLORS.binary), dmg: v(binary, COLORS.binary), pkg: v(binary, COLORS.binary), apk: v(binary, COLORS.excel), ipa: v(binary, COLORS.typescript),
  deb: v(binary, COLORS.pdf), rpm: v(binary, COLORS.pdf), dll: v(binary, COLORS.binary), so: v(binary, COLORS.binary), dylib: v(binary, COLORS.binary), obj: v(binary, COLORS.binary), stl: v(binary, COLORS.binary), glb: v(binary, COLORS.binary), gltf: v(binary, COLORS.binary), fbx: v(binary, COLORS.binary),
};

/** 按文件名、扩展名和可选 MIME 类型返回细化图标及语义色彩类。 */
export function fileTypeIconInfo(path: string, mimeType = ""): FileTypeIconInfo {
  const trimmed = path.trim();
  if (trimmed.endsWith("/") || trimmed.endsWith("\\")) return v(folder, COLORS.folder);
  const name = trimmed.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (exactNameIcons[name]) return exactNameIcons[name]!;
  if (name.startsWith("dockerfile.")) return v(terminal, COLORS.docker);
  if (name.startsWith(".env.")) return v(config, COLORS.config);
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const extension = name.slice(dot + 1);
    if (extensionIcons[extension]) return extensionIcons[extension]!;
  } else if (dot === 0) {
    const hiddenExt = name.slice(1);
    if (extensionIcons[hiddenExt]) return extensionIcons[hiddenExt]!;
  }
  if (mimeType) {
    return v(attachmentFileIcon(path, mimeType), KIND_COLORS[attachmentFileKind(path, mimeType)]);
  }
  return v(document, COLORS.default);
}

/** 按文件名、扩展名和可选 MIME 类型返回细化后的 Codex 单色图标。 */
export function fileTypeIcon(path: string, mimeType = ""): string {
  return fileTypeIconInfo(path, mimeType).icon;
}

export function markdownFileIcon(path: string): string {
  return fileTypeIcon(path);
}
