/** Let the directory yield space before truncating the filename. */
export function FileChangePath({ path }: { path: string }) {
  const normalized = path.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  const directory = normalized.slice(0, separator + 1);
  const filename = normalized.slice(separator + 1);
  return <span className="flex min-w-0 flex-1 items-center font-mono text-xs" aria-hidden="true">
    {directory && <span data-slot="file-change-directory" className="min-w-0 truncate text-foreground/50">{directory}</span>}
    <span data-slot="file-change-filename" className="max-w-full shrink-0 truncate text-foreground">{filename}</span>
  </span>;
}
