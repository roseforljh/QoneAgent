import { useEffect, useState } from "react";
import { CloudDownload, LoaderCircle, Search, X } from "lucide-react";
import type { CloudSkillInfo } from "@qone/protocol";
import { requestSkillCloud, useStore } from "../../store";
import { useLocale } from "../../localization";
import "./skill-cloud.css";

type Collection = "popular" | "trending" | "official";

export function SkillCloudDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const installed = useStore((state) => state.skills);
  const [collection, setCollection] = useState<Collection>("popular");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CloudSkillInfo[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<CloudSkillInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState("");
  const [installedKeys, setInstalledKeys] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setItems([]);
    setPage(1);
    setHasMore(false);
    setError("");
    const timer = window.setTimeout(() => {
      requestSkillCloud({ type: "skills.cloud.list", collection, page: 1, query: query.trim() })
        .then((response) => {
          if (cancelled || response.type !== "skills.cloud.list") return;
          setItems(response.skills);
          setPage(response.page);
          setHasMore(response.hasMore);
        })
        .catch((cause) => { if (!cancelled) setError(String(cause instanceof Error ? cause.message : cause)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, query.trim() ? 250 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [collection, query, retry]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const response = await requestSkillCloud({ type: "skills.cloud.list", collection, page: page + 1 });
      if (response.type !== "skills.cloud.list") throw new Error(t("skills.cloud.invalidResponse"));
      setItems((current) => {
        const seen = new Set(current.map((item) => `${item.source}#${item.skillId}`));
        return [...current, ...response.skills.filter((item) => !seen.has(`${item.source}#${item.skillId}`))];
      });
      setPage(response.page);
      setHasMore(response.hasMore);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setLoadingMore(false);
    }
  };

  const install = async () => {
    if (!selected || installing) return;
    setInstalling(true);
    setInstallError("");
    try {
      const response = await requestSkillCloud({ type: "skills.cloud.install", source: selected.source, skillId: selected.skillId });
      if (response.type !== "skills.cloud.installed") throw new Error(t("skills.cloud.invalidResponse"));
      setInstalledKeys((current) => [...current, `${selected.source}#${selected.skillId}`]);
      setSelected(null);
    } catch (cause) {
      setInstallError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="settings-subdialog-layer">
      <div className="settings-subdialog skill-cloud-dialog" role="dialog" aria-modal="true" aria-label={t("skills.cloud.title")}>
        <div className="settings-subdialog-header">
          <div><span>SKILLS.SH</span><h3>{t("skills.cloud.title")}</h3></div>
          <button type="button" className="settings-dialog-close" onClick={onClose} aria-label={t("common.close")}><X size={17} /></button>
        </div>
        <p className="skill-cloud-intro">{t("skills.cloud.description")}</p>
        <div className="skill-cloud-controls">
          <div className="skill-cloud-tabs" role="tablist" aria-label={t("skills.cloud.title")}>
            {(["popular", "trending", "official"] as const).map((value) => (
              <button key={value} type="button" role="tab" aria-selected={collection === value} className={collection === value ? "is-active" : ""} onClick={() => setCollection(value)}>{t(`skills.cloud.${value}`)}</button>
            ))}
          </div>
          <label className="settings-search skill-cloud-search"><Search size={14} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("skills.cloud.search")} /></label>
        </div>
        <div className="skill-cloud-list" aria-live="polite">
          {loading ? <div className="skill-cloud-state"><LoaderCircle className="settings-spin" size={18} />{t("skills.cloud.loading")}</div> :
            error && items.length === 0 ? <div className="skill-cloud-state"><span>{error}</span><button type="button" className="settings-secondary-action" onClick={() => setRetry((value) => value + 1)}>{t("skills.cloud.retry")}</button></div> :
              items.length === 0 ? <div className="skill-cloud-state">{t("skills.cloud.empty")}</div> : items.map((item) => {
                const isInstalled = installed.some((skill) => skill.name === item.skillId) || installedKeys.includes(`${item.source}#${item.skillId}`);
                return <button key={`${item.source}#${item.skillId}`} type="button" className="skill-cloud-item" onClick={() => { setSelected(item); setInstallError(""); }}>
                  <span className="skill-cloud-item-icon"><CloudDownload size={17} /></span>
                  <span className="skill-cloud-item-copy"><strong>{item.name}</strong><small>{item.source}</small></span>
                  <span className="skill-cloud-item-meta">{item.isOfficial && <em>{t("skills.cloud.officialBadge")}</em>}<small>{item.installs.toLocaleString()} {t("skills.cloud.installs")}</small>{isInstalled && <em>{t("skills.cloud.installed")}</em>}</span>
                </button>;
              })}
        </div>
        {error && items.length > 0 && <p className="skill-cloud-error" role="alert">{error}</p>}
        {hasMore && !query.trim() && <div className="skill-cloud-more"><button type="button" className="settings-secondary-action" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? <LoaderCircle className="settings-spin" size={14} /> : null}{t("skills.cloud.more")}</button></div>}
        {selected && <div className="skill-cloud-confirm" role="dialog" aria-modal="true" aria-label={t("skills.cloud.import")}>
          <div className="skill-cloud-confirm-card">
            <div className="settings-subdialog-header"><div><span>{selected.source}</span><h3>{selected.name}</h3></div><button type="button" className="settings-dialog-close" disabled={installing} onClick={() => setSelected(null)} aria-label={t("common.close")}><X size={17} /></button></div>
            <p>{t("skills.cloud.importDescription")}</p>
            {installError && <p className="skill-cloud-error" role="alert">{installError}</p>}
            <div className="settings-subdialog-footer"><button type="button" className="settings-secondary-action" disabled={installing} onClick={() => setSelected(null)}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" disabled={installing || installed.some((skill) => skill.name === selected.skillId) || installedKeys.includes(`${selected.source}#${selected.skillId}`)} onClick={() => void install()}>{installing ? <LoaderCircle className="settings-spin" size={14} /> : <CloudDownload size={14} />}{installing ? t("skills.cloud.importing") : t("skills.cloud.import")}</button></div>
          </div>
        </div>}
      </div>
    </div>
  );
}
