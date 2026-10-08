/** Generated invocation inventory must keep native session minting Host-only. */
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { WorkspaceAnalyzer } from '../src/analyzer.ts'

describe('Connection managed sessions', () => {
  it('contributes no generated browser invocation', { timeout: 30_000 }, () => {
    const root = fileURLToPath(new URL('../../../..', import.meta.url))
    const dir = mkdtempSync(join(tmpdir(), 'dsh-connection-reflection-'))
    try {
      const aggregate = join(dir, 'host.json')
      // The ordinary Host aggregate excludes packages/client. Analyze the declared
      // Connection Host face explicitly rather than accepting an empty selection.
      writeFileSync(aggregate, JSON.stringify({
        extends: join(root, 'tsconfig.base.json'), files: [],
        references: [{ path: join(root, 'packages/client/connection/tsconfig.host.json') }],
      }))
      const analyzer = new WorkspaceAnalyzer({ root, hostConfig: aggregate, faces: ['host'],
        packages: ['@deepseek-ai/dsh-client-connection'] })
      expect(analyzer.discoverPackages().some(pkg => pkg.package === '@deepseek-ai/dsh-client-connection'))
        .toBe(true)
      const workspace = analyzer.analyze()
      expect(workspace.faces.map(face => face.face)).toEqual(['host'])
      expect(workspace.faces.flatMap(face => face.packages.flatMap(pkg => pkg.invocations))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
