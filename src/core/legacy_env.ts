// Backward-compatibility shim for the job_ops-mcp → jobops rename.
//
// Every env var was renamed MCP_JSA_* → JOBOPS_*. So that an operator who upgrades
// the package but forgets to update their config (LaunchAgent plist, .env, shell
// exports, client JSON) doesn't silently lose settings, this maps any still-set
// legacy MCP_JSA_* var onto its JOBOPS_* equivalent — but only when the new name is
// unset, so an explicit JOBOPS_* always wins. A one-time deprecation warning is
// printed to stderr listing exactly which legacy names were picked up.
//
// MUST run before config.ts reads process.env (it's invoked at the top of config.ts
// module scope, before loadConfig()). Idempotent — safe to call from entry points too.

const LEGACY_PREFIX = 'MCP_JSA_';
const NEW_PREFIX = 'JOBOPS_';

// The full set of suffixes the project has ever defined. Anything not listed here is
// not migrated (there are no other MCP_JSA_* vars), but the mapping is purely
// prefix-based so adding a name here is the only maintenance needed.
const SUFFIXES = [
  'PROJECT_ROOT', 'DATA_DIR', 'OUTPUT_DIR', 'HOST', 'PORT', 'PUBLIC_BASE_URL',
  'AUTH_TOKEN', 'SCHEDULER_ENABLED', 'LLM_PROVIDER', 'LLM_MODEL', 'VISA_SCORING',
  'TEMPLATE_DIR', 'DEFAULT_TEMPLATE', 'SAMPLING', 'DEBUG',
];

let applied = false;

/**
 * Copy any set legacy MCP_JSA_* var onto its JOBOPS_* name when the new name is
 * unset. Returns the list of legacy names that were migrated (for tests / doctor).
 */
export function applyLegacyEnvAliases(): string[] {
  if (applied) return [];
  applied = true;

  const migrated: string[] = [];
  for (const suffix of SUFFIXES) {
    const newName = NEW_PREFIX + suffix;
    const oldName = LEGACY_PREFIX + suffix;
    const newVal = process.env[newName];
    const oldVal = process.env[oldName];
    const newIsSet = newVal !== undefined && newVal !== '';
    const oldIsSet = oldVal !== undefined && oldVal !== '';
    if (!newIsSet && oldIsSet) {
      process.env[newName] = oldVal;
      migrated.push(oldName);
    }
  }

  if (migrated.length) {
    // eslint-disable-next-line no-console
    console.error(
      `[env] DEPRECATED: detected legacy env var(s) ${migrated.join(', ')}. ` +
      `These were renamed to ${migrated.map(n => NEW_PREFIX + n.slice(LEGACY_PREFIX.length)).join(', ')} ` +
      `and the legacy names will be removed in a future release. Please rename them.`,
    );
  }
  return migrated;
}
