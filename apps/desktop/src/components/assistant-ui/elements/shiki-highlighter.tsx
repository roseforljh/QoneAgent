"use client";

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import type { ShikiHighlighterProps } from "react-shiki";
import {
  DEFAULT_HIGHLIGHT_THEMES,
  getCachedHighlight,
  isPlainHighlightLanguage,
  renderHighlightLine,
  requestHighlight,
  type HighlightLine,
  type HighlightThemes,
} from "../../../lib/shiki-highlight";
import { cn } from "../../../lib/utils";

/**
 * Props for the SyntaxHighlighter component
 */
export type SyntaxHighlighterProps = Omit<
  ShikiHighlighterProps,
  "children" | "theme"
> & {
  theme?: ShikiHighlighterProps["theme"];
  code: string;
  /** Skips tokenization and renders the plain code while `true`. */
  streaming?: boolean;
  /** File viewers retain leading blank lines and indentation. */
  preserveWhitespace?: boolean;
  /** Stable line markers in both the loading and highlighted render. */
  lineMarkers?: boolean;
};

const containerClassName =
  "aui-shiki-base [&_pre]:border-border/50 [&_pre]:bg-muted/30! [&_.line]:px-0! [&_pre]:overflow-x-auto [&_pre]:rounded-t-none [&_pre]:rounded-b-xl [&_pre]:border [&_pre]:border-t-0 [&_pre]:p-3.5 [&_pre]:text-sm [&_pre]:leading-relaxed";

function normalizeThemes(theme: SyntaxHighlighterProps["theme"] | HighlightThemes): HighlightThemes {
  if (typeof theme === "string" && theme.trim()) return { dark: theme, light: theme };
  if (theme && typeof theme === "object" && !("tokenColors" in theme)) {
    const map = theme as Record<string, unknown>;
    const dark = typeof map.dark === "string" && map.dark.trim() ? map.dark : DEFAULT_HIGHLIGHT_THEMES.dark;
    const light = typeof map.light === "string" && map.light.trim() ? map.light : DEFAULT_HIGHLIGHT_THEMES.light;
    return { dark, light };
  }
  return DEFAULT_HIGHLIGHT_THEMES;
}

const PlainCode: FC<{ code: string; lineMarkers?: boolean }> = ({ code, lineMarkers }) => (
  <pre>
    <code>{lineMarkers ? code.split(/\r?\n/).map((line, index, lines) => <span key={index}>
      <span className="line" data-file-line={index + 1}>{line}</span>{index < lines.length - 1 ? "\n" : ""}
    </span>) : code}</code>
  </pre>
);

const HighlightedCode: FC<{
  code: string;
  language: string;
  themes: HighlightThemes;
  delay: number;
  lineMarkers?: boolean;
}> = ({ code, language, themes, delay, lineMarkers }) => {
  const lines = useMemo(() => code.split(/\r?\n/), [code]);
  const cached = useMemo(
    () => (isPlainHighlightLanguage(language) ? undefined : getCachedHighlight(code, language, themes)),
    [code, language, themes.dark, themes.light],
  );
  const [tokenState, setTokenState] = useState<{ key: string; lines: (HighlightLine | undefined)[] } | null>(() =>
    cached ? { key: `${language}\0${themes.dark}\0${themes.light}\0${code}`, lines: cached } : null,
  );
  const currentKey = `${language}\0${themes.dark}\0${themes.light}\0${code}`;
  const bufferRef = useRef<{ key: string; lines: (HighlightLine | undefined)[] }>({
    key: currentKey,
    lines: cached ? [...cached] : [],
  });
  if (bufferRef.current.key !== currentKey) {
    bufferRef.current = { key: currentKey, lines: cached ? [...cached] : [] };
  }

  useEffect(() => {
    if (cached) {
      setTokenState({ key: currentKey, lines: cached });
      return;
    }
    if (isPlainHighlightLanguage(language) || !code) {
      setTokenState(null);
      return;
    }

    const buffer = bufferRef.current;
    let cancelHighlight: (() => void) | undefined;
    const start = () => {
      cancelHighlight = requestHighlight({
        code,
        lines,
        language,
        themes,
        onChunk: (startLine, chunkLines) => {
          if (bufferRef.current !== buffer) return;
          for (let i = 0; i < chunkLines.length; i++) {
            buffer.lines[startLine + i] = chunkLines[i];
          }
          setTokenState({ key: currentKey, lines: [...buffer.lines] });
        },
      });
    };

    if (delay > 0) {
      const timer = setTimeout(start, delay);
      return () => {
        clearTimeout(timer);
        cancelHighlight?.();
      };
    }
    start();
    return () => cancelHighlight?.();
  }, [cached, code, currentKey, delay, language, lines, themes.dark, themes.light]);

  const highlightedLines = tokenState?.key === currentKey ? tokenState.lines : cached;
  if (!highlightedLines) return <PlainCode code={code} lineMarkers={lineMarkers} />;

  return (
    <pre className="shiki">
      <code>
        {lines.map((line, index) => (
          <span key={index}>
            <span className="line" data-file-line={lineMarkers ? index + 1 : undefined}>
              {renderHighlightLine(highlightedLines[index], line)}
            </span>
            {index < lines.length - 1 ? "\n" : ""}
          </span>
        ))}
      </code>
    </pre>
  );
};

/**
 * SyntaxHighlighter component, backed by the shared Shiki Web Worker.
 *
 * Skips tokenization while `streaming` and renders the plain code in the
 * same container, so streaming costs no Shiki work and settling is a color
 * change rather than a layout shift.
 */
export const SyntaxHighlighter: FC<SyntaxHighlighterProps> = ({
  code,
  language,
  theme = DEFAULT_HIGHLIGHT_THEMES,
  className,
  style,
  // Inert: output has no default styles or language label.
  addDefaultStyles: _addDefaultStyles,
  showLanguage: _showLanguage,
  delay = 150, // the part settles before smooth streaming finishes draining, so code keeps changing for a few frames
  streaming = false,
  preserveWhitespace = false,
  lineMarkers = false,
}) => {
  const trimmed = preserveWhitespace ? code : code.trim();
  const themes = normalizeThemes(theme);
  const resolvedLanguage = typeof language === "string" ? language : "text";

  return (
    <div
      className={cn(
        containerClassName,
        streaming && "aui-shiki-streaming",
        className,
      )}
      style={style}
    >
      {streaming ? (
        <PlainCode code={trimmed} lineMarkers={lineMarkers} />
      ) : (
        <HighlightedCode
          code={trimmed}
          language={resolvedLanguage}
          themes={themes}
          delay={delay}
          lineMarkers={lineMarkers}
        />
      )}
    </div>
  );
};

SyntaxHighlighter.displayName = "SyntaxHighlighter";
