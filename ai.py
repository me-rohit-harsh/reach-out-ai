import os
import json
from groq import Groq

class AIGenerator:
    def __init__(self, api_key=None):
        self.client = Groq(
            api_key=api_key or os.environ.get("GROQ_API_KEY")
        )

    def generate_email(self, job_post_content, cv_content, author='', author_title='', custom_prompt_template=''):
        author_lower = author.lower() if author else ""
        if not author or any(word in author_lower for word in ["unknown", "recruiter", "member", "user", "someone"]):
            greeting = "Dear Hiring Manager,"
            poster_context = ""
        else:
            first_name = author.split(' ')[0]
            greeting = f"Dear {first_name},"
            poster_context = f"The job post / recipient is {author}{f', {author_title}' if author_title else ''}. Address them as the recipient in the greeting."

        prompt = ""
        if custom_prompt_template and custom_prompt_template.strip() != "":
            prompt = custom_prompt_template \
                .replace("{{greeting}}", greeting) \
                .replace("{{posterContext}}", poster_context) \
                .replace("{{jobPostContent}}", job_post_content) \
                .replace("{{cvContent}}", cv_content)
        elif os.path.exists('prompt_template.txt'):
            try:
                with open('prompt_template.txt', 'r', encoding='utf-8') as f:
                    template = f.read()
                if template.strip() != "":
                    prompt = template \
                        .replace("{{greeting}}", greeting) \
                        .replace("{{posterContext}}", poster_context) \
                        .replace("{{jobPostContent}}", job_post_content) \
                        .replace("{{cvContent}}", cv_content)
            except Exception as e:
                print("Error reading prompt template file:", str(e))
                    
        if not prompt:
            prompt = f"""You are a senior job applicant writing a highly professional, well-formatted email application.
{poster_context}

LinkedIn Job Post:
{job_post_content}

My CV:
{cv_content}

RULES:
1. Format the email body as a clean HTML snippet wrapped in a `div` tag with style `font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #0b1c30;`.
2. Start the body with the greeting: {greeting}<br><br>
3. Structure the email body using proper paragraphs separated by `<br><br>` tags.
   - Paragraph 1: Reference something SPECIFIC from the job post (a pain point, tech stack, wording they used) to show you actually read it.
   - Paragraph 2: Mention 2 specific experiences or key accomplishments from my CV that directly match the post's needs. Be concrete, not generic.
   - Paragraph 3: Explain in one short sentence why THIS specific role/company excites you.
4. End the body with a professional sign-off and a clean signature using `<br>` tags:
   Best regards,<br>
   [Applicant Name]
5. CRITICAL INSTRUCTION FOR SIGNATURE:
   - The recipient of the email is the post author/HR ({greeting}).
   - The sender of the email is the APPLICANT whose resume is in 'My CV'.
   - Extract the applicant's name (sender) from 'My CV' for the sign-off signature (e.g. Best regards,<br>Applicant Name).
   - DO NOT use placeholders like [Name] or [Company].
   - DO NOT use the recipient's name or the HR manager's/post author's name in the sign-off signature!
6. Do NOT use markdown symbols (like `**` or `*`); use HTML tags like `<strong>` or `<em>` if bolding or emphasis is needed.
7. Keep the text concise, professional, and under 180 words.

Return ONLY valid JSON:
{{"subject": "...", "body": "..."}}"""

        max_retries = 3
        retry_delay = 10
        
        for attempt in range(max_retries):
            try:
                chat_completion = self.client.chat.completions.create(
                    messages=[
                        {"role": "user", "content": prompt}
                    ],
                    model="llama-3.3-70b-versatile",
                    temperature=0.7,
                    max_tokens=1024,
                )
                
                full_content = chat_completion.choices[0].message.content or ""
                
                # Clean markdown code fences if wrapped in ```json
                cleaned = full_content.strip()
                if cleaned.startswith("```"):
                    if cleaned.startswith("```json"):
                        cleaned = cleaned[7:]
                    else:
                        cleaned = cleaned[3:]
                    if cleaned.endswith("```"):
                        cleaned = cleaned[:-3]
                    cleaned = cleaned.strip()
                    
                result = json.loads(cleaned)
                
                if 'body' in result:
                    result['body'] = "\n".join([line.strip() for line in result['body'].split('\n')])
                    
                return result
            except Exception as e:
                err_msg = str(e)
                if "rate_limit" in err_msg.lower() or "429" in err_msg or "too many requests" in err_msg.lower():
                    if attempt < max_retries - 1:
                        print(f"Groq Rate limit hit. Retrying in {retry_delay} seconds (Attempt {attempt + 1}/{max_retries})...")
                        import time
                        time.sleep(retry_delay)
                        retry_delay *= 2  # Exponential backoff
                        continue
                print("AI generation error:", err_msg)
                return None
