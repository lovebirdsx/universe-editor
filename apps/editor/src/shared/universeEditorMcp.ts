/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract shared with the external `universe-editor-mcp-bridge`
 *  extension: the server name it registers under `acp.mcpServers`, and the env
 *  var its bridge process reads to target a specific UE4Editor instance. The
 *  extension defines its own copies (it cannot import app code) — keep the
 *  values in sync.
 *--------------------------------------------------------------------------------------------*/

/** Name of the MCP server the bridge extension writes into `acp.mcpServers`. */
export const UNIVERSE_EDITOR_MCP_SERVER_NAME = 'universe-editor'

/** Env var the bridge process reads for the explicit UE4Editor pid. */
export const UNIVERSE_EDITOR_MCP_PID_ENV = 'UNIVERSE_EDITOR_MCP_PID'
