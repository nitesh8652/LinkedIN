/**
 * Excel input/output processing using ExcelJS.
 */

const ExcelJS = require('exceljs');

/**
 * Read company names from the first worksheet of an uploaded .xlsx file.
 * Finds the column containing "company" in its header, else uses the
 * first non-empty column. Returns unique display names (case-insensitive dedupe).
 */
async function readCompaniesFromExcel(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const ws = workbook.worksheets[0];
  if (!ws) throw new Error('Excel file has no worksheets');

  const companies = [];
  const seen = new Set();

  // Detect header row + column
  let companyCol = null;
  let startRow = 1;

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > 5 || companyCol) return;
    row.eachCell((cell, colNumber) => {
      const v = String(cell.value ?? '').trim().toLowerCase();
      if (v === 'company' || v === 'company name' || v === 'companies' ||
          v === 'company_name' || v === 'organisation' || v === 'organization') {
        companyCol = colNumber;
        startRow = rowNumber + 1;
      }
    });
  });

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    let raw = null;
    if (companyCol && rowNumber >= startRow) {
      raw = row.getCell(companyCol).value;
    } else if (!companyCol) {
      // take first non-empty cell in the row
      for (let c = 1; c <= Math.min(row.cellCount, 10); c++) {
        const val = row.getCell(c).value;
        if (val !== null && val !== undefined && String(val).trim() !== '') {
          raw = val;
          break;
        }
      }
    }
    if (raw === null || raw === undefined) return;
    let text = typeof raw === 'object' ? (raw.text ?? raw.result ?? '') : raw;
    text = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2 || text.length > 150) return;
    // skip header-looking values
    if (/^compan(y|ies)\s*name?$/i.test(text)) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    companies.push(text);
  });

  if (companies.length === 0) throw new Error('No company names found in the Excel file');
  return companies;
}

const NULL_VALUE = 'NULL';

/**
 * The agent knows exactly why a row came back empty; that reason used to be
 * dropped before writing, leaving a sheet of unexplained NULLs.
 */
const STATUS_LABELS = {
  ok: 'Found',
  ok_medium: 'Found (medium confidence)',
  no_linkedin: 'No LinkedIn match',
  no_directors: 'Website found, no directors named',
  no_website: 'Official website not found',
  error: 'Error during research',
  // ZaubaCorp fallback — every way it can come up empty gets its own label.
  linkedin_unverified: 'LinkedIn verification failed',
  zauba_not_found: 'ZaubaCorp page not found',
  zauba_low_confidence: 'ZaubaCorp company match confidence too low',
  zauba_no_directors: 'ZaubaCorp directors unavailable',
  zauba_unreachable: 'ZaubaCorp page could not be loaded',
  zauba_error: 'ZaubaCorp lookup error',
};

const statusLabel = (s) => STATUS_LABELS[s] || (s ? String(s) : NULL_VALUE);

const DEFAULT_SOURCE = 'Official Website';

/**
 * Build the output workbook.
 * rows: [{ companyName, personName, designation, linkedinUrl }]
 */
async function writeResultsToExcel(rows, outPath, meta = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AI Company Research Agent';
  workbook.created = new Date();

  const ws = workbook.addWorksheet('Directors Report');

  ws.columns = [
    { header: 'Company Name', key: 'companyName', width: 32 },
    { header: 'Person Name', key: 'personName', width: 26 },
    { header: 'Designation', key: 'designation', width: 28 },
    { header: 'LinkedIn URL', key: 'linkedinUrl', width: 46 },
    { header: 'Source', key: 'source', width: 18 },
    { header: 'Status', key: 'status', width: 34 },
    { header: 'DIN / DPIN', key: 'din', width: 16 },
    { header: 'Appointment Date', key: 'appointmentDate', width: 22 },
    { header: 'Source URL', key: 'sourceUrl', width: 48 },
  ];

  for (const r of rows) {
    ws.addRow({
      companyName: r.companyName || NULL_VALUE,
      personName: r.personName || NULL_VALUE,
      designation: r.designation || NULL_VALUE,
      linkedinUrl: r.linkedinUrl || NULL_VALUE,
      source: r.source || DEFAULT_SOURCE,
      status: statusLabel(r.status),
      din: r.din || NULL_VALUE,
      appointmentDate: r.appointmentDate || NULL_VALUE,
      sourceUrl: r.sourceUrl || NULL_VALUE,
    });
  }

  // Style header
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 22;

  // Borders + alternating fill
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    row.alignment = { vertical: 'middle' };
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      };
    });
    if (i % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6FC' } };
      });
    }
  }

  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: 'I1' };

  // Summary sheet
  const sumWs = workbook.addWorksheet('Summary');
  sumWs.columns = [
    { header: 'Metric', key: 'metric', width: 34 },
    { header: 'Value', key: 'value', width: 20 },
  ];
  const totalCompanies = new Set(rows.map((r) => r.companyName)).size;
  const withPeople = rows.filter((r) => r.personName && r.personName !== NULL_VALUE);
  const withLinkedIn = withPeople.filter((r) => r.linkedinUrl && r.linkedinUrl !== NULL_VALUE);
  sumWs.addRows([
    { metric: 'Generated At', value: new Date().toLocaleString() },
    { metric: 'Total Companies', value: meta.totalCompanies ?? totalCompanies },
    { metric: 'Rows With People Found', value: withPeople.length },
    { metric: 'Rows With LinkedIn Found', value: withLinkedIn.length },
    { metric: 'LLM Layer', value: meta.llmEnabled ? 'Enabled' : 'Heuristic mode (no API key)' },
    { metric: 'Search Provider', value: meta.searchProvider || 'scraped engines' },
  ]);
  // A cancelled run produces a real report of partial results; say so, so the
  // missing companies read as "stopped early", not "nothing found".
  if (meta.cancelled) {
    sumWs.addRow({
      metric: 'Run Status',
      value: `Cancelled by user after ${meta.companiesProcessed ?? totalCompanies} of ${meta.totalCompanies ?? totalCompanies} companies`,
    }).font = { bold: true };
  }

  // Where the NULLs actually come from — the whole point of keeping status.
  const byStatus = new Map();
  for (const r of rows) {
    const label = statusLabel(r.status);
    byStatus.set(label, (byStatus.get(label) || 0) + 1);
  }
  sumWs.addRow({});
  sumWs.addRow({ metric: 'Outcome breakdown', value: '' }).font = { bold: true };
  for (const [label, count] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
    sumWs.addRow({ metric: label, value: count });
  }

  // How much of the report the official-website route carried, and how much
  // the ZaubaCorp fallback had to rescue.
  const bySource = new Map();
  for (const r of withPeople) {
    const label = r.source || DEFAULT_SOURCE;
    bySource.set(label, (bySource.get(label) || 0) + 1);
  }
  sumWs.addRow({});
  sumWs.addRow({ metric: 'People found by source', value: '' }).font = { bold: true };
  for (const [label, count] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    sumWs.addRow({ metric: label, value: count });
  }

  sumWs.getRow(1).font = { bold: true };

  await workbook.xlsx.writeFile(outPath);
  return outPath;
}

module.exports = { readCompaniesFromExcel, writeResultsToExcel, NULL_VALUE };
