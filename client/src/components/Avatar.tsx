import { avatarHue, chatInitials } from '../lib/chats';

const sizeClasses = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
} as const;

export type AvatarSize = keyof typeof sizeClasses;

interface AvatarProps {
  /** Display name (user) or group name — used for the initials. */
  name: string;
  /** User id (or chat id for a group avatar) — used for the stable color. */
  id: number;
  size?: AvatarSize;
  className?: string;
}

/** Colored circle with up to two white initials. Decorative (aria-hidden). */
export default function Avatar({ name, id, size = 'md', className = '' }: AvatarProps) {
  const hue = avatarHue(id);
  return (
    <div
      className={`flex flex-shrink-0 items-center justify-center rounded-full font-semibold text-white ${sizeClasses[size]} ${className}`}
      style={{ backgroundColor: `hsl(${hue} 70% 45%)` }}
      aria-hidden="true"
    >
      {chatInitials(name)}
    </div>
  );
}
