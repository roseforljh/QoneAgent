import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { CloudDownload, LoaderCircle, Plus, Search, Upload } from "lucide-react";
import { localizeError } from "../../lib/error-localization";
import { requestSkillMutation, useStore } from "../../store";
import { useLocale } from "../../localization";
import { SkillCloudDialog } from "./SkillCloudDialog";
import { SkillCreateDialog } from "./SkillCreateDialog";
import { SkillCard } from "./SkillCard";
import { SkillPackageCard } from "./SkillPackageCard";
import { groupSkills } from "../../lib/skill-groups";

export function SkillsSection() {
  const { t } = useLocale();
  const send = useStore((state) => state.send);
  const skills = useStore((state) => state.skills);
  const workspaces = useStore((state) => state.workspaces);
  const currentWorkspaceId = useStore((state) => state.currentWorkspaceId);
  const [query, setQuery] = useState("");
  const [cloudOpen, setCloudOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const visibleSkills = groupSkills(skills).filter((group) => !q || group.name.toLowerCase().includes(q) || group.skills.some((skill) => `${skill.name} ${skill.description} ${skill.path}`.toLowerCase().includes(q)));

  const reloadSkills = () => {
    send({ type: "skills.list", requestId: crypto.randomUUID(), cwd: workspaces.find((workspace) => workspace.id === currentWorkspaceId)?.path });
  };

  useEffect(() => {
    reloadSkills();
  }, [send, workspaces, currentWorkspaceId]);

  const importSkill = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImporting(true);
    setImportError("");
    try {
      const content = await file.text();
      await requestSkillMutation({ type: "skills.import", content });
      reloadSkills();
    } catch (cause) {
      setImportError(localizeError(cause));
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <div className="settings-page-header">
        <div className="settings-dialog-heading"><span>{t("skills.eyebrow")}</span><h2>{t("skills.title")}</h2><p>{t("skills.builtin.nextRun")}</p></div>
        <div className="settings-section-toolbar settings-list-heading"><div><strong>{t("skills.installed")}</strong><span>{t("skills.count", { count: visibleSkills.length })}</span></div><div className="settings-skill-actions"><label className="settings-search"><Search size={13} /><input type="search" placeholder={t("common.search")} value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="settings-skill-action-buttons"><input ref={fileInputRef} className="settings-file-input" type="file" accept=".md,SKILL.md" onChange={(event) => void importSkill(event)} /><button type="button" className="settings-secondary-action" disabled={importing} onClick={() => { setImportError(""); fileInputRef.current?.click(); }}>{importing ? <LoaderCircle className="settings-spin" size={14} /> : <Upload size={14} />}{importing ? t("skills.importing") : t("skills.import")}</button><button type="button" className="settings-secondary-action" onClick={() => setCreateOpen(true)}><Plus size={14} />{t("skills.create.button")}</button><button type="button" className="settings-secondary-action" onClick={() => setCloudOpen(true)}><CloudDownload size={14} />{t("skills.cloud.button")}</button></div></div></div>
        {importError && <p className="settings-skill-error" role="alert"><strong>{t("skills.importError")}:</strong> {importError}</p>}
      </div>
      <div className="settings-skill-list">{visibleSkills.length === 0 ? <p className="settings-empty">{t("skills.none")}</p> : visibleSkills.map((group) => group.packaged ? <SkillPackageCard key={group.id} group={group} /> : <SkillCard key={group.id} skill={group.skills[0]!} />)}</div>
      {cloudOpen && <SkillCloudDialog onClose={() => setCloudOpen(false)} />}
      {createOpen && <SkillCreateDialog onClose={() => { setCreateOpen(false); reloadSkills(); }} />}
    </>
  );
}
