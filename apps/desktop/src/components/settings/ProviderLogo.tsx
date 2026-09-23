import { useState } from "react";

function getHostname(baseUrl: string) {
  try {
    return new URL(/^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`).hostname;
  } catch {
    return undefined;
  }
}

export function ProviderLogo({ name, baseUrl }: { name: string; baseUrl: string }) {
  const [failed, setFailed] = useState(false);
  const hostname = getHostname(baseUrl.trim());
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?";

  if (hostname && !failed) {
    return (
      <img
        className="settings-provider-logo"
        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`}
        alt=""
        aria-hidden="true"
        onError={() => setFailed(true)}
      />
    );
  }

  return <span className="settings-provider-logo settings-provider-logo-fallback" aria-hidden="true">{initial}</span>;
}
