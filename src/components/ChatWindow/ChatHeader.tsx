import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { renderModelSetting } from '../../utils/model/model.js';
import { getLogoDisplayData, truncatePath } from '../../utils/logoV2Utils.js';
import { truncate } from '../../utils/format.js';
import { getEffortSuffix } from '../../utils/effort.js';
import { useAppState } from '../../state/AppState.js';
import { getGlobalConfig } from '../../utils/config.js';
import { getAPIProvider } from '../../utils/model/providers.js';
import { GuestPassesUpsell, incrementGuestPassesSeenCount, useShowGuestPassesUpsell } from '../LogoV2/GuestPassesUpsell.js';
import { OverageCreditUpsell, incrementOverageCreditUpsellSeenCount, useShowOverageCreditUpsell } from '../LogoV2/OverageCreditUpsell.js';
import { useEffect } from 'react';

// Codex-style single-line chat header:
//   ◆ openclaude  v0.x.x          claude-sonnet-4.x  ~/cwd
//   ────────────────────────────────────────────────────────

export function ChatHeader() {
  const { columns } = useTerminalSize();
  const model = useMainLoopModel();
  const effortValue = useAppState((s) => s.effortValue);
  const effortSuffix = getEffortSuffix(model, effortValue);
  const rawModel = renderModelSetting(model) + effortSuffix;
  const { version, cwd } = getLogoDisplayData();

  const showAccountIdentity = getAPIProvider() === 'firstParty';
  const config = getGlobalConfig();
  const orgName = showAccountIdentity && config.oauthAccount?.organizationName;

  const showGuestPassesUpsell = useShowGuestPassesUpsell();
  const showOverageCreditUpsell = useShowOverageCreditUpsell();

  useEffect(() => {
    if (showGuestPassesUpsell) incrementGuestPassesSeenCount();
  }, [showGuestPassesUpsell]);

  useEffect(() => {
    if (showOverageCreditUpsell && !showGuestPassesUpsell) {
      incrementOverageCreditUpsellSeenCount();
    }
  }, [showOverageCreditUpsell, showGuestPassesUpsell]);

  // Left side: ◆ openclaude  v0.x.x  [@org]
  // Right side: model  cwd
  const leftFixed = `◆ openclaude  v${version}`;
  const orgSuffix = orgName ? `  [${orgName}]` : '';
  const modelTruncated = truncate(rawModel, 34);

  // Reserve space for right side so cwd doesn't overflow
  const rightBase = `  ${modelTruncated}  `;
  const leftBase = leftFixed + orgSuffix;
  const cwdAvail = Math.max(8, columns - leftBase.length - rightBase.length - 2);
  const truncatedCwd = truncatePath(cwd, cwdAvail);

  const divider = '─'.repeat(columns);

  return (
    <Box flexDirection="column" width={columns}>
      <Box flexDirection="row" justifyContent="space-between">
        {/* Left: brand */}
        <Box flexDirection="row">
          <Text color="cyan">◆ </Text>
          <Text bold color="white">openclaude</Text>
          <Text dimColor>{'  '}v{version}</Text>
          {orgName && <Text dimColor>{'  '}[{orgName}]</Text>}
        </Box>
        {/* Right: model + cwd */}
        <Box flexDirection="row">
          <Text color="cyan">{modelTruncated}</Text>
          <Text dimColor>{'  '}{truncatedCwd}</Text>
        </Box>
      </Box>
      <Text dimColor>{divider}</Text>
      {showGuestPassesUpsell && <GuestPassesUpsell />}
      {!showGuestPassesUpsell && showOverageCreditUpsell && (
        <OverageCreditUpsell maxWidth={columns - 4} twoLine />
      )}
    </Box>
  );
}
