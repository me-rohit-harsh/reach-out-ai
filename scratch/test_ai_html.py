import asyncio
import os
import sys
# Add parent directory to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from dotenv import load_dotenv
load_dotenv()

from ai import AIGenerator

async def main():
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        print("Error: GROQ_API_KEY not found in environment.")
        return
        
    ai = AIGenerator(api_key)
    job_post = """
    🚀 We're Hiring: Laravel Developer (mid-level)
    We're looking for a passionate Laravel Developer to join the Delta Sales App team.
    If you enjoy building scalable web applications, solving real-world business challenges, and writing clean, maintainable code, we'd love to hear from you.
    📍 Location: Biratnagar
    📩 Apply at: career@deltatechnepal.com
    """
    
    cv_text = """
    Rahul Kumar
    PHP & Laravel Developer
    Summary: 3+ years experience building Laravel web applications and REST APIs.
    Skills: PHP, Laravel, MySQL, REST APIs, Git, JavaScript.
    """
    
    print("Generating email...")
    result = ai.generate_email(job_post, cv_text, "Ekta Golchha", "Director at Delta Tech")
    
    if result:
        print("\n--- SUBJECT ---")
        print(result.get("subject"))
        print("\n--- HTML BODY ---")
        print(result.get("body"))
    else:
        print("Failed to generate email.")

if __name__ == "__main__":
    asyncio.run(main())
