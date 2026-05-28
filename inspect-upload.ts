import { chromium } from 'playwright';
import * as fs from 'fs';

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const requests: any[] = [];
  
  page.on('request', async request => {
    try {
      const url = request.url();
      const method = request.method();
      if (method !== 'GET' && method !== 'OPTIONS' && !url.includes('events') && !url.includes('analytics')) {
        let postData;
        try {
          postData = request.postData()?.substring(0, 1000);
        } catch (e) {
          // ignore
        }
        
        requests.push({
          url,
          method,
          headers: request.headers(),
          postData
        });
        
        // Write incrementally to not lose data
        fs.writeFileSync('requests.json', JSON.stringify(requests, null, 2));
      }
    } catch (e) {
      console.error('Error capturing request', e);
    }
  });

  await page.goto('https://tracks.dev');
  console.log('Please log in and perform an image upload in the browser window.');
  console.log('You can close the browser window when finished.');

  page.on('close', () => {
    console.log('Browser closed. Exiting.');
    process.exit(0);
  });
})();
