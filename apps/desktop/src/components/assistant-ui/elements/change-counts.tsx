export function ChangeCounts({ additions, deletions, colorOnHover = false }: { additions: number; deletions: number; colorOnHover?: boolean }) {
  return <span className="shrink-0 font-mono text-[11px] tabular-nums">
    <span className={colorOnHover
      ? "text-current transition-colors motion-reduce:transition-none group-hover/change-counts:text-emerald-600 dark:group-hover/change-counts:text-emerald-400"
      : "text-emerald-600 dark:text-emerald-400"}>+{additions}</span>{" "}
    <span className={colorOnHover
      ? "text-current transition-colors motion-reduce:transition-none group-hover/change-counts:text-rose-600 dark:group-hover/change-counts:text-rose-400"
      : "text-rose-600 dark:text-rose-400"}>−{deletions}</span>
  </span>;
}
