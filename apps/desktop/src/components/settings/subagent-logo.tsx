import {   IconSearch, IconVideo, IconPhoto, IconMicrophone, IconVolume, IconSparkles, IconRobot, IconCode,
  IconDatabase, IconBrain, IconChartBar, IconShield, IconRocket, IconPalette, IconCpu, IconCloud,
  IconGitBranch, IconTerminal2, IconBook, IconBulb, IconFlame, IconHeart, IconStar, IconTarget,
  IconPuzzle, IconWorld, IconBolt, IconCamera, IconMusic, IconLeaf, IconFingerprint, IconAntenna,
  IconAtom, IconAdjustments, IconCommand, IconBug, IconCube, IconKey, IconLock, IconMap,
  IconMessages, IconMoon, IconSun, IconTrophy, IconWand, IconWind, IconZoom, IconAbacus,
  IconAccessible, IconAcorn, IconActivity, IconAddressBook, IconAffiliate, IconAirBalloon, IconAlbum, IconAlien,
  IconAnchor, IconAperture, IconApi, IconArchive, IconArmchair, IconAward, IconBadge, IconBalloon,
  IconBan, IconBasket, IconBattery, IconBell, IconBike, IconBlocks, IconBookmark, IconBottle,
  IconBox, IconBuilding, IconCalculator, IconCalendar, IconCar, IconCat, IconCertificate, IconChairDirector,
  IconChess, IconCircleKey, IconClipboard, IconClock, IconCoffee, IconCompass, IconCookie, IconCrown,
  IconDeviceDesktop, IconDiamond, IconDog, IconDoor, IconDroplet, IconEye, IconFeather, IconFile,
  IconFlag, IconFlower, IconFolder, IconGalaxy, IconGift, IconGlobe, IconHammer, IconHeadphones,
  IconHome, IconHourglass, IconIceCream, IconInbox, IconInfinity, IconLamp, IconLego, IconLifebuoy,
  IconLivePhoto, IconMail, IconMan, IconMedal, IconMessage, IconMeteor, IconMouse, IconNews,
  IconNotebook, IconPackage, IconPaperclip, IconPaw, IconPhone, IconPlant, IconPlug, IconPrinter,
  IconRadio, IconReceipt, IconRecycle, IconRoute, IconSchool, IconScissors, IconSettings, IconShip,
  IconShoppingBag, IconSpeakerphone, IconStairs, IconStethoscope, IconSunset, IconTag, IconTool, IconTree,
  IconUmbrella, IconUser, IconUsers, IconWifi, IconWriting, IconYoga } from "@tabler/icons-react";
import {
  builtinSubagentId,
  builtinSubagentLogo,
  CAPABILITY_IDS,
  isBuiltinSubagentId,
  SUBAGENT_LOGO_IDS,
  type CapabilityId,
  type SubagentLogoId,
} from "@qone/protocol";

type TablerIcon = typeof IconSearch;

const logoComponents: Record<SubagentLogoId, TablerIcon> = {
    search: IconSearch,
  video: IconVideo,
  photo: IconPhoto,
  microphone: IconMicrophone,
  volume: IconVolume,
  sparkles: IconSparkles,
  robot: IconRobot,
  code: IconCode,
  database: IconDatabase,
  brain: IconBrain,
  "chart-bar": IconChartBar,
  shield: IconShield,
  rocket: IconRocket,
  palette: IconPalette,
  cpu: IconCpu,
  cloud: IconCloud,
  "git-branch": IconGitBranch,
  terminal: IconTerminal2,
  book: IconBook,
  bulb: IconBulb,
  flame: IconFlame,
  heart: IconHeart,
  star: IconStar,
  target: IconTarget,
  puzzle: IconPuzzle,
  world: IconWorld,
  bolt: IconBolt,
  camera: IconCamera,
  music: IconMusic,
  leaf: IconLeaf,
  fingerprint: IconFingerprint,
  antenna: IconAntenna,
  atom: IconAtom,
  adjustments: IconAdjustments,
  command: IconCommand,
  bug: IconBug,
  cube: IconCube,
  key: IconKey,
  lock: IconLock,
  map: IconMap,
  messages: IconMessages,
  moon: IconMoon,
  sun: IconSun,
  trophy: IconTrophy,
  wand: IconWand,
  wind: IconWind,
  zoom: IconZoom,
  abacus: IconAbacus,
  accessible: IconAccessible,
  acorn: IconAcorn,
  activity: IconActivity,
  "address-book": IconAddressBook,
  affiliate: IconAffiliate,
  "air-balloon": IconAirBalloon,
  album: IconAlbum,
  alien: IconAlien,
  anchor: IconAnchor,
  aperture: IconAperture,
  api: IconApi,
  archive: IconArchive,
  armchair: IconArmchair,
  award: IconAward,
  badge: IconBadge,
  balloon: IconBalloon,
  ban: IconBan,
  basket: IconBasket,
  battery: IconBattery,
  bell: IconBell,
  bike: IconBike,
  blocks: IconBlocks,
  bookmark: IconBookmark,
  bottle: IconBottle,
  box: IconBox,
  building: IconBuilding,
  calculator: IconCalculator,
  calendar: IconCalendar,
  car: IconCar,
  cat: IconCat,
  certificate: IconCertificate,
  "chair-director": IconChairDirector,
  chess: IconChess,
  "circle-key": IconCircleKey,
  clipboard: IconClipboard,
  clock: IconClock,
  coffee: IconCoffee,
  compass: IconCompass,
  cookie: IconCookie,
  crown: IconCrown,
  "device-desktop": IconDeviceDesktop,
  diamond: IconDiamond,
  dog: IconDog,
  door: IconDoor,
  droplet: IconDroplet,
  eye: IconEye,
  feather: IconFeather,
  file: IconFile,
  flag: IconFlag,
  flower: IconFlower,
  folder: IconFolder,
  galaxy: IconGalaxy,
  gift: IconGift,
  globe: IconGlobe,
  hammer: IconHammer,
  headphones: IconHeadphones,
  home: IconHome,
  hourglass: IconHourglass,
  "ice-cream": IconIceCream,
  inbox: IconInbox,
  infinity: IconInfinity,
  lamp: IconLamp,
  lego: IconLego,
  lifebuoy: IconLifebuoy,
  "live-photo": IconLivePhoto,
  mail: IconMail,
  man: IconMan,
  medal: IconMedal,
  message: IconMessage,
  meteor: IconMeteor,
  mouse: IconMouse,
  news: IconNews,
  notebook: IconNotebook,
  package: IconPackage,
  paperclip: IconPaperclip,
  paw: IconPaw,
  phone: IconPhone,
  plant: IconPlant,
  plug: IconPlug,
  printer: IconPrinter,
  radio: IconRadio,
  receipt: IconReceipt,
  recycle: IconRecycle,
  route: IconRoute,
  school: IconSchool,
  scissors: IconScissors,
  settings: IconSettings,
  ship: IconShip,
  "shopping-bag": IconShoppingBag,
  speakerphone: IconSpeakerphone,
  stairs: IconStairs,
  stethoscope: IconStethoscope,
  sunset: IconSunset,
  tag: IconTag,
  tool: IconTool,
  tree: IconTree,
  umbrella: IconUmbrella,
  user: IconUser,
  users: IconUsers,
  wifi: IconWifi,
  writing: IconWriting,
  yoga: IconYoga
};

