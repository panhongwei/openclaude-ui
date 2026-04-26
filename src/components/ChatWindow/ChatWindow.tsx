import * as React from 'react';
import type { ReactNode } from 'react';
import { Box } from '../../ink.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { ChatHeader } from './ChatHeader.js';

// Codex-style chat window layout:
//
//   ◆ openclaude  v0.x.x              model  ~/cwd
//   ────────────────────────────────────────────────
//   [messages scroll here]
//   ────────────────────────────────────────────────
//   ❯ [input]

type Props = {
  children: ReactNode;
  /** Show the Codex-style header bar. Default true. */
  showHeader?: boolean;
  /** Bottom-pinned content (prompt input area). */
  bottom?: ReactNode;
};

export function ChatWindow({ children, showHeader = true, bottom }: Props) {
  const { columns } = useTerminalSize();
  return (
    <Box flexDirection="column" width={columns}>
      {showHeader && <ChatHeader />}
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
      {bottom}
    </Box>
  );
}
