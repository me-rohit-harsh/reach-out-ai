import asyncio
import sys
import os

# Add root directory to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scraper import LinkedInScraper

async def main():
    print("Initializing scraper...")
    try:
        scraper = LinkedInScraper()
        await scraper.init()
        print("Scraper initialized successfully!")
        await scraper.close()
        print("Scraper closed.")
    except Exception as e:
        print("Initialization failed with error:", str(e))

if __name__ == "__main__":
    asyncio.run(main())
