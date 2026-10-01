import type { ReachChannelInfo } from "@qone/protocol";
import type { Locale } from "../locale-core";

export function localizeReachChannel(channel: ReachChannelInfo, locale: Locale): ReachChannelInfo {
  return locale === "en" && channel.english ? { ...channel, ...channel.english } : channel;
}
