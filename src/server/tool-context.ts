/**
 * FINDINGS #34 T1.4 — write attribution context.
 * The MCP dispatch sets the current tool+action here; state-writing repos
 * read it to stamp their audit rows. Ghost writes stop being ghosts.
 */
let current = 'unknown';
export function setToolContext(ctx: string): void { current = ctx; }
export function getToolContext(): string { return current; }
