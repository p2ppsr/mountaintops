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
      await page.goto(origin + '/test/ui.html?pending=unproven&payments')
      await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('main').getAttribute('aria-busy') === 'false')
      const status = page.getByRole('region', { name: 'Wallet payment status' })
      await status.getByRole('heading', { name: 'Payment sent', exact: true }).waitFor()
      await status.getByText('Waiting for confirmation.', { exact: true }).waitFor()
      assert.equal(await status.getAttribute('class'), 'payment-status sent')
      await page.getByText('Received', { exact: true }).waitFor()
      await page.getByText('10,002 sats', { exact: true }).waitFor()
      await page.getByText('New transfers are paused until your outgoing payment confirms.', { exact: true }).waitFor()
      await status.getByText('Payment details', { exact: true }).click()
      await status.getByText('Last checked', { exact: false }).waitFor()
      await status.getByText('Payment details', { exact: true }).click()
      if (evidence) await page.screenshot({ path: path.join(evidence, `received-${width}.png`), fullPage: true })
      await page.evaluate(() => window.fixtureBlockRecoveryReads())
      for (let i = 0; i < 2; i++) {
        await status.getByRole('button', { name: 'Refresh payment status' }).click()
        await status.getByRole('button', { name: 'Refresh payment status' }).waitFor({ state: 'visible' })
        await page.waitForFunction(() => !document.querySelector('[aria-label="Wallet payment status"] button').disabled)
        assert.equal(await page.getByRole('alert').count(), 0, 'status refresh must not access recovery records or chain coverage')
        await status.getByRole('heading', { name: 'Payment sent', exact: true }).waitFor()
        assert.equal(await page.locator('.feedback').count(), 0, 'a successful status refresh must not add a duplicate notice')
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
      await status.getByRole('heading', { name: 'Check payment status', exact: true }).waitFor()
      await status.getByRole('button', { name: 'Refresh payment status' }).click()
      await status.getByText('Your wallet has not reported a clear result.', { exact: true }).waitFor()
      assert.equal(await page.locator('.feedback').count(), 0)
      if (evidence) await page.screenshot({ path: path.join(evidence, `unknown-${width}.png`), fullPage: true })
      assert.equal(await page.locator('#fixture-actions').innerText(), 'Isolated fixture · 0 wallet transactions')
      await page.evaluate(() => { window.fixtureSetStatus('completed'); window.fixtureAddConflict() })
      await status.getByRole('button', { name: 'Refresh payment status' }).click()
      await status.getByText('Your wallet has not reported a clear result.', { exact: true }).waitFor()
      assert.equal(await page.locator('#fixture-actions').innerText(), 'Isolated fixture · 0 wallet transactions')
      // A stale cancel button must not cancel a payment submitted elsewhere.
      await page.goto(origin + '/test/ui.html?pending=nosend')
      await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
      await status.getByRole('button', { name: 'Cancel unsent payment' }).waitFor()
      await page.evaluate(() => { window.fixtureBlockRecoveryReads(); window.fixtureSetStatus('unproven') })
      await status.getByRole('button', { name: 'Cancel unsent payment' }).click()
      await status.getByRole('heading', { name: 'Payment sent', exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.fixtureAbortCalls()), 0)
      // A still-unsent preparation retains its normal explicit cancellation.
      await page.evaluate(() => window.fixtureSetStatus('nosend'))
      await status.getByRole('button', { name: 'Refresh payment status' }).click()
      await status.getByRole('button', { name: 'Cancel unsent payment' }).click()
      await page.getByText('Unsent payment canceled.', { exact: true }).waitFor()
      assert.equal(await status.count(), 0)
      assert.equal(await page.evaluate(() => window.fixtureAbortCalls()), 1)
      assert.equal(await page.locator('#fixture-actions').innerText(), 'Isolated fixture · 0 wallet transactions')
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
      console.log(`PASS ${width}px: pending proof, repeated refresh, completion and unknown outcome; zero wallet transactions or external requests`)
    } finally { await context.close() }
  }
} finally { await browser.close(); await server.close() }
