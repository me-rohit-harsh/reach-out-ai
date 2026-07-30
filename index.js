require('dotenv').config();
const fs = require('fs');
const LinkedInScraper = require('./scraper');
const AIGenerator = require('./ai');
const Mailer = require('./mailer');

async function main() {
  const scraper = new LinkedInScraper();
  const ai = new AIGenerator(process.env.GROQ_API_KEY);
  const mailer = new Mailer({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  });

  const cvPath = process.env.CV_PATH;
  if (!fs.existsSync(cvPath)) {
    console.error(`CV file not found at ${cvPath}. Please check your .env file.`);
    return;
  }
  
  // Read CV content (assuming it's text for the AI, even if we attach the PDF)
  // For PDFs, we'd need a parser, but let's assume a .txt version for AI or simple read for now.
  let cvContent = '';
  try {
    cvContent = fs.readFileSync(cvPath, 'utf8');
  } catch (e) {
    console.warn('Could not read CV as text for AI. AI quality might be limited if CV content is not provided as text.');
  }

  const urls = fs.readFileSync('urls.txt', 'utf8').split('\n').filter(url => url.trim() !== '');

  await scraper.init();

  // Login if necessary
  if (process.env.LINKEDIN_EMAIL && process.env.LINKEDIN_PASSWORD) {
    await scraper.login(process.env.LINKEDIN_EMAIL, process.env.LINKEDIN_PASSWORD);
  } else {
    console.log('No LinkedIn credentials in .env. Using existing session if available.');
  }

  for (const url of urls) {
    console.log(`Processing: ${url}`);
    const postsFound = await scraper.scrapePostsFromUrl(url, console.log);

    if (postsFound && postsFound.length > 0) {
      for (const postData of postsFound) {
        if (postData.emails && postData.emails.length > 0) {
          console.log(`Found emails: ${postData.emails.join(', ')}`);
          
          for (const email of postData.emails) {
            console.log(`Generating personalized email for ${email}...`);
            const emailContent = await ai.generateEmail(
              postData.content, 
              cvContent, 
              postData.author, 
              postData.authorTitle
            );

            if (emailContent) {
              console.log(`Sending application to ${email}...`);
              await mailer.sendApplication(email, emailContent.subject, emailContent.body, cvPath);
            }
          }
        }
      }
    } else {
      console.log('No posts with emails found at this URL.');
    }

    // Wait between posts to be safe
    const delay = Math.floor(Math.random() * (10000 - 5000 + 1)) + 5000;
    console.log(`Waiting ${delay / 1000}s before next post...`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  await scraper.close();
  console.log('Automation complete.');
}

main().catch(console.error);
