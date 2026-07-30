const { chromium } = require('playwright');
const fs = require('fs');

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

class LinkedInScraper {
  constructor() {
    this.browser = null;
    this.context = null;
    this.authStatePath = 'auth_state.json';
  }

  async init() {
    this.browser = await chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });

    if (fs.existsSync(this.authStatePath)) {
      this.context = await this.browser.newContext({
        storageState: this.authStatePath,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      });
    } else {
      this.context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      });
    }
  }

  async login(email, password) {
    const page = await this.context.newPage();
    try {
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      if (page.url().includes('/login') || page.url().includes('/checkpoint')) {
        await page.fill('#username', email);
        await page.waitForTimeout(500);
        await page.fill('#password', password);
        await page.waitForTimeout(500);
        await page.click('button[type="submit"]');
        console.log('LinkedIn login submitted. Waiting for redirect or 2FA...');
        await page.waitForURL('**/feed/**', { timeout: 90000 }).catch(() => {});
        await this.context.storageState({ path: this.authStatePath });
        console.log('Session saved to auth_state.json');
      }
    } catch (err) {
      console.error('Login error:', err.message);
    } finally {
      await page.close();
    }
  }

  async scrapePostsFromUrl(url, logCallback, maxPages = 10) {
    const page = await this.context.newPage();
    const results = [];
    const seenUrns = new Set();

    try {
      logCallback(`Navigating → ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(3000);

      // Check if redirected to login
      if (page.url().includes('/login') || page.url().includes('/checkpoint')) {
        logCallback('Error: LinkedIn session expired. Please re-login.');
        return results;
      }

      let pageNum = 1;
      let staleCount = 0;
      const MAX_STALE = 4;

      logCallback(`Page ${pageNum} loaded.`);

      while (pageNum <= maxPages) {
        // Expand all "see more" on current view
        await this._expandSeeMore(page);
        await page.waitForTimeout(800);

        // Extract posts
        const posts = await this._extractPosts(page);
        let newCount = 0;

        for (const post of posts) {
          if (!post.urn || seenUrns.has(post.urn)) continue;
          seenUrns.add(post.urn);
          newCount++;

          const emails = this._extractEmails(post.text);
          if (emails.length > 0) {
            logCallback(`Found: ${post.author || 'Unknown'} → ${emails.join(', ')}`);
            results.push({
              content: post.text,
              author: post.author,
              authorTitle: post.authorTitle,
              emails
            });
          }
        }

        logCallback(`Page ${pageNum}: +${newCount} new | ${seenUrns.size} total seen | ${results.length} with emails`);

        // Try paginated Next button first
        const nextBtn = await page.$(
          'button[aria-label="Next"]:not([disabled]), .artdeco-pagination__button--next:not([disabled])'
        );

        if (nextBtn) {
          logCallback(`Clicking Next → page ${pageNum + 1}...`);
          await nextBtn.scrollIntoViewIfNeeded();
          await nextBtn.click();
          await page.waitForTimeout(3500);
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(1500);
          pageNum++;
          staleCount = 0;
          logCallback(`Page ${pageNum} loaded.`);
          continue;
        }

        // Infinite scroll mode
        const prevHeight = await page.evaluate(() => document.body.scrollHeight);

        // Scroll in steps to trigger lazy loads
        await page.evaluate(() => {
          window.scrollBy(0, Math.floor(window.innerHeight * 0.8));
        });
        await page.waitForTimeout(1200);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1800);

        const newHeight = await page.evaluate(() => document.body.scrollHeight);

        if (newHeight === prevHeight && newCount === 0) {
          staleCount++;
          logCallback(`No new content (${staleCount}/${MAX_STALE})`);
          if (staleCount >= MAX_STALE) {
            logCallback('End of feed reached.');
            break;
          }
          await page.waitForTimeout(2000);
        } else {
          staleCount = 0;
          if (seenUrns.size % 10 === 0 && seenUrns.size > 0) {
            pageNum++;
            logCallback(`--- Page ${pageNum} (scroll) ---`);
          }
        }
      }

      logCallback(`Done. ${results.length} posts with emails across ${pageNum} page(s).`);
      return results;

    } catch (err) {
      logCallback(`Scrape error: ${err.message}`);
      return results;
    } finally {
      await page.close();
    }
  }

  async _expandSeeMore(page) {
    try {
      // Multiple selector patterns for different LinkedIn layouts
      const selectors = [
        'button.lt-line-clamp__more',
        'button[aria-label="see more"]',
        'span.lt-line-clamp__more',
        '.feed-shared-inline-show-more-text button',
        '.see-more'
      ];
      for (const sel of selectors) {
        const btns = await page.$$(sel);
        for (const btn of btns) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(80);
        }
      }
    } catch (_) {}
  }

  async _extractPosts(page) {
    return page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Primary selector: data-urn posts
      const nodes = document.querySelectorAll('[data-urn]');
      for (const el of nodes) {
        const urn = el.getAttribute('data-urn');
        if (!urn || seen.has(urn)) continue;
        seen.add(urn);

        const authorEl = el.querySelector(
          '.update-components-actor__name span[aria-hidden="true"], ' +
          '.feed-shared-actor__name span[aria-hidden="true"], ' +
          '.update-components-actor__name, ' +
          '.feed-shared-actor__name'
        );
        const titleEl = el.querySelector(
          '.update-components-actor__description span[aria-hidden="true"], ' +
          '.feed-shared-actor__description span[aria-hidden="true"], ' +
          '.update-components-actor__description, ' +
          '.feed-shared-actor__description'
        );
        const textEl = el.querySelector(
          '.update-components-text, ' +
          '.feed-shared-update-v2__description, ' +
          '.feed-shared-text, ' +
          '.attributed-text-segment-list__container'
        );

        const text = textEl ? textEl.innerText.trim() : el.innerText.trim();
        if (!text) continue;

        results.push({
          urn,
          author: authorEl ? authorEl.innerText.trim().split('\n')[0] : '',
          authorTitle: titleEl ? titleEl.innerText.trim().split('\n')[0] : '',
          text
        });
      }

      return results;
    });
  }

  _extractEmails(text) {
    const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const matches = text.match(emailRegex) || [];
    // Filter out image/media filenames that match the regex
    const filtered = matches.filter(e => !e.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i));
    return [...new Set(filtered)];
  }

  async close() {
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.context = null;
  }
}

module.exports = LinkedInScraper;
