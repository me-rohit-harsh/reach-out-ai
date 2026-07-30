const express = require('express');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const LinkedInScraper = require('./scraper');
const AIGenerator = require('./ai');
const Mailer = require('./mailer');
const db = require('./db');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());
app.use(express.static('dist')); // Serve Astro build output
app.use(express.static('public')); // Fallback for raw assets if needed
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const isAdmin = (email) => {
  if (!email) return false;
  if (email.toLowerCase() === 'guest@reachoutai.local') return true; // Grant admin to guest for local testing
  const adminEmail = process.env.ADMIN_EMAIL || 'rahulkumar828515@gmail.com';
  return email.toLowerCase() === adminEmail.toLowerCase();
};

const authenticateJWT = (req, res, next) => {
  const token = req.cookies.auth_token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'fallback-jwt-secret-key-123');
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

// Merge MongoDB config with process.env fallbacks
async function getConfig() {
  const mongoConf = await db.getConfig();
  return {
    GROQ_API_KEY: mongoConf.GROQ_API_KEY || process.env.GROQ_API_KEY || '',
    SMTP_HOST: mongoConf.SMTP_HOST || process.env.SMTP_HOST || '',
    SMTP_PORT: mongoConf.SMTP_PORT || process.env.SMTP_PORT || '465',
    SMTP_USER: mongoConf.SMTP_USER || process.env.SMTP_USER || '',
    SMTP_PASS: mongoConf.SMTP_PASS || process.env.SMTP_PASS || '',
    LINKEDIN_EMAIL: mongoConf.LINKEDIN_EMAIL || process.env.LINKEDIN_EMAIL || '',
    LINKEDIN_PASSWORD: mongoConf.LINKEDIN_PASSWORD || process.env.LINKEDIN_PASSWORD || '',
    CV_PATH: mongoConf.CV_PATH || process.env.CV_PATH || './my_cv.pdf',
    TEST_MODE: mongoConf.TEST_MODE || process.env.TEST_MODE || 'false',
    MAX_PAGES: mongoConf.MAX_PAGES || process.env.MAX_PAGES || '5',
    urls: mongoConf.urls || ''
  };
}

app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'app.html')));

app.get('/admin', (req, res) => {
  const token = req.cookies.auth_token;
  if (!token) return res.redirect('/app?redirect=admin');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-jwt-secret-key-123');
    if (!isAdmin(decoded.email)) {
      return res.status(403).send('Forbidden: Admin access required');
    }
    res.sendFile(path.join(__dirname, 'dist', 'admin.html'));
  } catch (_) {
    res.redirect('/app?redirect=admin');
  }
});

