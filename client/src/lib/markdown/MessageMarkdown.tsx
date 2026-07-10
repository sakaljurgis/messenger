// Chat-safe markdown renderer for message bubbles.
//
// Renders a message's text as a small, safe markdown subset while reproducing
// the app's existing @mention styling. All behaviour is driven by a
// `MessageMarkdownConfig` (defaults to `defaultMessageConfig`); pass a custom
// `config` to restrict or enrich the subset for other message classes (e.g.
// bot replies). See ./config.tsx and ./README.md.

import { useMemo } from 'react';
import Markdown from 'react-markdown';
import type { UserDTO } from '@messenger/shared';
import {
  defaultMessageConfig,
  type MarkdownRenderContext,
  type MessageMarkdownConfig,
} from './config';

export interface MessageMarkdownProps {
  /** The raw message content (markdown source). */
  content: string;
  /** The message's actual mention ids. */
  mentions: number[];
  /** Chat members, used to resolve `@name` spans. */
  members: UserDTO[];
  /** The viewing user's id. */
  meId: number;
  /** True for the viewer's own (blue) bubble; drives per-side styling. */
  isMine: boolean;
  /** Rendering preset; defaults to the chat-bubble subset. */
  config?: MessageMarkdownConfig;
}

/** Render `content` as chat-safe markdown with app-styled @mentions. */
export function MessageMarkdown({
  content,
  mentions,
  members,
  meId,
  isMine,
  config = defaultMessageConfig,
}: MessageMarkdownProps) {
  const ctx: MarkdownRenderContext = { mentions, members, meId, isMine };

  // Plugins/components close over `ctx`, so rebuild them when the message or
  // the bubble side changes — but not on unrelated re-renders.
  const remarkPlugins = useMemo(
    () => config.buildRemarkPlugins(ctx),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, isMine, meId, mentions, members],
  );
  const components = useMemo(
    () => config.buildComponents(ctx),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, isMine, meId, mentions, members],
  );

  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      components={components}
      allowedElements={config.allowedElements}
      unwrapDisallowed={config.unwrapDisallowed}
      urlTransform={config.urlTransform}
    >
      {content}
    </Markdown>
  );
}

export default MessageMarkdown;
