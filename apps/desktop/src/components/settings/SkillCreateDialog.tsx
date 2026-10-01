import { localizeError } from "../../lib/error-localization";
import { useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Plus, X } from "lucide-react";
import { requestSkillMutation } from "../../store";
import { useLocale } from "../../localization";
import "./skill-create.css";

export function SkillCreateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const valid = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name.trim()) && Boolean(description.trim()) && Boolean(instructions.trim());

  const create = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError("");
    try {
      await requestSkillMutation({ type: "skills.create", name: name.trim(), description: description.trim(), instructions: instructions.trim() });
      onClose();
    } catch (cause) {
      setError(localizeError(cause));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="skill-create-overlay">
      <div className="settings-subdialog skill-create-dialog" role="dialog" aria-modal="true" aria-label={t("skills.create.title")}>
        <div className="settings-subdialog-header"><div><span>SKILL.MD</span><h3>{t("skills.create.title")}</h3></div><button type="button" className="settings-dialog-close" disabled={saving} onClick={onClose} aria-label={t("common.close")}><X size={17} /></button></div>
        <div className="skill-create-fields">
          <label>{t("skills.create.name")}<input autoFocus value={name} onChange={(event) => setName(event.target.value.toLowerCase())} placeholder={t("skills.create.namePlaceholder")} maxLength={64} /><small>{t("skills.create.nameHint")}</small></label>
          <label>{t("skills.create.description")}<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("skills.create.descriptionPlaceholder")} maxLength={500} /></label>
          <label>{t("skills.create.instructions")}<textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder={t("skills.create.instructionsPlaceholder")} rows={9} maxLength={2_000_000} /></label>
        </div>
        {error && <p className="skill-create-error" role="alert">{error}</p>}
        <div className="settings-subdialog-footer"><button type="button" className="settings-secondary-action" disabled={saving} onClick={onClose}>{t("common.cancel")}</button><button type="button" className="settings-primary-action" disabled={!valid || saving} onClick={() => void create()}>{saving ? <LoaderCircle className="settings-spin" size={14} /> : <Plus size={14} />}{saving ? t("skills.create.creating") : t("skills.create.submit")}</button></div>
      </div>
    </div>,
    document.body,
  );
}
