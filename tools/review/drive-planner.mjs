import { chromium } from 'playwright';
const OUT='docs/review-shots/planner'; let n=0;
const browser = await chromium.launch(); const page = await browser.newPage({ viewport:{width:1440,height:900}, colorScheme:'dark' });
const errs=[]; page.on('pageerror',(e)=>errs.push(e.message)); page.on('dialog',(d)=>d.accept());
const snap=async(name)=>{ n++; await page.screenshot({path:`${OUT}/${String(n).padStart(2,'0')}-${name}.png`}); };
await page.goto('http://127.0.0.1:8765/planner.html'); await page.waitForFunction(()=>!!window.planner && window.planner.version==='planner/2', undefined, {timeout:60000});
await page.waitForTimeout(800); await snap('boot');
await page.evaluate(()=>window.planner.openFromLibrary('lead_to_customer')); await page.waitForTimeout(800); await snap('lead-split');
console.log('lines:', await page.evaluate(()=>{ const l=P2.view.lines(P2.state.doc); return Array.isArray(l)? l.length : Object.keys(l).join(','); }));
await page.click('[role=tab][data-tab="canvas"]'); await page.waitForTimeout(600); await snap('lead-canvas');
const lane = await page.locator('#cy').boundingBox(); 
// click first lane via cytoscape
await page.evaluate(()=>{ const n=window.cy.nodes('[kind="session"]').first(); n.emit('tap'); }); await page.waitForTimeout(500); await snap('lane-card');
console.log('card open:', await page.evaluate(()=>P2.state.cardOpen), '| sel:', await page.evaluate(()=>JSON.stringify(P2.state.sel)));
await page.keyboard.press('Escape'); await page.waitForTimeout(200);
await page.click('#b_join'); await page.waitForTimeout(400); await snap('join-sheet'); await page.keyboard.press('Escape');
await page.click('#b_new'); await page.waitForTimeout(200); await snap('new-menu');
const paste = page.locator('[data-new="paste"]'); if (await paste.count()) { await paste.click(); await page.waitForTimeout(300); await snap('paste-sheet'); await page.keyboard.press('Escape'); }
await page.click('[role=tab][data-tab="split"]'); await page.waitForTimeout(300);
await page.locator('.line.step').first().click(); await page.waitForTimeout(400); await snap('step-card');
console.log('strip:', (await page.locator('#strip').innerText()).replace(/\n/g,' '));
console.log('errors:', errs.length?errs.join(' || '):'none'); await browser.close();
