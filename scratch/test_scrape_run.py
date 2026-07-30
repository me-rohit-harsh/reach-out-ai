import asyncio
import sys
import os

# Add root directory to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scraper import LinkedInScraper

async def main():
    log_queue = asyncio.Queue()
    
    def put_log(msg):
        print(f"Log callback: {msg}")
        log_queue.put_nowait({"type": "log", "content": msg})
        
    try:
        scraper = LinkedInScraper()
        await scraper.init()
        print("Scraping...")
        await scraper.scrape_posts_from_url("https://www.google.com", put_log, 1)
        await scraper.close()
        print("Success!")
    except Exception as e:
        print("Failed with error:", str(e))

if __name__ == "__main__":
    asyncio.run(main())
