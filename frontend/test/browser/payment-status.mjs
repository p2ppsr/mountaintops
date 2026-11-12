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
const destination = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'

try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' })
    const page = await context.newPage(), errors = [], unexpected = []
    page.on('pageerror', error => errors.push(error.message))
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      unexpected.push(route.request().url()); return route.abort()
    })
    const idle = () => page.waitForFunction(() => document.querySelector('main').getAttribute('aria-busy') === 'false')
    const connect = async query => {
      await page.goto(`${origin}/test/ui.html?${query}`)
      await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
      await idle()
    }
    const draft = async amount => {
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await page.getByLabel('To', { exact: true }).fill(destination)
      await page.getByLabel('Amount', { exact: true }).fill(amount)
      await page.getByRole('button', { name: 'Review payment', exact: true }).click()
      await page.getByRole('region', { name: 'Review payment' }).waitFor()
    }
    const receipt = page.getByRole('status', { name: 'Payment receipt' })
    const unresolved = page.getByRole('region', { name: 'Wallet payment status' })
    const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, `${name}-${width}.png`), fullPage: true }) }
    try {
      // Existing accepted unmined funds are usable, without status polling.
      await connect('pending=unproven&payments')
      assert.equal(await unresolved.count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Move to wallet' }).isEnabled(), true)
      assert.doesNotMatch(await page.locator('body').innerText(), /waiting for confirmation|resume after confirmation/i)
      await shot('receive')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await page.getByLabel('To', { exact: true }).fill(destination)
      await page.getByLabel('Amount', { exact: true }).fill('1000')
      await page.getByLabel('Amount unit').selectOption('BSV')
      assert.equal(await page.getByLabel('Amount', { exact: true }).inputValue(), '0.00001000')
      await page.getByLabel('Amount unit').selectOption('sats')
      assert.equal(await page.getByLabel('Amount', { exact: true }).inputValue(), '1000')
      await page.getByRole('button', { name: 'Review payment', exact: true }).click()
      await page.getByRole('region', { name: 'Review payment' }).waitFor()
      assert.equal(await page.evaluate(() => window.fixtureSubmissionCount()), 0)
      await shot('review')
      await page.getByRole('button', { name: 'Back', exact: true }).click()
      assert.equal(await page.getByLabel('Amount', { exact: true }).inputValue(), '1000')
      await page.getByRole('button', { name: 'Review payment', exact: true }).click()
      // Two immediate clicks still authorize one submission only.
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find(item => item.textContent === 'Send payment')
        button.click(); button.click()
      })
      await receipt.getByText('Payment sent', { exact: true }).waitFor()
      await idle()
      assert.equal(await page.evaluate(() => window.fixtureSubmissionCount()), 1)
      assert.equal(await unresolved.count(), 0)
      assert.equal(await page.getByRole('region', { name: 'Review payment' }).count(), 0)
      await shot('sent')
      // A distinct subsequent payment does not wait for either payment to mine.
      await receipt.getByRole('button', { name: 'Send another' }).click()
      assert.equal(await page.getByLabel('To', { exact: true }).inputValue(), '')
      await draft('500')
      await page.getByRole('button', { name: 'Send payment', exact: true }).click()
      await receipt.getByText('Payment sent', { exact: true }).waitFor(); await idle()
      assert.equal(await page.evaluate(() => window.fixtureSubmissionCount()), 2)
      await receipt.getByRole('button', { name: 'Done', exact: true }).click()
      assert.equal(await page.getByRole('button', { name: 'Move to wallet' }).isEnabled(), true)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))

      // Truly unresolved outcomes are distinct; checking cannot create a payment.
      await connect('pending=unprocessed&payments')
      await unresolved.getByRole('heading', { name: 'Check your wallet' }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Move to wallet' }).isDisabled(), true)
      await page.evaluate(() => window.fixtureBlockRecoveryReads())
      for (let i = 0; i < 2; i++) {
        await unresolved.getByRole('button', { name: 'Check payment in wallet' }).click(); await idle()
        assert.equal(await page.getByRole('alert').count(), 0)
      }
      await shot('unknown')
      assert.equal(await page.evaluate(() => window.fixtureSubmissionCount()), 0)
      await page.evaluate(() => window.fixtureSetStatus('unproven'))
      await unresolved.getByRole('button', { name: 'Check payment in wallet' }).click(); await idle()
      assert.equal(await unresolved.count(), 0)
      await receipt.getByText('Payment accepted', { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.fixtureSubmissionCount()), 0)

      if (width === 1440) {
        // Cancel is checked against fresh wallet history, never a stale button.
        await connect('pending=nosend')
        await page.evaluate(() => { window.fixtureBlockRecoveryReads(); window.fixtureSetStatus('unproven') })
        await unresolved.getByRole('button', { name: 'Cancel unsent payment' }).click(); await idle()
        assert.equal(await page.evaluate(() => window.fixtureAbortCalls()), 0)
        assert.equal(await unresolved.count(), 0)
        await connect('pending=nosend')
        await page.evaluate(() => window.fixtureBlockRecoveryReads())
        await unresolved.getByRole('button', { name: 'Cancel unsent payment' }).click(); await idle()
        assert.equal(await page.evaluate(() => window.fixtureAbortCalls()), 1)
        assert.equal(await unresolved.count(), 0)

        for (const mode of ['missing', 'accepted-lost', 'failed']) {
          await connect(`submit=${mode}`); await draft('1000')
          await page.getByRole('button', { name: 'Send payment', exact: true }).click(); await idle()
          await unresolved.getByRole('heading', { name: 'Check your wallet' }).waitFor()
          assert.equal(await receipt.count(), 0)
          assert.equal(await page.evaluate(() => window.fixtureSubmissionCount()), 1)
          await unresolved.getByRole('button', { name: 'Check payment in wallet' }).click(); await idle()
          assert.equal(await page.evaluate(() => window.fixtureSubmissionCount()), 1)
          if (mode === 'missing') assert.equal(await unresolved.count(), 1)
          else if (mode === 'accepted-lost') { assert.equal(await unresolved.count(), 0); await receipt.getByText('Payment accepted', { exact: true }).waitFor() }
          else { assert.equal(await receipt.count(), 0); await page.getByText('Your wallet reports this payment failed.', { exact: false }).waitFor() }
        }
        // Post-acceptance metadata problems cannot erase success or cause retry.
        await connect('block-after-accept'); await draft('1000')
        await page.getByRole('button', { name: 'Send payment', exact: true }).click(); await idle()
        await receipt.getByText('Payment sent', { exact: true }).waitFor()
        assert.equal(await page.getByRole('alert').count(), 0)
        assert.equal(await page.evaluate(() => window.fixtureSubmissionCount()), 1)

        await connect(''); await draft('1000')
        await page.evaluate(() => window.fixtureSetNetwork('testnet'))
        await page.getByRole('button', { name: 'Send payment', exact: true }).click(); await idle()
        await page.getByRole('button', { name: 'Connect wallet', exact: true }).waitFor()
        assert.equal(await page.evaluate(() => window.fixtureSubmissionCount()), 0)
        assert.equal(await receipt.count(), 0)
      }
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
      console.log(`PASS ${width}px: wallet acceptance, amount review, single submission, subsequent payment, unresolved recovery; no external requests`)
    } finally { await context.close() }
  }
} finally { await browser.close(); await server.close() }
