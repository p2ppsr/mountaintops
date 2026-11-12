import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = path.resolve(import.meta.dirname, '../..'), evidence = process.env.ACTIONS_EVIDENCE
if (evidence) await mkdir(evidence, { recursive: true })
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } }); await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    const page = await context.newPage(), errors = [], external = []
    page.on('pageerror', error => errors.push(error.message))
    await context.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); external.push(route.request().url()); return route.abort() })
    const idle = () => page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false')
    const action = page.getByRole('status', { name: 'Action progress' })
    const release = () => page.getByRole('button', { name: 'Complete simulated action', exact: true }).click()
    const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, `${name}-${width}.png`), fullPage: true }) }
    const noActivity = async () => { await idle(); assert.equal(await action.count(), 0); assert.equal(await page.locator('button[aria-busy=true]').count(), 0) }
    const activeButton = async label => {
      const button = page.getByRole('button', { name: label, exact: true })
      assert.equal(await button.getAttribute('aria-busy'), 'true'); assert.equal(await button.isDisabled(), true)
      assert.equal(await button.evaluate(element => getComputedStyle(element).opacity), '1')
    }
    const connect = async query => {
      await page.goto(`${origin}/test/ui.html?${query}`)
      await page.getByRole('button', { name: 'Connect wallet', exact: true }).click(); await idle()
    }
    try {
      await page.goto(`${origin}/test/ui.html?synthetic-worker&hold-connect&hold-copy`)
      await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
      await action.getByText('Connecting your wallet', { exact: true }).waitFor(); await activeButton('Connecting…')
      assert.match(await page.locator('[data-live-progress]').textContent(), /Connecting your wallet/)
      assert.equal(await page.locator('[data-live-progress]').evaluate(element => element.closest('[aria-busy=true]') === null), true, 'live progress is outside the busy region')
      await shot('connect'); await release(); await noActivity()
      await page.getByRole('button', { name: 'Copy address', exact: true }).click()
      await page.getByRole('button', { name: 'Complete simulated copy', exact: true }).waitFor()
      const copy = page.getByRole('button', { name: 'Copy address', exact: true })
      assert.equal(await copy.innerText(), 'Copying…'); assert.equal(await copy.getAttribute('aria-busy'), 'true')
      assert.equal(await page.getByText('Address copied.', { exact: true }).count(), 0)
      await page.getByRole('button', { name: 'Complete simulated copy', exact: true }).click()
      await page.getByText('Address copied.', { exact: true }).waitFor(); await noActivity()

      await page.locator('.address-search > summary').click()
      await page.evaluate(() => window.fixtureHoldWalletCall('getNetwork'))
      await page.getByRole('button', { name: 'Find an address', exact: true }).click()
      await action.getByText('Preparing address search', { exact: true }).waitFor(); await activeButton('Preparing…')
      await release()
      await action.getByText('Finding an address', { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.fixtureWorkerCount()), 1)
      await page.locator('.address-search > summary').click()
      assert.equal(await action.isVisible(), true, 'search progress stays visible when its disclosure closes')
      await shot('search'); await page.locator('.address-search > summary').click()
      await page.getByRole('button', { name: 'Pause', exact: true }).click(); await noActivity()
      await page.getByText('Search paused.', { exact: false }).waitFor()
      await page.locator('.advanced > summary').click()
      await page.evaluate(() => window.fixtureHoldWalletCall('createAction'))
      await page.getByRole('button', { name: 'Save progress', exact: true }).click()
      await action.getByText('Saving search progress', { exact: true }).waitFor(); await activeButton('Saving…')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      assert.equal(await action.locator('.loading-spinner').evaluate(element => getComputedStyle(element).animationName), 'none')
      await page.emulateMedia({ reducedMotion: 'no-preference' }); await shot('save-progress')
      await release(); await noActivity(); await page.getByText('Search progress saved in your wallet.', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Resume stage 2', exact: true }).click()
      await action.getByText('Finding an address', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Finish simulated search', exact: true }).click(); await noActivity()
      await page.getByRole('heading', { name: 'New address found', exact: true }).waitFor()
      await page.evaluate(() => window.fixtureHoldWalletCall('createAction', true))
      await page.getByRole('button', { name: 'Save & use address', exact: true }).click()
      await action.getByText('Saving your address', { exact: true }).waitFor(); await activeButton('Saving…')
      await release(); await noActivity(); await page.getByRole('alert').waitFor()
      assert.equal(await page.getByText('New address saved and ready to receive.', { exact: true }).count(), 0)
      await page.evaluate(() => window.fixtureHoldWalletCall('createAction'))
      await page.getByRole('button', { name: 'Save & use address', exact: true }).click()
      await action.getByText('Saving your address', { exact: true }).waitFor(); await shot('save-address')
      await release(); await noActivity(); await page.getByText('New address saved and ready to receive.', { exact: true }).waitFor()
      await page.locator('.address-list > summary').click()
      await page.getByRole('button', { name: 'Use for receiving', exact: true }).click(); await noActivity()
      await page.getByText('Receiving address changed.', { exact: false }).waitFor()
      await page.getByRole('button', { name: /More info about stage/ }).first().click()
      await page.getByRole('dialog').waitFor(); await page.getByRole('button', { name: 'Close address information' }).click()
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await page.getByText('Enter a recipient and amount to continue.', { exact: true }).waitFor(); await noActivity()
      await page.getByRole('button', { name: 'Receive', exact: true }).click()
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))

      await connect('pending=unprocessed')
      await page.evaluate(() => window.fixtureHoldWalletCall('listActions'))
      await page.getByRole('button', { name: 'Check payment in wallet', exact: true }).click()
      await action.getByText('Checking payment status', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Complete simulated action', exact: true }).waitFor()
      await release(); await noActivity(); assert.equal(await page.getByRole('region', { name: 'Wallet payment status' }).count(), 1)
      await connect('pending=nosend')
      await page.evaluate(() => window.fixtureHoldWalletCall('abortAction'))
      await page.getByRole('button', { name: 'Cancel unsent payment', exact: true }).click()
      await action.getByText('Canceling unfinished payment', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Complete simulated action', exact: true }).waitFor(); await shot('cancel')
      await release(); await noActivity(); await page.getByText('Unsent payment canceled.', { exact: true }).waitFor()
      if (width === 1440) {
        await page.goto(`${origin}/test/ui.html`)
        await page.clock.install()
        await page.getByRole('button', { name: 'Connect wallet', exact: true }).click(); await idle()
        await page.evaluate(() => window.fixtureHoldWalletCall('getNetwork'))
        await page.clock.fastForward(60001)
        await action.getByText('Updating address status', { exact: true }).waitFor()
        await page.getByRole('button', { name: 'Complete simulated action', exact: true }).waitFor()
        await release(); await noActivity()
      }
      assert.deepEqual(errors, []); assert.deepEqual(external, [])
      console.log(`PASS ${width}px: connect/copy/search/pause/resume/save/review/cancel/background feedback; no external requests`)
    } finally { await context.close() }
  }
} finally { await browser.close(); await server.close() }
