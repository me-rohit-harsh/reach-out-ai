const Groq = require('groq-sdk');

class AIGenerator {
  constructor(apiKey) {
    // Initialize Groq client
    this.client = new Groq({
      apiKey: apiKey || process.env.GROQ_API_KEY
    });
  }

  async generateEmail(jobPostContent, cvContent, author = '', authorTitle = '', customPromptTemplate = '') {
    const fs = require('fs');
    const greeting = author
      ? `Dear ${author.split(' ')[0]},`
      : 'Dear Hiring Manager,';

    const posterContext = author
      ? `The job post / recipient is ${author}${authorTitle ? `, ${authorTitle}` : ''}. Address them as the recipient in the greeting.`
      : '';

    let prompt = '';
    if (customPromptTemplate && customPromptTemplate.trim() !== '') {
      prompt = customPromptTemplate
        .replace(/\{\{greeting\}\}/g, greeting)
        .replace(/\{\{posterContext\}\}/g, posterContext)
        .replace(/\{\{jobPostContent\}\}/g, jobPostContent)
        .replace(/\{\{cvContent\}\}/g, cvContent);
    } else if (fs.existsSync('prompt_template.txt') && fs.readFileSync('prompt_template.txt', 'utf8').trim() !== '') {
      const template = fs.readFileSync('prompt_template.txt', 'utf8');
      prompt = template
        .replace(/\{\{greeting\}\}/g, greeting)
        .replace(/\{\{posterContext\}\}/g, posterContext)
        .replace(/\{\{jobPostContent\}\}/g, jobPostContent)
        .replace(/\{\{cvContent\}\}/g, cvContent);
    } else {
      prompt = `You are a senior job applicant writing a highly personal, human application email.
${posterContext}

LinkedIn Job Post:
${jobPostContent}

My CV:
${cvContent}

RULES:
1. Start with: ${greeting}
2. First sentence: reference something SPECIFIC from the post (a pain point, tech stack, wording they used) — show you actually read it.
3. Second paragraph: 2 specific skills/experiences from CV that directly match the post. Be concrete, not generic.
4. Third paragraph: one short sentence why THIS company/role excites you — make it feel human, not templated.
5. Close naturally with sign-off. CRITICAL: Extract the applicant's name (sender) from 'My CV' for the sign-off signature. DO NOT use the recipient's or HR manager's name!
6. NO placeholders like [Name], [Company], [Date]. NO bullet points. Plain text only.
7. Under 180 words total.
8. NO leading spaces or indentation on any line.

Return ONLY valid JSON:
{"subject": "...", "body": "..."}`;
    }

    try {
      const chatCompletion = await this.client.chat.completions.create({
        messages: [
          { role: 'user', content: prompt }
        ],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.7,
        max_tokens: 1024,
      });

      const fullContent = chatCompletion.choices[0]?.message?.content || '';

      // Strip markdown code fences if model wraps JSON in ```
      const cleaned = fullContent.replace(/```json?\n?/gi, '').replace(/```/g, '').trim();
      const result = JSON.parse(cleaned);

      if (result.body) {
        result.body = result.body
          .split('\n')
          .map(line => line.trim())
          .join('\n');
      }

      return result;
    } catch (error) {
      console.error('AI generation error:', error.message);
      return null;
    }
  }
}

module.exports = AIGenerator;
