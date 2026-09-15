const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { readCompaniesFromExcel } = require('../src/excel');

async function readRows(t, rows) {
  const directory = await fs.mkdtemp(path.join(__dirname, 'excel-directors-'));
  const filePath = path.join(directory, 'companies.xlsx');
  t.after(async () => {
    await fs.unlink(filePath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(directory);
  });
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Companies').addRows(rows);
  await workbook.xlsx.writeFile(filePath);
  return readCompaniesFromExcel(filePath);
}

test('company-only sheets retain their existing string entries and case-insensitive dedupe', async (t) => {
  assert.deepEqual(await readRows(t, [
    ['Company Name', 'Website'],
    [' Acme  Foods ', 'https://acme.example'],
    ['ACME FOODS', 'https://acme.example'],
    ['Example Industries', 'https://example.example'],
  ]), ['Acme Foods', 'Example Industries']);
  assert.deepEqual(await readRows(t, [['Acme Foods'], ['ACME FOODS'], ['Example Industries']]),
    ['Acme Foods', 'Example Industries']);
});

test('merges uploaded directors by company and person name, preserving display names and roles', async (t) => {
  assert.deepEqual(await readRows(t, [
    ['Company', 'Director Name', 'Designation'],
    ['Acme Foods', '', ''],
    ['ACME FOODS', ' Asha  Rao ', ''],
    ['acme foods', 'ASHA RAO', 'Managing Director'],
    ['Acme Foods', 'Bimal Shah', 'Director'],
    ['Other Company', '', ''],
    ['Third Company', 'Priya Nair', 'Founder'],
  ]), [
    { companyName: 'Acme Foods', directors: [
      { name: 'Asha Rao', designation: 'Managing Director' },
      { name: 'Bimal Shah', designation: 'Director' },
    ] },
    'Other Company',
    { companyName: 'Third Company', directors: [{ name: 'Priya Nair', designation: 'Founder' }] },
  ]);
});

test('accepts exact person and role headers, including exported reports, without splitting names', async (t) => {
  for (const header of ['Director Name', 'DIRECTOR', 'Person Name', 'Name']) {
    assert.deepEqual(await readRows(t, [
      ['Company Name', header, 'Role'],
      ['Acme Foods', 'Rao, Asha', 'Director'],
      ['Other Company', 'NULL', 'NULL'],
    ]), [
      { companyName: 'Acme Foods', directors: [{ name: 'Rao, Asha', designation: 'Director' }] },
      'Other Company',
    ]);
  }
  assert.deepEqual(await readRows(t, [['Company', 'Director', 'Title'], ['Acme Foods', 'Asha Rao', 'CEO']]),
    [{ companyName: 'Acme Foods', directors: [{ name: 'Asha Rao', designation: 'CEO' }] }]);
  assert.deepEqual(await readRows(t, [['Company', 'Director'], ['Acme Foods', 'Asha Rao']]),
    [{ companyName: 'Acme Foods', directors: [{ name: 'Asha Rao', designation: '' }] }]);
});

test('does not infer people from unrelated columns or generic Name without a company header', async (t) => {
  assert.deepEqual(await readRows(t, [
    ['Company', 'Description', 'Director Email', 'Contact'],
    ['Acme Foods', 'Asha Rao', 'asha@example.test', 'Bimal Shah'],
  ]), ['Acme Foods']);
  const entries = await readRows(t, [['Name', 'Details'], ['Acme Foods', 'Asha Rao']]);
  assert(entries.every((entry) => typeof entry === 'string'));
  assert(entries.includes('Acme Foods'));
});

test('reads rich text, hyperlink text, and cached formula results in headers and data', async (t) => {
  assert.deepEqual(await readRows(t, [
    ['Company import'],
    [{ richText: [{ text: 'Company ' }, { text: 'Name' }] }, 'Person Name', 'Title'],
    [
      { formula: '"Acme Foods"', result: 'Acme Foods' },
      { richText: [{ text: 'Asha' }, { text: ' Rao' }] },
      { text: 'Managing Director', hyperlink: 'https://example.test' },
    ],
  ]), [{ companyName: 'Acme Foods', directors: [{ name: 'Asha Rao', designation: 'Managing Director' }] }]);
});

test('still rejects sheets without valid company names', async (t) => {
  await assert.rejects(readRows(t, [['Company', 'Director Name'], ['', 'Asha Rao']]),
    /No company names found in the Excel file/);
});
