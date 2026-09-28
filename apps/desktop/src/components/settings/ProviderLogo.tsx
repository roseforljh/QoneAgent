import { useState } from "react";
import { providerLogoUrls } from "./provider-logo-urls";
import { getProviderBrand, providerBrandIcons } from "./provider-brand";

export function ProviderLogo({ name, baseUrl, logoUrl }: { name: string; baseUrl: string; logoUrl?: string }) {
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?";
  const brand = getProviderBrand(name, baseUrl);
  const urls = providerLogoUrls(baseUrl, logoUrl);
  return <ProviderLogoImage key={`${name}:${baseUrl}:${logoUrl ?? ""}`} urls={urls} initial={initial} brandUrl={logoUrl ? undefined : brand ? providerBrandIcons[brand] : undefined} />;
}

function ProviderLogoImage({ urls, initial, brandUrl }: { urls: string[]; initial: string; brandUrl?: string }) {
  const [index, setIndex] = useState(0);
  const [brandFailed, setBrandFailed] = useState(false);
  const source = brandUrl && !brandFailed ? brandUrl : urls[index];

  if (source) {
    return (
      <img
        className="settings-provider-logo"
        src={source}
        alt=""
        aria-hidden="true"
        onError={() => {
          if (brandUrl && !brandFailed) setBrandFailed(true);
          else setIndex((current) => current + 1);
        }}
      />
    );
  }

  return <span className="settings-provider-logo settings-provider-logo-fallback" aria-hidden="true">{initial}</span>;
}
