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
}

/** Colored circle with up to two white initials, plus an optional online dot. Decorative (aria-hidden). */
export default function Avatar({ name, id, size = 'md', className = '', online = false }: AvatarProps) {
  const hue = avatarHue(id);
  return (
    <div
      className={`relative flex flex-shrink-0 items-center justify-center rounded-full font-semibold text-white ${sizeClasses[size]} ${className}`}
      style={{ backgroundColor: `hsl(${hue} 70% 45%)` }}
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
