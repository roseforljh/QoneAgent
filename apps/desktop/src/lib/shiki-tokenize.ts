import { bundledLanguages, getSingletonHighlighter, type BundledLanguage, type BundledTheme, type GrammarState, type HighlighterGeneric, type LanguageInput, type SpecialLanguage, type ThemedToken } from "shiki";
import { guessEmbeddedLanguages, isSpecialLang } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/** 单个语法着色片段：无样式时直接存字符串，有样式时存 [文本, color?, fontStyle位掩码?] */
export type HighlightToken = string | readonly [content: string, color?: string, fontStyle?: number];
export type HighlightLine = readonly HighlightToken[];

export interface HighlightThemes {
  dark: string;
  light: string;
}

export const DEFAULT_HIGHLIGHT_THEMES: HighlightThemes = {
  dark: "github-dark-default",
  light: "github-light-default",
};

/** 每批分词的行数：首屏 ~120 行迅速返回，同时保持 Worker 可被取消打断 */
export const HIGHLIGHT_CHUNK_LINES = 120;
/** 单行超过此字符数（如压缩后的单行 bundle）跳过正则分词，防止正则回溯卡死 */
const MAX_LINE_LENGTH = 8_000;
/** 超大文件只高亮前 N 行，避免后台无限占用 CPU 与内存 */
const MAX_HIGHLIGHT_LINES = 20_000;

let enginePromise: ReturnType<typeof createJavaScriptRegexEngine> | undefined;

function getJsEngine() {
  // 延续轻内存策略，使用 Shiki JS 正则引擎并开启 forgiving 容错
  enginePromise ??= createJavaScriptRegexEngine({ forgiving: true });
  return enginePromise;
}

function resolveFontStyleMask(token: ThemedToken): number {
  if (token.fontStyle && token.fontStyle > 0) return token.fontStyle;
  const style = typeof token.htmlStyle === "object" && token.htmlStyle ? token.htmlStyle : undefined;
  if (!style) return 0;
  let mask = 0;
  if (style["font-style"] === "italic") mask |= 1;
  if (style["font-weight"] === "bold" || Number(style["font-weight"]) >= 600) mask |= 2;
  if (style["text-decoration"]?.includes("underline")) mask |= 4;
  if (style["text-decoration"]?.includes("line-through")) mask |= 8;
  return mask;
}

function compactLine(tokens: readonly ThemedToken[]): HighlightLine {
  const result: HighlightToken[] = [];
  for (const token of tokens) {
    if (!token.content) continue;
    const color = typeof token.htmlStyle === "object" && token.htmlStyle ? token.htmlStyle.color : token.color;
    const fontStyle = resolveFontStyleMask(token);
    if (!color && !fontStyle) {
      const prev = result.at(-1);
      if (typeof prev === "string") result[result.length - 1] = prev + token.content;
      else result.push(token.content);
    } else if (fontStyle) {
      result.push([token.content, color, fontStyle]);
    } else {
      result.push([token.content, color]);
    }
  }
  return result;
}

const PLAIN_LANGS = new Set(["", "text", "txt", "plain", "plaintext"]);

export function isPlainLanguage(language?: string): boolean {
  return !language || PLAIN_LANGS.has(language.trim().toLowerCase());
}

/**
 * 分块执行 Shiki 分词，并通过 grammarState 保持跨块语法上下文（多行注释/模板字符串）。
 * 每处理一块后让出事件循环，支持随时取消。
 */
export async function tokenizeLinesInChunks(params: {
  lines: readonly string[];
  language: string;
  themes?: HighlightThemes;
  chunkSize?: number;
  isCancelled: () => boolean;
  onChunk: (startLine: number, lines: HighlightLine[], done: boolean) => void;
}): Promise<void> {
  const { lines, language, themes = DEFAULT_HIGHLIGHT_THEMES, chunkSize = HIGHLIGHT_CHUNK_LINES, isCancelled, onChunk } = params;
  const total = Math.min(lines.length, MAX_HIGHLIGHT_LINES);
  if (total === 0) {
    onChunk(0, [], true);
    return;
  }

  const normalized = language.trim().toLowerCase();
  const loadable = normalized in bundledLanguages;
  const targetLang = loadable ? normalized : "plaintext";

  const highlighter: HighlighterGeneric<BundledLanguage, BundledTheme> = await getSingletonHighlighter({
    langs: loadable ? [targetLang as BundledLanguage] : [],
    themes: [themes.dark as BundledTheme, themes.light as BundledTheme],
    engine: getJsEngine(),
  });
  if (isCancelled()) return;

  // 仅取前 40KB 探测嵌入语言，避免超大文件反复全量正则扫描
  if (loadable) {
    const sample = lines.slice(0, Math.min(total, 600)).join("\n").slice(0, 40_000);
    const bundled = highlighter.getBundledLanguages() as Record<string, LanguageInput | undefined>;
    const embedded = guessEmbeddedLanguages(sample, targetLang).flatMap((lang) => {
      const entry = bundled[lang];
      return entry ? [entry] : [];
    });
    if (embedded.length) {
      await highlighter.loadLanguage(...embedded);
      if (isCancelled()) return;
    }
  }

  const loaded = highlighter.getLoadedLanguages();
  const effectiveLang = (isSpecialLang(targetLang) || loaded.includes(targetLang) ? targetLang : "plaintext") as BundledLanguage | SpecialLanguage;
  if (effectiveLang === "plaintext") {
    onChunk(0, [], true);
    return;
  }

  const baseOptions = {
    lang: effectiveLang,
    themes: { dark: themes.dark as BundledTheme, light: themes.light as BundledTheme },
    defaultColor: "light-dark()" as const,
  };

  let grammarState: GrammarState | undefined;
  let offset = 0;

  while (offset < total) {
    if (isCancelled()) return;
    const end = Math.min(offset + chunkSize, total);
    const chunkOut: HighlightLine[] = [];

    // 将连续的正常长度行打包送入 Shiki，遇到超长行则跳过正则分词
    let runStart = offset;
    const flushRun = (runEnd: number) => {
      if (runEnd <= runStart) return;
      const snippet = lines.slice(runStart, runEnd).join("\n");
      const result = highlighter.codeToTokens(snippet, grammarState ? { ...baseOptions, grammarState } : baseOptions);
      grammarState = highlighter.getLastGrammarState(result.tokens);
      for (const tokenLine of result.tokens) chunkOut.push(compactLine(tokenLine));
    };

    for (let i = runStart; i < end; i++) {
      const line = lines[i] ?? "";
      if (line.length > MAX_LINE_LENGTH) {
        flushRun(i);
        chunkOut.push(line ? [line] : []);
        runStart = i + 1;
      }
    }
    flushRun(end);

    const done = end >= total;
    onChunk(offset, chunkOut, done);
    offset = end;

    if (!done) {
      // 让出事件循环，确保取消消息与后续高优任务能及时介入
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}
