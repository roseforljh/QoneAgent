import { VERTEX_AI_DEFAULT_BASE_URL } from "@qone/protocol";
import { useEffect, useState } from "react";
import { useLocale } from "../../localization";
import { QoneSelect } from "../ui/Select";

let locationsRequest: Promise<string[]> | undefined;
function discoverLocations() {
  // Use Google's public Discovery API. This request contains no project ID or credentials.
  return locationsRequest ??= fetch(new URL("/$discovery/rest?version=v1", VERTEX_AI_DEFAULT_BASE_URL), {
    credentials: "omit", signal: AbortSignal.timeout(6_000),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`Vertex discovery HTTP ${response.status}`);
    const { endpoints } = await response.json() as { endpoints?: { location?: unknown }[] };
    return [...new Set((endpoints ?? []).flatMap(({ location }) => typeof location === "string" ? [location] : []))].sort();
  }).catch(() => {
    locationsRequest = undefined;
    return [];
  });
}

export function VertexLocationSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useLocale();
  const [locations, setLocations] = useState<string[]>([]);
  const [manual, setManual] = useState(false);
  useEffect(() => {
    let active = true;
    void discoverLocations().then((result) => { if (active) setLocations(result); });
    return () => { active = false; };
  }, []);
  const options = [...new Set(["global", ...locations, value])].filter(Boolean).map((region) => ({ value: region, label: region }));
  return (
    <label>{t("provider.vertexRegion")}
      <QoneSelect value={manual ? "" : value} ariaLabel={t("provider.vertexRegion")}
        options={[...options, { value: "", label: t("provider.vertexCustomRegion") }]}
        onChange={(next) => { setManual(!next); if (next) onChange(next); }} />
      {manual && <input value={value} aria-label={t("provider.vertexCustomRegion")} onChange={(event) => onChange(event.target.value)} />}
    </label>
  );
}
