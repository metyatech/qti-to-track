import { chromium } from 'playwright';
import * as fs from 'fs';

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const captures: any[] = [];
  
  page.on('response', async response => {
    try {
      const url = response.url();
      if (url.includes('upload')) {
        const request = response.request();
        let postData;
        try {
          if (request.postData()) {
            postData = request.postData()?.substring(0, 2000);
          }
        } catch (e) {}
        
        let responseBody;
        try {
          const buffer = await response.body();
          responseBody = buffer.toString('utf8').substring(0, 2000);
        } catch (e) {}

        captures.push({
          url,
          method: request.method(),
          requestHeaders: request.headers(),
          requestBody: postData,
          status: response.status(),
          responseHeaders: response.headers(),
          responseBody
        });
        
        fs.writeFileSync('uploads.json', JSON.stringify(captures, null, 2));
      }
    } catch (e) {
      console.error('Error capturing response', e);
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