const colors = [
  ["#e0f2fe", "#0369a1"], ["#fce7f3", "#be185d"], ["#dcfce7", "#15803d"],
  ["#fef3c7", "#b45309"], ["#ede9fe", "#6d28d9"], ["#cffafe", "#0e7490"],
  ["#ffedd5", "#c2410c"], ["#f3e8ff", "#7e22ce"], ["#d1fae5", "#047857"],
  ["#fee2e2", "#b91c1c"], ["#e0e7ff", "#4338ca"], ["#fef9c3", "#a16207"],
] as const;

const logoId = (value?: string): SubagentLogoId =>
  value && (SUBAGENT_LOGO_IDS as readonly string[]).includes(value)
    ? value as SubagentLogoId
    : "robot";

function colorIndex(value: string) {
  return [...value].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7) % colors.length;
}

function randomIndex(max: number) {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return values[0] % max;
  }
  return Math.floor(Math.random() * max);
}

export function pickSubagentLogo(used: readonly string[]): SubagentLogoId | undefined {
  const available = SUBAGENT_LOGO_IDS.filter((id) => !used.includes(id));
  return available.length ? available[randomIndex(available.length)] : undefined;
}

function builtinCapability(id: string): CapabilityId | undefined {
  return CAPABILITY_IDS.find((capability) => builtinSubagentId(capability) === id);
}

export function normalizeSubagentLogos<T extends { id: string; logo?: string }>(profiles: T[]): T[] {
  const reserved = new Set<string>(CAPABILITY_IDS.map((capability) => builtinSubagentLogo(capability)));
  const used = new Set<string>();
  const assigned = new Map<number, string>();
  profiles
    .map((profile, index) => ({ profile, index }))
    .sort((left, right) => Number(isBuiltinSubagentId(right.profile.id)) - Number(isBuiltinSubagentId(left.profile.id)))
    .forEach(({ profile, index }) => {
      const capability = builtinCapability(profile.id);
      const fixed = capability ? builtinSubagentLogo(capability) : undefined;
      const requested = profile.logo && (SUBAGENT_LOGO_IDS as readonly string[]).includes(profile.logo)
        && !reserved.has(profile.logo) && !used.has(profile.logo) ? profile.logo : undefined;
      const selected = fixed && !used.has(fixed) ? fixed : requested ?? pickSubagentLogo([...used, ...reserved]);
      if (selected) {
        assigned.set(index, selected);
        used.add(selected);
      }
    });
  return profiles.map((profile, index) => ({ ...profile, logo: assigned.get(index) }));
}

export function SubagentLogo({ logo, name, size = 32 }: { logo?: string; name: string; size?: number }) {
  const id = logoId(logo);
  const Icon = logoComponents[id];
  const [backgroundColor, color] = colors[colorIndex(id + name)];
  return (
    <span
      className="q-subagent-logo"
      style={{ width: size, height: size, backgroundColor, color }}
      aria-label={name}
      title={name}
    >
      <Icon size={Math.max(15, Math.round(size * 0.52))} strokeWidth={1.9} aria-hidden="true" />
    </span>
  );
}

