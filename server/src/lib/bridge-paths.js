/**
 * Where the bridge token lives. Shared by the ASDD server (which writes it) and the MCP process
 * (which reads it) — kept separate from bridge.js so the MCP process never loads the queue, and
 * from store.js so it never creates the data directory as a side effect.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.ASDD_DATA_DIR ? path.resolve(process.env.ASDD_DATA_DIR) : path.resolve(here, '../../data');
export const TOKEN_FILE = path.join(DATA_DIR, 'bridge-token.json');
