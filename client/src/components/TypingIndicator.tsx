import type { UserDTO } from '@messenger/shared';

/** "Ana is typing…", "Ana and Ben are typing…", "Ana, Ben and Cara are typing…". */
export function typingLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are typing…`;
}

/** Display names for the typing user ids; ids with no member (a departed one) are skipped. */
export function typingDisplayNames(ids: Iterable<number>, members: UserDTO[]): string[] {
  const names: string[] = [];
  for (const id of ids) {
    const name = members.find((m) => m.id === id)?.displayName;
    if (name) names.push(name);
  }
  return names;
}

/**
 * Messenger-style typing bubble: a small gray pill with three staggered bouncing
 * dots and a tiny label. Rendered below the last message, inside the scroll area
 * (main chat and thread overlay alike), so it never yanks the viewport around.
 * Nothing shows when no one is typing.
 */
export default function TypingIndicator({ names, isGroup }: { names: string[]; isGroup: boolean }) {
  if (names.length === 0) return null;
  return (
    <div className="mt-2 flex justify-start px-3" aria-live="polite">
      <div className="flex items-end gap-2">
        {isGroup && <div className="w-8 flex-shrink-0" />}
        <div className="flex flex-col items-start gap-0.5">
          <div className="flex items-center gap-1 rounded-2xl bg-gray-200 px-3.5 py-3 dark:bg-gray-700">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-2 w-2 animate-bounce rounded-full bg-gray-400 dark:bg-gray-500"
                style={{ animationDelay: `${i * 0.15}s` }}
              />
            ))}
          </div>
          <span className="ml-1 text-[10px] text-gray-400 dark:text-gray-500">{typingLabel(names)}</span>
        </div>
      </div>
    </div>
  );
}
