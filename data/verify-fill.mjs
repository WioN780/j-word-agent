import { BrowserSession } from '../session-manager.mjs';
import { writeFileSync } from 'fs';

const URL = 'https://job-boards.greenhouse.io/monzo/jobs/6635595';
const CV_PATH = new URL('../output/cv-alex-chen-python-backend-test-2026-06-26.pdf', import.meta.url).pathname.slice(1);

const session = new BrowserSession();
try {
  await session.launch();
  await session.navigate(URL);
  console.log('Navigated to:', session.page.url());

  await session.fillGreenhouse({
    name: 'Test User',
    email: 'test@example.com',
    phone: '+1-555-0000',
    linkedIn: '', github: '', website: '',
    cvPath: CV_PATH,
    coverLetterPath: null,
  });

  const resumeCheck = await session.page.evaluate(() => {
    const el = document.querySelector('#resume');
    return {
      found: !!el,
      filesLength: el?.files?.length ?? -1,
      firstFileName: el?.files?.[0]?.name ?? null,
      display: el ? window.getComputedStyle(el).display : null,
      visibility: el ? window.getComputedStyle(el).visibility : null,
    };
  });
  console.log('\n#resume check:', JSON.stringify(resumeCheck, null, 2));

  const buf = await session.page.screenshot({ type: 'png', fullPage: true });
  writeFileSync('data/fill-verify-fullpage.png', buf);
  console.log('Full-page screenshot → data/fill-verify-fullpage.png (' + buf.length + ' bytes)');
  console.log('URL after fill:', session.page.url());
} finally {
  await session.close();
}
