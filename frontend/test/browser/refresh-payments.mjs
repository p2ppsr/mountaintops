import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = path.resolve(import.meta.dirname, '../..')
const evidence = process.env.REFRESH_EVIDENCE
if (evidence) await mkdir(evidence, { recursive: true })
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, permissions: ['clipboard-write'], serviceWorkers: 'block' })
    const page = await context.newPage(), errors = [], external = []
    page.on('pageerror', error => errors.push(error.message))
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      external.push(route.request().url()); return route.abort()
    })
    const idle = () => page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false')
    let baselineSubmissions = 0
    const connect = async extra => {
      await page.goto(`${origin}/test/ui.html?saved&payments&hold-refresh&${extra}`); await page.bringToFront()
      await page.getByRole('button', { name: 'Connect wallet', exact: true }).click(); await idle()
      baselineSubmissions = await page.evaluate(() => window.fixtureSubmissionCount())
    }
    const progress = page.getByRole('status', { name: 'Refresh progress' })
    const refresh = page.getByRole('button', { name: 'Refresh payments', exact: true })
    const amounts = () => page.locator('.payments-panel .payment-row strong').allTextContents()
    try {
      await connect('')
      const before = await amounts()
      await page.evaluate(() => { const button = document.querySelector('[aria-label="Refresh payments"]'); button.click(); button.click() })
      await page.getByRole('button', { name: 'Complete simulated refresh', exact: true }).waitFor()
      await progress.getByText('0 of 2 addresses checked', { exact: true }).waitFor()
      assert.equal(await refresh.innerText(), 'Refreshing…')
      assert.equal(await refresh.getAttribute('aria-busy'), 'true')
      assert.equal(await refresh.evaluate(element => getComputedStyle(element).opacity), '1')
      assert.equal(await progress.locator('svg').evaluate(element => getComputedStyle(element).animationName), 'payment-orbit')
      assert.deepEqual(await amounts(), before, 'refresh keeps existing balances visible')
      assert.equal(await page.evaluate(() => window.fixtureRefreshReads()), 1, 'two clicks still start one refresh')
      await page.getByRole('button', { name: 'Copy address', exact: true }).first().click()
      await page.getByText('Address copied.', { exact: true }).waitFor()
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      if (evidence) await page.screenshot({ path: path.join(evidence, `refreshing-${width}.png`), fullPage: true })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      assert.equal(await progress.locator('svg').evaluate(element => getComputedStyle(element).animationName), 'none')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.getByRole('button', { name: 'Complete simulated refresh', exact: true }).click(); await idle()
      assert.equal(await progress.count(), 0)
      assert.equal(await refresh.innerText(), 'Refresh')
      assert.equal(await refresh.isEnabled(), true)
      assert.equal(await page.evaluate(() => window.fixtureRefreshReads()), 2)
      assert.equal(await page.evaluate(() => window.fixtureSubmissionCount()), baselineSubmissions)
      await page.getByText('Payments checked.', { exact: true }).waitFor()

      await connect('refresh-error')
      const retained = await amounts()
      await refresh.click(); await page.getByRole('button', { name: 'Complete simulated refresh', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Complete simulated refresh', exact: true }).click(); await idle()
      assert.equal(await progress.count(), 0)
      assert.equal(await refresh.isEnabled(), true)
      assert.deepEqual(await amounts(), retained, 'failed refresh cannot erase restored funds')
      assert.equal(await page.getByRole('alert').count(), 1)
      assert.equal(await page.getByText('Payments checked.', { exact: true }).count(), 0)
      assert.equal(await page.evaluate(() => window.fixtureSubmissionCount()), baselineSubmissions)

      if (width === 1440) {
        await connect('')
        await page.locator('.address-list > summary').click()
        const single = page.locator('.address-list .address-card').getByRole('button', { name: 'Refresh', exact: true })
        await single.click(); await page.getByRole('button', { name: 'Complete simulated refresh', exact: true }).waitFor()
        await progress.getByText('Checking this address for new payments…', { exact: true }).waitFor()
        assert.equal(await single.innerText(), 'Refreshing…')
        await page.getByRole('button', { name: 'Complete simulated refresh', exact: true }).click(); await idle()
        assert.equal(await progress.count(), 0)
        assert.equal(await page.evaluate(() => window.fixtureRefreshReads()), 1)
        await page.evaluate(() => window.fixtureHoldNextRefresh('addresses'))
        const addresses = page.getByRole('button', { name: 'Refresh addresses', exact: true })
        await addresses.click(); await page.getByRole('button', { name: 'Complete simulated refresh', exact: true }).waitFor()
        await progress.getByText('Checking your addresses', { exact: true }).waitFor()
        assert.equal(await addresses.innerText(), 'Refreshing…')
        await page.getByRole('button', { name: 'Complete simulated refresh', exact: true }).click(); await idle()
        assert.equal(await progress.count(), 0)
        assert.equal(await addresses.isEnabled(), true)
      }
      assert.deepEqual(errors, []); assert.deepEqual(external, [])
      console.log(`PASS ${width}px: visible refresh progress, preserved balances/copy, reduced motion, success/failure cleanup; no external requests`)
    } finally { await context.close() }
  }
} finally { await browser.close(); await server.close() }
