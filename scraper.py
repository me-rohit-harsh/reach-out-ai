import re
import os
import json
import asyncio
import random
from playwright.async_api import async_playwright

EMAIL_REGEX = re.compile(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}')

class LinkedInScraper:
    def __init__(self):
        self.browser = None
        self.context = None
        self.auth_state_path = 'auth_state.json'
        self.playwright = None

    async def init(self, headless=False):
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(
            headless=headless,
            args=['--disable-blink-features=AutomationControlled', '--no-sandbox']
        )
        
        if os.path.exists(self.auth_state_path):
            self.context = await self.browser.new_context(
                storage_state=self.auth_state_path,
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            )
        else:
            self.context = await self.browser.new_context(
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            )

    async def login(self, email, password):
        pass

    async def scrape_posts_from_url(self, url, log_callback, post_callback, max_pages=10):
        page = await self.context.new_page()
        results = []
        seen_urns = set()
        
        try:
            log_callback(f"Navigating -> {url}")
            await page.goto(url, wait_until='domcontentloaded', timeout=90000)
            await page.wait_for_timeout(3000)
            
            if '/login' in page.url or '/checkpoint' in page.url:
                log_callback('Authentication required. Please log in manually in the browser window...')
                try:
                    # Wait for user to log in and get redirected away from login/checkpoint pages
                    await page.wait_for_url(lambda u: '/login' not in u and '/checkpoint' not in u, timeout=300000)
                    log_callback('Authenticated! Saving session state...')
                    await self.context.storage_state(path=self.auth_state_path)
                    # Re-navigate to target URL now that we are authenticated
                    await page.goto(url, wait_until='domcontentloaded', timeout=90000)
                    await page.wait_for_timeout(3000)
                except Exception:
                    log_callback('Error: Login timeout or verification failed. Stopping.')
                    return results
                
            page_num = 1
            stale_count = 0
            max_stale = 4
            
            log_callback(f"Page {page_num} loaded.")
            
            while page_num <= max_pages:
                # Wait for search results or post cards to load dynamically via AJAX
                try:
                    await page.wait_for_selector('[role="listitem"], [data-urn], [componentkey*="FeedType"]', timeout=15000)
                    await page.wait_for_timeout(1000)
                except Exception:
                    pass

                # Expand "see more" buttons
                await self._expand_see_more(page)
                await page.wait_for_timeout(800)
                
                # Extract posts
                posts = await self._extract_posts(page)
                new_count = 0
                
                for post in posts:
                    urn = post.get('urn')
                    if not urn or urn in seen_urns:
                        continue
                    seen_urns.add(urn)
                    new_count += 1
                    
                    emails = self._extract_emails(post.get('text', ''))
                    if emails:
                        log_callback(f"Found URN {urn}: {post.get('author') or 'Unknown'} -> {', '.join(emails)}")
                    
                    try:
                        await post_callback(post, emails)
                    except Exception as ex:
                        log_callback(f"Callback error: {str(ex)}")
                
                # Try paginated Next button first
                next_btn = await page.query_selector(
                    'button[aria-label="Next"]:not([disabled]), .artdeco-pagination__button--next:not([disabled])'
                )
                
                if next_btn:
                    await page.wait_for_timeout(random.randint(1500, 3000))
                    log_callback(f"Clicking Next -> page {page_num + 1}...")
                    await next_btn.scroll_into_view_if_needed()
                    await next_btn.click()
                    await page.wait_for_timeout(random.randint(4000, 7000))
                    try:
                        await page.wait_for_load_state('domcontentloaded', timeout=5000)
                    except Exception:
                        pass
                    await page.wait_for_timeout(random.randint(2000, 4000))
                    page_num += 1
                    stale_count = 0
                    log_callback(f"Page {page_num} loaded.")
                    continue
                    
                # Infinite scroll mode
                prev_height = await page.evaluate("() => document.body.scrollHeight")
                
                await page.evaluate("() => window.scrollBy(0, Math.floor(window.innerHeight * 0.8))")
                await page.wait_for_timeout(random.randint(1500, 2500))
                await page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
                await page.wait_for_timeout(random.randint(2000, 3500))
                
                new_height = await page.evaluate("() => document.body.scrollHeight")
                
                if new_height == prev_height and new_count == 0:
                    stale_count += 1
                    log_callback(f"No new content ({stale_count}/{max_stale})")
                    if stale_count >= max_stale:
                        log_callback('End of feed reached.')
                        break
                    await page.wait_for_timeout(2000)
                else:
                    stale_count = 0
                    if len(seen_urns) % 10 == 0 and len(seen_urns) > 0:
                        page_num += 1
                        log_callback(f"--- Page {page_num} (scroll) ---")
                        
            log_callback(f"Done. {len(results)} posts with emails across {page_num} page(s).")
            return results
        except Exception as e:
            log_callback(f"Scrape error: {str(e)}")
            return results
        finally:
            await page.close()

    async def _expand_see_more(self, page):
        try:
            selectors = [
                'button.lt-line-clamp__more',
                'button[aria-label="see more"]',
                'span.lt-line-clamp__more',
                '.feed-shared-inline-show-more-text button',
                '.see-more'
            ]
            for sel in selectors:
                btns = await page.query_selector_all(sel)
                for btn in btns:
                    try:
                        await btn.click()
                        await page.wait_for_timeout(random.randint(400, 1200))
                    except Exception:
                        pass
        except Exception:
            pass

    async def _extract_posts(self, page):
        return await page.evaluate("""() => {
            const results = [];
            const seen = new Set();
            const nodes = document.querySelectorAll('[role="listitem"], [data-urn], [componentkey*="FeedType"]');
            for (const el of nodes) {
                let urn = el.getAttribute('data-urn') || el.getAttribute('componentkey');
                if (!urn) {
                    const textContent = el.innerText || '';
                    if (textContent.length < 50) continue;
                    urn = textContent.slice(0, 100);
                }
                if (seen.has(urn)) continue;
                seen.add(urn);

                const authorLink = el.querySelector('a[href*="/in/"]');
                let author = '';
                if (authorLink) {
                    author = authorLink.innerText.trim().split('\\n')[0];
                }
                if (!author) {
                    const fallbackActor = el.querySelector('.update-components-actor__name, .feed-shared-actor__name');
                    if (fallbackActor) {
                        author = fallbackActor.innerText.trim().split('\\n')[0];
                    }
                }

                let authorTitle = '';
                const titleEl = el.querySelector(
                    '.update-components-actor__description, ' +
                    '.feed-shared-actor__description'
                );
                if (titleEl) {
                    authorTitle = titleEl.innerText.trim().split('\\n')[0];
                } else if (authorLink) {
                    const parentContainer = authorLink.parentElement;
                    if (parentContainer) {
                        const descriptionSibling = parentContainer.querySelector('p, div');
                        if (descriptionSibling && descriptionSibling !== authorLink) {
                            authorTitle = descriptionSibling.innerText.trim().split('\\n')[0];
                        }
                    }
                }

                const textEl = el.querySelector(
                    '[data-testid="expandable-text-box"], ' +
                    '.update-components-text, ' +
                    '.feed-shared-update-v2__description, ' +
                    '.feed-shared-text, ' +
                    '.attributed-text-segment-list__container'
                );

                const text = textEl ? textEl.innerText.trim() : el.innerText.trim();
                if (!text || text.length < 10) continue;

                results.push({
                    urn: urn,
                    author: author,
                    authorTitle: authorTitle,
                    text: text
                });
            }
            return results;
        }""")

    def _extract_emails(self, text):
        matches = EMAIL_REGEX.findall(text) or []
        filtered = [e for e in matches if not re.search(r'\.(png|jpg|jpeg|gif|svg|webp)$', e, re.IGNORECASE)]
        return list(dict.fromkeys(filtered))

    async def close(self):
        try:
            if self.browser:
                await self.browser.close()
        except Exception:
            pass
        self.browser = None
        self.context = None
        if self.playwright:
            try:
                await self.playwright.stop()
            except Exception:
                pass
        self.playwright = None
