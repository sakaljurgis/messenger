import { avatarHue, chatInitials } from '../lib/chats';

const sizeClasses = {
  xs: 'h-4 w-4 text-[8px]',
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
} as const;

/** Presence-dot size, scaled to each avatar size. */
const dotSizeClasses = {
  xs: 'h-1.5 w-1.5',
  sm: 'h-2.5 w-2.5',
  md: 'h-3 w-3',
  lg: 'h-3.5 w-3.5',
} as const;

export type AvatarSize = keyof typeof sizeClasses;

interface AvatarProps {
  /** Display name (user) or group name — used for the initials. */
  name: string;
  /** User id (or chat id for a group avatar) — used for the stable color. */
  id: number;
  size?: AvatarSize;
  className?: string;
  /** When true, overlays a small green online dot at the bottom-right. */
  online?: boolean;
  /**
   * User-picked accent color ('#rrggbb'), when set it wins; null/undefined
   * falls back to the id-derived color exactly as before.
   */
  color?: string | null;
  /**
   * Group avatars: 2+ colors render as an equal-slice conic-gradient pie of
   * the members' accent colors (see groupColors in lib/chats). Fewer than 2
   * entries is ignored — the color/derived fallback applies as usual.
   */
  colors?: string[];
}

/** Equal-slice pie, e.g. conic-gradient(#a 0deg 120deg, #b 120deg 240deg, …). */
function pieGradient(colors: string[]): string {
  const slice = 360 / colors.length;
  const stops = colors.map((c, i) => `${c} ${i * slice}deg ${(i + 1) * slice}deg`);
  return `conic-gradient(${stops.join(', ')})`;
}

/** Colored circle with up to two white initials, plus an optional online dot. Decorative (aria-hidden). */
export default function Avatar({
  name,
  id,
  size = 'md',
  className = '',
  online = false,
  color,
  colors,
}: AvatarProps) {
  const hue = avatarHue(id);
  const background =
    colors && colors.length >= 2
      ? { backgroundImage: pieGradient(colors) }
      : { backgroundColor: color ?? `hsl(${hue} 70% 45%)` };
  return (
    <div
      className={`relative flex flex-shrink-0 items-center justify-center rounded-full font-semibold text-white ${sizeClasses[size]} ${className}`}
      style={background}
      aria-hidden="true"
    >
      {chatInitials(name)}
      {online && (
        <span
          data-testid="presence-dot"
          className={`absolute bottom-0 right-0 rounded-full bg-green-500 ring-2 ring-white dark:ring-gray-900 ${dotSizeClasses[size]}`}
        />
      )}
    </div>
  );
}
