/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Side-effect import hub that registers the settings UI of every built-in agent
 *  into the agentSettingsRegistry. The Agent Settings shell imports this once so
 *  the contributions are present before it renders. Add a new agent's settings
 *  module here to surface it.
 *--------------------------------------------------------------------------------------------*/

import './claude/ClaudeAgentSettings.js'
