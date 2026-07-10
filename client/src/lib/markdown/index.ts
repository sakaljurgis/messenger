// Public API of the chat markdown module.

export { MessageMarkdown, default } from './MessageMarkdown';
export type { MessageMarkdownProps } from './MessageMarkdown';

export {
  defaultMessageConfig,
  buildDefaultComponents,
  sideChromeClasses,
  createMentionRemarkPlugin,
  defaultMentionClassName,
  isSafeHref,
} from './config';
export type {
  MessageMarkdownConfig,
  MarkdownRenderContext,
  RemarkPlugins,
} from './config';
