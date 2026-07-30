const http = require('http');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const dotenv = require('dotenv');
const db = require('../db'); // Import DB module directly to seed admin user

// Load environment variables if available
if (fs.existsSync('.env')) {
  dotenv.config();
}

const jwtSecret = process.env.JWT_SECRET || 'fallback-jwt-secret-key-123';
const adminEmail = process.env.ADMIN_EMAIL || 'rahulkumar828515@gmail.com';

// Seed the Admin user in database.json
console.log('Seeding admin user in local database...');
db.saveUser(adminEmail, {
  name: 'Admin User',
  plan: 'agency', // Admins default to agency/unlimited plan
  emailsSent: 0
});
console.log('Admin user seeded successfully.');

async function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function runTests() {
  console.log('Starting verification tests for SaaS Platform...');
  
  // 1. Guest Login
  console.log('\nTesting Guest Login (POST /api/guest-login)...');
  const loginRes = await request('http://localhost:3000/api/guest-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  
  console.log('Login Status Code:', loginRes.statusCode);
  const setCookie = loginRes.headers['set-cookie'];
  console.log('Cookie received:', setCookie ? 'Yes' : 'No');
  
  if (!setCookie) {
    console.error('Failed to get auth cookie');
    process.exit(1);
  }
  
  const guestCookie = setCookie[0].split(';')[0];
  
  // 2. Fetch Guest User Profile
  console.log('\nTesting Get Guest Profile (GET /api/user-profile)...');
  const profileRes = await request('http://localhost:3000/api/user-profile', {
    headers: { 'Cookie': guestCookie }
  });
  console.log('Profile Status Code:', profileRes.statusCode);
  const profile = JSON.parse(profileRes.body);
  console.log('Profile details:', JSON.stringify(profile, null, 2));
  
  if (profile.email !== 'guest@reachoutai.local' || profile.isAdmin !== false) {
    console.error('Test Failed: Expected email to be guest@reachoutai.local and isAdmin false');
    process.exit(1);
  }
  
  // 3. Test access to Admin config endpoint from Guest (Expected 403)
  console.log('\nTesting Guest Config access (GET /api/config)...');
  const configRes = await request('http://localhost:3000/api/config', {
    headers: { 'Cookie': guestCookie }
  });
  console.log('Config Status Code (Expected 403):', configRes.statusCode);
  if (configRes.statusCode !== 403) {
    console.error('Test Failed: Expected guest user to get 403 Forbidden for admin config');
    process.exit(1);
  }
  
  // 4. Admin JWT Token Generation
  console.log('\nGenerating mock Admin JWT Token for:', adminEmail);
  const adminToken = jwt.sign(
    { email: adminEmail, name: 'Admin User' },
    jwtSecret,
    { expiresIn: '1h' }
  );
  const adminCookie = `auth_token=${adminToken}`;
  
  // 5. Fetch Admin Profile
  console.log('\nTesting Get Admin Profile (GET /api/user-profile)...');
  const adminProfileRes = await request('http://localhost:3000/api/user-profile', {
    headers: { 'Cookie': adminCookie }
  });
  console.log('Admin Profile Status Code:', adminProfileRes.statusCode);
  if (adminProfileRes.statusCode !== 200) {
    console.error('Test Failed: Expected 200 OK for admin profile. Body:', adminProfileRes.body);
    process.exit(1);
  }
  
  const adminProfile = JSON.parse(adminProfileRes.body);
  console.log('Admin Profile details:', JSON.stringify(adminProfile, null, 2));
  if (adminProfile.isAdmin !== true) {
    console.error('Test Failed: Expected isAdmin to be true for admin email');
    process.exit(1);
  }
  
  // 6. Test access to Admin config endpoint from Admin (Expected 200)
  console.log('\nTesting Admin Config access (GET /api/config)...');
  const adminConfigRes = await request('http://localhost:3000/api/config', {
    headers: { 'Cookie': adminCookie }
  });
  console.log('Admin Config Status Code (Expected 200):', adminConfigRes.statusCode);
  if (adminConfigRes.statusCode !== 200) {
    console.error('Test Failed: Expected admin to access config with 200 OK');
    process.exit(1);
  }
  
  // 7. Test access to Admin users endpoint from Admin (Expected 200)
  console.log('\nTesting Admin User List access (GET /api/admin/users)...');
  const adminUsersRes = await request('http://localhost:3000/api/admin/users', {
    headers: { 'Cookie': adminCookie }
  });
  console.log('Admin Users Status Code (Expected 200):', adminUsersRes.statusCode);
  if (adminUsersRes.statusCode !== 200) {
    console.error('Test Failed: Expected admin to access users list with 200 OK');
    process.exit(1);
  }
  
  const users = JSON.parse(adminUsersRes.body);
  console.log('Total registered users:', users.length);
  
  // 8. Test Plan Modification and Credit Reset
  console.log('\nTesting Admin Update User Plan (POST /api/admin/update-user-plan)...');
  const updatePlanRes = await request('http://localhost:3000/api/admin/update-user-plan', {
    method: 'POST',
    headers: {
      'Cookie': adminCookie,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email: 'guest@reachoutai.local', plan: 'pro' })
  });
  console.log('Update Plan Status Code (Expected 200):', updatePlanRes.statusCode);
  if (updatePlanRes.statusCode !== 200) {
    console.error('Test Failed: Failed to update user plan');
    process.exit(1);
  }
  
  // Re-fetch guest profile to verify plan standard is active
  const updatedGuestRes = await request('http://localhost:3000/api/user-profile', {
    headers: { 'Cookie': guestCookie }
  });
  const updatedGuest = JSON.parse(updatedGuestRes.body);
  console.log('Updated Guest Profile (Expected plan: pro, limit: 500):', JSON.stringify(updatedGuest, null, 2));
  if (updatedGuest.plan !== 'pro' || updatedGuest.emailsLimit !== 500) {
    console.error('Test Failed: Plan updates not persisted correctly');
    process.exit(1);
  }
  
  console.log('\nAll SaaS role verification checks passed successfully!');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test Run failed with error:', err);
  process.exit(1);
});
