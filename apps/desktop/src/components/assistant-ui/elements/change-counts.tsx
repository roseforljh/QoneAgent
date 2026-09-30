export function ChangeCounts({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="shrink-0 font-mono text-[11px] tabular-nums">
    <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{" "}
    <span className="text-rose-600 dark:text-rose-400">−{deletions}</span>
  </span>;
}
