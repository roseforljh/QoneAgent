import { memo } from "react";
import { avatarIdOf, customAvatarOf, isCustomAvatar, TEAM_AVATARS, type TeamAvatarDesign } from "../../lib/team/avatar";
import type { TeamBot, TeamGroup } from "../../lib/team/types";
import { cn } from "../../lib/utils";

interface TeamAvatarProps {
  bot: Pick<TeamBot, "id" | "avatar" | "name" | "presetKey">;
  size: number;
  className?: string;
}

export const TeamAvatar = memo(function TeamAvatar({ bot, size, className }: TeamAvatarProps) {
  const custom = customAvatarOf(bot);
  if (custom) {
    return (
      <img
        src={custom}
        alt={bot.name}
        width={size}
        height={size}
        draggable={false}
        aria-hidden={!bot.name || undefined}
        className={cn("team-avatar is-custom", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  const design: TeamAvatarDesign = TEAM_AVATARS[avatarIdOf(bot)];
  const { color, outline, gaze, border, faceplate, face = "#FFFFFF", detail } = design;
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role={bot.name ? "img" : undefined}
      aria-label={bot.name || undefined}
      aria-hidden={!bot.name || undefined}
      className={cn("team-avatar", className)}
    >
      <path d={outline} fill={color} stroke={border} strokeWidth={border ? 2.5 : undefined} />
      {faceplate && <path d={faceplate.outline} fill={faceplate.color} />}
      <g fill={face} transform={gaze}>
        <rect x="0" y="0" width="5.5" height="12" rx="2.75" />
        <rect x="12" y="2" width="5.5" height="11" rx="2.75" />
      </g>
      {detail && <path d={detail} fill={face} />}
    </svg>
  );
});

interface TeamGroupAvatarProps {
  group: Pick<TeamGroup, "avatar" | "name" | "directBotId">;
  members: readonly TeamBot[];
  /** 自定义群头像或私聊头像的渲染尺寸。 */
  size?: number;
  /** 未自定义群头像时成员叠图的单个头像尺寸。 */
  stackSize?: number;
  maxStack?: number;
  className?: string;
}

/** 群头像：优先显示自定义图片，私聊显示对方头像，其余默认显示成员头像堆叠。 */
export const TeamGroupAvatar = memo(function TeamGroupAvatar({
  group,
  members,
  size = 32,
  stackSize = 26,
  maxStack = 3,
  className,
}: TeamGroupAvatarProps) {
  if (isCustomAvatar(group.avatar)) {
    return (
      <img
        src={group.avatar}
        alt={group.name}
        width={size}
        height={size}
        draggable={false}
        aria-hidden={!group.name || undefined}
        className={cn("team-avatar is-custom", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  if (group.directBotId && members[0]) {
    return <TeamAvatar bot={{ ...members[0], name: "" }} size={size} className={className} />;
  }
  return (
    <div className={cn("team-avatar-stack", className)}>
      {members.slice(0, maxStack).map((member) => (
        <TeamAvatar key={member.id} bot={{ ...member, name: "" }} size={stackSize} />
      ))}
    </div>
  );
});
