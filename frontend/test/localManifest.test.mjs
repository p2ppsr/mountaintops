import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'

test('native wallet origin can read the complete local manifest without opening CORS to unrelated sites', async () => {
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  try {
    const url = `http://127.0.0.1:${server.httpServer.address().port}/manifest.json`
    const response = await fetch(url, { headers: { Origin: 'tauri://localhost' } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), 'tauri://localhost')
    const manifest = await response.json()
    assert.equal(manifest.metanet.schemaVersion, 1)
    assert.equal(manifest.metanet.groupPermissions.protocolPermissions.length, 6)
    assert.equal(manifest.metanet.groupPermissions.basketAccess.length, 2)
    const unrelated = await fetch(url, { headers: { Origin: 'https://unrelated.example' } })
    assert.equal(unrelated.headers.get('access-control-allow-origin'), null)
  } finally { await server.close() }
})
