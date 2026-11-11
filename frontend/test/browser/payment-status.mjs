import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'
const root = path.resolve(import.meta.dirname, '../..')
const evidence = process.env.PAYMENT_STATUS_EVIDENCE
if (evidence) await mkdir(evidence, { recursive: true })
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    const page = await context.newPage(), errors = [], unexpected = []
    page.on('pageerror', error => errors.push(error.message))
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      unexpected.push(route.request().url()); return route.abort()
    })
    try {
      await page.goto(origin + '/test/ui.html?pending=unproven')
      await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
      const status = page.getByRole('region', { name: 'Wallet payment status' })
      await status.getByRole('heading', { name: 'Submitted; waiting for confirmation', exact: true }).waitFor()
      await status.getByText('Last checked', { exact: false }).waitFor()
      for (let i = 0; i < 2; i++) {
        await status.getByRole('button', { name: 'Refresh payment status' }).click()
        await page.getByText('Submitted; waiting for confirmation. Your wallet has not returned a mined proof yet. Do not send this payment again.', { exact: true }).last().waitFor()
      }
      assert.equal(await page.locator('#fixture-actions').innerText(), 'Isolated fixture · 0 wallet transactions')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await page.getByLabel('To', { exact: true }).fill('1BoatSLRHtKNngkdXEeobR76b53LETtpyT')
      await page.getByLabel('Amount in BSV').fill('0.00000001')
      assert.equal(await page.getByRole('button', { name: 'Send BSV', exact: true }).isDisabled(), true)
      if (evidence) await page.screenshot({ path: path.join(evidence, `pending-${width}.png`), fullPage: true })
      await page.evaluate(() => window.fixtureSetStatus('completed'))
      await status.getByRole('button', { name: 'Refresh payment status' }).click()
      await page.getByText('Payment confirmed by your wallet.', { exact: true }).waitFor()
      assert.equal(await status.count(), 0)
      assert.equal(await page.locator('#fixture-actions').innerText(), 'Isolated fixture · 0 wallet transactions')
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      // A fresh connection must show an unknown sending outcome differently.
      await page.goto(origin + '/test/ui.html?pending=sending')
      await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
      await status.getByRole('heading', { name: 'Check your wallet before continuing', exact: true }).waitFor()
      await status.getByRole('button', { name: 'Refresh payment status' }).click()
      await page.getByText('The payment outcome is not known.', { exact: false }).last().waitFor()
      assert.equal(await page.locator('#fixture-actions').innerText(), 'Isolated fixture · 0 wallet transactions')
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
      console.log(`PASS ${width}px: pending proof, repeated refresh, completion and unknown outcome; zero wallet transactions or external requests`)
    } finally { await context.close() }
  }
} finally { await browser.close(); await server.close() }