// ── GOOGLE OAUTH ──
app.get('/auth/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).send('GOOGLE_CLIENT_ID not configured');
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
  const scope = encodeURIComponent('openid email profile https://www.googleapis.com/auth/gmail.send');
  res.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code` +
    `&scope=${scope}&access_type=offline&prompt=consent`
  );
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;

  if (!code) return res.redirect('/app?error=no_code');

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' })
    });
    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);

    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const userInfo = await userInfoRes.json();
    if (!userInfo.email) throw new Error('Email not returned by Google');

    const updates = {
      googleId: userInfo.sub,
      name: userInfo.name,
      picture: userInfo.picture,
      accessToken: tokens.access_token,
      tokenExpiry: Date.now() + (tokens.expires_in * 1000)
    };
    if (tokens.refresh_token) updates.refreshToken = tokens.refresh_token;

    const savedUser = await db.saveUser(userInfo.email, updates);
    const jwtToken = jwt.sign(
      { email: savedUser.email, name: savedUser.name },
      process.env.JWT_SECRET || 'fallback-jwt-secret-key-123',
      { expiresIn: '7d' }
    );

    res.cookie('auth_token', jwtToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.redirect('/app');
  } catch (err) {
    console.error('Google OAuth error:', err.message);
    res.redirect(`/app?error=${encodeURIComponent(err.message)}`);
  }
});

app.post('/api/guest-login', async (req, res) => {
  try {
    const guestEmail = 'guest@reachoutai.local';
    let guestUser = await db.getUser(guestEmail);
    if (!guestUser) {
      guestUser = await db.saveUser(guestEmail, {
        name: 'Guest User',
        picture: '',
        googleId: 'guest-id',
        plan: 'free',
        cvText: '',
        cvPath: '',
        promptTemplate: ''
      });
    }

    const jwtToken = jwt.sign(
      { email: guestUser.email, name: guestUser.name, isGuest: true },
      process.env.JWT_SECRET || 'fallback-jwt-secret-key-123',
      { expiresIn: '1d' }
    );

    res.cookie('auth_token', jwtToken, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.sendStatus(200);
});

// ── PROTECTED ENDPOINTS ──

app.get('/api/user-profile', authenticateJWT, async (req, res) => {
  try {
    const user = await db.getUser(req.user.email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const config = await getConfig();
    const testMode = config.TEST_MODE === 'true';

    res.json({
      email: user.email,
      name: user.name,
      picture: user.picture,
      plan: user.plan,
      emailsSent: user.emailsSent,
      emailsLimit: user.emailsLimit,
      isAdmin: isAdmin(user.email),
      systemTestMode: testMode,
      cvPath: user.cvPath
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config', authenticateJWT, async (req, res) => {
  if (!isAdmin(req.user.email)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const config = await getConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config', authenticateJWT, async (req, res) => {
  if (!isAdmin(req.user.email)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { urls, ...rest } = req.body;
    await db.saveConfig({ ...rest, urls: urls || '' });
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload-cv', authenticateJWT, async (req, res) => {
  try {
    const { fileName, fileData } = req.body;
    if (!fileName || !fileData) return res.status(400).send('Missing file info');

    const buffer = Buffer.from(fileData, 'base64');
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

    const sanitized = req.user.email.replace(/[^a-zA-Z0-9]/g, '_');
    const relativePath = `./uploads/cv_${sanitized}.pdf`;
    fs.writeFileSync(path.join(__dirname, relativePath), buffer);

    await db.saveUser(req.user.email, { cvPath: relativePath });
    res.json({ path: relativePath });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ── IMPORTS MODULE ──

app.post('/api/imports/upload', authenticateJWT, async (req, res) => {
  try {
    const { fileName, fileData } = req.body;
    if (!fileName || !fileData) return res.status(400).send('Missing file info');

    const buffer = Buffer.from(fileData, 'base64');
    const importsDir = path.join(__dirname, 'uploads', 'imports');
    if (!fs.existsSync(importsDir)) fs.mkdirSync(importsDir, { recursive: true });

    const sanitizedEmail = req.user.email.replace(/[^a-zA-Z0-9]/g, '_');
    const timestamp = Date.now();
    const sanitizedFilename = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const finalFilename = `${sanitizedEmail}___${timestamp}___${sanitizedFilename}`;
    const filePath = path.join(importsDir, finalFilename);

    fs.writeFileSync(filePath, buffer);

    const content = buffer.toString('utf8');
    const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    res.json({ filename: finalFilename, itemsCount: lines.length });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/api/imports', authenticateJWT, async (req, res) => {
  try {
    const importsDir = path.join(__dirname, 'uploads', 'imports');
    if (!fs.existsSync(importsDir)) {
      return res.json([]);
    }

    const files = fs.readdirSync(importsDir);
    const sanitizedEmail = req.user.email.replace(/[^a-zA-Z0-9]/g, '_');
    
    const userFiles = files.filter(f => f.startsWith(sanitizedEmail));
    const results = userFiles.map(file => {
      const filePath = path.join(importsDir, file);
      const stats = fs.statSync(filePath);
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const lines = fileContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      
      return {
        key: file,
        name: file.split('___')[2] || file,
        uploadedAt: stats.mtime,
        size: stats.size,
        itemsCount: lines.length
      };
    });

    results.sort((a, b) => b.uploadedAt - a.uploadedAt);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/imports/:filename', authenticateJWT, async (req, res) => {
  try {
    const { filename } = req.params;
    const sanitizedEmail = req.user.email.replace(/[^a-zA-Z0-9]/g, '_');
    
    if (!filename.startsWith(sanitizedEmail)) {
      return res.status(403).send('Forbidden: Access denied');
    }

    const filePath = path.join(__dirname, 'uploads', 'imports', filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    res.json({ content, lines });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.delete('/api/imports/:filename', authenticateJWT, async (req, res) => {
  try {
    const { filename } = req.params;
    const sanitizedEmail = req.user.email.replace(/[^a-zA-Z0-9]/g, '_');
    
    if (!filename.startsWith(sanitizedEmail)) {
      return res.status(403).send('Forbidden: Access denied');
    }

    const filePath = path.join(__dirname, 'uploads', 'imports', filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.sendStatus(200);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/api/cv-text', authenticateJWT, async (req, res) => {
  try {
    const user = await db.getUser(req.user.email);
    let text = user ? (user.cvText || '') : '';
    if (!text && fs.existsSync('cv_text.txt')) text = fs.readFileSync('cv_text.txt', 'utf8');
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cv-text', authenticateJWT, async (req, res) => {
  try {
    await db.saveUser(req.user.email, { cvText: req.body.text || '' });
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/prompt-template', authenticateJWT, async (req, res) => {
  try {
    const user = await db.getUser(req.user.email);
    let template = user ? (user.promptTemplate || '') : '';
    if (!template && fs.existsSync('prompt_template.txt')) template = fs.readFileSync('prompt_template.txt', 'utf8');
    res.json({ template });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/prompt-template', authenticateJWT, async (req, res) => {
  try {
    await db.saveUser(req.user.email, { promptTemplate: req.body.template || '' });
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HISTORY ──

app.get('/api/history', authenticateJWT, async (req, res) => {
  try {
    const history = await db.getOutreachHistory(req.user.email, 300);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/history', authenticateJWT, async (req, res) => {
  try {
    await db.clearOutreachHistory(req.user.email);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN ──

app.get('/api/admin/stats', authenticateJWT, async (req, res) => {
  if (!isAdmin(req.user.email)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const users = await db.getUsers();
    const candidates = users.filter(u => !isAdmin(u.email));
    
    // Aggregations
    const totalUsers = candidates.length;
    let totalEmailsSent = 0;
    let totalEmailsSentToday = 0;
    let activeUsersCount = 0;
    
    for (const u of candidates) {
      totalEmailsSent += (u.emailsSentTotal || 0);
      totalEmailsSentToday += (u.emailsSent || 0);
      if ((u.emailsSentTotal || 0) > 0 || u.refreshToken || u.cvPath) {
        activeUsersCount++;
      }
    }

    const recentOutreach = await db.getGlobalOutreach(100);
    const upgradeRequests = await db.getUpgradeRequests();

    res.json({
      totalUsers,
      activeUsersCount,
      totalEmailsSent,
      totalEmailsSentToday,
      recentOutreach,
      upgradeRequests
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', authenticateJWT, async (req, res) => {
  if (!isAdmin(req.user.email)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const users = await db.getUsers();
    const candidates = users.filter(u => !isAdmin(u.email));
    res.json(candidates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/update-user-plan', authenticateJWT, async (req, res) => {
  if (!isAdmin(req.user.email)) return res.status(403).json({ error: 'Forbidden' });
  const { email, plan } = req.body;
  if (!email || !plan) return res.status(400).send('Missing email or plan');
  try {
    const updated = await db.saveUser(email, { plan });
    updated ? res.json(updated) : res.status(404).send('User not found');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reset-user-usage', authenticateJWT, async (req, res) => {
  if (!isAdmin(req.user.email)) return res.status(403).json({ error: 'Forbidden' });
  const { email } = req.body;
  if (!email) return res.status(400).send('Missing email');
  try {
    const updated = await db.resetUsage(email);
    updated ? res.json(updated) : res.status(404).send('User not found');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── UPGRADE REQUESTS ──

app.post('/api/upgrade-request', authenticateJWT, async (req, res) => {
  try {
    const { reason } = req.body;
    await db.createUpgradeRequest(req.user.email, { reason: reason || 'Requested more emails limit' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MAIN AUTOMATION (SSE) ──
app.get('/api/start', authenticateJWT, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendLog = (msg) => res.write(`data: ${msg}\n\n`);
  const sendStats = (stats) => res.write(`data: STATS:${JSON.stringify(stats)}\n\n`);
  const done = () => { res.write('data: [DONE]\n\n'); res.end(); };

  let scraper = null;

  try {
    const user = await db.getUser(req.user.email);
    if (!user) {
      sendLog('Error: User not found in database.');
      return done();
    }

    // Daily limit check
    if (user.emailsSent >= user.emailsLimit) {
      sendLog(`Daily limit of ${user.emailsLimit} emails reached. Resets at midnight UTC.`);
      return done();
    }

    const config = await getConfig();
    const testMode = config.TEST_MODE === 'true';
    const maxPages = parseInt(config.MAX_PAGES || '5', 10);

    // Build mailer
    let mailer;
    const isGuest = req.user.isGuest === true;
    if (!isGuest && user.refreshToken) {
      mailer = new Mailer({
        type: 'OAuth2',
        user: user.email,
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: user.refreshToken,
        accessToken: user.accessToken
      });
    } else {
      if (isGuest) sendLog('[GUEST MODE] Using shared administrator email configuration.');
      else sendLog('Warning: No OAuth token. Falling back to SMTP.');
      mailer = new Mailer({
        host: config.SMTP_HOST,
        port: parseInt(config.SMTP_PORT || '465'),
        user: config.SMTP_USER,
        pass: config.SMTP_PASS
      });
    }

    // CV path
    let cvPath = user.cvPath;
    if (!cvPath || !fs.existsSync(path.join(__dirname, cvPath))) {
      cvPath = config.CV_PATH || './my_cv.pdf';
    }
    if (!fs.existsSync(path.join(__dirname, cvPath))) {
      sendLog(`Error: CV PDF not found at: ${cvPath}`);
      return done();
    }

    // CV text for AI
    let cvContent = user.cvText || '';
    if (!cvContent) {
      if (fs.existsSync('cv_text.txt')) cvContent = fs.readFileSync('cv_text.txt', 'utf8');
      else {
        try { cvContent = fs.readFileSync(path.join(__dirname, cvPath), 'utf8'); } catch (_) {}
        if (!cvContent) sendLog('Warning: No CV text found. Email quality may be reduced.');
      }
    }

    // URLs
    const urls = (config.urls || '').split('\n').map(u => u.trim()).filter(u => u && !u.startsWith('#'));
    if (urls.length === 0) {
      sendLog('Error: No target URLs configured. Admin must add LinkedIn search URLs.');
      return done();
    }

    const ai = new AIGenerator(config.GROQ_API_KEY || process.env.GROQ_API_KEY);
    const processedEmails = new Set();
    let limitReached = false;

    const stats = { sentCount: user.emailsSent, recipients: [] };
    const updateStats = async (email, author, subject, isTest) => {
      stats.sentCount++;
      stats.recipients.push({ email, author, time: new Date().toLocaleTimeString() });
      sendStats(stats);
      await db.recordOutreach(req.user.email, { recipientEmail: email, recruiterName: author, subject, testMode: isTest });
    };

    sendLog('Launching browser...');
    scraper = new LinkedInScraper();
    await scraper.init();

    if (config.LINKEDIN_EMAIL && config.LINKEDIN_PASSWORD) {
      sendLog('Logging into LinkedIn...');
      await scraper.login(config.LINKEDIN_EMAIL, config.LINKEDIN_PASSWORD);
    } else {
      sendLog('No LinkedIn credentials. Using existing session (auth_state.json).');
    }

    if (testMode) sendLog('[TEST MODE] Dry-run active — emails located but NOT sent.');

    urlLoop:
    for (const url of urls) {
      const freshUser = await db.getUser(req.user.email);
      if (freshUser.emailsSent >= freshUser.emailsLimit) {
        sendLog(`[DAILY LIMIT] ${freshUser.emailsLimit}/day reached. Stopping.`);
        break;
      }

      sendLog(`Scraping: ${url}`);
      const postsFound = await scraper.scrapePostsFromUrl(url, sendLog, maxPages);

      if (postsFound.length === 0) {
        sendLog('No posts with recruiter emails found at this URL.');
        continue;
      }

      sendLog(`Found ${postsFound.length} post(s) with emails.`);

      for (const postData of postsFound) {
        for (const email of postData.emails) {
          const emailLower = email.toLowerCase();

          if (processedEmails.has(emailLower)) {
            sendLog(`[SKIP] Already processed ${email} this session.`);
            continue;
          }

          const alreadySent = await db.isEmailSentBefore(req.user.email, email);
          if (alreadySent) {
            sendLog(`[SKIP] Already sent to ${email} in a previous run.`);
            processedEmails.add(emailLower);
            continue;
          }

          processedEmails.add(emailLower);

          const checkUser = await db.getUser(req.user.email);
          if (checkUser.emailsSent >= checkUser.emailsLimit) {
            sendLog(`[DAILY LIMIT] ${checkUser.emailsLimit}/day reached. Stopping.`);
            limitReached = true;
            break urlLoop;
          }

          if (testMode) {
            sendLog(`[TEST] Would send to: ${email} (${postData.author || 'Unknown'})`);
            await updateStats(email, postData.author || '', '[TEST DRY RUN]', true);
            continue;
          }

          sendLog(`Generating email for ${email}...`);
          const emailContent = await ai.generateEmail(
            postData.content, cvContent, postData.author, postData.authorTitle, user.promptTemplate
          );

          if (!emailContent) {
            sendLog(`Error: AI generation failed for ${email}. Skipping.`);
            continue;
          }

          sendLog(`Sending to ${email}...`);
          const sendResult = await mailer.sendApplication(
            email, emailContent.subject, emailContent.body, path.join(__dirname, cvPath)
          );

          if (sendResult) {
            await db.incrementEmailsSent(req.user.email);
            await updateStats(email, postData.author || '', emailContent.subject, false);
            sendLog(`Sent to ${email}.`);

            const gap = Math.floor(Math.random() * 30000) + 30000;
            sendLog(`Rate-limit pause: ${Math.round(gap / 1000)}s...`);
            await new Promise(r => setTimeout(r, gap));
          } else {
            sendLog(`Error: Failed to send to ${email}.`);
          }
        }
      }

      if (!testMode && !limitReached && urls.indexOf(url) < urls.length - 1) {
        const delay = Math.floor(Math.random() * 30000) + 30000;
        sendLog(`Batch pause: ${Math.round(delay / 1000)}s before next URL...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    sendLog('Automation complete.');
  } catch (err) {
    sendLog(`Fatal error: ${err.message}`);
  } finally {
    if (scraper) {
      try { await scraper.close(); } catch (_) {}
    }
    done();
  }
});

app.listen(PORT, () => {
  console.log(`ReachOut AI server → http://localhost:${PORT}`);
});
