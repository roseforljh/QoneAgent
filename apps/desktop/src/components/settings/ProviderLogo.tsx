import { useState } from "react";
import { providerLogoUrls } from "./provider-logo-urls";

export function ProviderLogo({ name, baseUrl, logoUrl }: { name: string; baseUrl: string; logoUrl?: string }) {
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?";
  const urls = providerLogoUrls(baseUrl, logoUrl);
  return <ProviderLogoImage key={`${baseUrl}:${logoUrl ?? ""}`} urls={urls} initial={initial} />;
}

function ProviderLogoImage({ urls, initial }: { urls: string[]; initial: string }) {
  const [index, setIndex] = useState(0);

  if (urls[index]) {
    return (
      <img
        className="settings-provider-logo"
        src={urls[index]}
        alt=""
        aria-hidden="true"
        onError={() => setIndex((current) => current + 1)}
      />
    );
  }

  return <span className="settings-provider-logo settings-provider-logo-fallback" aria-hidden="true">{initial}</span>;
}
