const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const cheerio = require('cheerio');
const ExcelJS = require('exceljs');
const { parseDirectorsFromHtml } = require('../src/zaubacorp');
const { writeResultsToExcel } = require('../src/excel');

test('extracts current directors and registry details only from #director-information', async () => {
  const $ = cheerio.load(await fs.readFile(path.join(__dirname, 'fixtures/zauba-directors.html'), 'utf8'));
  $('#director-panel').html($('#director-rows').html());
  const directors = parseDirectorsFromHtml($.html(), 'Acme Foods Private Limited');
  assert.deepEqual(directors.map((person) => [person.name, person.designation, person.din, person.appointmentDate]), [
    ['ASHA RAO', 'Managing Director', '00001234', '20/09/2006'],
    ['BIMAL SHAH', 'Director', '00005678', '17/03/2015'],
  ]);
});

test('an empty Directors section cannot be replaced by stale summary names or unrelated tables', () => {
  const html = '<p>Directors of Acme Foods are Stale Person.</p><table><tr><th>Name</th></tr><tr><td>Unrelated Person</td></tr></table>' +
    '<section id="director-information"><h2>Directors</h2><p>No directors available</p></section>';
  assert.deepEqual(parseDirectorsFromHtml(html, 'Acme Foods'), []);
});

test('supports an anchored Directors heading and reads every current director', () => {
  const names = ['Asha Rao', 'Bimal Shah', 'Vikram Desai', 'Priya Nair', 'Sunil Mehta', 'Rajesh Sharma', 'Anil Kumar', 'Vinod Nahar', 'Jitendra Shah', 'Dilip Shah', 'Ramesh Patel'];
  const html = '<h2 id="director-information">Directors</h2><div><table><tr><th>DIN</th><th>Director Name</th><th>Role</th></tr>' +
    names.map((name, i) => `<tr><td>${String(i + 1).padStart(8, '0')}</td><td>${name}</td><td>Director</td></tr>`).join('') +
    '</table></div><h2>Other contacts</h2><table><tr><th>Name</th></tr><tr><td>Unrelated Person</td></tr></table>';
  assert.deepEqual(parseDirectorsFromHtml(html, 'Acme Foods').map((person) => person.name), names);
});

test('retains legacy director tables when #director-information is absent', () => {
  const html = '<h2>Current Directors</h2><table><tr><th>DIN</th><th>Name</th><th>Designation</th></tr>' +
    '<tr><td>00001234</td><td>ASHA RAO</td><td>Director</td></tr></table>';
  assert.equal(parseDirectorsFromHtml(html, 'Acme Foods')[0].din, '00001234');
});

test('Excel retains DIN leading zeros, appointment dates and the Directors section source URL', async (t) => {
  const output = path.join(__dirname, `zauba-details-test-${process.pid}.xlsx`);
  t.after(() => fs.unlink(output).catch(() => {}));
  const sourceUrl = 'https://www.zaubacorp.com/ACME-FOODS-PRIVATE-LIMITED-U12345AA2000PTC123456#director-information';
  await writeResultsToExcel([{ companyName: 'Acme Foods', personName: 'Asha Rao', source: 'ZaubaCorp', din: '00001234', appointmentDate: '20/09/2006', sourceUrl }], output);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(output);
  const sheet = workbook.getWorksheet('Directors Report');
  assert.equal(sheet.getCell('G2').value, '00001234');
  assert.equal(sheet.getCell('H2').value, '20/09/2006');
  assert.equal(sheet.getCell('I2').value, sourceUrl);
});
