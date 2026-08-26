/**
 * Creates a sample input Excel for testing.
 * Usage: node scripts/make-sample-excel.js [output.xlsx]
 */

const ExcelJS = require('exceljs');
const path = require('path');

const out = process.argv[2] || path.join(__dirname, '..', 'sample-companies.xlsx');

async function main() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Companies');
  ws.columns = [
    { header: 'Company Name', key: 'name', width: 40 },
  ];
  const names = (process.env.SAMPLE_COMPANIES || 'Tata Consultancy Services Ltd,Infosys Limited,Zerodha')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  names.forEach((n) => ws.addRow({ name: n }));
  await wb.xlsx.writeFile(out);
  console.log(`Sample Excel written to ${out} with ${names.length} companies`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
