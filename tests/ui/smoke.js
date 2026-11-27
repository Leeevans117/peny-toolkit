// Panel UI smoke test in headless Chromium (no Premiere): opens the real index.html/main.js
// with Node calls served by server.js and Premiere answers stubbed, then opens every app,
// presses every button in it, goes back, and fails on any page error.
// Needs Playwright (pre-installed in Claude's cloud container; not needed on the Macs).
//   node tests/ui/smoke.js
const path = require("path"), cp = require("child_process");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { console.log("SKIP ui smoke: Playwright not installed"); process.exit(0); }
const ROOT = path.join(__dirname, "..", ".."), PORT = 8700 + Math.floor(Math.random() * 200);
const srv = cp.spawn(process.execPath, [path.join(__dirname, "server.js"), ROOT], { env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: ["ignore", "pipe", "inherit"] });
srv.stdout.once("data", async () => {
  const errs = [], b = await chromium.launch(), p = await b.newPage({ viewport: { width: 420, height: 760 } });
  p.on("pageerror", e => errs.push("pageerror: " + e.message));
  p.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
  p.on("dialog", d => d.dismiss());
  let fail = 0;
  try {
    await p.goto(`http://localhost:${PORT}/index.html`); await p.waitForTimeout(1500);
    const ids = await p.$$eval("#tiles .tile", ts => ts.map(t => t.getAttribute("data-skill")));
    console.log("tiles:", ids.length, ids.join(", "));
    if (ids.length < 8) { console.log("FAIL fewer than 8 tiles"); fail++; }
    for (const id of ids) {
      const before = errs.length;
      await p.click(`#tiles .tile[data-skill="${id}"]`); await p.waitForTimeout(700);
      const shown = await p.$eval(`.app[data-skill="${id}"]`, v => !v.classList.contains("hidden")).catch(() => false);
      const buttons = await p.$$(`.app[data-skill="${id}"] button:not([disabled])`);
      let pressed = 0;
      for (const btn of buttons) { if (await btn.isVisible()) { await btn.click({ timeout: 1000 }).catch(() => {}); pressed++; await p.waitForTimeout(150); } }
      // A button may have opened a sheet (folder prompt, how-to): Escape closes the top one first.
      let home = false, escapes = 0;
      for (; escapes < 4 && !home; escapes++) {
        await p.keyboard.press("Escape"); await p.waitForTimeout(700);
        home = await p.$eval("#tiles .tile", t => { const r = t.getBoundingClientRect(); return r.width > 0 && getComputedStyle(t).visibility !== "hidden"; }).catch(() => false)
          && await p.$eval(`.app[data-skill="${id}"]`, v => v.classList.contains("hidden")).catch(() => true);
      }
      if (!home) console.log("   still in " + id + " after 4 x Escape; visible: " + await p.evaluate(() => Array.from(document.querySelectorAll(".sheet:not(.hidden), .app:not(.hidden), [role=dialog]")).map(e => e.className).join(" ; ")));
      const ok = shown && home && errs.length === before;
      if (!ok) fail++;
      console.log((ok ? "PASS " : "FAIL ") + id + ": opened " + shown + ", pressed " + pressed + " buttons, back home " + home + (errs.length > before ? ", errors: " + errs.slice(before).join(" | ") : ""));
    }
    const before = errs.length;
    for (const k of ["s", "s", "s", "s", "m", "m"]) { await p.keyboard.press(k); await p.waitForTimeout(200); }
    if (errs.length > before) { console.log("FAIL style/motion keys: " + errs.slice(before).join(" | ")); fail++; }
  } catch (e) { console.log("FAIL " + e.message); fail++; }
  await b.close(); srv.kill();
  console.log(fail ? `UI SMOKE FAIL (${fail})` : "UI SMOKE PASS");
  process.exit(fail ? 1 : 0);
});
