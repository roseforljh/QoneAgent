import { attachmentFileIcon } from "./attachment-file-kind";
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
import code from "../assets/codex-icons/code-light-16.svg";
import document from "../assets/codex-icons/document-light-16.svg";
import folder from "../assets/codex-icons/folder-light-16.svg";

// Specialized glyphs from Codex's D_i/k_i registry; common kinds reuse our assets.
const specialized: Record<string, string> = {
  ts: typescript, tsx: react, jsx: react,
  js: javascript, mjs: javascript, cjs: javascript, hs: javascript,
  css, scss: css, less: css, sass: css,
  cpp: cplusplus, cxx: cplusplus, cc: cplusplus, c: cplusplus, hpp: cplusplus, hh: cplusplus, h: cplusplus,
  html, htm: html, java, json, jsonc: json, ipynb: notebook, php, py: python, rs: rust,
  sh: shell, bash: shell, zsh: shell, fish: shell, ps1: shell,
  build, bazel: build, bzl: build, ninja: build, gradle: build, mk: build, makefile: build,
  sha: hashes, sha1: hashes, sha256: hashes, md5: hashes, checksum: hashes, sum: hashes,
  dockerfile: terminal, toml,
  rb: code, go: code, kt: code, swift: code, m: code, mm: code, cs: code, sql: code,
  md: document, mdx: document, markdown: document, mkd: document, mdown: document,
  yaml: document, yml: document, xml: document, env: document, dotenv: document, gitignore: document, lock: document,
  zip: folder, gz: folder, tgz: folder, tar: folder,
};

export function markdownFileIcon(path: string): string {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (name === "skill.md") return skill;
  const extension = name.split(".").at(-1) ?? name;
  return specialized[extension] ?? attachmentFileIcon(path, "");
}
