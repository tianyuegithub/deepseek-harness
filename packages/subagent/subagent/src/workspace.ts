/**
 * Shared child-workspace validation and resolution for Subagent providers.
 *
 * @module @deepseek-ai/dsh-subagent/workspace
 */

import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** Whether `path` names an existing directory the process can enter. */
function isEnterableDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    // Missing, inaccessible, and non-directory paths are all unusable cwd values.
    return false
  }
}

/**
 * Assert that a directory can serve as a child workspace.
 * @param prefix - the consuming provider's diagnostic prefix.
 * @param label - the value source named in diagnostics.
 * @param cwd - candidate absolute directory.
 * @returns the validated directory.
 */
export function assertUsableCwd(prefix: string, label: string, cwd: string): string {
  if (!isAbsolute(cwd)) throw new Error(`${prefix}: ${label} must be an absolute path: ${cwd}`)
  if (!isEnterableDirectory(cwd)) {
    throw new Error(`${prefix}: ${label} is not an accessible directory: ${cwd}`)
  }
  return cwd
}

/**
 * Validate a provider-wide configured workspace at plugin load.
 * @param prefix - the consuming provider's diagnostic prefix.
 * @param cwd - configured path, or `undefined` to inherit per run.
 * @returns the resolved validated directory when configured.
 */
export function validateConfiguredCwd(prefix: string, cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  if (cwd === '') {
    throw new Error(`${prefix}: config cwd must not be empty — omit the key to inherit the request or parent session cwd`)
  }
  return assertUsableCwd(prefix, 'config cwd', resolve(cwd))
}

/**
 * Resolve one child's directory without letting a per-run request bypass a
 * provider-wide deployment restriction.
 * @param prefix - the consuming provider's diagnostic prefix.
 * @param configured - load-validated provider directory, if fixed.
 * @param requested - trusted per-run directory, if selected by the caller.
 * @param parentCwd - delegating parent Session workspace, if present.
 * @returns the absolute directory the provider must use.
 */
export function resolveChildCwd(
  prefix: string,
  configured: string | undefined,
  requested: string | undefined,
  parentCwd: string | undefined,
): string {
  if (configured !== undefined) {
    if (requested !== undefined) {
      const candidate = assertUsableCwd(prefix, 'request cwd', requested)
      if (resolve(candidate) !== resolve(configured)) {
        throw new Error(`${prefix}: request cwd conflicts with the configured cwd`)
      }
    }
    return configured
  }
  if (requested !== undefined) return assertUsableCwd(prefix, 'request cwd', requested)
  if (parentCwd === undefined) {
    throw new Error(`${prefix}: no working directory for the child — configure \`cwd\`, request one, or delegate from a parent session that has one`)
  }
  return assertUsableCwd(prefix, 'parent session cwd', parentCwd)
}
