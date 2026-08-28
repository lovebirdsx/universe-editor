/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TTLs for the AI remote-source cache (rate tables and gateway account usage),
 *  shared by main's on-disk cache and the renderer's account-usage poller.
 *--------------------------------------------------------------------------------------------*/

export const RATES_TTL_MS = 24 * 60 * 60_000
export const USAGE_TTL_MS = 5 * 60_000
