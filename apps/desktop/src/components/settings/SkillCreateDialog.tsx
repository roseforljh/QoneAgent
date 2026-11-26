import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ExternalLink, LoaderCircle, Plus, X } from "lucide-react";
import type { SkillInfo } from "@qone/protocol";
import { openPath } from "../../lib/desktop-bridge";
import { localizeError } from "../../lib/error-localization";
import { requestSkillMutation } from "../../store";
import { useLocale } from "../../localization";
import "./skill-create.css";

export function SkillCreateDialog({ skill, onClose }: { skill?: SkillInfo; onClose: () => void }) {
  const { t } = useLocale();
  const isEdit = Boolean(skill);
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [instructions, setInstructions] = useState("");
  const [editable, setEditable] = useState(true);
  const [loading, setLoading] = useState(isEdit);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!skill) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    setError("");
    void requestSkillMutation({ type: "skills.read", skillId: skill.id })
      .then((response) => {
        if (cancelled || response.type !== "skills.content") return;
        setName(response.skill.name);
        setDescription(response.skill.description);
        setInstructions(response.instructions);
        setEditable(response.editable);
      })
      .catch((cause) => {
        if (cancelled) return;
        setLoadFailed(true);
        setError(localizeError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [skill?.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, saving]);

  const valid = !loading && !loadFailed && editable && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name.trim()) && Boolean(description.trim()) && Boolean(instructions.trim());
  const title = !isEdit ? t("skills.create.title") : editable ? t("skills.edit.title") : t("skills.edit.viewTitle");

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError("");
    try {
      if (skill) {
        await requestSkillMutation({ type: "skills.update", skillId: skill.id, name: name.trim(), description: description.trim(), instructions: instructions.trim() });
      } else {
        await requestSkillMutation({ type: "skills.create", name: name.trim(), description: description.trim(), instructions: instructions.trim() });
      }
      onClose();
    } catch (cause) {
      setError(localizeError(cause));
    } finally {
      setSaving(false);
    }
  };

  const openExternalFile = async () => {
    if (!skill) return;
    setError("");
    try {
      await openPath(skill.path);
    } catch (cause) {
      setError(localizeError(cause));
    }
  };

  return createPortal(
    <div className="skill-create-overlay">
      <div className="settings-subdialog skill-create-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="settings-subdialog-header"><div><span>SKILL.MD</span><h3>{title}</h3></div><button type="button" className="settings-dialog-close" disabled={saving} onClick={onClose} aria-label={t("common.close")}><X size={17} /></button></div>
        {loading ? (
          <div className="skill-create-loading"><LoaderCircle className="settings-spin" size={15} /><span>{t("skills.edit.loading")}</span></div>
        ) : (
          <div className="skill-create-fields">
            <label>{t("skills.create.name")}<input autoFocus={!isEdit} readOnly={!editable} value={name} onChange={(event) => setName(event.target.value.toLowerCase())} placeholder={t("skills.create.namePlaceholder")} maxLength={64} /><small>{t("skills.create.nameHint")}</small></label>
            <label>{t("skills.create.description")}<input readOnly={!editable} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("skills.create.descriptionPlaceholder")} maxLength={500} /></label>
            <label>{t("skills.create.instructions")}<textarea autoFocus={isEdit && editable} readOnly={!editable} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder={t("skills.create.instructionsPlaceholder")} rows={9} maxLength={2_000_000} /></label>
          </div>
        )}
        {isEdit && !loading && !loadFailed && !editable && <p className="skill-create-readonly-hint">{t("skills.edit.readonlyHint")}</p>}
        {error && <p className="skill-create-error" role="alert">{error}</p>}
        <div className="settings-subdialog-footer skill-create-footer">
          {skill && <button type="button" className="settings-secondary-action skill-create-open-file" disabled={saving} onClick={() => void openExternalFile()}><ExternalLink size={14} />{t("skills.edit.openFile")}</button>}
          <button type="button" className="settings-secondary-action" disabled={saving} onClick={onClose}>{t("common.cancel")}</button>
          {(!isEdit || editable) && <button type="button" className="settings-primary-action" disabled={!valid || saving} onClick={() => void submit()}>{saving ? <LoaderCircle className="settings-spin" size={14} /> : isEdit ? <Check size={14} /> : <Plus size={14} />}{saving ? t(isEdit ? "skills.edit.saving" : "skills.create.creating") : isEdit ? t("common.save") : t("skills.create.submit")}</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
