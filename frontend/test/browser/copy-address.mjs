import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = path.resolve(import.meta.dirname, '../..')
const evidence = process.env.COPY_ADDRESS_EVIDENCE
if (evidence) await mkdir(evidence, { recursive: true })
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'], serviceWorkers: 'block' })
    const page = await context.newPage(), errors = [], external = []
    page.on('pageerror', error => errors.push(error.message))
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      external.push(route.request().url()); return route.abort()
    })
    await page.addInitScript(() => {
      const write = navigator.clipboard.writeText.bind(navigator.clipboard)
      window.copyCalls = []
      Object.defineProperty(navigator.clipboard, 'writeText', { value: text => {
        window.copyCalls.push({ text, active: navigator.userActivation.isActive, focused: document.hasFocus() })
        return new URL(location.href).searchParams.has('deny-copy') ? Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError')) : write(text)
      } })
    })
    const idle = () => page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false')
    const connect = async query => {
      await page.goto(`${origin}/test/ui.html?${query}`); await page.bringToFront()
      await page.getByRole('button', { name: 'Connect wallet', exact: true }).click(); await idle()
    }
    try {
      await connect('')
      const address = await page.locator('.selected .address').innerText()
      await page.evaluate(() => window.fixtureBlockCopyReads())
      await page.getByRole('button', { name: 'Copy address', exact: true }).click()
      await page.getByText('Address copied.', { exact: true }).waitFor()
      assert.deepEqual(await page.evaluate(() => window.copyCalls), [{ text: address, active: true, focused: true }])
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), address)
      assert.equal(await page.getByRole('button', { name: 'Copy address', exact: true }).innerText(), 'Copied!')
      assert.equal(await page.getByRole('alert').count(), 0)
      if (evidence) await page.screenshot({ path: path.join(evidence, `copied-${width}.png`), fullPage: true })

      await connect('deny-copy')
      await page.evaluate(() => window.fixtureBlockCopyReads())
      await page.getByRole('button', { name: 'Copy address', exact: true }).click()
      await page.getByText('Automatic copy is unavailable.', { exact: false }).waitFor()
      assert.equal(await page.evaluate(() => window.getSelection().toString()), address)
      assert.equal(await page.getByText('Address copied.', { exact: true }).count(), 0)
      assert.equal(await page.getByRole('alert').count(), 0)
      if (evidence) await page.screenshot({ path: path.join(evidence, `manual-copy-${width}.png`), fullPage: true })

      if (width === 1440) {
        await connect('')
        await page.clock.setFixedTime(new Date(Date.now() + 120000))
        await page.getByRole('button', { name: 'Copy address', exact: true }).click(); await idle()
        await page.getByText('Address checked. Click Copy address to copy it.', { exact: true }).waitFor()
        assert.equal(await page.evaluate(() => window.copyCalls.length), 0, 'stale refresh never writes the clipboard after the click')
        await page.getByRole('button', { name: 'Copy address', exact: true }).click()
        await page.getByText('Address copied.', { exact: true }).waitFor()
        assert.equal(await page.evaluate(() => window.copyCalls.length), 1)
        await page.clock.setFixedTime(new Date())
        await connect('expired')
        assert.equal(await page.getByRole('button', { name: 'Copy address', exact: true }).count(), 0)
      }
      assert.deepEqual(errors, []); assert.deepEqual(external, [])
      console.log(`PASS ${width}px: focused direct clipboard copy with blocked RPCs, manual fallback; no external requests`)
    } finally { await context.close() }
  }
} finally { await browser.close(); await server.close() }
